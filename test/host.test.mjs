/**
 * Host-half unit tests for dsh-opencode-go-usage.
 *
 * Everything is local: no credentials are read from the real vault, no request
 * leaves the process, and `fetch` is always injected. The suite covers the
 * frozen INTERFACES.md shapes plus the RPC envelope the browser framework
 * actually accepts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name, __internals } from '../lib/host.js'

const {
  DEFAULT_BASE_URL,
  DEFAULT_CONFIG,
  DEFAULT_KEY_ENV,
  RPC_ENDPOINT,
  RPC_PATH,
  UsageError,
  UsageService,
  SampleStore,
  sampleFilePath,
  clampPercent,
  createDispatch,
  fetchGoUsage,
  handleApiRequest,
  handleRequest,
  isEnvName,
  maskKey,
  normalizeBaseUrl,
  normalizeResult,
  normalizeUsage,
  originOf,
  resolveSource,
  sanitizeSource,
  usageUrl,
} = __internals

/* ------------------------------------------------------------------ helpers */

const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const ISO = (ms) => new Date(ms).toISOString()
const SECRET = 'oc_sk_unit_test_secret_A1b2'
const KEY_REF = 'OPENCODE_GO_API_KEY'

const usageBody = (overrides = {}) => ({
  usage: {
    rolling: { status: 'ok', percent: 12.5, resetsAt: ISO(NOW + 6 * 3600 * 1000) },
    weekly: { status: 'ok', percent: 41, resetsAt: ISO(NOW + 5 * 24 * 3600 * 1000) },
    monthly: { status: 'ok', percent: 8.25, resetsAt: ISO(NOW + 11 * 24 * 3600 * 1000) },
    ...overrides,
  },
})

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-go-usage-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    assert.equal(typeof error.message, 'string')
    assert.ok(error.message.length > 0)
    return true
  })
}

/** Fake Cordis context with settings + credentials services. */
function fakeCtx(options = {}) {
  const settings = options.settings || {}
  const credentials = options.credentials || {}
  const resolved = []
  return {
    resolved,
    get(service) {
      if (service === 'settings') {
        return { get: (key) => settings[key] }
      }
      if (service === 'credentials') {
        return {
          async resolve(ref) {
            resolved.push(ref)
            if (options.credentialsThrow === true) throw new Error('credentials offline')
            if (Object.prototype.hasOwnProperty.call(credentials, ref)) {
              return { value: credentials[ref], source: 'file' }
            }
            return null
          },
        }
      }
      return undefined
    },
  }
}

function fakeSource(overrides = {}) {
  return {
    baseUrl: 'https://opencode.ai',
    usageUrl: 'https://opencode.ai/zen/go/v1/usage',
    keyRef: KEY_REF,
    keyHint: '…A1b2',
    apiKey: SECRET,
    ...overrides,
  }
}

/** A dispatch backed by a stub service, for envelope tests. */
function makeDispatchStub() {
  const calls = []
  const service = {
    async get(options) {
      calls.push(options)
      return {
        ok: true,
        value: {
          fetchedAt: NOW,
          cached: options.refresh !== true,
          stale: false,
          error: null,
          source: { baseUrl: DEFAULT_BASE_URL, usageUrl: usageUrl(DEFAULT_BASE_URL), keyRef: KEY_REF, keyHint: '…A1b2' },
          windows: normalizeUsage(usageBody(), NOW),
          samples: [],
          sampledSince: null,
        },
      }
    },
  }
  return { dispatch: createDispatch(service), calls }
}

function rpcRequest(payload) {
  return new Request('http://127.0.0.1:59978' + RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/* -------------------------------------------------------------- maskKey etc */

test('maskKey only exposes the last four characters', () => {
  assert.equal(maskKey(''), '…')
  assert.equal(maskKey('short'), '…')
  assert.equal(maskKey('1234567'), '…')
  assert.equal(maskKey('12345678'), '…5678')
  assert.equal(maskKey(SECRET), '…A1b2')
  assert.ok(!maskKey(SECRET).includes(SECRET))
})

test('originOf normalizes to http(s) origins only', () => {
  assert.equal(originOf('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai')
  assert.equal(originOf('https://opencode.ai:8443/proxy?x=1'), 'https://opencode.ai:8443')
  assert.equal(originOf('opencode.ai'), 'https://opencode.ai')
  assert.equal(originOf('  https://opencode.ai/  '), 'https://opencode.ai')
  assert.equal(originOf('ftp://opencode.ai'), '')
  assert.equal(originOf(''), '')
  assert.equal(originOf(null), '')
})

test('normalizeBaseUrl keeps the path and drops only trailing slash/query/hash', () => {
  assert.equal(normalizeBaseUrl('https://opencode.ai'), 'https://opencode.ai')
  assert.equal(normalizeBaseUrl('https://opencode.ai/'), 'https://opencode.ai')
  assert.equal(normalizeBaseUrl('  https://opencode.ai/zen/go/v1/  '), 'https://opencode.ai/zen/go/v1')
  assert.equal(normalizeBaseUrl('https://proxy.example/api/'), 'https://proxy.example/api')
  assert.equal(normalizeBaseUrl('https://proxy.example/api//'), 'https://proxy.example/api')
  assert.equal(normalizeBaseUrl('https://proxy.example/api/?token=1#frag'), 'https://proxy.example/api')
  assert.equal(normalizeBaseUrl('opencode.ai/api'), 'https://opencode.ai/api')
  assert.equal(normalizeBaseUrl('https://opencode.ai:8443/proxy?x=1'), 'https://opencode.ai:8443/proxy')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/zen/go/v1'), 'http://127.0.0.1:8787/zen/go/v1')
  assert.equal(normalizeBaseUrl('ftp://opencode.ai/proxy'), '')
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl(null), '')
})

test('usageUrl appends /zen/go/v1/usage and keeps a configured proxy path', () => {
  assert.equal(usageUrl('https://opencode.ai'), 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(usageUrl('https://opencode.ai/'), 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(usageUrl('https://opencode.ai/zen/go/v1'), 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(usageUrl('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai/zen/go/v1/usage')
  // INTERFACES.md §4: an enterprise proxy/mirror prefix must survive.
  assert.equal(usageUrl('https://proxy.example/api'), 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(usageUrl('https://proxy.example/api/'), 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(usageUrl('https://proxy.example/api/zen/go/v1'), 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(usageUrl('https://proxy.example/api/?token=1#frag'), 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(usageUrl('https://opencode.ai/custom/path'), 'https://opencode.ai/custom/path/zen/go/v1/usage')
  // Idempotent once the base already is the full usage URL.
  assert.equal(usageUrl('https://proxy.example/api/zen/go/v1/usage'), 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(usageUrl('http://127.0.0.1:8787/zen/go/v1'), 'http://127.0.0.1:8787/zen/go/v1/usage')
  assert.equal(usageUrl(''), DEFAULT_BASE_URL + '/zen/go/v1/usage')
})

/* ----------------------------------------------------------- normalizeUsage */

test('normalizeUsage keeps raw finite percents and parses resetAt', () => {
  const windows = normalizeUsage(usageBody({
    weekly: { status: 'warning', percent: 128.5, resetsAt: ISO(NOW + 24 * 3600 * 1000) },
  }), NOW)

  assert.deepEqual(Object.keys(windows), ['rolling', 'weekly', 'monthly'])
  assert.equal(windows.rolling.key, 'rolling')
  assert.equal(windows.rolling.label, '5h')
  assert.equal(windows.weekly.label, 'weekly')
  assert.equal(windows.monthly.label, 'monthly')
  assert.equal(windows.rolling.status, 'ok')
  assert.equal(windows.rolling.percent, 12.5)
  assert.equal(windows.rolling.resetInSec, 6 * 3600)
  // The Host does not clamp: the Client draws the saturation warning.
  assert.equal(windows.weekly.percent, 128.5)
  assert.equal(windows.weekly.status, 'warning')
})

test('normalizeUsage tolerates missing windows and bad fields', () => {
  const missing = normalizeUsage({}, NOW)
  for (const key of ['rolling', 'weekly', 'monthly']) {
    assert.deepEqual(missing[key], {
      key,
      label: key === 'rolling' ? '5h' : key,
      status: 'unknown',
      percent: null,
      resetAt: '',
      resetInSec: 0,
    })
  }

  const broken = normalizeUsage({
    usage: {
      rolling: { status: 'ok', percent: '42', resetsAt: 12345 },
      weekly: { status: 7, percent: Number.NaN, resetsAt: 'not-a-date' },
      monthly: { status: '', percent: Infinity },
    },
  }, NOW)

  // A missing/non-finite percent is unknown, never a synthetic 0%.
  assert.equal(broken.rolling.percent, null)
  assert.equal(broken.rolling.status, 'ok')
  assert.equal(broken.rolling.resetAt, '')
  assert.equal(broken.rolling.resetInSec, 0)
  assert.equal(broken.weekly.percent, null)
  assert.equal(broken.weekly.status, 'unknown')
  // INTERFACES.md §3: an unparseable string is preserved, countdown becomes 0.
  assert.equal(broken.weekly.resetAt, 'not-a-date')
  assert.equal(broken.weekly.resetInSec, 0)
  assert.equal(broken.monthly.percent, null)
  assert.equal(broken.monthly.status, 'unknown')
  assert.equal(broken.monthly.resetAt, '')
})

test('normalizeUsage keeps a finite percent even when the status is missing', () => {
  const win = normalizeUsage({ usage: { rolling: { percent: 42 } } }, NOW)
  assert.equal(win.rolling.percent, 42)
  assert.equal(win.rolling.status, 'ok')

  // A partial 200 response must stay unknown for the missing windows.
  const partial = normalizeUsage({ usage: { rolling: { status: 'ok', percent: 12.5 } } }, NOW)
  assert.equal(partial.rolling.percent, 12.5)
  assert.equal(partial.weekly.percent, null)
  assert.equal(partial.weekly.status, 'unknown')
})

test('normalizeUsage clamps countdown at zero for past resets', () => {
  const win = normalizeUsage({ usage: { rolling: { percent: 1, resetsAt: ISO(NOW - 60_000) } } }, NOW)
  assert.equal(win.rolling.resetInSec, 0)
})

test('clampPercent is the drawing helper', () => {
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(0), 0)
  assert.equal(clampPercent(42.5), 42.5)
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(Infinity), 0)
  assert.equal(clampPercent('7'), 7)
})

test('isEnvName accepts POSIX identifiers only', () => {
  assert.equal(isEnvName('OPENCODE_GO_API_KEY'), true)
  assert.equal(isEnvName('_private'), true)
  assert.equal(isEnvName('9LEADING'), false)
  assert.equal(isEnvName('has-dash'), false)
  assert.equal(isEnvName('has space'), false)
  assert.equal(isEnvName(''), false)
  assert.equal(isEnvName(42), false)
})

/* ------------------------------------------------------------- resolveSource */

test('resolveSource reads opencode-go apiKeyEnv, baseURL and credentials', async () => {
  const ctx = fakeCtx({
    settings: {
      'llm-pi-ai': {
        providers: {
          'opencode-go': {
            apiKeyEnv: 'OPENCODE_GO_TEAM_KEY',
            baseURL: 'https://opencode.ai/zen/go/v1/',
          },
        },
      },
      'llm-deepseek': {
        providers: { 'opencode-go': { baseURL: 'https://deepseek.invalid' } },
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    },
    credentials: { OPENCODE_GO_TEAM_KEY: 'oc_sk_team_secret_A1b2' },
  })

  const source = await resolveSource(ctx, {})
  assert.equal(source.keyRef, 'OPENCODE_GO_TEAM_KEY')
  assert.equal(source.apiKey, 'oc_sk_team_secret_A1b2')
  assert.equal(source.keyHint, '…A1b2')
  // INTERFACES.md §4: the provider baseURL keeps its path, minus the trailing slash.
  assert.equal(source.baseUrl, 'https://opencode.ai/zen/go/v1')
  assert.equal(source.usageUrl, 'https://opencode.ai/zen/go/v1/usage')
  assert.deepEqual(ctx.resolved, ['OPENCODE_GO_TEAM_KEY'])
  // The DeepSeek credential must never be consulted.
  assert.ok(!ctx.resolved.includes('DEEPSEEK_API_KEY'))
  // The key must not be enumerable, so accidental serialization cannot leak it.
  assert.equal(JSON.stringify(source).includes(source.apiKey), false)
})

test('resolveSource prefers config, validates the reference and falls back', async () => {
  const ctx = fakeCtx({
    settings: {
      'llm-pi-ai': {
        providers: {
          'opencode-go': {
            apiKeyEnv: 'PROVIDER_KEY',
            baseURL: 'https://provider.example/zen/go/v1',
          },
        },
      },
    },
    credentials: {
      CUSTOM_KEY: 'oc_sk_custom_ABCD',
      PROVIDER_KEY: 'oc_sk_provider_EFGH',
    },
  })

  const custom = await resolveSource(ctx, {
    apiKeyEnv: 'CUSTOM_KEY',
    apiBaseUrl: 'http://127.0.0.1:8787/some/path/',
  })
  assert.equal(custom.keyRef, 'CUSTOM_KEY')
  assert.equal(custom.apiKey, 'oc_sk_custom_ABCD')
  assert.equal(custom.keyHint, '…ABCD')
  // The proxy path must survive; only the trailing slash is normalized.
  assert.equal(custom.baseUrl, 'http://127.0.0.1:8787/some/path')
  assert.equal(custom.usageUrl, 'http://127.0.0.1:8787/some/path/zen/go/v1/usage')

  // Invalid config reference is ignored; the provider reference wins.
  const invalid = await resolveSource(ctx, { apiKeyEnv: '../NOT_A_REF' })
  assert.equal(invalid.keyRef, 'PROVIDER_KEY')
  assert.equal(invalid.apiKey, 'oc_sk_provider_EFGH')

  // README compatibility: `baseUrl` is accepted as an alias for `apiBaseUrl`.
  const alias = await resolveSource(ctx, { baseUrl: 'https://alias.example' })
  assert.equal(alias.baseUrl, 'https://alias.example')
})

test('resolveSource falls back from credentials to the environment', async (t) => {
  const envName = 'DSH_TEST_OPENCODE_KEY'
  const previous = process.env[envName]
  t.after(() => {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
  })
  process.env[envName] = 'oc_sk_from_env_1234'

  const empty = await resolveSource(fakeCtx({ credentials: { [envName]: '' } }), { apiKeyEnv: envName })
  assert.equal(empty.apiKey, 'oc_sk_from_env_1234')

  const offline = await resolveSource(
    fakeCtx({ credentialsThrow: true }),
    { apiKeyEnv: envName },
  )
  assert.equal(offline.apiKey, 'oc_sk_from_env_1234')
  assert.equal(offline.keyHint, '…1234')
})

test('resolveSource never reads llm-deepseek.apiKeyEnv', async (t) => {
  const prevGo = process.env[KEY_REF]
  const prevDeepseek = process.env.DEEPSEEK_API_KEY
  delete process.env[KEY_REF]
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-must-not-be-used'
  t.after(() => {
    if (prevGo === undefined) delete process.env[KEY_REF]
    else process.env[KEY_REF] = prevGo
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevDeepseek
  })

  const ctx = fakeCtx({
    settings: {
      'llm-pi-ai': { providers: {} },
      'llm-deepseek': {
        providers: { 'opencode-go': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://deepseek.invalid/proxy' } },
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    },
    credentials: { DEEPSEEK_API_KEY: 'sk-deepseek-must-not-be-used' },
  })

  const source = await resolveSource(ctx, {})
  assert.equal(source.keyRef, DEFAULT_KEY_ENV)
  assert.equal(source.apiKey, '')
  assert.equal(source.keyHint, '…')
  // The `providers['opencode-go'].baseURL` fallback is allowed; the credential
  // is not, and its path is preserved like any other base URL.
  assert.equal(source.baseUrl, 'https://deepseek.invalid/proxy')
  assert.equal(source.usageUrl, 'https://deepseek.invalid/proxy/zen/go/v1/usage')
  assert.ok(!ctx.resolved.includes('DEEPSEEK_API_KEY'))
})

test('resolveSource ignores a top-level llm-deepseek baseURL', async (t) => {
  const prevGo = process.env[KEY_REF]
  delete process.env[KEY_REF]
  t.after(() => {
    if (prevGo === undefined) delete process.env[KEY_REF]
    else process.env[KEY_REF] = prevGo
  })

  const ctx = fakeCtx({
    settings: {
      'llm-pi-ai': { providers: {} },
      // A top-level llm-deepseek.baseURL belongs to the DeepSeek API. Falling
      // back to it would send the OpenCode Go Bearer token to that host, so it
      // is deliberately not a permitted route (INTERFACES.md §4).
      'llm-deepseek': { baseURL: 'https://deepseek-base.example/zen/go/v1', providers: {} },
    },
    credentials: {},
  })
  const source = await resolveSource(ctx, {})
  assert.equal(source.baseUrl, DEFAULT_BASE_URL)
  assert.equal(source.usageUrl, DEFAULT_BASE_URL + '/zen/go/v1/usage')
})

test('resolveSource preserves a configured proxy path', async () => {
  const ctx = fakeCtx({
    settings: {
      'llm-pi-ai': { providers: { 'opencode-go': { baseURL: 'https://mirror.example/go/api/' } } },
    },
    credentials: { [KEY_REF]: SECRET },
  })

  const source = await resolveSource(ctx, {})
  assert.equal(source.keyRef, DEFAULT_KEY_ENV)
  assert.equal(source.apiKey, SECRET)
  assert.equal(source.baseUrl, 'https://mirror.example/go/api')
  assert.equal(source.usageUrl, 'https://mirror.example/go/api/zen/go/v1/usage')
})

test('resolveSource falls back to settings.describe() on the live service shape', async () => {
  const resolved = []
  const ctx = {
    get(service) {
      if (service === 'settings') {
        return {
          describe(options) {
            assert.deepEqual(options, { redactSecrets: true })
            return [{
              ns: 'llm-pi-ai',
              value: {
                providers: {
                  'opencode-go': {
                    apiKeyEnv: 'DESCRIBED_KEY',
                    baseURL: 'https://described.example/zen/go/v1',
                  },
                },
              },
            }]
          },
        }
      }
      if (service === 'credentials') {
        return {
          async resolve(ref) {
            resolved.push(ref)
            return ref === 'DESCRIBED_KEY' ? { value: 'oc_sk_described_1234' } : null
          },
        }
      }
      return undefined
    },
  }

  const source = await resolveSource(ctx, {})
  assert.equal(source.keyRef, 'DESCRIBED_KEY')
  assert.equal(source.apiKey, 'oc_sk_described_1234')
  assert.equal(source.baseUrl, 'https://described.example/zen/go/v1')
  assert.equal(source.usageUrl, 'https://described.example/zen/go/v1/usage')
  assert.deepEqual(resolved, ['DESCRIBED_KEY'])
})

test('resolveSource never throws when services are missing or broken', async () => {
  const source = await resolveSource(undefined, undefined)
  assert.equal(source.keyRef, DEFAULT_KEY_ENV)
  assert.equal(source.baseUrl, DEFAULT_BASE_URL)
  assert.equal(source.apiKey, '')

  const broken = {
    get() {
      throw new Error('service graph exploded')
    },
  }
  const source2 = await resolveSource(broken, {})
  assert.equal(source2.baseUrl, DEFAULT_BASE_URL)
  assert.equal(source2.apiKey, '')
})

/* --------------------------------------------------------------- fetchGoUsage */

test('fetchGoUsage sends exactly Authorization + Accept and normalizes 200', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(usageBody())
  }
  const result = await fetchGoUsage({
    baseUrl: 'https://opencode.ai/zen/go/v1/',
    apiKey: SECRET,
    timeoutMs: 1234,
    fetchImpl,
    now: () => NOW,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(calls[0].init.method, 'GET')
  assert.deepEqual(calls[0].init.headers, {
    Authorization: 'Bearer ' + SECRET,
    Accept: 'application/json',
  })
  assert.equal(Object.keys(calls[0].init.headers).length, 2)
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  assert.equal(result.status, 200)
  assert.equal(result.windows.rolling.percent, 12.5)
  assert.equal(result.windows.rolling.resetInSec, 6 * 3600)
  assert.ok(result.durationMs >= 0)
})

test('fetchGoUsage keeps a configured proxy path in the request URL', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    return jsonResponse(usageBody())
  }

  const nested = await fetchGoUsage({
    baseUrl: 'https://proxy.example/api/zen/go/v1/',
    apiKey: SECRET,
    fetchImpl,
    now: () => NOW,
  })
  assert.equal(urls[0], 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(nested.url, urls[0])

  await fetchGoUsage({
    baseUrl: 'https://proxy.example/api',
    apiKey: SECRET,
    fetchImpl,
    now: () => NOW,
  })
  assert.equal(urls[1], 'https://proxy.example/api/zen/go/v1/usage')

  // The origin is normalized only as a transport detail, never as a path drop.
  await fetchGoUsage({
    baseUrl: 'proxy.example/api/',
    apiKey: SECRET,
    fetchImpl,
    now: () => NOW,
  })
  assert.equal(urls[2], 'https://proxy.example/api/zen/go/v1/usage')
})

test('fetchGoUsage maps 401/403 to unauthorized', async () => {
  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => new Response('', { status: 401 }),
  }), 'unauthorized')
  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => new Response('', { status: 403 }),
  }), 'unauthorized')
})

test('fetchGoUsage maps other non-2xx to upstream', async () => {
  for (const status of [429, 500, 502, 503]) {
    await rejectsWithCode(fetchGoUsage({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: SECRET,
      fetchImpl: async () => new Response('', { status }),
    }), 'upstream')
  }
})

test('fetchGoUsage maps malformed JSON and shape to bad-response', async () => {
  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => new Response('<html>oops</html>', { status: 200 }),
  }), 'bad-response')

  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({ ok: true }),
  }), 'bad-response')

  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({ usage: [] }),
  }), 'bad-response')

  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse(null),
  }), 'bad-response')
})

test('fetchGoUsage maps transport failures and timeouts to network', async () => {
  const connect = new TypeError('fetch failed')
  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    fetchImpl: async () => { throw connect },
  }), 'network')

  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  await assert.rejects(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: SECRET,
    timeoutMs: 25,
    fetchImpl: async () => { throw timeout },
  }), (error) => {
    assert.equal(error.code, 'network')
    assert.match(error.message, /timed out/)
    return true
  })
})

test('fetchGoUsage refuses to send an empty key', async () => {
  await rejectsWithCode(fetchGoUsage({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('must not be called')
    },
  }), 'no-key')
})

test('fetchGoUsage error messages never contain the key', async () => {
  try {
    await fetchGoUsage({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: SECRET,
      fetchImpl: async () => new Response('', { status: 401 }),
    })
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.code, 'unauthorized')
    assert.ok(!String(error.message).includes(SECRET))
  }
})

test('UsageService redacts a transport error that echoes the key', async () => {
  const service = new UsageService({
    resolveSource: async () => fakeSource(),
    fetchImpl: async () => { throw new TypeError('bad header value: Bearer ' + SECRET) },
    store: null,
    now: () => 1_800_000_000_000,
    log: () => {},
  })
  const result = await service.get()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'network')
  assert.ok(!result.error.message.includes(SECRET))
  assert.match(result.error.message, /\[redacted\]/)
})

/* ----------------------------------------------------------------- SampleStore */

test('SampleStore appends, dedupes within 30s and persists atomically', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'opencode-go-usage', 'samples.json')
  let clock = 1_800_000_000_000
  const store = new SampleStore({ file, now: () => clock })

  store.append({ t: clock, rolling: 1, weekly: 2, monthly: 3 })
  assert.equal(store.list().length, 1)

  clock += 10_000
  store.append({ t: clock, rolling: 4, weekly: 5, monthly: 6 })
  assert.equal(store.list().length, 1)
  assert.deepEqual(store.list()[0], { t: clock, rolling: 4, weekly: 5, monthly: 6 })

  clock += 30_000
  store.append({ t: clock, rolling: 7, weekly: 8, monthly: 9 })
  assert.equal(store.list().length, 2)

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.samples.length, 2)
  assert.deepEqual(onDisk.samples, store.list())

  const reloaded = new SampleStore({ file, now: () => clock })
  assert.deepEqual(reloaded.list(), store.list())
})

test('SampleStore trims old points and caps the trail', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'samples.json')
  const now = 1_800_000_000_000

  writeFileSync(file, JSON.stringify({
    version: 1,
    updatedAt: now,
    samples: [
      { t: now - 8 * 24 * 3600 * 1000, rolling: 1, weekly: 1, monthly: 1 },
      { t: now - 60_000, rolling: 2, weekly: 2, monthly: 2 },
    ],
  }))
  const trimmed = new SampleStore({ file, now: () => now })
  assert.deepEqual(trimmed.list().map((point) => point.rolling), [2])

  let clock = now
  const capped = new SampleStore({ file: join(dir, 'capped.json'), now: () => clock, maxSamples: 3 })
  for (let index = 0; index < 5; index += 1) {
    capped.append({ t: clock, rolling: index, weekly: index, monthly: index })
    clock += 31_000
  }
  const points = capped.list()
  assert.equal(points.length, 3)
  assert.deepEqual(points.map((point) => point.rolling), [2, 3, 4])
})

test('SampleStore recovers from a corrupt file and survives IO failure', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'samples.json')
  writeFileSync(file, '{ not json')
  const store = new SampleStore({ file, now: () => 1_800_000_000_000 })
  assert.deepEqual(store.list(), [])
  const rewritten = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(rewritten.version, 1)
  assert.deepEqual(rewritten.samples, [])

  // A file where a directory is required: both load and save must stay silent.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const broken = new SampleStore({ file: join(blocker, 'samples.json') })
  assert.doesNotThrow(() => broken.append({ t: 1_800_000_000_000, rolling: 1, weekly: 2, monthly: 3 }))
  assert.equal(broken.list().length, 1)

  // list() must be a copy.
  const copy = broken.list()
  copy.push({ t: 1, rolling: 0, weekly: 0, monthly: 0 })
  assert.equal(broken.list().length, 1)
})

test('sampleFilePath honours DSH_HOME shape', () => {
  const path = sampleFilePath('C:/tmp/dsh-home')
  assert.ok(path.endsWith(join('opencode-go-usage', 'samples.json')))
})

/* ----------------------------------------------------------------- UsageService */

function makeServiceHarness(t, options = {}) {
  const dir = tempDir(t)
  let clock = 1_800_000_000_000
  const calls = []
  let behavior = options.behavior || 'ok'
  const source = fakeSource(options.source)
  const store = options.store === false ? null : new SampleStore({
    file: join(dir, 'samples.json'),
    now: () => clock,
  })
  const service = new UsageService({
    resolveSource: options.resolveSource || (async () => ({ ...source })),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (behavior === 'network') throw new TypeError('fetch failed')
      if (behavior === 'unauthorized') return new Response('', { status: 401 })
      return jsonResponse(options.body || usageBody())
    },
    store,
    cacheTtlMs: options.cacheTtlMs,
    timeoutMs: options.timeoutMs,
    maxStaleMs: options.maxStaleMs,
    now: () => clock,
    log: () => {},
  })
  return {
    service,
    store,
    calls,
    source,
    advance: (ms) => { clock += ms },
    setBehavior: (next) => { behavior = next },
    get clock() { return clock },
  }
}

test('UsageService caches for the TTL and refresh bypasses it', async (t) => {
  const harness = makeServiceHarness(t)
  const first = await harness.service.get()
  assert.equal(first.ok, true)
  assert.equal(first.value.cached, false)
  assert.equal(first.value.stale, false)
  assert.equal(first.value.error, null)
  assert.equal(first.value.fetchedAt, harness.clock)
  assert.equal(harness.calls.length, 1)

  harness.advance(29_999)
  const second = await harness.service.get()
  assert.equal(second.ok, true)
  assert.equal(second.value.cached, true)
  assert.equal(second.value.stale, false)
  assert.equal(second.value.fetchedAt, first.value.fetchedAt)
  assert.equal(harness.calls.length, 1)

  harness.advance(1)
  const third = await harness.service.get()
  assert.equal(third.value.cached, false)
  assert.equal(harness.calls.length, 2)

  const fourth = await harness.service.get({ refresh: true })
  assert.equal(fourth.value.cached, false)
  assert.equal(harness.calls.length, 3)
})

test('UsageService builds the frozen Summary shape', async (t) => {
  const harness = makeServiceHarness(t)
  const result = await harness.service.get()
  const summary = result.value
  assert.deepEqual(
    Object.keys(summary).sort(),
    ['cached', 'error', 'fetchedAt', 'sampledSince', 'samples', 'source', 'stale', 'windows'],
  )
  assert.deepEqual(Object.keys(summary.source).sort(), ['baseUrl', 'keyHint', 'keyRef', 'usageUrl'])
  assert.deepEqual(Object.keys(summary.windows), ['rolling', 'weekly', 'monthly'])
  for (const key of ['rolling', 'weekly', 'monthly']) {
    assert.equal(summary.windows[key].key, key)
    assert.equal(typeof summary.windows[key].percent, 'number')
    assert.equal(typeof summary.windows[key].resetInSec, 'number')
    assert.equal(typeof summary.windows[key].resetAt, 'string')
    assert.equal(typeof summary.windows[key].status, 'string')
  }
  assert.equal(summary.windows.rolling.label, '5h')
  assert.equal(summary.samples.length, 1)
  assert.equal(summary.sampledSince, summary.samples[0].t)
  assert.deepEqual(Object.keys(summary.samples[0]).sort(), ['monthly', 'rolling', 't', 'weekly'])
})

test('UsageService samples once per success and dedupes within 30s', async (t) => {
  const harness = makeServiceHarness(t)
  await harness.service.get()
  assert.equal(harness.store.list().length, 1)

  harness.advance(10_000)
  await harness.service.get({ refresh: true })
  assert.equal(harness.store.list().length, 1)
  assert.equal(harness.store.list()[0].t, harness.clock)

  harness.advance(40_000)
  await harness.service.get({ refresh: true })
  assert.equal(harness.store.list().length, 2)
})

test('UsageService never samples a partial response', async (t) => {
  const harness = makeServiceHarness(t, {
    body: { usage: { rolling: { status: 'ok', percent: 12.5 } } },
  })
  const result = await harness.service.get()
  assert.equal(result.ok, true)
  assert.equal(result.value.windows.rolling.percent, 12.5)
  assert.equal(result.value.windows.weekly.percent, null)
  assert.equal(result.value.windows.monthly.percent, null)
  // A partial 200 must not invent a zero line in the 7-day trail.
  assert.equal(harness.store.list().length, 0)
})

test('sanitizeSource keeps apiKey out of enumeration and JSON', () => {
  const source = sanitizeSource({
    baseUrl: 'https://opencode.ai',
    keyRef: 'OPENCODE_GO_API_KEY',
    keyHint: '…abcd',
    apiKey: 'sk-secret-value',
  })
  assert.equal(source.apiKey, 'sk-secret-value')
  assert.equal(Object.keys(source).includes('apiKey'), false)
  assert.equal(JSON.stringify(source).includes('sk-secret-value'), false)
})

test('UsageService returns a stale Summary when a later fetch fails', async (t) => {
  const harness = makeServiceHarness(t)
  const first = await harness.service.get()
  const samplesBefore = harness.store.list()

  harness.advance(31_000)
  harness.setBehavior('network')
  const stale = await harness.service.get()

  assert.equal(stale.ok, true)
  assert.equal(stale.value.stale, true)
  assert.equal(stale.value.cached, true)
  assert.equal(stale.value.error.code, 'network')
  assert.equal(typeof stale.value.error.message, 'string')
  assert.equal(stale.value.fetchedAt, first.value.fetchedAt)
  assert.deepEqual(stale.value.windows, first.value.windows)
  // Failed reads must not pollute the trail.
  assert.deepEqual(harness.store.list(), samplesBefore)
})

test('UsageService fails when there is no cached value', async (t) => {
  const harness = makeServiceHarness(t)
  harness.setBehavior('network')
  const result = await harness.service.get()
  assert.equal(result.ok, false)
  assert.equal(result.value, undefined)
  assert.equal(result.error.code, 'network')
  assert.equal(typeof result.error.message, 'string')
  assert.equal(typeof result.error.details, 'object')
})

test('UsageService stops serving stale data after six hours', async (t) => {
  const harness = makeServiceHarness(t)
  await harness.service.get()
  harness.advance(6 * 60 * 60 * 1000 + 1)
  harness.setBehavior('network')
  const result = await harness.service.get()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'network')
})

test('UsageService reports unauthorized/upstream through the Summary or failure', async (t) => {
  const harness = makeServiceHarness(t)
  await harness.service.get()
  harness.advance(31_000)
  harness.setBehavior('unauthorized')
  const stale = await harness.service.get()
  assert.equal(stale.ok, true)
  assert.equal(stale.value.stale, true)
  assert.equal(stale.value.error.code, 'unauthorized')

  const cold = makeServiceHarness(t)
  cold.setBehavior('unauthorized')
  const failed = await cold.service.get()
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'unauthorized')
})

test('UsageService returns no-key even when a fresh cache exists', async (t) => {
  const harness = makeServiceHarness(t)
  await harness.service.get()
  harness.source.apiKey = ''
  const result = await harness.service.get()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'no-key')
  assert.equal(result.error.details.keyRef, KEY_REF)
  assert.equal(harness.calls.length, 1)
})

test('UsageService merges concurrent calls into one upstream request', async (t) => {
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  let calls = 0
  let clock = 1_800_000_000_000
  const service = new UsageService({
    resolveSource: async () => fakeSource(),
    fetchImpl: async () => {
      calls += 1
      await gate
      return jsonResponse(usageBody())
    },
    store: null,
    now: () => clock,
    log: () => {},
  })

  const first = service.get({ refresh: true })
  const second = service.get({ refresh: true })
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(left, right)
  assert.equal(left.ok, true)
})

test('UsageService does not throw when source resolution throws', async (t) => {
  const service = new UsageService({
    resolveSource: async () => { throw new Error('settings unavailable') },
    fetchImpl: async () => jsonResponse(usageBody()),
    store: null,
    now: () => 1_800_000_000_000,
    log: () => {},
  })
  const result = await service.get()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'no-key')
})

test('UsageService keeps the proxy path in the request URL and the Summary', async (t) => {
  const harness = makeServiceHarness(t, {
    source: {
      baseUrl: 'https://proxy.example/api',
      usageUrl: 'https://proxy.example/api/zen/go/v1/usage',
    },
  })
  const result = await harness.service.get()
  assert.equal(result.ok, true)
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].url, 'https://proxy.example/api/zen/go/v1/usage')
  assert.equal(result.value.source.baseUrl, 'https://proxy.example/api')
  assert.equal(result.value.source.usageUrl, 'https://proxy.example/api/zen/go/v1/usage')
})

/* ---------------------------------------------------------------- RPC envelope */

test('handleRequest answers the contracted success envelope', async () => {
  const { dispatch, calls } = makeDispatchStub()
  const request = rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-summary-1',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary', payload: {} },
  })
  const response = await handleRequest(request, dispatch)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const body = await response.json()

  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'rpc-summary-1')
  assert.deepEqual(Object.keys(body.result).sort(), ['ok', 'value'])
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.cached, true)
  assert.equal(body.result.value.windows.rolling.percent, 12.5)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { refresh: false })
})

test('handleRequest returns unknown-endpoint as a shaped failure', async () => {
  const { dispatch } = makeDispatchStub()
  const response = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-unknown-1',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'not-a-real-endpoint' },
  }), dispatch)
  const body = await response.json()

  assert.equal(body.rpcId, 'rpc-unknown-1')
  assert.deepEqual(Object.keys(body.result).sort(), ['error', 'ok'])
  assert.equal(body.result.ok, false)
  assert.deepEqual(Object.keys(body.result.error).sort(), ['code', 'details', 'message'])
  assert.equal(body.result.error.code, 'unknown-endpoint')
  assert.equal(typeof body.result.error.message, 'string')
  assert.equal(typeof body.result.error.details, 'object')
  assert.equal(body.result.error.details.endpoint, 'not-a-real-endpoint')
})

test('handleRequest rejects a broken envelope without throwing', async () => {
  const { dispatch } = makeDispatchStub()
  const cases = [
    { type: 'server-response', rpcId: 'x', method: RPC_ENDPOINT, payload: { endpoint: 'summary' } },
    { type: 'client-request', rpcId: 'x', method: 'other/call', payload: { endpoint: 'summary' } },
    { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: null },
    { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT },
  ]
  for (const payload of cases) {
    const response = await handleRequest(rpcRequest(payload), dispatch)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'bad-request')
    assert.equal(typeof body.result.error.message, 'string')
    assert.equal(typeof body.result.error.details, 'object')
  }

  const malformed = await handleRequest(new Request('http://127.0.0.1:59978' + RPC_PATH, {
    method: 'POST',
    body: 'not json',
  }), dispatch)
  const malformedBody = await malformed.json()
  assert.equal(malformedBody.rpcId, 'invalid-request')
  assert.equal(malformedBody.result.error.code, 'bad-request')
})

test('handleRequest converts dispatch throws and malformed results to failures', async () => {
  const throwing = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-throw',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary' },
  }), async () => { throw new Error('boom') })
  const thrownBody = await throwing.json()
  assert.equal(thrownBody.result.ok, false)
  assert.equal(thrownBody.result.error.code, 'error')
  assert.match(thrownBody.result.error.message, /boom/)

  const empty = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-empty',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary' },
  }), async () => ({ ok: true }))
  const emptyBody = await empty.json()
  assert.equal(emptyBody.result.ok, false)
  assert.equal(emptyBody.result.error.code, 'empty-result')

  const bare = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-bare',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary' },
  }), async () => ({ ok: false, error: { code: 'weird' } }))
  const bareBody = await bare.json()
  assert.equal(bareBody.result.ok, false)
  assert.equal(bareBody.result.error.code, 'weird')
  assert.equal(bareBody.result.error.message, 'weird')
  assert.deepEqual(bareBody.result.error.details, {})
})

test('handleRequest tolerates missing endpoint and malformed payload value', async () => {
  const { dispatch } = makeDispatchStub()
  const noEndpoint = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-no-endpoint',
    method: RPC_ENDPOINT,
    payload: { payload: {} },
  }), dispatch)
  const noEndpointBody = await noEndpoint.json()
  assert.equal(noEndpointBody.result.error.code, 'unknown-endpoint')

  const scalarPayload = await handleRequest(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-scalar-payload',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary', payload: 'ignored' },
  }), dispatch)
  const scalarPayloadBody = await scalarPayload.json()
  assert.equal(scalarPayloadBody.result.ok, true)
})

/* --------------------------------------------------------------------- apply */

test('apply registers the Fetch route and answers no-key without network', async (t) => {
  const dir = tempDir(t)
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env[KEY_REF]
  process.env.DSH_HOME = dir
  delete process.env[KEY_REF]
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env[KEY_REF]
    else process.env[KEY_REF] = previousKey
  })

  let registered = null
  const disposers = []
  const ctx = {
    get(service) {
      if (service === 'connection') {
        return {
          fetch: {
            register(options) {
              registered = options
              return () => { registered = null }
            },
          },
        }
      }
      if (service === 'settings') return { get: () => undefined }
      if (service === 'credentials') return { resolve: async () => null }
      return undefined
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }

  apply(ctx, {})
  assert.ok(registered, 'route must be registered')
  assert.equal(registered.path, RPC_PATH)
  assert.deepEqual(registered.methods, ['POST'])
  assert.equal(registered.requestBody, 'buffered')
  assert.equal(registered.fetch, handleApiRequest)

  const response = await registered.fetch(rpcRequest({
    type: 'client-request',
    rpcId: 'rpc-apply',
    method: RPC_ENDPOINT,
    payload: { endpoint: 'summary', payload: {} },
  }))
  const body = await response.json()
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'no-key')
  assert.equal(body.result.error.details.keyRef, KEY_REF)

  // Dispose in reverse order (cleanup last registered first would be LIFO in Cordis).
  for (const dispose of disposers.reverse()) dispose()
})

test('apply does nothing when disabled', () => {
  let registered = null
  const ctx = {
    get(service) {
      if (service === 'connection') {
        return { fetch: { register(options) { registered = options; return () => {} } } }
      }
      return undefined
    },
    effect() {},
  }
  apply(ctx, { enabled: false })
  assert.equal(registered, null)
})

test('module identity matches the contract', () => {
  assert.equal(name, 'dsh-opencode-go-usage')
  assert.deepEqual(inject, ['connection'])
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.equal(DEFAULT_CONFIG.apiKeyEnv, 'OPENCODE_GO_API_KEY')
  assert.equal(DEFAULT_CONFIG.cacheTtlMs, 30_000)
  assert.equal(DEFAULT_CONFIG.timeoutMs, 15_000)
  assert.equal(RPC_ENDPOINT, 'dsh-opencode-go-usage/call')
  assert.equal(RPC_PATH, '/api/dsh-opencode-go-usage/call')
  assert.equal(normalizeResult({ ok: true, value: 0 }).ok, true)
  assert.equal(normalizeResult({ ok: false }).error.details.constructor, Object)
  assert.equal(typeof UsageError, 'function')
})
