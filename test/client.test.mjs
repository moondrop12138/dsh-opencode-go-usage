/**
 * Client-half tests for `dsh-opencode-go-usage`.
 *
 * No DOM and no jsdom: the browser module is executed with a fake `window`
 * module loader, a recording `React.createElement`, and a fake client context.
 * Everything under test is pure or has an explicit seam in `__internals`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')

let captured = null
const loadedIds = []
const elements = []

const fakeReact = {
  createElement(type, props, ...children) {
    const element = { type, props: props === null || props === undefined ? {} : props, children }
    elements.push(element)
    return element
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value === undefined ? null : value }
  },
}

const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

new Function('window', SOURCE)(windowStub)

assert.ok(captured !== null, 'client module must call window.__ModuleLoader__.load')
const exported = captured.factory((id) => {
  loadedIds.push(id)
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
})
const internals = exported.__internals

/** Translator over one bundled dictionary, mirroring the preview's helper. */
function makeTranslator(lang) {
  const dictionary = lang === 'en' ? internals.dictionaries.en : internals.dictionaries.zh
  return (key, vars) => {
    const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
    if (vars === undefined || vars === null) return template
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ))
  }
}

/** Walk a fake element tree, calling `visit(element, text)` for each node. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') {
    visit(null, node)
    return
  }
  if (node.type === undefined) return
  if (typeof node.type === 'function') {
    walk(node.type({ ...node.props, children: node.children }), visit)
    return
  }
  visit(node, null)
  for (const child of node.children) walk(child, visit)
}

function textOf(node) {
  const out = []
  walk(node, (element, text) => {
    if (text !== null) out.push(String(text))
  })
  return out
}

function findByClass(node, className) {
  const found = []
  walk(node, (element) => {
    if (element !== null && typeof element.props.className === 'string'
      && element.props.className.split(/\s+/).includes(className)) {
      found.push(element)
    }
  })
  return found
}

function windowSet(overrides) {
  const base = {
    rolling: { key: 'rolling', label: '5h', status: 'ok', percent: 41, resetAt: '', resetInSec: 3600 },
    weekly: { key: 'weekly', label: 'weekly', status: 'ok', percent: 16, resetAt: '', resetInSec: 4 * 86400 },
    monthly: { key: 'monthly', label: 'monthly', status: 'ok', percent: 10, resetAt: '', resetInSec: 12 * 86400 },
  }
  return ['rolling', 'weekly', 'monthly'].map((key) => (
    overrides !== null && overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : base[key]
  ))
}

const UNKNOWN_WINDOW = { key: 'weekly', label: 'weekly', status: 'unknown', percent: null, resetAt: '', resetInSec: 0 }

test('module format: stable id, react-only require, inject/apply/__internals', () => {
  assert.equal(captured.id, 'dsh-opencode-go-usage')
  assert.deepEqual(loadedIds, ['react'])
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
  for (const key of [
    'formatCountdown',
    'formatPercent',
    'forecast',
    'sampleSlope',
    'arcPath',
    'tickMarks',
    'downsample',
    'normalizeResult',
    'callHost',
    'windowLabel',
    'sortWindows',
    'readSummary',
    'readWindows',
    'readSamples',
    'Dial',
    'Legend',
    'ForecastCard',
    'HorizonCard',
    'TrailCard',
    'QuotaPage',
    'PanelIcon',
    'PAGE_CSS',
  ]) {
    assert.ok(internals[key] !== undefined, 'missing __internals.' + key)
  }
  assert.equal(typeof internals.QuotaPage, 'function')
  assert.equal(typeof internals.PanelIcon, 'function')
  assert.equal(typeof internals.PAGE_CSS, 'string')
  assert.ok(internals.PAGE_CSS.length > 2000)
})

test('locale dictionaries: zh/en key sets match and wording follows the contract', () => {
  const { zh, en } = internals.dictionaries
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.equal(zh['meta.lang'], 'zh')
  assert.equal(en['meta.lang'], 'en')
  assert.equal(zh['panel'], 'OpenCode Go 用量')
  assert.equal(zh['title'], '额度观测窗')
  assert.equal(en['title'], 'Quota window')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', 'zh.' + key + ' must be a string')
    assert.equal(typeof en[key], 'string', 'en.' + key + ' must be a string')
    assert.ok(zh[key].trim() !== '', 'zh.' + key + ' must not be empty')
    assert.ok(en[key].trim() !== '', 'en.' + key + ' must not be empty')
  }
  // The page reports used percents. The frozen contract forbids "剩余" wording.
  for (const key of zhKeys) {
    assert.ok(!zh[key].includes('剩余'), 'zh.' + key + ' must not say 剩余')
  }
  // The header subtitle and panel label are part of the frozen copy.
  assert.ok(zh['subtitle'].includes('60 秒采样'))
  assert.ok(en['subtitle'].includes('60 s sampling'))
})

test('install registers main + sidebar.panellist with the frozen contract values', async () => {
  const registrations = []
  const injections = []
  const effects = []
  const localeCalls = []
  const { zh } = internals.dictionaries
  const context = {
    effect(factory, label) {
      const dispose = factory()
      effects.push({ label, dispose })
      return dispose
    },
    get() {
      return undefined
    },
    locale: {
      register(namespace, dictionaries) {
        localeCalls.push([namespace, dictionaries])
        return () => {}
      },
      bind() {
        return (key) => Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key
      },
    },
    slots: {
      inject(name, factory) {
        injections.push(name)
        factory()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }

  exported.apply(context)

  assert.deepEqual(injections, ['main', 'sidebar.panellist'])
  assert.deepEqual(effects.map((entry) => entry.label), [
    'dsh-opencode-go-usage: styles',
    'dsh-opencode-go-usage: dictionaries',
  ])
  assert.ok(effects.every((entry) => typeof entry.dispose === 'function'))
  assert.equal(localeCalls.length, 1)
  assert.equal(localeCalls[0][0], 'opencode-go-usage')
  assert.deepEqual(localeCalls[0][1], internals.dictionaries)

  assert.equal(registrations.length, 2)
  const main = registrations[0]
  assert.deepEqual(main.spec, {
    name: 'main',
    key: 'opencode-go-usage',
    locale: 'opencode-go-usage',
    inject: main.spec.inject,
  })
  assert.equal(typeof main.spec.inject, 'function')
  assert.equal(main.component, internals.QuotaPage)
  const injected = main.spec.inject()
  assert.equal(typeof injected.requestSummary, 'function')
  assert.equal(typeof injected.requestRefresh, 'function')
  const unavailable = await injected.requestSummary()
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.error.code, 'host-unavailable')
  assert.equal(typeof unavailable.error.message, 'string')
  assert.equal(typeof unavailable.error.details, 'object')

  const sidebar = registrations[1]
  assert.equal(sidebar.spec.name, 'sidebar.panellist')
  assert.equal(sidebar.spec.id, 'opencode-go-usage')
  assert.equal(sidebar.spec.order, 30)
  assert.equal(sidebar.spec.locale, 'opencode-go-usage')
  assert.equal(sidebar.spec.label(), 'OpenCode Go 用量')
  assert.equal(sidebar.component, internals.PanelIcon)
})

test('locale registration falls back to the per-language form when the probe misses', () => {
  const calls = []
  const context = {
    effect(factory) { return factory() },
    locale: {
      register(namespace, ...rest) {
        calls.push([namespace, ...rest])
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject() {},
      register() { return () => {} },
    },
  }
  exported.apply(context)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], ['opencode-go-usage', internals.dictionaries])
  assert.equal(calls[1][0], 'opencode-go-usage')
  assert.equal(calls[1][1], 'zh')
  assert.equal(calls[2][1], 'en')
})

test('injected requests go through the frozen /api RPC envelope', async () => {
  const calls = []
  let mainSpec = null
  const context = {
    effect(factory) { return factory() },
    get(name) {
      assert.equal(name, 'connection')
      return {
        rpc: {
          call(base, endpoint, payload) {
            calls.push({ base, endpoint, payload })
            return Promise.resolve({ ok: true, value: { windows: {} } })
          },
        },
      }
    },
    locale: {
      register() { return () => {} },
      bind() { return (key) => key },
    },
    slots: {
      inject(name, factory) { factory() },
      register(spec) {
        if (spec.name === 'main') mainSpec = spec
        return () => {}
      },
    },
  }
  exported.apply(context)
  assert.ok(mainSpec !== null)
  const injected = mainSpec.inject()
  const summary = await injected.requestSummary()
  const refresh = await injected.requestRefresh()
  assert.equal(summary.ok, true)
  assert.equal(refresh.ok, true)
  assert.deepEqual(calls, [
    { base: '/api', endpoint: 'dsh-opencode-go-usage/call', payload: { endpoint: 'summary', payload: {} } },
    { base: '/api', endpoint: 'dsh-opencode-go-usage/call', payload: { endpoint: 'refresh', payload: {} } },
  ])
})

test('formatCountdown: zh/en units, zero, unknown', () => {
  assert.equal(internals.formatCountdown(3661, 'zh'), '1 时 01 分 01 秒')
  assert.equal(internals.formatCountdown(3661, 'en'), '1h 01m 01s')
  assert.equal(internals.formatCountdown(90061, 'zh'), '1 天 01 时 01 分 01 秒')
  assert.equal(internals.formatCountdown(90061, 'en'), '1d 01h 01m 01s')
  assert.equal(internals.formatCountdown(86400, 'zh'), '1 天 00 时 00 分 00 秒')
  assert.equal(internals.formatCountdown(45, 'zh'), '45 秒')
  assert.equal(internals.formatCountdown(5, 'zh'), '5 秒')
  assert.equal(internals.formatCountdown(0, 'zh'), '0 秒')
  assert.equal(internals.formatCountdown(0, 'en'), '0s')
  assert.equal(internals.formatCountdown(-1, 'zh'), '—')
  assert.equal(internals.formatCountdown(Number.NaN, 'en'), '—')
  assert.equal(internals.formatCountdown(undefined, 'zh'), '—')
  assert.equal(internals.formatCountdown('nope', 'zh'), '—')
})

test('formatPercent: one decimal by default, exact digits, unknown is never 0%', () => {
  assert.equal(internals.formatPercent(41, 1), '41.0%')
  assert.equal(internals.formatPercent(8.25, 2), '8.25%')
  assert.equal(internals.formatPercent(8.25), '8.3%')
  assert.equal(internals.formatPercent(112.4), '112.4%')
  assert.equal(internals.formatPercent(0, 0), '0%')
  assert.equal(internals.formatPercent(-5), '0.0%')
  assert.equal(internals.formatPercent(Number.NaN), '—')
  assert.equal(internals.formatPercent(Number.POSITIVE_INFINITY), '—')
  assert.equal(internals.formatPercent(undefined), '—')
  assert.equal(internals.formatPercent(null), '—')
  assert.equal(internals.formatPercent(''), '—')
  assert.equal(internals.formatPercent('nope'), '—')
})

test('forecast: no samples or one sample means no projection, never a fake extrapolation', () => {
  const now = 1_700_000_000_000
  const hour = 3600_000
  const base = { key: 'rolling', percent: 40, resetInSec: 10000 }
  const options = { periodSec: 18000, now, samples: [] }

  const none = internals.forecast(base, options)
  assert.equal(none.sampleCount, 0)
  assert.equal(none.slopePerSec, null)
  assert.equal(none.projected, null)
  assert.equal(none.known, false)
  assert.equal(none.etaSec, null)
  assert.equal(none.elapsedFrac, (18000 - 10000) / 18000, 'horizon progress still works without samples')
  assert.equal(none.horizonKnown, true)

  const one = internals.forecast(base, {
    ...options,
    samples: [{ t: now - hour, rolling: 30, weekly: 10, monthly: 5 }],
  })
  assert.equal(one.sampleCount, 1)
  assert.equal(one.sampleSpanSec, 0)
  assert.equal(one.slopePerSec, null)
  assert.equal(one.projected, null)
  assert.equal(one.known, false)
})

test('forecast: projected percent and ETA come from the recent sample slope', () => {
  const now = 1_700_000_000_000
  const hour = 3600_000
  const samples = [
    { t: now - 3 * hour, rolling: 30, weekly: 10, monthly: 5 },
    { t: now - 2 * hour, rolling: 33, weekly: 10, monthly: 5 },
    { t: now - hour, rolling: 36, weekly: 10, monthly: 5 },
    { t: now, rolling: 40, weekly: 10, monthly: 5 },
  ]
  const rising = internals.forecast({ key: 'rolling', percent: 40, resetInSec: 10000 }, {
    periodSec: 18000,
    samples,
    now,
  })
  assert.equal(rising.sampleCount, 4)
  assert.equal(rising.sampleSpanSec, 10800)
  assert.ok(rising.slopePerSec > 0.0008 && rising.slopePerSec < 0.001, String(rising.slopePerSec))
  assert.ok(Math.abs(rising.projected - (40 + rising.slopePerSec * 10000)) < 1e-9)
  assert.ok(rising.projected > 40 && rising.projected < 100)
  assert.equal(rising.etaSec, null, 'it will not hit the cap before the reset')

  const steep = internals.forecast({ key: 'weekly', percent: 60, resetInSec: 36000 }, {
    periodSec: 604800,
    now,
    samples: [
      { t: now - hour, rolling: 0, weekly: 40, monthly: 0 },
      { t: now, rolling: 0, weekly: 60, monthly: 0 },
    ],
  })
  assert.ok(Math.abs(steep.slopePerSec - 20 / 3600) < 1e-9)
  assert.ok(Math.abs(steep.projected - 260) < 1e-6)
  assert.ok(Math.abs(steep.etaSec - 7200) < 1e-6)
  assert.equal(steep.capped, false)

  const flat = internals.forecast({ key: 'monthly', percent: 10, resetInSec: 12 * 86400 }, {
    periodSec: 30 * 86400,
    now,
    samples: [{ t: now - hour, rolling: 0, weekly: 0, monthly: 10 }, { t: now, rolling: 0, weekly: 0, monthly: 10 }],
  })
  assert.equal(flat.projected, 10, 'a flat trail projects the current percent')

  const idle = internals.forecast({ key: 'monthly', percent: 0, resetInSec: 12 * 86400 }, {
    periodSec: 30 * 86400,
    now,
    samples: [{ t: now - hour, monthly: 0 }, { t: now, monthly: 0 }],
  })
  assert.equal(idle.projected, 0)
  assert.equal(idle.idle, true)
})

test('forecast: a one-minute two-sample window is not a usable pace', () => {
  const now = 1_700_000_000_000
  const short = internals.forecast({ key: 'weekly', percent: 22, resetInSec: 5 * 86400 }, {
    periodSec: 7 * 86400,
    now,
    samples: [
      { t: now - 60_000, weekly: 21 },
      { t: now, weekly: 22 },
    ],
  })
  assert.equal(short.sampleCount, 2)
  assert.equal(short.sampleSpanSec, 60)
  assert.equal(short.slopePerSec, null, 'a 60s blip is not a slope')
  assert.equal(short.projected, null)
  assert.equal(short.known, false)

  const absurd = internals.forecast({ key: 'weekly', percent: 60, resetInSec: 6 * 86400 }, {
    periodSec: 7 * 86400,
    now,
    samples: [
      { t: now - 3600_000, weekly: 40 },
      { t: now, weekly: 60 },
    ],
  })
  assert.equal(absurd.beyond, true)
  assert.equal(absurd.projected, 300, 'very high pace is capped for display')
})

test('forecast: reset beyond the assumed period is unknown, not 100x percent', () => {
  const now = 1_700_000_000_000
  const hour = 3600_000
  const samples = [
    { t: now - 2 * hour, monthly: 8 },
    { t: now - hour, monthly: 9 },
    { t: now, monthly: 10 },
  ]
  const skewed = internals.forecast({ key: 'monthly', percent: 10, resetInSec: 31 * 86400 }, {
    periodSec: 30 * 86400,
    samples,
    now,
  })
  assert.equal(skewed.horizonKnown, false)
  assert.equal(skewed.elapsedFrac, null)
  assert.equal(skewed.projected, null)
  assert.equal(skewed.known, false)
  assert.equal(skewed.etaSec, null)

  // An unknown window has no percent to project from.
  const unknown = internals.forecast({ key: 'weekly', percent: null, resetInSec: 3600 }, {
    periodSec: 604800,
    samples: [{ t: now - hour, weekly: 1 }, { t: now, weekly: 2 }],
    now,
  })
  assert.equal(unknown.percent, null)
  assert.equal(unknown.projected, null)
  assert.equal(unknown.known, false)

  const capped = internals.forecast({ key: 'weekly', percent: 112, resetInSec: 600 }, {
    periodSec: 604800,
    samples: [{ t: now - hour, weekly: 100 }, { t: now, weekly: 112 }],
    now,
  })
  assert.equal(capped.capped, true)
  assert.equal(capped.projected, 112)
  assert.equal(capped.etaSec, null)

  const badPercent = internals.forecast({ key: 'weekly', percent: 'oops', resetInSec: 3600 }, {
    periodSec: 604800,
    samples: [{ t: now - hour, weekly: 1 }, { t: now, weekly: 2 }],
    now,
  })
  assert.equal(badPercent.percent, null)
  assert.equal(badPercent.projected, null)
})

test('forecast: sample window is the last 24 h and only the matching series is fitted', () => {
  const now = 1_700_000_000_000
  const hour = 3600_000
  const samples = [
    { t: now - 48 * hour, rolling: 10, weekly: 0, monthly: 0 },
    { t: now - 25 * hour, rolling: 20, weekly: 0, monthly: 0 },
    { t: now - 2 * hour, rolling: 30, weekly: 99, monthly: 99 },
    { t: now, rolling: 40, weekly: 99, monthly: 99 },
  ]
  const result = internals.forecast({ key: 'rolling', percent: 40, resetInSec: 3600 }, {
    periodSec: 18000,
    samples,
    now,
  })
  assert.equal(result.sampleCount, 2, 'samples older than 24 h are ignored')
  assert.equal(result.sampleSpanSec, 7200)
  assert.ok(Math.abs(result.slopePerSec - 10 / 7200) < 1e-9)

  const badPeriod = internals.forecast({ key: 'nope', percent: 10, resetInSec: 60 }, {
    periodSec: 0,
    samples: [],
    now,
  })
  assert.equal(badPeriod.horizonKnown, false)
  assert.equal(badPeriod.projected, null)
})

test('sampleSlope: least squares in percent per second, degenerate input is null', () => {
  const slope = internals.sampleSlope([{ t: 0, value: 0 }, { t: 1000, value: 2 }, { t: 2000, value: 4 }])
  assert.ok(Math.abs(slope - 2) < 1e-12, String(slope))
  assert.equal(internals.sampleSlope([]), null)
  assert.equal(internals.sampleSlope([{ t: 5, value: 1 }]), null)
  assert.equal(internals.sampleSlope([{ t: 5, value: 1 }, { t: 5, value: 2 }]), null)
})

test('normalizeResult: value wins, data fallback, failure envelope is always valid', () => {
  const value = { windows: {} }
  assert.deepEqual(internals.normalizeResult({ ok: true, value }), { ok: true, value })
  assert.deepEqual(internals.normalizeResult({ ok: true, data: value }), { ok: true, value })
  assert.deepEqual(internals.normalizeResult(value), { ok: true, value }, 'bare Summary accepted')

  const empty = internals.normalizeResult({ ok: true, value: null })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'bad-response')
  assert.ok(empty.error.message !== '')
  assert.deepEqual(empty.error.details, {})

  const noWindows = internals.normalizeResult({ ok: true, value: { fetchedAt: 1 } })
  assert.equal(noWindows.ok, false)
  assert.equal(noWindows.error.code, 'bad-response')

  const failed = internals.normalizeResult({
    ok: false,
    error: { code: 'network', message: 'offline', details: { status: 503 } },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'network')
  assert.equal(failed.error.message, 'offline')
  assert.deepEqual(failed.error.details, { status: 503 })

  const blank = internals.normalizeResult({ ok: false, error: {} })
  assert.equal(blank.error.code, 'error')
  assert.equal(blank.error.message, 'error')
  assert.deepEqual(blank.error.details, {})

  const badDetails = internals.normalizeResult({ ok: false, error: { code: 'x', message: 'y', details: 'nope' } })
  assert.deepEqual(badDetails.error.details, {})

  for (const input of [null, undefined, 3, 'nope', []]) {
    const outcome = internals.normalizeResult(input)
    assert.equal(outcome.ok, false)
    assert.equal(typeof outcome.error.code, 'string')
    assert.equal(typeof outcome.error.message, 'string')
    assert.equal(typeof outcome.error.details, 'object')
  }
})

test('callHost: unavailable host, success, and thrown rejection', async () => {
  const unavailable = await internals.callHost({ get: () => undefined }, 'summary', {})
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.error.code, 'host-unavailable')

  const summary = { windows: { rolling: { percent: 1 } } }
  const calls = []
  const okHost = {
    get(name) {
      assert.equal(name, 'connection')
      return {
        rpc: {
          call(...args) {
            calls.push(args)
            return Promise.resolve({ ok: true, value: summary })
          },
        },
      }
    },
  }
  const ok = await internals.callHost(okHost, 'summary', {})
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, summary)
  assert.deepEqual(calls[0], ['/api', 'dsh-opencode-go-usage/call', { endpoint: 'summary', payload: {} }])

  const badHost = {
    get() {
      return { rpc: { call() { throw new Error('socket closed') } } }
    },
  }
  const failed = await internals.callHost(badHost, 'refresh', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'rpc-failed')
  assert.ok(failed.error.message.includes('socket closed'))
})

test('downsample: keeps first/last, caps length, never mutates', () => {
  const sample = (t) => ({ t, rolling: 0, weekly: 0, monthly: 0 })
  const list = Array.from({ length: 48 }, (_, index) => sample(index))
  const reduced = internals.downsample(list, 24)
  assert.equal(reduced.length, 24)
  assert.equal(reduced[0].t, 0)
  assert.equal(reduced[23].t, 47)
  assert.equal(list.length, 48, 'input must not be mutated')

  const short = internals.downsample(list.slice(0, 5), 10)
  assert.equal(short.length, 5)
  assert.notEqual(short, list.slice(0, 5))

  const three = internals.downsample([0, 1, 2, 3, 4], 3)
  assert.deepEqual(three, [0, 2, 4])
  assert.deepEqual(internals.downsample([], 10), [])
  assert.deepEqual(internals.downsample([1, 2, 3], 0), [])
  assert.deepEqual(internals.downsample([1, 2, 3], 1), [3])
  assert.deepEqual(internals.downsample(null, 5), [])
})

test('arcPath: 240° dial geometry, clamping, no NaN', () => {
  assert.equal(internals.arcPath(180, 180, 150, 150, 240, 0.5), 'M 50.096 255 A 150 150 0 0 1 180 30')
  assert.ok(internals.arcPath(180, 180, 150, 150, 240, 1).includes(' A 150 150 0 1 1 '))
  assert.equal(internals.arcPath(180, 180, 150, 150, 240, 0), '')
  assert.equal(internals.arcPath(180, 180, 0, 150, 240, 0.5), '')
  assert.equal(internals.arcPath(Number.NaN, 180, 150, 150, 240, 0.5), '')
  assert.equal(internals.arcPath(180, 180, 150, 150, 240, Number.NaN), '')
  const over = internals.arcPath(180, 180, 150, 150, 240, 2)
  assert.ok(over !== '')
  assert.ok(!over.includes('NaN'))
  for (const fraction of [0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
    const path = internals.arcPath(180, 180, 94, 150, 240, fraction)
    assert.ok(!path.includes('NaN'), 'NaN in ' + path)
    assert.ok(!path.includes('undefined'), 'undefined in ' + path)
    assert.ok(/^-?[\d.\sA-Za-z-]+$/.test(path))
  }
})

test('tickMarks: 24 ticks around the 240° sweep, finite geometry', () => {
  const marks = internals.tickMarks()
  assert.equal(marks.length, 24)
  assert.equal(marks.filter((mark) => mark.major).length, 4)
  assert.equal(marks[0].angle, 150)
  assert.ok(marks.every((mark) => [
    mark.x1, mark.y1, mark.x2, mark.y2, mark.angle,
  ].every((value) => Number.isFinite(value))))
  assert.equal(internals.tickMarks(0).length, 24)
  assert.equal(internals.tickMarks(7).length, 7)
})

test('windowLabel + sortWindows: frozen labels, highest first, ties to monthly', () => {
  assert.equal(internals.windowLabel('rolling'), '5h')
  assert.equal(internals.windowLabel('weekly'), 'weekly')
  assert.equal(internals.windowLabel('monthly'), 'monthly')
  assert.equal(internals.windowLabel('other'), 'other')
  assert.equal(internals.windowLabel(null), '')

  const tied = [
    { key: 'rolling', percent: 10 },
    { key: 'weekly', percent: 10 },
    { key: 'monthly', percent: 10 },
  ]
  assert.deepEqual(internals.sortWindows(tied).map((entry) => entry.key), ['monthly', 'weekly', 'rolling'])
  assert.deepEqual(internals.sortWindows([
    { key: 'rolling', percent: 30 },
    { key: 'weekly', percent: 10 },
    { key: 'monthly', percent: 20 },
  ]).map((entry) => entry.key), ['rolling', 'monthly', 'weekly'])
  assert.deepEqual(internals.sortWindows(tied).length, 3)
  assert.equal(tied[0].key, 'rolling', 'sortWindows must not mutate its input')
  assert.deepEqual(internals.sortWindows(null), [])
})

test('readSummary: defensive shaping of untrusted values', () => {
  const now = Date.now()
  const shaped = internals.readSummary({
    fetchedAt: now,
    cached: true,
    stale: 'yes',
    error: { code: 'network', message: 'offline', details: { status: 0 } },
    source: { usageUrl: 'https://opencode.ai/zen/go/v1/usage', keyRef: 'OPENCODE_GO_API_KEY', keyHint: '…A1b2' },
    windows: {
      rolling: { status: 'ok', percent: 12.5, resetAt: new Date(now + 3600_000).toISOString(), resetInSec: 3600 },
      weekly: { percent: 'bad', resetAt: 'not-a-date' },
      monthly: null,
    },
    samples: [
      { t: 2, rolling: 2, weekly: 3, monthly: 4 },
      { t: 1, rolling: 1, weekly: 1, monthly: 1 },
      { t: 'bad', rolling: 9 },
      { t: 3, rolling: Number.NaN, weekly: 0, monthly: 0 },
    ],
    sampledSince: 0,
  })
  assert.equal(shaped.cached, true)
  assert.equal(shaped.stale, false)
  assert.equal(shaped.error.code, 'network')
  assert.equal(shaped.windows.length, 3)
  assert.equal(shaped.windows[0].key, 'rolling')
  assert.equal(shaped.windows[0].percent, 12.5)
  assert.equal(shaped.windows[0].status, 'ok')
  assert.equal(shaped.windows[0].known, true)
  assert.equal(shaped.windows[1].label, 'weekly')
  assert.equal(shaped.windows[1].status, 'unknown')
  assert.equal(shaped.windows[1].percent, null, 'an unknown window must not become a fake 0%')
  assert.equal(shaped.windows[1].known, false)
  assert.equal(shaped.windows[2].status, 'unknown')
  assert.equal(shaped.windows[2].percent, null)
  assert.equal(shaped.samples.length, 2, 'samples with a non-finite window value are dropped, not zeroed')
  assert.deepEqual(shaped.samples.map((sample) => sample.t), [1, 2])
  assert.equal(shaped.sampledSince, 0)
})

test('readWindows/readSamples: unknown and partial windows stay unknown', () => {
  const windows = internals.readWindows({
    windows: {
      rolling: { status: 'ok', percent: 0, resetAt: '', resetInSec: 0 },
      weekly: { status: 'unknown', percent: 12, resetAt: '', resetInSec: 0 },
    },
  })
  assert.equal(windows[0].percent, 0, 'a real 0% is not unknown')
  assert.equal(windows[0].known, true)
  assert.equal(windows[1].percent, null, 'status unknown wins over a stray percent')
  assert.equal(windows[2].percent, null, 'a missing window is unknown')
  assert.equal(windows[2].resetAt, '')

  const samples = internals.readSamples({
    samples: [
      { t: 2, rolling: 1, weekly: 2, monthly: 3 },
      { t: 1, rolling: 1, weekly: Number.NaN, monthly: 3 },
      { t: 3, rolling: 1, weekly: 2 },
      { rolling: 1, weekly: 2, monthly: 3 },
    ],
  })
  assert.deepEqual(samples.map((sample) => sample.t), [2])
})

test('Dial: an unknown focused window shows —, draws no arc and no used/unused split', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const windows = windowSet({ weekly: UNKNOWN_WINDOW })
  const dial = internals.Dial({ t, lang: 'zh', windows, focusKey: 'weekly', fetchedAt: null, now })
  const texts = textOf(dial)
  assert.ok(texts.includes('—'), 'the focus percent is unknown')
  assert.ok(texts.includes('该档未提供'), 'no used/unused split for an unknown window')
  assert.equal(findByClass(dial, 'ogq-ring-fill').length, 2, 'only the two known windows draw an arc')
  assert.equal(findByClass(dial, 'ogq-ring-dot').length, 0)
  assert.equal(findByClass(dial, 'ogq-ring-halo').length, 0)
  assert.ok(!texts.some((text) => text.includes('已用') && text.includes('未用')), texts.join('|'))
  assert.ok(dial.props['aria-label'].includes('已用 —'), dial.props['aria-label'])

  const knownDial = internals.Dial({ t, lang: 'zh', windows, focusKey: 'rolling', fetchedAt: null, now })
  assert.equal(findByClass(knownDial, 'ogq-ring-fill').length, 2)
  assert.equal(findByClass(knownDial, 'ogq-ring-dot').length, 1)
  assert.ok(textOf(knownDial).some((text) => text.includes('已用 41.0%')))
})

test('Legend: an unknown window shows —, an empty mini ring and its status', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const windows = windowSet({ weekly: UNKNOWN_WINDOW })
  const legend = internals.Legend({
    t,
    lang: 'zh',
    windows,
    focusKey: 'rolling',
    fetchedAt: null,
    now,
    onFocus() {},
  })
  const texts = textOf(legend)
  assert.ok(texts.includes('—'))
  assert.ok(texts.includes('状态 unknown'), texts.join('|'))
  assert.equal(findByClass(legend, 'ogq-mini-fill').length, 2)
  assert.equal(findByClass(legend, 'ogq-leg-status').length, 1)
  const legs = findByClass(legend, 'ogq-leg')
  assert.equal(legs.length, 3)
  assert.ok(textOf(legs[1]).includes('—'))
})

test('ForecastCard: without samples it shows — for every window and says so', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const card = internals.ForecastCard({ t, lang: 'zh', windows: windowSet(), samples: [], now })
  const texts = textOf(card)
  assert.equal(texts.filter((text) => text === '—').length, 3)
  assert.ok(texts.includes('采样不足，稍后自动更新'))
  assert.equal(findByClass(card, 'ogq-fc-bar').length, 0, 'no projection bar without a projection')
  assert.ok(!texts.some((text) => text.startsWith('≈')))
})

test('ForecastCard: a single recent sample does not claim a sample basis', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const card = internals.ForecastCard({
    t,
    lang: 'zh',
    windows: windowSet(),
    samples: [{ t: now - 60000, rolling: 41, weekly: 16, monthly: 10 }],
    now,
  })
  const texts = textOf(card)
  assert.ok(texts.includes('采样不足，稍后自动更新'))
  assert.ok(!texts.some((text) => text.includes('个采样')), texts.join('|'))
  assert.ok(!texts.some((text) => text.startsWith('≈')))
})

test('ForecastCard: projects from the recent sample slope and states the real sample basis', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const hour = 3600_000
  const windows = windowSet({
    rolling: { key: 'rolling', label: '5h', status: 'ok', percent: 40, resetAt: '', resetInSec: 10000 },
  })
  const samples = [
    { t: now - 3 * hour, rolling: 30, weekly: 10, monthly: 5 },
    { t: now - 2 * hour, rolling: 33, weekly: 10, monthly: 5 },
    { t: now - hour, rolling: 36, weekly: 10, monthly: 5 },
    { t: now, rolling: 40, weekly: 10, monthly: 5 },
  ]
  const card = internals.ForecastCard({ t, lang: 'zh', windows, samples, now })
  const texts = textOf(card)
  assert.ok(texts.includes('≈ 49.2%'), texts.join('|'))
  assert.ok(texts.some((text) => text.includes('4 个采样')), 'footnote names the sample count')
  assert.ok(texts.some((text) => text.includes('3 时')), 'footnote names the sample span')
  assert.equal(findByClass(card, 'ogq-fc-bar').length, 3)
  assert.ok(texts.includes('≈ 16.0%'), 'a flat trail projects the current percent')
  assert.ok(texts.includes('≈ 10.0%'))
})

test('HorizonCard: a reset beyond the assumed period draws no progress', () => {
  const t = makeTranslator('zh')
  const now = 1_700_000_000_000
  const windows = windowSet({
    monthly: {
      key: 'monthly',
      label: 'monthly',
      status: 'ok',
      percent: 10,
      resetAt: new Date(now + 31 * 86400 * 1000).toISOString(),
      resetInSec: 31 * 86400,
    },
  })
  const card = internals.HorizonCard({ t, lang: 'zh', windows, fetchedAt: now, now })
  assert.equal(findByClass(card, 'ogq-ruler-fill').length, 2)
  const tracks = findByClass(card, 'ogq-ruler-track')
  assert.equal(tracks.length, 3)
  assert.ok(tracks[2].props['aria-label'].includes('进度未知'), tracks[2].props['aria-label'])
})

test('PanelIcon: currentColor, three arcs, active state, no external resource', () => {
  elements.length = 0
  const element = internals.PanelIcon({ size: 20, active: true })
  assert.equal(element.type, 'svg')
  assert.equal(element.props.width, 20)
  assert.equal(element.props.height, 20)
  assert.equal(element.props.viewBox, '0 0 24 24')
  assert.equal(element.props['data-active'], 'true')
  assert.equal(element.props['aria-hidden'], 'true')
  assert.equal(element.props.fill, 'none')
  assert.ok(!('href' in element.props))
  const paths = element.children.filter((child) => child && child.type === 'path')
  assert.equal(paths.length, 3)
  for (const path of paths) {
    assert.equal(path.props.stroke, 'currentColor')
    assert.ok(!path.props.d.includes('NaN'))
  }
  const circle = element.children.find((child) => child && child.type === 'circle')
  assert.equal(circle.props.fill, 'currentColor')

  const idle = internals.PanelIcon({})
  assert.equal(idle.props.width, 16)
  assert.equal(idle.props['data-active'], 'false')
})

test('PAGE_CSS: themed tokens with warm fallbacks, dark + responsive + motion rules', () => {
  const css = internals.PAGE_CSS
  for (const token of [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-label-primary',
    '--dsw-alias-border-l1',
    '--dsw-alias-brand-primary',
    '--dsh-font-family-text',
    '--dsh-font-family-code',
  ]) {
    assert.ok(css.includes('var(' + token), 'missing ' + token)
  }
  for (const fallback of ['#f5f3ee', '#1d1b16', '#da7756', '#e3ddd1']) {
    assert.ok(css.includes(fallback), 'missing fallback ' + fallback)
  }
  assert.ok(css.includes('body[data-ds-dark-theme] .ogq-page'))
  assert.ok(css.includes('@media (max-width:1099.98px)'))
  assert.ok(css.includes('@media (max-width:719.98px)'))
  assert.ok(css.includes('prefers-reduced-motion:reduce'))
  assert.ok(css.includes('font-variant-numeric:tabular-nums'))
  assert.ok(!css.includes('position:fixed'), 'the page must never cover the host shell')
  assert.ok(!css.includes('!important'))
})
