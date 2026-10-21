/**
 * Host half of `dsh-opencode-go-usage`.
 *
 * The Client half only draws the sidebar entry and the "OpenCode Go usage"
 * page. This half owns everything a browser cannot do:
 *
 *   1. **Credential resolution** — it reuses the DSH-stored
 *      `OPENCODE_GO_API_KEY` (or the configured reference name) and never
 *      reads the DeepSeek credential. The key value never leaves this module
 *      except in the `Authorization` request header.
 *   2. **Upstream fetch** — one `GET <baseUrl>/zen/go/v1/usage` with a single
 *      `Authorization` + `Accept` header pair, a hard timeout, and tolerant
 *      normalization of an untrusted JSON body (INTERFACES.md §3/§5). A
 *      configured proxy/mirror path is preserved.
 *   3. **Cache, stale fallback and single-flight** — a short in-memory cache,
 *      `refresh` bypass, and a 6 h stale window. Concurrent calls share one
 *      in-flight promise.
 *   4. **Local sampling** — a 7-day / 4096-point trail at
 *      `<DSH_HOME>/opencode-go-usage/samples.json`, written only after a
 *      successful upstream read, atomically, best-effort.
 *   5. **RPC** — `POST /api/dsh-opencode-go-usage/call`, carrying the same
 *      `client-request` / `server-response` envelope as `dsh-token-usage`.
 *
 * The module is ESM and only imports Node builtins, so the bundle keeps its
 * zero-runtime-dependency promise.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'dsh-opencode-go-usage'
// The authenticated Fetch carrier is the supported plugin RPC seam.
export const inject = ['connection']

/** Package / locale / panel identity (INTERFACES.md §2). */
const PKG = 'dsh-opencode-go-usage'
const RPC_ENDPOINT = 'dsh-opencode-go-usage/call'
const RPC_PATH = '/api/' + RPC_ENDPOINT
/** Canonical upstream origin; also the baseURL fallback. */
const DEFAULT_BASE_URL = 'https://opencode.ai'
/** The credential reference the bundled profile points at. */
const DEFAULT_KEY_ENV = 'OPENCODE_GO_API_KEY'
/** Window keys and their fixed UI labels (labels are never translated). */
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']
const WINDOW_LABELS = { rolling: '5h', weekly: 'weekly', monthly: 'monthly' }
/** The usage path segment; `usageUrl` appends `/usage` to it. */
const USAGE_PATH = '/zen/go/v1'
/** Sampling constants (INTERFACES.md §7). */
const SAMPLE_DEDUPE_MS = 30_000
const SAMPLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// 7 days at the 60 s client cadence is 10,080 points; cap each account bucket
// there so the UI's fixed "last 7 days" domain is always backed by a full trail.
const MAX_SAMPLES = 10_080
/** Account model (INTERFACES.md §4.1). */
const DEFAULT_ACCOUNT_ID = 'default'
const MAX_ACCOUNTS = 8
const ACCOUNT_ID_PATTERN = /^acc-[a-z0-9]{8}$/
const ACCOUNT_REF_PREFIX = 'OPENCODE_GO_USAGE_ACC_'
const ACCOUNT_REF_PATTERN = /^OPENCODE_GO_USAGE_ACC_[A-Z0-9]{8}$/
const MIN_KEY_LENGTH = 8
const MAX_KEY_LENGTH = 512
const MAX_LABEL_LENGTH = 40
/** 6 h stale fallback window (INTERFACES.md §6). */
const MAX_STALE_MS = 6 * 60 * 60 * 1000
/** Plugin defaults; every value can be overridden through `apply(ctx, config)`. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  apiBaseUrl: undefined,
  apiKeyEnv: DEFAULT_KEY_ENV,
  cacheTtlMs: 30_000,
  timeoutMs: 15_000,
  maxStaleMs: MAX_STALE_MS,
  sampleRetentionMs: SAMPLE_RETENTION_MS,
  maxSamples: MAX_SAMPLES,
})
/** Small activation/failure journal in the OS temp directory (best effort). */
const LOG_PATH = join(tmpdir(), 'opencode-go-usage-host.log')

/** Dispatch of the currently applied plugin instance (`summary`/`refresh`). */
let currentDispatch

// --- small tolerant helpers -------------------------------------------------

/** True for a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** First non-empty trimmed string, or `''`. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (text !== '') return text
    }
  }
  return ''
}

/** Trim a secret without ever logging it; CR/LF cannot reach a header value. */
function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]/g, '') : ''
}

/** A POSIX environment-variable / credential-reference identifier. */
function isEnvName(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())
}

/** Positive finite number or the fallback. */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** Non-negative finite number or the fallback. */
function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/** Positive integer or the fallback. */
function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** The wall clock, guarded against a broken injected clock. */
function clockMs(clock) {
  const number = Number(typeof clock === 'function' ? clock() : clock)
  return Number.isFinite(number) ? number : Date.now()
}

/** Human-readable message without a stack or a secret. */
function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** Mask a key for display: `…A1b2`, or `…` when it is too short to hint. */
function maskKey(key) {
  const text = normalizeSecret(key)
  if (text.length < 8) return '…'
  return '…' + text.slice(-4)
}

/**
 * Normalize one user-supplied key (INTERFACES.md §4.1): trim, drop one leading
 * `Bearer `, strip CR/LF, then reject anything with whitespace or a control
 * character and anything outside 8–512 characters. Never echoes the value.
 * @returns `{ok:true, value}` or `{ok:false, code:'invalid-key', reason}`
 */
function normalizeApiKey(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid-key', reason: 'not-a-string' }
  }
  let text = raw.replace(/\r/g, '').replace(/\n/g, '').trim()
  text = text.replace(/^Bearer\s+/i, '').trim()
  if (text === '') return { ok: false, code: 'invalid-key', reason: 'empty' }
  if (/\s/.test(text)) return { ok: false, code: 'invalid-key', reason: 'whitespace' }
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, code: 'invalid-key', reason: 'control' }
  if (text.length < MIN_KEY_LENGTH) return { ok: false, code: 'invalid-key', reason: 'too-short' }
  if (text.length > MAX_KEY_LENGTH) return { ok: false, code: 'invalid-key', reason: 'too-long' }
  return { ok: true, value: text }
}

/** Stable, non-reversible account fingerprint for the sample buckets. */
function keyFingerprint(key) {
  const text = normalizeSecret(key)
  if (text === '') return ''
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** `acc-1a2b3c4d`; retries never collide because randomUUID has 122 bits. */
function newAccountId() {
  return 'acc-' + randomUUID().replace(/-/g, '').slice(0, 8).toLowerCase()
}

/** `acc-1a2b3c4d` -> `OPENCODE_GO_USAGE_ACC_1A2B3C4D`. */
function refForAccountId(id) {
  return ACCOUNT_REF_PREFIX + String(id).slice(4).toUpperCase()
}

/** A user label, trimmed and capped; anything non-string becomes `''`. */
function normalizeLabel(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, MAX_LABEL_LENGTH)
}

/**
 * Normalize any baseURL-ish string to its HTTP(S) origin.
 * `https://opencode.ai/zen/go/v1/` -> `https://opencode.ai`; invalid -> `''`.
 *
 * Diagnostic only: never derive a request URL from this helper, because it
 * discards a configured proxy path. Use `normalizeBaseUrl` instead.
 */
function originOf(value) {
  let text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch (_ignored) {
    return ''
  }
}

/**
 * Normalize a configured base URL per INTERFACES.md §4: an absolute `http(s)`
 * URL whose pathname is preserved, with trailing slashes, query and hash
 * stripped. `proxy.example/api/` -> `https://proxy.example/api`; invalid -> `''`.
 *
 * The pathname must survive (unlike `originOf`) because an enterprise proxy or
 * mirror legitimately lives under a prefix such as `/api`.
 */
function normalizeBaseUrl(value) {
  let text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text
  let url
  try {
    url = new URL(text)
  } catch (_ignored) {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  const pathname = url.pathname.replace(/\/+$/, '')
  return url.origin + pathname
}

/**
 * Derive the usage URL from the normalized base URL (INTERFACES.md §4): append
 * `/usage` when the path already ends with `/zen/go/v1`, otherwise append the
 * whole `/zen/go/v1/usage`. Any proxy prefix is kept, and an input that already
 * ends with the full usage path is returned unchanged (idempotent).
 */
function usageUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL
  if (base.endsWith(USAGE_PATH + '/usage')) return base
  if (base.endsWith(USAGE_PATH)) return base + '/usage'
  return base + USAGE_PATH + '/usage'
}

/** Client-side drawing helper (the Host keeps upstream percent untouched). */
function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

/** Reset countdown in seconds; unparseable timestamps become 0. */
function resetInSecOf(resetAt, now) {
  if (typeof resetAt !== 'string' || resetAt === '') return 0
  const parsed = Date.parse(resetAt)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.round((parsed - now) / 1000))
}

/**
 * Normalize one window. Missing windows and non-finite percents are
 * `percent: null` (the Client renders `—` instead of a synthetic 0%), a
 * missing status defaults to `ok` only when a finite percent exists, and a
 * string status is passed through. Per INTERFACES.md §3 the Host does **not**
 * clamp a finite percent (the Client clamps while drawing) and keeps an
 * unparseable `resetsAt` string as-is, with `resetInSec = 0`.
 */
function normalizeWindow(key, raw, now) {
  const source = isRecord(raw) ? raw : null
  const label = WINDOW_LABELS[key]
  if (source === null) {
    return { key, label, status: 'unknown', percent: null, resetAt: '', resetInSec: 0 }
  }
  const percent = typeof source.percent === 'number' && Number.isFinite(source.percent) ? source.percent : null
  // A finite number without a status is still usable; an unknown/missing value
  // with no status stays `unknown` so the Client renders `—`.
  const status = typeof source.status === 'string' && source.status !== ''
    ? source.status
    : (percent === null ? 'unknown' : 'ok')
  const resetAt = typeof source.resetsAt === 'string' ? source.resetsAt : ''
  return { key, label, status, percent, resetAt, resetInSec: resetInSecOf(resetAt, now) }
}

/** Normalize the whole upstream body into the three contracted windows. */
function normalizeUsage(payload, now = Date.now()) {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {}
  const windows = {}
  for (const key of WINDOW_KEYS) windows[key] = normalizeWindow(key, usage[key], now)
  return windows
}

/** Recompute `resetInSec` against "now" for a stored window set. */
function windowsAt(windows, now) {
  const out = {}
  for (const key of WINDOW_KEYS) {
    const raw = isRecord(windows) && isRecord(windows[key]) ? windows[key] : {}
    const resetAt = typeof raw.resetAt === 'string' ? raw.resetAt : ''
    const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : null
    out[key] = {
      key,
      label: WINDOW_LABELS[key],
      status: typeof raw.status === 'string' && raw.status !== ''
        ? raw.status
        : (percent === null ? 'unknown' : 'ok'),
      percent,
      resetAt,
      resetInSec: resetInSecOf(resetAt, now),
    }
  }
  return out
}

// --- logging (best effort, never a secret) ----------------------------------

/** Strip anything that looks like the key before it reaches the log file. */
function redactText(text, secret) {
  let out = String(text)
  if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('[redacted]')
  return out.replace(/\b(?:oc_sk_|sk-)[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
}

/** Append one diagnostic line; logging must never affect the plugin. */
function log(message, secret) {
  try {
    const text = redactText(message, secret).slice(0, 2000)
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + text + '\n')
  } catch (_ignored) {
    // Best effort by contract.
  }
}

// --- credential / source resolution ----------------------------------------

/** Read a service from a Cordis context, preferring `ctx.get(service)`. */
function serviceOf(ctx, serviceName) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(serviceName)
      if (service !== undefined && service !== null) return service
    }
  } catch (_ignored) {
    // Fall through to the property form.
  }
  return ctx[serviceName]
}

/**
 * Read one settings namespace tolerantly.
 *
 * The contract's shape is `ctx.get('settings').get('llm-pi-ai')`. The live
 * DSH settings service in this build exposes `describe({redactSecrets})`
 * instead, so that is used as a fallback. Both forms are best-effort: a
 * missing or broken settings service simply yields `undefined`.
 */
async function readSettings(ctx, settingsName) {
  const settings = serviceOf(ctx, 'settings')
  if (!settings) return undefined

  // `get(ns)` is the documented shape. Keep its failure isolated: a live build
  // that exposes only `describe()` (or throws for an unknown namespace) must
  // still reach the describe fallback instead of silently losing the provider.
  if (typeof settings.get === 'function') {
    try {
      const value = await settings.get(settingsName)
      if (value !== undefined) return value
    } catch (_ignored) {
      // fall through to describe
    }
  }

  if (typeof settings.describe === 'function') {
    try {
      const descriptors = await settings.describe({ redactSecrets: true })
      if (Array.isArray(descriptors)) {
        const hit = descriptors.find((row) => isRecord(row) && row.ns === settingsName)
        if (isRecord(hit)) return hit.value
      }
    } catch (_ignored) {
      // settings are optional; defaults remain
    }
  }
  return undefined
}

/** Pull the secret out of the several shapes a credentials service may return. */
function secretOf(hit) {
  if (typeof hit === 'string') return normalizeSecret(hit)
  if (!isRecord(hit)) return ''
  const value = hit.value ?? hit.secret ?? hit.apiKey
  return normalizeSecret(value)
}

/**
 * Resolve the credential reference and baseURL exactly as frozen in
 * INTERFACES.md §4:
 *
 *   config.apiKeyEnv -> llm-pi-ai.providers['opencode-go'].apiKeyEnv
 *                    -> OPENCODE_GO_API_KEY
 *
 * The value comes from `credentials.resolve(ref)`, then `process.env[ref]`.
 * `llm-deepseek` is read for its `providers['opencode-go'].baseURL` only,
 * never for a top-level `baseURL` and never for `apiKeyEnv`: a top-level
 * `llm-deepseek.baseURL` belongs to the DeepSeek API, and falling back to it
 * would send the OpenCode Go key to the other subscription provider.
 *
 * The returned object has a non-enumerable `apiKey` so an accidental
 * `JSON.stringify(source)` cannot leak it.
 */
/** The shared baseURL chain (INTERFACES.md §4), without touching any key. */
async function resolveBaseUrl(ctx, config) {
  const cfg = isRecord(config) ? config : {}

  const piAi = await readSettings(ctx, 'llm-pi-ai')
  const opencodeGo = isRecord(piAi) && isRecord(piAi.providers) ? piAi.providers['opencode-go'] : undefined
  // Deliberately only the `opencode-go` provider entry; reading `apiKeyEnv`
  // here would mix the two subscription providers (INTERFACES.md §4 hard
  // constraint), and a top-level `llm-deepseek.baseURL` is not a permitted
  // route at all.
  const deepseek = await readSettings(ctx, 'llm-deepseek')
  const deepseekGo = isRecord(deepseek) && isRecord(deepseek.providers)
    ? deepseek.providers['opencode-go']
    : undefined

  return normalizeBaseUrl(firstString(
    cfg.apiBaseUrl,
    cfg.baseUrl,
    isRecord(opencodeGo) ? opencodeGo.baseURL : undefined,
    isRecord(deepseekGo) ? deepseekGo.baseURL : undefined,
  )) || DEFAULT_BASE_URL
}

/**
 * Read one credential reference: the DSH credentials store first, then the
 * same-named environment variable. Per-operation, so a rotated key applies to
 * the next call without a restart (INTERFACES.md §4).
 */
async function secretForRef(ctx, ref) {
  if (!isEnvName(ref)) return ''
  let key = ''
  try {
    const credentials = serviceOf(ctx, 'credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      key = secretOf(await credentials.resolve(ref))
    }
  } catch (_ignored) {
    key = ''
  }
  if (key === '') {
    try {
      key = normalizeSecret(process.env[ref])
    } catch (_ignored) {
      key = ''
    }
  }
  return key
}

/** Resolve the default account's source through the frozen §4 chain. */
async function resolveSource(ctx, config) {
  const cfg = isRecord(config) ? config : {}

  const piAi = await readSettings(ctx, 'llm-pi-ai')
  const opencodeGo = isRecord(piAi) && isRecord(piAi.providers) ? piAi.providers['opencode-go'] : undefined
  const baseUrl = await resolveBaseUrl(ctx, config)

  const configuredRef = isEnvName(cfg.apiKeyEnv) ? cfg.apiKeyEnv.trim() : ''
  const providerRef = isRecord(opencodeGo) && isEnvName(opencodeGo.apiKeyEnv)
    ? opencodeGo.apiKeyEnv.trim()
    : ''
  const keyRef = configuredRef !== '' ? configuredRef : providerRef !== '' ? providerRef : DEFAULT_KEY_ENV

  const apiKey = await secretForRef(ctx, keyRef)

  const source = {
    baseUrl,
    usageUrl: usageUrl(baseUrl),
    keyRef,
    keyHint: maskKey(apiKey),
  }
  Object.defineProperty(source, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return source
}

// --- upstream fetch ---------------------------------------------------------

/** Business/transport error with a contracted `code`. */
class UsageError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.details = isRecord(details) ? details : {}
  }
}

/**
 * `GET <baseUrl>/zen/go/v1/usage`, keeping any configured proxy prefix.
 *
 * Only `Authorization` and `Accept` are sent. 401/403 is `unauthorized`, any
 * other non-2xx is `upstream`, transport/timeout failures are `network`, and
 * an unparseable or structurally wrong 2xx body is `bad-response`.
 *
 * @returns `{ windows, url, status, durationMs }`.
 */
async function fetchGoUsage(options = {}) {
  const apiKey = normalizeSecret(options.apiKey)
  if (apiKey === '') {
    throw new UsageError('no-key', 'No OpenCode Go API key is configured.', {})
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl) || DEFAULT_BASE_URL
  const url = usageUrl(baseUrl)
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_CONFIG.timeoutMs)
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  if (typeof fetchImpl !== 'function') {
    throw new UsageError('network', 'This Node.js runtime has no global fetch().', {})
  }

  const startedAt = Date.now()
  const headers = { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error && typeof error.name === 'string' ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new UsageError(
        'network',
        'OpenCode Go usage request timed out after ' + timeoutMs + ' ms.',
        { reason: 'timeout', timeoutMs },
      )
    }
    throw new UsageError(
      'network',
      'Could not reach OpenCode Go at ' + url + ': ' + redactText(errorMessage(error), apiKey),
      { reason: 'fetch-failed' },
    )
  }

  const status = typeof response.status === 'number' ? response.status : 0
  const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300
  if (status === 401 || status === 403) {
    throw new UsageError(
      'unauthorized',
      'OpenCode Go rejected the API key (HTTP ' + status + ').',
      { status },
    )
  }
  if (!ok) {
    throw new UsageError(
      'upstream',
      'OpenCode Go usage endpoint returned HTTP ' + status + '.',
      { status },
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch (_ignored) {
    throw new UsageError('bad-response', 'OpenCode Go usage response was not valid JSON.', { status })
  }
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new UsageError(
      'bad-response',
      'OpenCode Go usage response did not contain a usage object.',
      { status },
    )
  }

  return {
    windows: normalizeUsage(payload, clockMs(now)),
    url,
    status,
    durationMs: Date.now() - startedAt,
  }
}

// --- sample store -----------------------------------------------------------

/** `<DSH_HOME>` with `~/.dsh` as the contract default. */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return resolve(configured !== '' ? configured : join(homedir(), '.dsh'))
}

/** `<home>/opencode-go-usage/samples.json`. */
function sampleFilePath(home) {
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : dshHome()
  return join(resolve(base), 'opencode-go-usage', 'samples.json')
}

/** `<home>/opencode-go-usage/accounts.json` (metadata only, never keys). */
function accountFilePath(home) {
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : dshHome()
  return join(resolve(base), 'opencode-go-usage', 'accounts.json')
}

/** Keep only numerically valid points, ascending by `t`. */
function sanitizeSamples(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (!isRecord(item)) continue
    const t = Number(item.t)
    if (!Number.isFinite(t)) continue
    const point = { t: Math.round(t) }
    let valid = true
    for (const key of WINDOW_KEYS) {
      const value = Number(item[key])
      if (!Number.isFinite(value)) valid = false
      point[key] = Number.isFinite(value) ? value : 0
    }
    if (valid) out.push(point)
  }
  out.sort((left, right) => left.t - right.t)
  return out
}

/**
 * 7-day sample trail.
 *
 * Loading is tolerant (a corrupt file becomes an empty trail and is rewritten);
 * appending dedupes points within 30 s, trims to 7 days / 4096 points, and
 * saves atomically through a temp file + rename. Every IO failure is swallowed
 * after a best-effort log line — sampling must never break the RPC answer.
 */
class SampleStore {
  constructor(options = {}) {
    this.file = typeof options.file === 'string' && options.file.trim() !== ''
      ? options.file
      : sampleFilePath(options.home)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.retentionMs = nonNegativeNumber(options.retentionMs, SAMPLE_RETENTION_MS)
    this.maxSamples = positiveInteger(options.maxSamples, MAX_SAMPLES)
    /** accountId -> { fingerprint, samples } */
    this.accounts = new Map()
    this.load()
  }

  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      // Missing file is normal. Any other read failure leaves an empty trail
      // and never overwrites what may still be a valid file.
      if (error && error.code !== 'ENOENT') log('samples read failed: ' + errorMessage(error))
      this.accounts = new Map()
      return
    }

    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (_ignored) {
      parsed = null
    }
    if (parsed === null) {
      this.accounts = new Map()
      this.save()
      return
    }

    let migrated = false
    this.accounts = new Map()
    if (isRecord(parsed) && parsed.version === 2 && isRecord(parsed.accounts)) {
      for (const [id, bucket] of Object.entries(parsed.accounts)) {
        if (!isRecord(bucket) || !Array.isArray(bucket.samples)) continue
        const samples = sanitizeSamples(bucket.samples)
        if (samples.length === 0) continue
        this.accounts.set(id, {
          fingerprint: typeof bucket.fingerprint === 'string' ? bucket.fingerprint : '',
          samples,
        })
      }
    } else {
      // v1 (`{version:1, samples}`) and the pre-version bare array both belong
      // to the default account; keeping them preserves the old trail.
      const list = Array.isArray(parsed)
        ? parsed
        : (isRecord(parsed) && Array.isArray(parsed.samples) ? parsed.samples : null)
      if (list !== null) {
        const samples = sanitizeSamples(list)
        if (samples.length > 0) this.accounts.set(DEFAULT_ACCOUNT_ID, { fingerprint: '', samples })
        migrated = true
      }
    }
    this.trim(clockMs(this.now))
    if (migrated) this.save()
  }

  /** The bucket for one account, created lazily. */
  bucket(id) {
    let bucket = this.accounts.get(id)
    if (bucket === undefined) {
      bucket = { fingerprint: '', samples: [] }
      this.accounts.set(id, bucket)
    }
    return bucket
  }

  /**
   * Read one account's trail. A fingerprint mismatch means the key behind this
   * account changed, so the old percentages no longer describe it: return an
   * empty trail and let the next append reset the bucket.
   */
  list(id = DEFAULT_ACCOUNT_ID, fingerprint) {
    const bucket = this.accounts.get(id)
    if (bucket === undefined) return []
    if (typeof fingerprint === 'string' && fingerprint !== '' && bucket.fingerprint !== '' && bucket.fingerprint !== fingerprint) {
      return []
    }
    if (typeof fingerprint === 'string' && fingerprint !== '' && bucket.fingerprint === '') {
      bucket.fingerprint = fingerprint
    }
    return sanitizeSamples(bucket.samples)
  }

  /** Whether an account has any persisted points (diagnostics/tests). */
  has(id) {
    const bucket = this.accounts.get(id)
    return bucket !== undefined && bucket.samples.length > 0
  }

  /**
   * Dedupe (<30 s replaces the tail), trim and persist one point.
   *
   * Back-compatible call shapes:
   *   append(sample)                     -> default bucket
   *   append(accountId, sample, fingerprint)
   */
  append(idOrSample, sample, fingerprint) {
    let id = DEFAULT_ACCOUNT_ID
    let input = idOrSample
    let prints = ''
    if (typeof idOrSample === 'string') {
      id = idOrSample
      input = sample
      prints = typeof fingerprint === 'string' ? fingerprint : ''
    }

    const now = clockMs(this.now)
    const at = Number.isFinite(Number(input && input.t)) ? Math.round(Number(input.t)) : now
    const point = { t: at }
    for (const key of WINDOW_KEYS) {
      const value = Number(input && input[key])
      point[key] = Number.isFinite(value) ? value : 0
    }

    const bucket = this.bucket(id)
    if (prints !== '') {
      if (bucket.fingerprint !== '' && bucket.fingerprint !== prints) bucket.samples = []
      bucket.fingerprint = prints
    }

    const list = bucket.samples
    const lastIndex = list.length - 1
    const last = lastIndex >= 0 ? list[lastIndex] : null
    if (last !== null && point.t <= last.t) {
      // Clock skew or an immediate repeat: keep the trail ascending.
      point.t = last.t
      list[lastIndex] = point
    } else if (last !== null && point.t - last.t < SAMPLE_DEDUPE_MS) {
      list[lastIndex] = point
    } else {
      list.push(point)
    }

    this.trim(now)
    this.save()
    return { ...point }
  }

  /** Drop one account's trail (deleted account / rotated key). */
  drop(id) {
    if (!this.accounts.has(id)) return
    this.accounts.delete(id)
    this.save()
  }

  trim(now) {
    const cutoff = now - this.retentionMs
    for (const [id, bucket] of this.accounts) {
      bucket.samples = bucket.samples.filter((sample) => sample.t >= cutoff)
      if (bucket.samples.length > this.maxSamples) {
        bucket.samples = bucket.samples.slice(bucket.samples.length - this.maxSamples)
      }
      if (bucket.samples.length === 0) this.accounts.delete(id)
    }
  }

  save() {
    const tmp = this.file + '.tmp.' + process.pid
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const accounts = {}
      for (const [id, bucket] of this.accounts) {
        accounts[id] = { fingerprint: bucket.fingerprint, samples: bucket.samples }
      }
      writeFileSync(tmp, JSON.stringify({
        version: 2,
        updatedAt: clockMs(this.now),
        accounts,
      }), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch (_ignored) {
        // Nothing to clean up.
      }
      log('samples write failed: ' + errorMessage(error))
    }
  }
}

/**
 * Account metadata store: labels and credential references only.
 *
 * Never holds a key. Writes are atomic and serialized by the service that owns
 * the store, so an add followed by an activate cannot interleave on disk.
 */
class AccountStore {
  constructor(options = {}) {
    this.file = typeof options.file === 'string' && options.file.trim() !== ''
      ? options.file
      : accountFilePath(options.home)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.maxAccounts = positiveInteger(options.maxAccounts, MAX_ACCOUNTS)
    this.accounts = []
    this.activeId = DEFAULT_ACCOUNT_ID
    this.defaultLabel = ''
    this.load()
  }

  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') log('accounts read failed: ' + errorMessage(error))
      return
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (_ignored) {
      parsed = null
    }
    if (!isRecord(parsed)) {
      this.reset()
      this.trySave()
      return
    }
    this.defaultLabel = normalizeLabel(parsed.defaultLabel)
    this.activeId = typeof parsed.activeId === 'string' ? parsed.activeId : DEFAULT_ACCOUNT_ID
    const seenId = new Set()
    const seenRef = new Set()
    const accounts = []
    if (Array.isArray(parsed.accounts)) {
      for (const item of parsed.accounts) {
        if (!isRecord(item)) continue
        const id = typeof item.id === 'string' ? item.id : ''
        const ref = typeof item.ref === 'string' ? item.ref : ''
        if (!ACCOUNT_ID_PATTERN.test(id) || !ACCOUNT_REF_PATTERN.test(ref)) continue
        if (seenId.has(id) || seenRef.has(ref)) continue
        seenId.add(id)
        seenRef.add(ref)
        accounts.push({
          id,
          ref,
          label: normalizeLabel(item.label),
          createdAt: Number.isFinite(Number(item.createdAt)) ? Math.round(Number(item.createdAt)) : clockMs(this.now),
        })
      }
    }
    this.accounts = accounts.slice(0, Math.max(0, this.maxAccounts - 1))
    if (!this.has(this.activeId)) this.activeId = DEFAULT_ACCOUNT_ID
  }

  reset() {
    this.accounts = []
    this.activeId = DEFAULT_ACCOUNT_ID
    this.defaultLabel = ''
  }

  snapshot() {
    return {
      version: 1,
      activeId: this.activeId,
      defaultLabel: this.defaultLabel,
      accounts: this.accounts.map((account) => ({ ...account })),
    }
  }

  list() {
    return this.accounts.map((account) => ({ ...account }))
  }

  has(id) {
    return id === DEFAULT_ACCOUNT_ID || this.accounts.some((account) => account.id === id)
  }

  get(id) {
    if (id === DEFAULT_ACCOUNT_ID) return null
    const hit = this.accounts.find((account) => account.id === id)
    return hit === undefined ? null : { ...hit }
  }

  add({ label }) {
    if (this.accounts.length >= Math.max(1, this.maxAccounts - 1)) {
      throw new UsageError('too-many-accounts', 'This plugin supports at most ' + this.maxAccounts + ' accounts.', {
        max: this.maxAccounts,
      })
    }
    let id = newAccountId()
    while (this.has(id)) id = newAccountId()
    const account = {
      id,
      ref: refForAccountId(id),
      label: normalizeLabel(label),
      createdAt: clockMs(this.now),
    }
    this.accounts.push(account)
    return { ...account }
  }

  rename(id, label) {
    const text = normalizeLabel(label)
    if (id === DEFAULT_ACCOUNT_ID) {
      this.defaultLabel = text
      return
    }
    const hit = this.accounts.find((account) => account.id === id)
    if (hit === undefined) throw new UsageError('account-not-found', 'Unknown account: ' + String(id), { id })
    hit.label = text
  }

  remove(id) {
    if (id === DEFAULT_ACCOUNT_ID) {
      throw new UsageError('cannot-remove-default', 'The default account cannot be removed.', {})
    }
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) throw new UsageError('account-not-found', 'Unknown account: ' + String(id), { id })
    this.accounts.splice(index, 1)
    if (this.activeId === id) this.activeId = DEFAULT_ACCOUNT_ID
  }

  setActive(id) {
    if (!this.has(id)) throw new UsageError('account-not-found', 'Unknown account: ' + String(id), { id })
    this.activeId = id
  }

  save() {
    const tmp = this.file + '.tmp.' + process.pid
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.snapshot()), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch (_ignored) {
        // Nothing to clean up.
      }
      throw new UsageError('account-store-failed', 'Could not write the account list.', {
        reason: errorMessage(error).slice(0, 200),
      })
    }
  }

  /** Constructor-time recovery only: a failed write must not break activation. */
  trySave() {
    try {
      this.save()
    } catch (error) {
      log('accounts write failed: ' + errorMessage(error))
    }
  }
}

/**
 * Account operations over the metadata store and the DSH credential store.
 *
 * Every mutation is queued: `add` writes a credential then metadata, and a
 * concurrent `activate` must not interleave with that sequence. Reads are
 * cheap (the credential provider keeps an in-memory snapshot).
 */
class AccountService {
  constructor(options = {}) {
    this.ctx = options.ctx
    this.config = options.config
    this.store = options.store
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_CONFIG.timeoutMs)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.operations = Promise.resolve()
  }

  /** Queue one exclusive mutation behind every earlier one. */
  enqueue(operation) {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** The default label plus every custom account, with hints but no keys. */
  async buildList() {
    const source = await resolveSource(this.ctx, this.config)
    const accounts = [{
      id: DEFAULT_ACCOUNT_ID,
      label: this.store.defaultLabel,
      keyRef: source.keyRef,
      keyHint: source.keyHint,
      isDefault: true,
      configured: source.apiKey !== '',
    }]
    for (const meta of this.store.list()) {
      const key = await secretForRef(this.ctx, meta.ref)
      accounts.push({
        id: meta.id,
        label: meta.label,
        keyRef: meta.ref,
        keyHint: maskKey(key),
        isDefault: false,
        configured: key !== '',
      })
    }
    return { activeId: this.effectiveActiveId(accounts), accounts }
  }

  /**
   * The persisted active account, with one deliberate exception: when the
   * default account has no key but a custom account does, start on that custom
   * account instead of greeting the user with a `no-key` error.
   */
  effectiveActiveId(accounts) {
    const active = this.store.activeId
    if (!accounts.some((account) => account.id === active)) return DEFAULT_ACCOUNT_ID
    if (active === DEFAULT_ACCOUNT_ID) {
      const def = accounts[0]
      const fallback = accounts.find((account) => !account.isDefault && account.configured)
      if (def !== undefined && !def.configured && fallback !== undefined) return fallback.id
    }
    return active
  }

  /** Public, read-only account list. */
  list() {
    return this.enqueue(() => this.buildList())
  }

  /** Every account's actual key, for duplicate checks (never returned to the client). */
  async resolvedKeys() {
    const out = []
    const source = await resolveSource(this.ctx, this.config)
    out.push({ id: DEFAULT_ACCOUNT_ID, key: source.apiKey })
    for (const meta of this.store.list()) {
      out.push({ id: meta.id, key: await secretForRef(this.ctx, meta.ref) })
    }
    return out
  }

  /**
   * Resolve one account (with its key) for the fetch layer. `id` omitted means
   * the effective active account.
   */
  async resolveAccount(id) {
    let target = typeof id === 'string' ? id.trim() : ''
    if (target === '') {
      const list = await this.buildList()
      target = list.activeId
    }
    if (target === DEFAULT_ACCOUNT_ID) {
      const source = await resolveSource(this.ctx, this.config)
      return {
        id: DEFAULT_ACCOUNT_ID,
        label: this.store.defaultLabel,
        keyRef: source.keyRef,
        keyHint: source.keyHint,
        isDefault: true,
        apiKey: source.apiKey,
        baseUrl: source.baseUrl,
        usageUrl: source.usageUrl,
      }
    }
    const meta = this.store.get(target)
    if (meta === null) {
      throw new UsageError('account-not-found', 'Unknown account: ' + target, { id: target })
    }
    const baseUrl = await resolveBaseUrl(this.ctx, this.config)
    const apiKey = await secretForRef(this.ctx, meta.ref)
    return {
      id: meta.id,
      label: meta.label,
      keyRef: meta.ref,
      keyHint: maskKey(apiKey),
      isDefault: false,
      apiKey,
      baseUrl,
      usageUrl: usageUrl(baseUrl),
    }
  }

  /**
   * Add one account. Validation is transactional: a 401/403 rolls the key and
   * the metadata back out; a transport failure keeps the account (the key may
   * be fine and the network may not).
   */
  add(input) {
    return this.enqueue(async () => {
      const normalized = normalizeApiKey(input && input.apiKey)
      if (!normalized.ok) {
        throw new UsageError('invalid-key', 'The API key is not valid.', { reason: normalized.reason })
      }
      const existing = await this.resolvedKeys()
      if (existing.some((row) => row.key !== '' && row.key === normalized.value)) {
        throw new UsageError('duplicate-key', 'That API key is already configured for another account.', {})
      }
      const credentials = serviceOf(this.ctx, 'credentials')
      if (!credentials || typeof credentials.set !== 'function') {
        throw new UsageError('key-store-unavailable', 'The DSH credential store is not available; the key was not saved.', {})
      }
      const account = this.store.add({ label: input && input.label })
      try {
        await credentials.set(account.ref, normalized.value)
        this.store.setActive(account.id)
        this.store.save()
      } catch (error) {
        try {
          if (typeof credentials.unset === 'function') await credentials.unset(account.ref)
        } catch (_ignored) {
          // Best effort: the metadata rollback below is the important part.
        }
        this.store.load()
        if (error instanceof UsageError) throw error
        throw new UsageError('key-store-unavailable', 'The DSH credential store rejected the key; nothing was saved.', {})
      }

      let windows = null
      let fetchedAt = null
      let warning = null
      try {
        const baseUrl = await resolveBaseUrl(this.ctx, this.config)
        const fetched = await fetchGoUsage({
          baseUrl,
          apiKey: normalized.value,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
        windows = fetched.windows
        fetchedAt = clockMs(this.now)
      } catch (error) {
        if (error && error.code === 'unauthorized') {
          try {
            if (typeof credentials.unset === 'function') await credentials.unset(account.ref)
          } catch (_ignored) {
            // Best effort.
          }
          // The metadata was already persisted; remove it too, or a reload
          // would resurrect an account whose key was just rejected.
          try {
            this.store.remove(account.id)
            this.store.save()
          } catch (_ignored) {
            this.store.load()
          }
          throw error
        }
        warning = {
          code: typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'error',
          message: redactText(errorMessage(error), normalized.value),
        }
      }

      return {
        account: {
          id: account.id,
          label: account.label,
          keyRef: account.ref,
          keyHint: maskKey(normalized.value),
          isDefault: false,
        },
        warning,
        windows,
        fetchedAt,
      }
    })
  }

  /** Rename and/or rotate one account. */
  update(input) {
    return this.enqueue(async () => {
      const id = typeof (input && input.id) === 'string' ? input.id.trim() : ''
      const hasKey = input !== undefined && input !== null && input.apiKey !== undefined
      const hasLabel = input !== undefined && input !== null && input.label !== undefined
      if (id === DEFAULT_ACCOUNT_ID) {
        if (hasKey) {
          throw new UsageError('default-key-managed', 'Change the default account key in the DSH credential store.', {})
        }
        if (hasLabel) {
          this.store.rename(DEFAULT_ACCOUNT_ID, input.label)
          this.store.save()
        }
        return { changedKey: false, warning: null, windows: null, fetchedAt: null }
      }
      const meta = this.store.get(id)
      if (meta === null) throw new UsageError('account-not-found', 'Unknown account: ' + id, { id })

      if (hasLabel) {
        this.store.rename(id, input.label)
        this.store.save()
      }
      if (!hasKey) return { changedKey: false, warning: null, windows: null, fetchedAt: null }

      const normalized = normalizeApiKey(input.apiKey)
      if (!normalized.ok) {
        throw new UsageError('invalid-key', 'The API key is not valid.', { reason: normalized.reason })
      }
      const keys = await this.resolvedKeys()
      if (keys.some((row) => row.id !== id && row.key !== '' && row.key === normalized.value)) {
        throw new UsageError('duplicate-key', 'That API key is already configured for another account.', {})
      }
      const oldKey = keys.find((row) => row.id === id)
      const credentials = serviceOf(this.ctx, 'credentials')
      if (!credentials || typeof credentials.set !== 'function') {
        throw new UsageError('key-store-unavailable', 'The DSH credential store is not available; the key was not saved.', {})
      }
      try {
        await credentials.set(meta.ref, normalized.value)
      } catch (_ignored) {
        throw new UsageError('key-store-unavailable', 'The DSH credential store rejected the key; nothing was saved.', {})
      }

      let windows = null
      let fetchedAt = null
      let warning = null
      try {
        const baseUrl = await resolveBaseUrl(this.ctx, this.config)
        const fetched = await fetchGoUsage({
          baseUrl,
          apiKey: normalized.value,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
        windows = fetched.windows
        fetchedAt = clockMs(this.now)
      } catch (error) {
        if (error && error.code === 'unauthorized') {
          try {
            if (oldKey && oldKey.key !== '') await credentials.set(meta.ref, oldKey.key)
            else if (typeof credentials.unset === 'function') await credentials.unset(meta.ref)
          } catch (_ignored) {
            // Best effort: the old key may be gone, but never echo either key.
          }
          throw error
        }
        warning = {
          code: typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'error',
          message: redactText(errorMessage(error), normalized.value),
        }
      }
      return { changedKey: true, warning, windows, fetchedAt }
    })
  }

  /** Remove one custom account; the credential is unset best-effort. */
  remove(id) {
    return this.enqueue(async () => {
      const target = typeof id === 'string' ? id.trim() : ''
      const meta = this.store.get(target)
      if (meta === null) {
        if (target === DEFAULT_ACCOUNT_ID) {
          throw new UsageError('cannot-remove-default', 'The default account cannot be removed.', {})
        }
        throw new UsageError('account-not-found', 'Unknown account: ' + target, { id: target })
      }
      this.store.remove(target)
      this.store.save()
      const credentials = serviceOf(this.ctx, 'credentials')
      try {
        if (credentials && typeof credentials.unset === 'function') await credentials.unset(meta.ref)
      } catch (error) {
        log('credential unset failed for ' + target + ': ' + errorMessage(error))
      }
      return meta
    })
  }

  /** Persist which account the page should show. */
  activate(id) {
    return this.enqueue(async () => {
      this.store.setActive(typeof id === 'string' ? id.trim() : '')
      this.store.save()
      return this.store.activeId
    })
  }
}

// --- summary / service ------------------------------------------------------

/** Strip a source to the four contracted Summary fields. */
function publicSource(source) {
  const raw = isRecord(source) ? source : {}
  const baseUrl = normalizeBaseUrl(raw.baseUrl) || DEFAULT_BASE_URL
  return {
    baseUrl,
    usageUrl: usageUrl(baseUrl),
    keyRef: typeof raw.keyRef === 'string' ? raw.keyRef : DEFAULT_KEY_ENV,
    keyHint: typeof raw.keyHint === 'string' ? raw.keyHint : '…',
  }
}

/** The account fields the client may see; never the key. */
function publicAccount(account) {
  const raw = isRecord(account) ? account : {}
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : DEFAULT_ACCOUNT_ID,
    label: typeof raw.label === 'string' ? raw.label : '',
    keyRef: typeof raw.keyRef === 'string' ? raw.keyRef : DEFAULT_KEY_ENV,
    keyHint: typeof raw.keyHint === 'string' ? raw.keyHint : '…',
    isDefault: raw.isDefault === true,
  }
}

/** Defensive copy of the stored source (its `apiKey` stays internal). */
function sanitizeSource(source) {
  const raw = isRecord(source) ? source : {}
  const baseUrl = normalizeBaseUrl(raw.baseUrl) || DEFAULT_BASE_URL
  const apiKey = normalizeSecret(raw.apiKey)
  const sanitized = {
    baseUrl,
    usageUrl: usageUrl(baseUrl),
    keyRef: isEnvName(raw.keyRef) ? raw.keyRef.trim() : DEFAULT_KEY_ENV,
    keyHint: typeof raw.keyHint === 'string' && raw.keyHint !== '' ? raw.keyHint : maskKey(apiKey),
  }
  // Keep the secret available to the fetcher but out of JSON.stringify / logs.
  Object.defineProperty(sanitized, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return sanitized
}

/** Turn any thrown value into a contracted failure triple. */
function serviceError(error) {
  if (error instanceof UsageError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'network',
    message: 'OpenCode Go usage request failed: ' + errorMessage(error),
    details: {},
  }
}

/** Normalize `{ok:true,value}` / `{ok:false,error}` into what the service returns. */
function failure(code, message, details) {
  return {
    ok: false,
    error: {
      code: typeof code === 'string' && code !== '' ? code : 'error',
      message: typeof message === 'string' && message !== '' ? message : 'dsh-opencode-go-usage request failed',
      details: isRecord(details) ? details : {},
    },
  }
}

/** Force the two shapes `parseConnectionResponse` accepts. */
function normalizeResult(result) {
  if (isRecord(result) && result.ok === true) {
    if (result.value === undefined || result.value === null) {
      return failure('empty-result', 'dsh-opencode-go-usage produced no summary payload.')
    }
    return { ok: true, value: result.value }
  }
  const error = isRecord(result) && isRecord(result.error) ? result.error : {}
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'error'
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : code
  return {
    ok: false,
    error: {
      code,
      message,
      details: isRecord(error.details) ? error.details : {},
    },
  }
}

/**
 * Cache + stale + sampling state machine.
 *
 * `get` never rejects. `resolveSource` and `fetchImpl` are injected so tests
 * can run without credentials or a network.
 */
class UsageService {
  constructor(options = {}) {
    // Compatibility: older callers pass `resolveSource`; new ones pass
    // `resolveAccount`. Both end up as an account-shaped object.
    this.resolveAccount = typeof options.resolveAccount === 'function'
      ? options.resolveAccount
      : async () => {
          let source
          try {
            source = sanitizeSource(await (typeof options.resolveSource === 'function' ? options.resolveSource() : {}))
          } catch (error) {
            // The legacy seam treats an unreadable source as "no key" rather
            // than as a transport error; the account seam reports not-found.
            source = sanitizeSource({})
          }
          return {
            id: DEFAULT_ACCOUNT_ID,
            label: '',
            keyRef: source.keyRef,
            keyHint: source.keyHint,
            isDefault: true,
            apiKey: source.apiKey,
            baseUrl: source.baseUrl,
            usageUrl: source.usageUrl,
          }
        }
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    this.store = options.store || null
    this.cacheTtlMs = positiveNumber(options.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs)
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_CONFIG.timeoutMs)
    this.maxStaleMs = nonNegativeNumber(options.maxStaleMs, DEFAULT_CONFIG.maxStaleMs)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.log = typeof options.log === 'function' ? options.log : () => {}
    /** accountId -> { fetchedAt, windows } */
    this.last = new Map()
    /** accountId -> in-flight promise (single-flight per account) */
    this.inFlight = new Map()
    /** accountId -> generation; bumped when the key or the account changes. */
    this.epochs = new Map()
  }

  nowMs() {
    return clockMs(this.now)
  }

  /** Drop one account's cache and invalidate any in-flight result. */
  forget(id) {
    this.last.delete(id)
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1)
  }

  /** Seed the cache from a successful validation fetch (no sample written). */
  seed(id, windows, fetchedAt) {
    if (typeof id !== 'string' || id === '') return
    this.last.set(id, {
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : this.nowMs(),
      windows,
    })
  }

  /**
   * @param {{refresh?: boolean, accountId?: string}} [options]
   * @returns `{ok:true, value: Summary}` or `{ok:false, error}`.
   */
  async get(options) {
    const refresh = !!(options && options.refresh === true)
    const requestedId = options && typeof options.accountId === 'string' ? options.accountId.trim() : ''
    let account
    try {
      account = await this.resolveAccount(requestedId === '' ? undefined : requestedId)
    } catch (error) {
      const problem = serviceError(error)
      return failure(problem.code, redactText(problem.message), { ...problem.details })
    }
    const id = account.id
    if (this.inFlight.has(id)) return this.inFlight.get(id)
    const promise = this.load(account, refresh)
      .catch((error) => {
        const problem = serviceError(error)
        return failure(problem.code, redactText(problem.message, account.apiKey), { ...problem.details })
      })
      .finally(() => {
        if (this.inFlight.get(id) === promise) this.inFlight.delete(id)
      })
    this.inFlight.set(id, promise)
    return promise
  }

  async load(account, refresh) {
    const id = account.id

    // A missing key is a configuration error and outranks any cached value
    // (INTERFACES.md §6): the page must not pretend the numbers are live.
    if (account.apiKey === '') {
      this.log('account resolved without a key: id=' + id + ' ref=' + account.keyRef)
      return failure(
        'no-key',
        'No OpenCode Go API key is configured; set the DSH credential ' + account.keyRef + '.',
        { account: publicAccount(account), keyRef: account.keyRef, usageUrl: account.usageUrl },
      )
    }

    const now = this.nowMs()
    const last = this.last.get(id)
    if (!refresh && last !== undefined && now - last.fetchedAt < this.cacheTtlMs) {
      return {
        ok: true,
        value: this.summary({
          account,
          windows: last.windows,
          fetchedAt: last.fetchedAt,
          cached: true,
          stale: false,
          error: null,
          now,
        }),
      }
    }

    const epoch = this.epochs.get(id) || 0
    const startedAt = Date.now()
    try {
      const fetched = await fetchGoUsage({
        baseUrl: account.baseUrl,
        apiKey: account.apiKey,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
      const fetchedAt = this.nowMs()
      if ((this.epochs.get(id) || 0) !== epoch) {
        return failure('account-changed', 'The account changed while the request was in flight.', { account: publicAccount(account) })
      }
      this.last.set(id, { fetchedAt, windows: fetched.windows })
      this.appendSample(account, fetchedAt, fetched.windows)
      this.log(
        'upstream ok: id=' + id + ' status=' + fetched.status + ' in ' + (Date.now() - startedAt)
          + 'ms url=' + account.usageUrl,
      )
      return {
        ok: true,
        value: this.summary({
          account,
          windows: fetched.windows,
          fetchedAt,
          cached: false,
          stale: false,
          error: null,
          now: this.nowMs(),
        }),
      }
    } catch (error) {
      const problem = serviceError(error)
      // A transport error can echo request context; strip the key regardless.
      const message = redactText(problem.message, account.apiKey)
      this.log(
        'upstream failed: id=' + id + ' code=' + problem.code + ' in ' + (Date.now() - startedAt)
          + 'ms url=' + account.usageUrl,
        account.apiKey,
      )
      const failedAt = this.nowMs()
      const stale = this.last.get(id)
      if (stale !== undefined && failedAt - stale.fetchedAt <= this.maxStaleMs) {
        return {
          ok: true,
          value: this.summary({
            account,
            windows: stale.windows,
            fetchedAt: stale.fetchedAt,
            cached: true,
            stale: true,
            error: { code: problem.code, message },
            now: failedAt,
          }),
        }
      }
      return failure(problem.code, message, {
        ...problem.details,
        account: publicAccount(account),
        usageUrl: account.usageUrl,
      })
    }
  }

  /**
   * Only a successful upstream read appends a sample, and only when all three
   * windows carry a finite percent. A partial 200 response must never invent a
   * zero line in the trail or the forecast (INTERFACES.md §7).
   */
  appendSample(account, fetchedAt, windows) {
    if (this.store === null || typeof this.store.append !== 'function') return
    const point = { t: fetchedAt }
    for (const key of WINDOW_KEYS) {
      const value = isRecord(windows) && isRecord(windows[key]) ? windows[key].percent : null
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      point[key] = value
    }
    try {
      this.store.append(account.id, point, keyFingerprint(account.apiKey))
    } catch (error) {
      this.log('sample append failed: ' + errorMessage(error))
    }
  }

  /** Build the frozen Summary shape (INTERFACES.md §6). */
  summary(input) {
    const now = input.now
    const account = input.account
    let samples = []
    if (this.store !== null && typeof this.store.list === 'function') {
      try {
        samples = sanitizeSamples(this.store.list(account.id, keyFingerprint(account.apiKey)))
      } catch (error) {
        this.log('sample read failed: ' + errorMessage(error))
        samples = []
      }
    }
    const error = isRecord(input.error)
      ? {
          code: typeof input.error.code === 'string' && input.error.code !== '' ? input.error.code : 'error',
          message: typeof input.error.message === 'string' ? input.error.message : '',
        }
      : null
    return {
      fetchedAt: Number.isFinite(input.fetchedAt) ? input.fetchedAt : now,
      cached: input.cached === true,
      stale: input.stale === true,
      error,
      source: publicSource(account),
      account: publicAccount(account),
      windows: windowsAt(input.windows, now),
      samples,
      sampledSince: samples.length > 0 ? samples[0].t : null,
    }
  }
}

// --- RPC --------------------------------------------------------------------

/** A raw throw converted to the contracted failure triple, without echoing secrets. */
function failureFromError(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== ''
    ? error.code
    : 'error'
  return failure(code, errorMessage(error), error !== null && typeof error === 'object' ? error.details : {})
}

/**
 * Map an endpoint name to the service; unknown names stay explicit failures.
 * Accepts the old bare `UsageService` as well as `{usage, accounts, samples}`.
 */
function createDispatch(services) {
  const bundle = services !== null && typeof services === 'object' && typeof services.get === 'function'
    ? { usage: services }
    : (isRecord(services) ? services : {})
  const usage = bundle.usage
  const accounts = bundle.accounts
  const samples = bundle.samples

  return async function dispatch(endpoint, payload) {
    const input = isRecord(payload) ? payload : {}
    try {
      if (endpoint === 'summary' || endpoint === 'refresh') {
        if (usage === undefined || typeof usage.get !== 'function') {
          return failure('error', 'dsh-opencode-go-usage host half is not applied')
        }
        const request = { refresh: endpoint === 'refresh' }
        if (input.accountId !== undefined && input.accountId !== null && input.accountId !== '') {
          request.accountId = normalizeAccountId(input.accountId)
        }
        return await usage.get(request)
      }

      if (endpoint === 'accounts.list') {
        if (accounts === undefined) return failure('error', 'Account support is not available')
        return { ok: true, value: await accounts.list() }
      }

      if (endpoint === 'accounts.activate') {
        if (accounts === undefined) return failure('error', 'Account support is not available')
        await accounts.activate(input.id)
        return { ok: true, value: await accounts.list() }
      }

      if (endpoint === 'accounts.remove') {
        if (accounts === undefined || samples === undefined) {
          return failure('error', 'Account support is not available')
        }
        const removed = await accounts.remove(input.id)
        usage.forget(removed.id)
        if (typeof samples.drop === 'function') samples.drop(removed.id)
        return { ok: true, value: await accounts.list() }
      }

      if (endpoint === 'accounts.add') {
        if (accounts === undefined) return failure('error', 'Account support is not available')
        const result = await accounts.add(input)
        const list = await accounts.list()
        let summary = null
        if (result.windows !== null && result.windows !== undefined) {
          usage.seed(result.account.id, result.windows, result.fetchedAt)
          const got = await usage.get({ refresh: false, accountId: result.account.id })
          if (got.ok === true) summary = got.value
        }
        return {
          ok: true,
          value: { accounts: list.accounts, activeId: list.activeId, summary, warning: result.warning },
        }
      }

      if (endpoint === 'accounts.update') {
        if (accounts === undefined || samples === undefined) {
          return failure('error', 'Account support is not available')
        }
        const result = await accounts.update(input)
        const id = typeof input.id === 'string' ? input.id.trim() : ''
        if (result.changedKey) {
          usage.forget(id)
          if (typeof samples.drop === 'function') samples.drop(id)
        }
        if (result.windows !== null && result.windows !== undefined) {
          usage.seed(id, result.windows, result.fetchedAt)
        }
        const list = await accounts.list()
        let summary = null
        if (result.windows !== null && result.windows !== undefined) {
          const got = await usage.get({ refresh: false, accountId: id })
          if (got.ok === true) summary = got.value
        }
        return {
          ok: true,
          value: { accounts: list.accounts, activeId: list.activeId, summary, warning: result.warning },
        }
      }

      return failure(
        'unknown-endpoint',
        'unknown dsh-opencode-go-usage endpoint: ' + String(endpoint),
        { endpoint: typeof endpoint === 'string' ? endpoint : '' },
      )
    } catch (error) {
      return failureFromError(error)
    }
  }
}

/** Accept `default` or `acc-xxxxxxxx`; anything else is a not-found. */
function normalizeAccountId(value) {
  if (typeof value !== 'string') {
    throw new UsageError('account-not-found', 'Invalid account id.', { id: '' })
  }
  const id = value.trim()
  if (id === DEFAULT_ACCOUNT_ID || ACCOUNT_ID_PATTERN.test(id)) return id
  throw new UsageError('account-not-found', 'Unknown account: ' + id, { id })
}

/** A JSON Response that itself cannot throw out of the RPC seam. */
function jsonResponse(envelope) {
  try {
    return Response.json(envelope)
  } catch (error) {
    log('failed to serialize RPC response: ' + errorMessage(error))
    const rpcId = isRecord(envelope) && typeof envelope.rpcId === 'string'
      ? envelope.rpcId
      : 'invalid-request'
    const fallback = {
      type: 'server-response',
      rpcId,
      result: failure('serialization-failed', 'dsh-opencode-go-usage could not serialize its response.'),
    }
    try {
      return Response.json(fallback)
    } catch (_ignored) {
      return new Response(JSON.stringify(fallback), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}

/**
 * Decode one Fetch-carried RPC request into the shared server-response
 * envelope. Never throws: every failure becomes the contracted failure shape
 * (`{code, message, details:{}}`), which the browser framework requires.
 */
async function handleRequest(request, dispatch = currentDispatch) {
  let body = null
  try {
    body = await request.json()
  } catch (_ignored) {
    body = null
  }
  const rpcId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
  const envelopeOk = isRecord(body)
    && body.type === 'client-request'
    && body.method === RPC_ENDPOINT
    && isRecord(body.payload)

  let result
  if (!envelopeOk) {
    result = failure('bad-request', 'invalid dsh-opencode-go-usage request')
  } else if (typeof dispatch !== 'function') {
    result = failure('error', 'dsh-opencode-go-usage host half is not applied')
  } else {
    const endpoint = body.payload.endpoint
    const payload = isRecord(body.payload.payload) ? body.payload.payload : {}
    try {
      result = await dispatch(endpoint, payload)
    } catch (error) {
      result = failureFromError(error)
    }
  }

  return jsonResponse({
    type: 'server-response',
    rpcId,
    result: normalizeResult(result),
  })
}

/** The function registered on `connection.fetch`. */
function handleApiRequest(request) {
  return handleRequest(request, currentDispatch)
}

// --- apply ------------------------------------------------------------------

/** Fill config defaults without silently accepting a bad credential reference. */
function normalizeConfig(raw) {
  const input = isRecord(raw) ? raw : {}
  return {
    enabled: input.enabled !== false,
    apiBaseUrl: firstString(input.apiBaseUrl, input.baseUrl) || undefined,
    apiKeyEnv: isEnvName(input.apiKeyEnv) ? input.apiKeyEnv.trim() : DEFAULT_KEY_ENV,
    cacheTtlMs: positiveNumber(input.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs),
    timeoutMs: positiveNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    maxStaleMs: nonNegativeNumber(input.maxStaleMs, DEFAULT_CONFIG.maxStaleMs),
    sampleRetentionMs: nonNegativeNumber(input.sampleRetentionMs, DEFAULT_CONFIG.sampleRetentionMs),
    maxSamples: positiveInteger(input.maxSamples, DEFAULT_CONFIG.maxSamples),
  }
}

/** Run a registration through Cordis' `ctx.effect`, or directly in tests. */
function useEffect(ctx, factory, label) {
  const run = () => {
    try {
      return factory()
    } catch (error) {
      log('effect "' + label + '" failed: ' + errorMessage(error))
      return () => {}
    }
  }
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(run, PKG + ': ' + label)
      return
    } catch (error) {
      log('ctx.effect "' + label + '" failed: ' + errorMessage(error))
    }
  }
  run()
}

/** Exported plugin entry point. Never throws into the host. */
export function apply(ctx, config) {
  try {
    applyPlugin(ctx, config)
  } catch (error) {
    log('apply threw: ' + errorMessage(error))
  }
}

function applyPlugin(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    log('apply: disabled by config')
    return
  }

  const home = dshHome()
  const store = new SampleStore({
    home,
    retentionMs: settings.sampleRetentionMs,
    maxSamples: settings.maxSamples,
  })
  const accountStore = new AccountStore({ home })
  const accountService = new AccountService({
    ctx,
    config: settings,
    store: accountStore,
    fetchImpl: globalThis.fetch,
    timeoutMs: settings.timeoutMs,
    now: Date.now,
    log,
  })
  const service = new UsageService({
    resolveAccount: (accountId) => accountService.resolveAccount(accountId),
    fetchImpl: globalThis.fetch,
    store,
    cacheTtlMs: settings.cacheTtlMs,
    timeoutMs: settings.timeoutMs,
    maxStaleMs: settings.maxStaleMs,
    log,
  })
  const dispatch = createDispatch({ usage: service, accounts: accountService, samples: store })
  currentDispatch = dispatch

  const connection = serviceOf(ctx, 'connection')
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    log('apply: connection.fetch.register is unavailable; RPC route not mounted')
  } else {
    useEffect(ctx, () => connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handleApiRequest,
    }), 'rpc route')
  }

  useEffect(ctx, () => () => {
    if (currentDispatch === dispatch) currentDispatch = undefined
    log('apply: disposed')
  }, 'cleanup')

  log(
    'apply: host half ready (ttl=' + settings.cacheTtlMs + 'ms timeout=' + settings.timeoutMs
      + 'ms samples=' + store.file + ' accounts=' + accountStore.file + ')',
  )
}

export const __internals = Object.freeze({
  PKG,
  RPC_ENDPOINT,
  RPC_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_KEY_ENV,
  DEFAULT_CONFIG,
  WINDOW_KEYS,
  WINDOW_LABELS,
  LOG_PATH,
  maskKey,
  originOf,
  normalizeBaseUrl,
  usageUrl,
  clampPercent,
  resetInSecOf,
  normalizeUsage,
  isEnvName,
  resolveSource,
  resolveBaseUrl,
  secretForRef,
  fetchGoUsage,
  UsageError,
  SampleStore,
  sampleFilePath,
  dshHome,
  UsageService,
  DEFAULT_ACCOUNT_ID,
  MAX_ACCOUNTS,
  normalizeApiKey,
  keyFingerprint,
  normalizeLabel,
  newAccountId,
  refForAccountId,
  normalizeAccountId,
  publicAccount,
  AccountStore,
  AccountService,
  accountFilePath,
  createDispatch,
  failure,
  normalizeResult,
  handleRequest,
  handleApiRequest,
  normalizeConfig,
  sanitizeSamples,
  sanitizeSource,
})
