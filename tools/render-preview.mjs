/**
 * Render the OpenCode Go quota page preview in headless Chrome over CDP.
 *
 *   node tools/render-preview.mjs
 *
 * Produces:
 *   artifacts/preview-light.png  1440 × 900
 *   artifacts/preview-dark.png   1440 × 900
 *   artifacts/preview-narrow.png  900 × 700
 *
 * The preview normally loads React 18 UMD from unpkg. If the CDN is unreachable
 * this script installs React into `tools/node_modules` (never into the plugin's
 * own package.json) and renders the local UMD fallback instead.
 *
 * Exits non-zero when the page reports a boot/runtime error or has horizontal
 * overflow (scrollWidth > clientWidth + 1).
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(TOOLS_DIR)
const PREVIEW = path.join(TOOLS_DIR, 'preview.html')
const ARTIFACTS = path.join(ROOT, 'artifacts')
const REACT_CDN = 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'
const REACT_DOM_CDN = 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'
const REACT_LOCAL = path.join(TOOLS_DIR, 'node_modules', 'react', 'umd', 'react.production.min.js')
const REACT_DOM_LOCAL = path.join(TOOLS_DIR, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function resolveChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* keep looking */ }
  }
  return null
}

function fileUrl(file, query) {
  const base = 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '')
  return query === undefined ? base : base + '?' + query
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

async function cdnReachable() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(REACT_CDN, { method: 'HEAD', signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function ensureLocalReact() {
  if (fs.existsSync(REACT_LOCAL) && fs.existsSync(REACT_DOM_LOCAL)) return true
  console.log('[preview] unpkg unreachable; installing React 18 into tools/node_modules (plugin package.json untouched)…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, [
    'install',
    '--prefix', 'tools',
    'react@18',
    'react-dom@18',
    '--no-audit',
    '--no-fund',
  ], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', timeout: 180000 })
  return result.status === 0 && fs.existsSync(REACT_LOCAL) && fs.existsSync(REACT_DOM_LOCAL)
}

function makeCdpClient(ws) {
  let nextId = 0
  const pending = new Map()
  const eventHandlers = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const settle = pending.get(message.id)
      pending.delete(message.id)
      settle(message)
      return
    }
    if (message.method !== undefined && eventHandlers.has(message.method)) {
      for (const handler of eventHandlers.get(message.method)) handler(message.params)
    }
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = (nextId += 1)
        pending.set(id, (message) => {
          if (message.error) reject(new Error(method + ': ' + JSON.stringify(message.error)))
          else resolve(message.result)
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, handler) {
      if (!eventHandlers.has(method)) eventHandlers.set(method, [])
      eventHandlers.get(method).push(handler)
    },
  }
}

async function connectToChrome(port) {
  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const pages = await response.json()
      target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl) || null
      if (target !== null) break
    } catch { /* chrome still starting */ }
    await sleep(100)
  }
  if (target === null) throw new Error('Chrome did not expose a debuggable page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return { ws, cdp: makeCdpClient(ws) }
}

async function waitForReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
          ready: window.__PREVIEW_READY__ === true,
          bootError: document.body.dataset.previewError === 'true',
          errors: Array.isArray(window.__PREVIEW_ERRORS__) ? window.__PREVIEW_ERRORS__.slice(0, 8) : [],
          source: window.__PREVIEW_SOURCE__ || ''
        }))()`,
        returnByValue: true,
      })
      const value = result.result.value
      if (value && value.ready) return value
      if (value && value.bootError) return value
    } catch { /* page is navigating */ }
    await sleep(120)
  }
  return { ready: false, bootError: false, errors: ['timed out waiting for __PREVIEW_READY__'], source: '' }
}

async function inspectPage(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const doc = document.documentElement
      const body = document.body
      const page = document.querySelector('.ogq-page')
      const shell = document.querySelector('.ogq-shell')
      const footer = document.querySelector('.ogq-foot')
      const bootError = document.getElementById('boot-error')
      const rect = (element) => {
        if (element === null) return null
        const box = element.getBoundingClientRect()
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), width: Math.round(box.width) }
      }
      return {
        ready: window.__PREVIEW_READY__ === true,
        state: document.body.getAttribute('data-preview-ready'),
        title: document.title,
        source: window.__PREVIEW_SOURCE__ || '',
        runtimeErrors: Array.isArray(window.__PREVIEW_ERRORS__) ? window.__PREVIEW_ERRORS__.slice(0, 8) : [],
        bootError: document.body.dataset.previewError === 'true'
          ? (bootError ? bootError.innerText.slice(0, 800) : 'boot failed')
          : '',
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight },
        body: { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
        shell: rect(shell),
        footer: rect(footer),
        responsive: (() => {
          const count = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim().split(/\\s+/).length : 0)
          const grid = document.querySelector('.ogq-grid')
          const dial = document.querySelector('.ogq-dial')
          const legend = document.querySelector('.ogq-legend')
          const ruler = document.querySelector('.ogq-ruler')
          const boxOf = (el) => {
            if (el === null) return null
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, w: r.width, h: r.height }
          }
          const hits = (a, b) => a !== null && b !== null
            && a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1
            && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1
          const dialBox = boxOf(dial)
          const legendBox = boxOf(legend)
          const legs = Array.from(document.querySelectorAll('.ogq-leg')).map(boxOf)
          let collisions = hits(dialBox, legendBox) ? 1 : 0
          for (let index = 1; index < legs.length; index += 1) {
            if (hits(legs[index - 1], legs[index])) collisions += 1
          }
          return {
            gridColumns: grid === null ? null : count(getComputedStyle(grid).gridTemplateColumns),
            dialWidth: dial === null ? null : Math.round(dialBox.w),
            legendColumns: legend === null ? null : count(getComputedStyle(legend).gridTemplateColumns),
            rulerAreas: ruler === null ? null : getComputedStyle(ruler).gridTemplateAreas,
            collisions,
            pageWidth: page === null ? null : page.clientWidth,
          }
        })(),
        fonts: {
          page: page === null ? '' : getComputedStyle(page).fontFamily,
          mono: page === null ? '' : getComputedStyle(page).getPropertyValue('--ogq-mono').trim(),
        },
        page: page === null ? null : {
          scrollWidth: page.scrollWidth,
          clientWidth: page.clientWidth,
          scrollHeight: page.scrollHeight,
          clientHeight: page.clientHeight,
          blocks: {
            header: document.querySelector('.ogq-head') !== null,
            gauge: document.querySelector('.ogq-dial svg') !== null,
            legend: document.querySelectorAll('.ogq-leg').length,
            forecast: document.querySelectorAll('.ogq-fc-row').length,
            rulers: document.querySelectorAll('.ogq-ruler').length,
            trail: document.querySelector('.ogq-trailsvg') !== null,
            footer: document.querySelector('.ogq-foot') !== null,
          },
          cards: Array.from(document.querySelectorAll('.ogq-grid > .ogq-card, .ogq-horizon, .ogq-trail')).map((card) => ({
            className: card.className,
            ...rect(card),
          })),
        },
      }
    })()`,
    returnByValue: true,
  })
  return result.result.value
}

async function capture(cdp, name) {
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const buffer = Buffer.from(screenshot.data, 'base64')
  const target = path.join(ARTIFACTS, name)
  fs.writeFileSync(target, buffer)
  return { file: target, bytes: buffer.length, buffer }
}

async function main() {
  const chrome = resolveChrome()
  if (chrome === null) {
    console.error('FAIL: Chrome/Edge executable not found. Set CHROME_PATH to a Chromium binary.')
    process.exit(1)
  }
  if (!fs.existsSync(PREVIEW)) {
    console.error('FAIL: preview.html is missing at ' + PREVIEW)
    process.exit(1)
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true })

  let localMode = false
  const forceLocal = process.env.PREVIEW_LOCAL === '1'
  const reachable = forceLocal ? false : await cdnReachable()
  if (forceLocal) {
    console.log('[preview] PREVIEW_LOCAL=1: using tools/node_modules React UMD')
  }
  if (!reachable) {
    localMode = ensureLocalReact()
    if (!localMode) {
      console.error('FAIL: unpkg is unreachable and local React 18 could not be installed.')
      process.exit(1)
    }
  }

  const port = await freePort()
  const profileDir = path.join(os.tmpdir(), 'dsh-ogq-preview-' + process.pid)
  fs.rmSync(profileDir, { recursive: true, force: true })

  const launchUrl = fileUrl(PREVIEW, (localMode ? 'local=1&' : '') + 'state=ready')
  console.log('[preview] chrome: ' + chrome)
  console.log('[preview] url: ' + launchUrl)
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    launchUrl,
  ], { stdio: 'ignore' })

  const browserExit = new Promise((resolve) => browser.once('exit', resolve))
  let connection = null
  let exitCode = 0
  const report = { chrome, localMode, cdnReachable: reachable, shots: {}, probes: [], problems: [] }

  const cleanup = async () => {
    try { if (connection) connection.ws.close() } catch { /* already closed */ }
    try { browser.kill() } catch { /* already gone */ }
    if (process.platform === 'win32' && browser.pid !== undefined) {
      try { spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
    }
    await Promise.race([browserExit, sleep(2500)])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true })
        break
      } catch {
        await sleep(200)
      }
    }
  }

  try {
    connection = await connectToChrome(port)
    const { cdp } = connection
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params && params.exceptionDetails
      const text = detail && detail.exception
        ? (detail.exception.description || detail.exception.value || detail.text)
        : (detail ? detail.text : 'unknown exception')
      report.problems.push('runtime exception: ' + String(text).slice(0, 300))
    })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params && params.type === 'error') {
        const text = (params.args || []).map((arg) => arg.value === undefined ? arg.description : arg.value).join(' ')
        report.problems.push('console.error: ' + String(text).slice(0, 300))
      }
    })

    const shots = [
      { name: 'preview-light.png', width: 1440, height: 900, query: 'state=ready' },
      { name: 'preview-dark.png', width: 1440, height: 900, query: 'state=ready&dark=1' },
      { name: 'preview-narrow.png', width: 900, height: 700, query: 'state=ready' },
      { name: 'preview-accounts.png', width: 1440, height: 900, query: 'state=ready&panel=list' },
      { name: 'preview-account-add.png', width: 1440, height: 900, query: 'state=ready&panel=add&dark=1' },
    ]

    for (const shot of shots) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: shot.width,
        screenHeight: shot.height,
      })
      const query = (localMode ? 'local=1&' : '') + shot.query
      await cdp.send('Page.navigate', { url: fileUrl(PREVIEW, query) })
      await sleep(250)
      const state = await waitForReady(cdp, 20000)
      if (!state.ready) {
        report.problems.push(shot.name + ': preview did not become ready (' + (state.errors || []).join('; ') + ')')
      }
      // Let the 600 ms first-paint arc animation and font swap settle.
      await sleep(state.ready ? 900 : 400)
      const info = await inspectPage(cdp)
      const horizontalOverflow = []
      if (info.document && info.document.scrollWidth > info.document.clientWidth + 1) {
        horizontalOverflow.push(`document ${info.document.scrollWidth} > ${info.document.clientWidth}`)
      }
      if (info.body && info.body.scrollWidth > info.body.clientWidth + 1) {
        horizontalOverflow.push(`body ${info.body.scrollWidth} > ${info.body.clientWidth}`)
      }
      if (info.page && info.page.scrollWidth > info.page.clientWidth + 1) {
        horizontalOverflow.push(`page ${info.page.scrollWidth} > ${info.page.clientWidth}`)
      }
      if (horizontalOverflow.length > 0) {
        report.problems.push(shot.name + ': horizontal overflow (' + horizontalOverflow.join(', ') + ')')
      }
      if (info.bootError) report.problems.push(shot.name + ': ' + String(info.bootError).slice(0, 500))
      if (Array.isArray(info.runtimeErrors) && info.runtimeErrors.length > 0) {
        report.problems.push(shot.name + ': page errors ' + info.runtimeErrors.join('; '))
      }
      const image = await capture(cdp, shot.name)
      report.shots[shot.name] = {
        viewport: shot.width + 'x' + shot.height,
        file: path.relative(ROOT, image.file).replace(/\\/g, '/'),
        bytes: image.bytes,
        ready: info.ready,
        source: info.source,
        page: info.page,
        shell: info.shell,
        footer: info.footer,
        fonts: info.fonts,
        verticalOverflow: info.page ? Math.max(0, info.page.scrollHeight - info.page.clientHeight) : null,
        horizontalOverflow,
      }
      console.log(`[preview] ${shot.name}: ${shot.width}x${shot.height} → ${image.bytes} bytes` +
        (info.page ? `, blocks ${JSON.stringify(info.page.blocks)}` : '') +
        (info.page ? `, scroll ${info.page.scrollHeight}/${info.page.clientHeight}` : ''))
    }

    // Responsive contract probes (no screenshots): two columns at 1100, a
    // compact dial below 720, vertical ruler rows on a phone, no horizontal
    // overflow and no dial/legend or legend-row overlap anywhere. The last
    // probe emulates the host handing the page a narrow column inside a wide
    // window, which only container queries can see.
    const probes = [
      // 1200 is the narrowest window that still gives the two-column layout:
      // the breakpoint measures the page container (window minus its padding).
      { name: 'wide-1200', width: 1200, height: 900, twoColumns: true },
      { name: 'wide-en-1440', width: 1440, height: 900, twoColumns: true, query: 'state=ready&lang=en' },
      { name: 'tablet-719', width: 719, height: 800, narrow: true },
      { name: 'phone-480', width: 480, height: 844, narrow: true, stackedRuler: true },
      { name: 'panel-column-700', width: 1600, height: 1000, panel: 700, oneColumn: true },
      { name: 'panel-column-980', width: 1600, height: 1000, panel: 980, oneColumn: true },
    ]
    for (const probe of probes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: probe.width,
        height: probe.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: probe.width,
        screenHeight: probe.height,
      })
      await cdp.send('Page.navigate', { url: fileUrl(PREVIEW, (localMode ? 'local=1&' : '') + (probe.query || 'state=ready')) })
      await sleep(200)
      const state = await waitForReady(cdp, 15000)
      await sleep(400)
      if (probe.panel) {
        await cdp.send('Runtime.evaluate', {
          expression: 'document.getElementById("root").style.maxWidth = "' + probe.panel + 'px"',
        })
        await sleep(350)
      }
      const info = await inspectPage(cdp)
      const horizontalOverflow = []
      if (info.document && info.document.scrollWidth > info.document.clientWidth + 1) {
        horizontalOverflow.push(`document ${info.document.scrollWidth} > ${info.document.clientWidth}`)
      }
      if (info.page && info.page.scrollWidth > info.page.clientWidth + 1) {
        horizontalOverflow.push(`page ${info.page.scrollWidth} > ${info.page.clientWidth}`)
      }
      const responsive = info.responsive || {}
      if (horizontalOverflow.length > 0) {
        report.problems.push(probe.name + ': horizontal overflow (' + horizontalOverflow.join(', ') + ')')
      }
      if (probe.twoColumns && responsive.gridColumns !== 2) {
        report.problems.push(probe.name + ': expected 2 main columns, got ' + responsive.gridColumns)
      }
      if (probe.oneColumn && responsive.gridColumns !== 1) {
        report.problems.push(probe.name + ': expected 1 main column in a narrow host column, got ' + responsive.gridColumns)
      }
      if (probe.narrow && (typeof responsive.dialWidth !== 'number' || responsive.dialWidth > 341)) {
        report.problems.push(probe.name + ': expected a compact dial, got ' + responsive.dialWidth)
      }
      if (probe.stackedRuler && !String(responsive.rulerAreas || '').includes('track')) {
        report.problems.push(probe.name + ': ruler rows did not stack vertically (' + responsive.rulerAreas + ')')
      }
      if (probe.narrow && responsive.legendColumns !== 1) {
        report.problems.push(probe.name + ': expected a single-column legend, got ' + responsive.legendColumns)
      }
      if (responsive.collisions > 0) {
        report.problems.push(probe.name + ': ' + responsive.collisions + ' layout collision(s) between the dial, legend or legend rows')
      }
      if (!info.ready) report.problems.push(probe.name + ': preview did not become ready')
      report.probes.push({
        name: probe.name,
        viewport: probe.width + 'x' + probe.height,
        ready: info.ready,
        horizontalOverflow,
        verticalOverflow: info.page ? Math.max(0, info.page.scrollHeight - info.page.clientHeight) : null,
        responsive,
      })
      console.log(`[preview] probe ${probe.name}: ${probe.width}x${probe.height}, columns=${responsive.gridColumns}, dial=${responsive.dialWidth}px, legend=${responsive.legendColumns}, overflow=${horizontalOverflow.length}, scroll=${info.page ? info.page.scrollHeight + '/' + info.page.clientHeight : '?'}`)
    }
  } catch (error) {
    report.problems.push('fatal: ' + String(error && error.stack ? error.stack : error))
    exitCode = 1
  } finally {
    await cleanup()
  }

  if (report.problems.length > 0) exitCode = 1
  console.log(JSON.stringify(report, null, 2))
  if (exitCode !== 0) console.error('FAIL: preview issues found')
  else console.log('preview: ok')
  process.exit(exitCode)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
