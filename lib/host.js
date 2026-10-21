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
// 7 days at the 60 s client cadence is 10,080 points; cap the file there so the
// UI's fixed "last 7 days" domain is always backed by the full trail.
const MAX_SAMPLES = 10_080
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
async function resolveSource(ctx, config) {
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

  const baseUrl = normalizeBaseUrl(firstString(
    cfg.apiBaseUrl,
    cfg.baseUrl,
    isRecord(opencodeGo) ? opencodeGo.baseURL : undefined,
    isRecord(deepseekGo) ? deepseekGo.baseURL : undefined,
  )) || DEFAULT_BASE_URL

  const configuredRef = isEnvName(cfg.apiKeyEnv) ? cfg.apiKeyEnv.trim() : ''
  const providerRef = isRecord(opencodeGo) && isEnvName(opencodeGo.apiKeyEnv)
    ? opencodeGo.apiKeyEnv.trim()
    : ''
  const keyRef = configuredRef !== '' ? configuredRef : providerRef !== '' ? providerRef : DEFAULT_KEY_ENV

  let apiKey = ''
  try {
    const credentials = serviceOf(ctx, 'credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      apiKey = secretOf(await credentials.resolve(keyRef))
    }
  } catch (_ignored) {
    apiKey = ''
  }
  if (apiKey === '' && isEnvName(keyRef)) {
    try {
      apiKey = normalizeSecret(process.env[keyRef])
    } catch (_ignored) {
      apiKey = ''
    }
  }

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
    this.samples = []
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
      this.samples = []
      return
    }

    let list = null
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
      else if (isRecord(parsed) && Array.isArray(parsed.samples)) list = parsed.samples
    } catch (_ignored) {
      list = null
    }
    if (list === null) {
      this.samples = []
      this.save()
      return
    }
    this.samples = sanitizeSamples(list)
    this.trim(clockMs(this.now))
  }

  list() {
    return this.samples.map((sample) => ({ ...sample }))
  }

  /** Dedupe (<30 s replaces the tail), trim and persist one point. */
  append(sample) {
    const now = clockMs(this.now)
    const at = Number.isFinite(Number(sample && sample.t)) ? Math.round(Number(sample.t)) : now
    const point = { t: at }
    for (const key of WINDOW_KEYS) {
      const value = Number(sample && sample[key])
      point[key] = Number.isFinite(value) ? value : 0
    }

    const lastIndex = this.samples.length - 1
    const last = lastIndex >= 0 ? this.samples[lastIndex] : null
    if (last !== null && point.t <= last.t) {
      // Clock skew or an immediate repeat: keep the trail ascending.
      point.t = last.t
      this.samples[lastIndex] = point
    } else if (last !== null && point.t - last.t < SAMPLE_DEDUPE_MS) {
      this.samples[lastIndex] = point
    } else {
      this.samples.push(point)
    }

    this.trim(now)
    this.save()
    return { ...point }
  }

  trim(now) {
    const cutoff = now - this.retentionMs
    this.samples = this.samples.filter((sample) => sample.t >= cutoff)
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - this.maxSamples)
    }
  }

  save() {
    const tmp = this.file + '.tmp.' + process.pid
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({
        version: 1,
        updatedAt: clockMs(this.now),
        samples: this.samples,
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
    this.resolveSource = typeof options.resolveSource === 'function'
      ? options.resolveSource
      : async () => ({})
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    this.store = options.store || null
    this.cacheTtlMs = positiveNumber(options.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs)
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_CONFIG.timeoutMs)
    this.maxStaleMs = nonNegativeNumber(options.maxStaleMs, DEFAULT_CONFIG.maxStaleMs)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.last = null
    this.inFlight = null
  }

  nowMs() {
    return clockMs(this.now)
  }

  /**
   * @param {{refresh?: boolean}} [options]
   * @returns `{ok:true, value: Summary}` or `{ok:false, error}`.
   */
  get(options) {
    const refresh = !!(options && options.refresh === true)
    if (this.inFlight !== null) return this.inFlight
    const promise = this.load(refresh)
      .catch((error) => failure('error', errorMessage(error)))
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null
      })
    this.inFlight = promise
    return promise
  }

  async load(refresh) {
    let source
    try {
      source = sanitizeSource(await this.resolveSource())
    } catch (error) {
      this.log('source resolution failed: ' + errorMessage(error))
      source = sanitizeSource({})
    }

    // A missing key is a configuration error and outranks any cached value
    // (INTERFACES.md §6): the page must not pretend the numbers are live.
    if (source.apiKey === '') {
      const result = failure(
        'no-key',
        'No OpenCode Go API key is configured; set the DSH credential ' + source.keyRef + '.',
        { keyRef: source.keyRef, usageUrl: source.usageUrl },
      )
      this.log('source resolved without a key: ref=' + source.keyRef)
      return result
    }

    const now = this.nowMs()
    if (!refresh && this.last !== null && now - this.last.fetchedAt < this.cacheTtlMs) {
      return {
        ok: true,
        value: this.summary({
          windows: this.last.windows,
          fetchedAt: this.last.fetchedAt,
          cached: true,
          stale: false,
          error: null,
          source,
          now,
        }),
      }
    }

    const startedAt = Date.now()
    try {
      const fetched = await fetchGoUsage({
        baseUrl: source.baseUrl,
        apiKey: source.apiKey,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
      const fetchedAt = this.nowMs()
      this.last = { fetchedAt, windows: fetched.windows }
      this.appendSample(fetchedAt, fetched.windows)
      this.log(
        'upstream ok: status=' + fetched.status + ' in ' + (Date.now() - startedAt)
          + 'ms url=' + source.usageUrl,
      )
      return {
        ok: true,
        value: this.summary({
          windows: fetched.windows,
          fetchedAt,
          cached: false,
          stale: false,
          error: null,
          source,
          now: this.nowMs(),
        }),
      }
    } catch (error) {
      const problem = serviceError(error)
      // A transport error can echo request context; strip the key regardless.
      const message = redactText(problem.message, source.apiKey)
      this.log(
        'upstream failed: code=' + problem.code + ' in ' + (Date.now() - startedAt)
          + 'ms url=' + source.usageUrl,
        source.apiKey,
      )
      const failedAt = this.nowMs()
      if (this.last !== null && failedAt - this.last.fetchedAt <= this.maxStaleMs) {
        return {
          ok: true,
          value: this.summary({
            windows: this.last.windows,
            fetchedAt: this.last.fetchedAt,
            cached: true,
            stale: true,
            error: { code: problem.code, message },
            source,
            now: failedAt,
          }),
        }
      }
      return failure(problem.code, message, {
        ...problem.details,
        usageUrl: source.usageUrl,
      })
    }
  }

  /**
   * Only a successful upstream read appends a sample, and only when all three
   * windows carry a finite percent. A partial 200 response must never invent a
   * zero line in the trail or the forecast (INTERFACES.md §7).
   */
  appendSample(fetchedAt, windows) {
    if (this.store === null || typeof this.store.append !== 'function') return
    const point = { t: fetchedAt }
    for (const key of WINDOW_KEYS) {
      const value = isRecord(windows) && isRecord(windows[key]) ? windows[key].percent : null
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      point[key] = value
    }
    try {
      this.store.append(point)
    } catch (error) {
      this.log('sample append failed: ' + errorMessage(error))
    }
  }

  /** Build the frozen Summary shape (INTERFACES.md §6). */
  summary(input) {
    const now = input.now
    let samples = []
    if (this.store !== null && typeof this.store.list === 'function') {
      try {
        samples = sanitizeSamples(this.store.list())
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
      source: publicSource(input.source),
      windows: windowsAt(input.windows, now),
      samples,
      sampledSince: samples.length > 0 ? samples[0].t : null,
    }
  }
}

// --- RPC --------------------------------------------------------------------

/** Map an endpoint name to the service; unknown names stay explicit failures. */
function createDispatch(service) {
  return async function dispatch(endpoint, payload) {
    if (endpoint === 'summary') {
      void payload
      return service.get({ refresh: false })
    }
    if (endpoint === 'refresh') {
      void payload
      return service.get({ refresh: true })
    }
    return failure(
      'unknown-endpoint',
      'unknown dsh-opencode-go-usage endpoint: ' + String(endpoint),
      { endpoint: typeof endpoint === 'string' ? endpoint : '' },
    )
  }
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
      result = failure('error', errorMessage(error))
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

  const store = new SampleStore({
    home: dshHome(),
    retentionMs: settings.sampleRetentionMs,
    maxSamples: settings.maxSamples,
  })
  const service = new UsageService({
    resolveSource: () => resolveSource(ctx, settings),
    fetchImpl: globalThis.fetch,
    store,
    cacheTtlMs: settings.cacheTtlMs,
    timeoutMs: settings.timeoutMs,
    maxStaleMs: settings.maxStaleMs,
    log,
  })
  const dispatch = createDispatch(service)
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
      + 'ms samples=' + store.file + ')',
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
  fetchGoUsage,
  UsageError,
  SampleStore,
  sampleFilePath,
  dshHome,
  UsageService,
  createDispatch,
  failure,
  normalizeResult,
  handleRequest,
  handleApiRequest,
  normalizeConfig,
  sanitizeSamples,
  sanitizeSource,
})
