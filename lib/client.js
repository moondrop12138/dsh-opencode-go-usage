/**
 * Client half of `dsh-opencode-go-usage`.
 *
 * Adds the OpenCode Go subscription quota page to the DSH Web UI:
 *
 *   1. a left-sidebar panel row (`sidebar.panellist`, id `opencode-go-usage`,
 *      order 30) with a three-arc dial glyph;
 *   2. the keyed `main` panel that row selects: a quiet, paper-like observation
 *      window for the official 5h / weekly / monthly used-percent windows,
 *      their reset countdowns, a pacing forecast and the local 7-day sample
 *      trail kept by the host half.
 *
 * Plain browser JavaScript only: React comes from the module table, no Harness
 * Client package is imported, no JSX (this file is plain `.js`), and every
 * visible string goes through the locale namespace `opencode-go-usage`.
 *
 * The page never invents a value. A failed request is an error (or a labelled
 * stale banner over the last good data), never a synthetic zero.
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG = 'dsh-opencode-go-usage'
    const NS = 'opencode-go-usage'
    const PANEL_ID = 'opencode-go-usage'
    const PANEL_ORDER = 30
    const RPC_BASE = '/api'
    const RPC_ENDPOINT = PKG + '/call'

    /** Summary poll cadence while the page is visible (lead spec: 60 s). */
    const POLL_MS = 60000
    /** Fixed order of the three windows, independent of their percentages. */
    const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']
    /** Unit vocabulary frozen by the contract; never translated. */
    const WINDOW_LABELS = { rolling: '5h', weekly: 'weekly', monthly: 'monthly' }
    /**
     * Published cycle lengths. Used only to place the reset-horizon ruler; the
     * pacing forecast never derives a window start from them (only the sample
     * slope is extrapolated).
     */
    const WINDOW_PERIOD_SEC = { rolling: 5 * 3600, weekly: 7 * 86400, monthly: 30 * 86400 }
    /** Gauge geometry, frozen by the design spec. */
    const GAUGE_CENTER = 180
    const GAUGE_RADIUS = { rolling: 162, weekly: 134, monthly: 106 }
    const GAUGE_START = 150
    const GAUGE_SWEEP = 240
    const GAUGE_TICKS = 24
    const TRAIL_DAYS = 7
    const TRAIL_MAX_POINTS = 360
    const DETAIL_MAX = 240
    /** How far back the pacing forecast looks for a sample slope. */
    const FORECAST_WINDOW_MS = 24 * 3600 * 1000
    /** Fewer samples than this cannot establish a slope. */
    const FORECAST_MIN_SAMPLES = 2
    /**
     * Two points a minute apart are mathematically a slope but not a usable
     * pace: a 1% blip would project to thousands of percent. Require at least
     * one hour of real sampling before showing a projection.
     */
    const FORECAST_MIN_SPAN_SEC = 3600
    /** An extrapolation above this is shown as "> 300%", not a silly number. */
    const FORECAST_MAX_PROJECTED = 300

    /* ------------------------------------------------------------------ locale */

    const zh = {
      'meta.lang': 'zh',
      'panel': 'OpenCode Go 用量',
      'eyebrow': 'OPENCODE GO',
      'title': '额度观测窗',
      'subtitle': '官方 /zen/go/v1/usage · 60 秒采样',
      'page.aria': 'OpenCode Go 订阅用量',
      'badge.live': '实时',
      'badge.cached': '缓存',
      'badge.stale': '旧数据',
      'badge.error': '不可用',
      'badge.loading': '读取中',
      'meta.updated': '更新于 {time}',
      'meta.never': '尚未成功取数',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中',
      'action.retry': '重试',
      'action.refreshAria': '刷新 OpenCode Go 额度',
      'time.justNow': '刚刚',
      'time.secondsAgo': '{n} 秒前',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'time.unknown': '—',
      'window.rolling': '5 小时滚动',
      'window.weekly': '每周',
      'window.monthly': '每月',
      'window.unknown': '未知窗口',
      'window.status': '状态 {status}',
      'section.windows.kicker': 'WINDOWS',
      'section.windows': '三档额度',
      'section.forecast.kicker': 'PACING',
      'section.forecast': '节奏预测',
      'forecast.note': '按当前节奏估算，不是官方配额',
      'forecast.eta': '约 {time} 后触顶',
      'forecast.capped': '已触顶',
      'forecast.now': '暂无消耗',
      'forecast.unknown': '—',
      'forecast.samples': '基于最近 {span} 的 {n} 个采样',
      'forecast.noSamples': '采样不足，稍后自动更新',
      'section.horizon.kicker': 'RESET HORIZON',
      'section.horizon': '重置地平线',
      'horizon.note': '窗口进度按 5h / 7d / 30d 周期估算',
      'horizon.nearest': '最近：{window}',
      'horizon.unknownReset': '重置时间未知',
      'horizon.rowAria': '{window} 窗口已过约 {progress}，距重置 {countdown}',
      'horizon.rowAriaUnknown': '{window} 窗口进度未知，距重置 {countdown}',
      'section.trail.kicker': 'SAMPLE TRAIL',
      'section.trail': '采样轨迹',
      'trail.meta': '{n} 个采样 · 近 7 天',
      'trail.aria': '最近 7 天三档额度已用百分比折线图',
      'trail.empty': '还没有采样',
      'trail.emptyHint': '成功取数后会在这里留下轨迹；采样只保存在本机。',
      'trail.insufficient': '采样不足',
      'trail.insufficientHint': '至少需要 2 个采样点才能画出轨迹；页面打开后每 60 秒记录一次。',
      'trail.point': '{time} · {window} 已用 {percent}',
      'gauge.aria': '三档额度环：5 小时已用 {rolling}，每周已用 {weekly}，每月已用 {monthly}',
      'gauge.used': '已用 {percent}',
      'gauge.unused': '未用 {percent}',
      'gauge.unknown': '该档未提供',
      'gauge.reset': '重置 {countdown}',
      'gauge.focus': '{window} 已用 {percent}',
      'legend.aria': '选择要查看的额度窗口',
      'legend.reset': '重置 {countdown}',
      'legend.unknown': '重置 —',
      'stale.title': '显示的是旧数据。',
      'stale.text': '上次刷新失败（{code}）：{message}。数据取于 {time}。',
      'stale.retry': '重新获取',
      'error.title': '无法读取额度',
      'error.code': '错误码：{code}',
      'error.hint.no-key': '在 DSH credentials 中配置 OPENCODE_GO_API_KEY 后再试。',
      'error.hint.unauthorized': '密钥无效，或该账号没有 OpenCode Go 订阅。',
      'error.hint.network': '网络不通或请求超时，稍后重试。',
      'error.hint.upstream': '上游临时故障，稍后重试。',
      'error.hint.bad-response': '接口返回了无法识别的结构，可能需要更新插件。',
      'error.hint.bad-request': '插件内部请求不合法，请更新插件或重启 DSH。',
      'error.hint.unknown-endpoint': '插件内部端点不匹配，可能需要更新插件。',
      'error.hint.host-unavailable': '宿主 RPC 尚不可用，宿主半可能还没有加载完成。',
      'error.hint.rpc-failed': '与宿主的连接中断，稍后重试。',
      'error.hint.generic': '请稍后重试；若持续失败，请查看插件日志。',
      'error.retry': '重试',
      'loading.title': '正在读取 OpenCode Go 额度…',
      'loading.hint': '首次取数通常不到一秒。',
      'footer.source': '数据源',
      'footer.key': '密钥',
      'footer.samples': '{n} 个采样',
      'footer.disclaimer': '数据来自 OpenCode Go 官方接口，仅供参考。',
      'footer.live': '本次实时取数',
      'footer.cached': '本次读自缓存',
    }

    const en = {
      'meta.lang': 'en',
      'panel': 'OpenCode Go usage',
      'eyebrow': 'OPENCODE GO',
      'title': 'Quota window',
      'subtitle': 'Official /zen/go/v1/usage · 60 s sampling',
      'page.aria': 'OpenCode Go subscription usage',
      'badge.live': 'Live',
      'badge.cached': 'Cached',
      'badge.stale': 'Stale',
      'badge.error': 'Unavailable',
      'badge.loading': 'Reading',
      'meta.updated': 'Updated {time}',
      'meta.never': 'No successful fetch yet',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing',
      'action.retry': 'Retry',
      'action.refreshAria': 'Refresh OpenCode Go usage',
      'time.justNow': 'just now',
      'time.secondsAgo': '{n} s ago',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.daysAgo': '{n} d ago',
      'time.unknown': '—',
      'window.rolling': '5-hour rolling',
      'window.weekly': 'Weekly',
      'window.monthly': 'Monthly',
      'window.unknown': 'Unknown window',
      'window.status': 'Status {status}',
      'section.windows.kicker': 'WINDOWS',
      'section.windows': 'Quota windows',
      'section.forecast.kicker': 'PACING',
      'section.forecast': 'Pacing forecast',
      'forecast.note': 'Extrapolated from the current pace, not an official quota',
      'forecast.eta': 'Hits the cap in about {time}',
      'forecast.capped': 'Cap reached',
      'forecast.now': 'No usage yet',
      'forecast.unknown': '—',
      'forecast.samples': 'Based on {n} samples over the last {span}',
      'forecast.noSamples': 'Not enough samples yet; this updates automatically',
      'section.horizon.kicker': 'RESET HORIZON',
      'section.horizon': 'Reset horizon',
      'horizon.note': 'Window progress estimated from 5h / 7d / 30d cycles',
      'horizon.nearest': 'Nearest: {window}',
      'horizon.unknownReset': 'Reset time unknown',
      'horizon.rowAria': '{window} window is about {progress} elapsed, reset in {countdown}',
      'horizon.rowAriaUnknown': '{window} window progress unknown, resets in {countdown}',
      'section.trail.kicker': 'SAMPLE TRAIL',
      'section.trail': 'Sample trail',
      'trail.meta': '{n} samples · last 7 days',
      'trail.aria': 'Used-percent trails for all three windows over the last 7 days',
      'trail.empty': 'No samples yet',
      'trail.emptyHint': 'Successful reads leave a trail here; samples stay on this machine.',
      'trail.insufficient': 'Not enough samples',
      'trail.insufficientHint': 'At least two samples are needed to draw the trail; one is recorded every 60 seconds while this page is open.',
      'trail.point': '{time} · {window} used {percent}',
      'gauge.aria': 'Three quota rings: 5h used {rolling}, weekly used {weekly}, monthly used {monthly}',
      'gauge.used': 'Used {percent}',
      'gauge.unused': 'Unused {percent}',
      'gauge.unknown': 'Not reported',
      'gauge.reset': 'Resets in {countdown}',
      'gauge.focus': '{window} used {percent}',
      'legend.aria': 'Choose the quota window to inspect',
      'legend.reset': '{countdown} to reset',
      'legend.unknown': 'Reset —',
      'stale.title': 'Showing stale data.',
      'stale.text': 'Last refresh failed ({code}): {message}. Data fetched {time}.',
      'stale.retry': 'Fetch again',
      'error.title': 'Cannot read quota',
      'error.code': 'Error code: {code}',
      'error.hint.no-key': 'Configure OPENCODE_GO_API_KEY in DSH credentials, then retry.',
      'error.hint.unauthorized': 'The key is invalid, or this account has no OpenCode Go subscription.',
      'error.hint.network': 'Network unreachable or the request timed out. Try again later.',
      'error.hint.upstream': 'The upstream service is temporarily failing. Try again later.',
      'error.hint.bad-response': 'The API returned an unrecognized shape; the plugin may need an update.',
      'error.hint.bad-request': 'The plugin sent an invalid request; update the plugin or restart DSH.',
      'error.hint.unknown-endpoint': 'The plugin endpoints do not match; the plugin may need an update.',
      'error.hint.host-unavailable': 'The host RPC is not available yet; the host half may still be loading.',
      'error.hint.rpc-failed': 'The connection to the host dropped. Try again later.',
      'error.hint.generic': 'Try again later; if it keeps failing, check the plugin log.',
      'error.retry': 'Retry',
      'loading.title': 'Reading OpenCode Go quota…',
      'loading.hint': 'The first read usually takes under a second.',
      'footer.source': 'Source',
      'footer.key': 'Key',
      'footer.samples': '{n} samples',
      'footer.disclaimer': 'Data comes from the official OpenCode Go API, for reference only.',
      'footer.live': 'Fetched live',
      'footer.cached': 'Read from cache',
    }

    /* ------------------------------------------------------------- style sheet */

    const PAGE_CSS = [
      '.ogq-page{',
      '--ogq-surface:var(--dsw-alias-bg-base,#f5f3ee);',
      '--ogq-panel:var(--dsw-alias-bg-layer-1,#faf8f3);',
      '--ogq-ink:var(--dsw-alias-label-primary,#1d1b16);',
      '--ogq-muted:var(--dsw-alias-label-secondary,#7f7869);',
      '--ogq-faint:var(--dsw-alias-label-caption,#786f60);',
      '--ogq-border:var(--dsw-alias-border-l1,#e3ddd1);',
      '--ogq-subtle:var(--dsw-alias-bg-layer-3,#ece7dd);',
      '--ogq-accent:var(--dsw-alias-brand-primary,#da7756);',
      '--ogq-accent-ink:#ad5535;',
      '--ogq-accent-soft:rgba(218,119,86,.10);',
      '--ogq-accent-line:rgba(218,119,86,.40);',
      '--ogq-warn:#b4552f;',
      '--ogq-warn-soft:rgba(180,85,47,.10);',
      '--ogq-serif:var(--dsh-font-family-text,"思源宋体 VF","Source Han Serif","Noto Serif SC",serif);',
      '--ogq-mono:var(--dsh-font-family-code,"SF Mono","Consolas",monospace);',
      'box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:100%;overflow-y:auto;',
      'padding:16px 36px 12px;background-color:var(--ogq-surface);',
      'background-image:radial-gradient(1200px 520px at 82% -14%,rgba(218,119,86,.05),transparent 70%);',
      'color:var(--ogq-ink);font-family:var(--ogq-serif);font-size:13px;line-height:1.5;',
      '-webkit-font-smoothing:auto;',
      '}',
      '.ogq-page *,.ogq-page *::before,.ogq-page *::after{box-sizing:border-box;}',
      'body[data-ds-dark-theme] .ogq-page{',
      '--ogq-surface:var(--dsw-alias-bg-base,#24221f);',
      '--ogq-panel:var(--dsw-alias-bg-layer-1,#2b2824);',
      '--ogq-ink:var(--dsw-alias-label-primary,#f0ece4);',
      '--ogq-muted:var(--dsw-alias-label-secondary,#a49c8d);',
      '--ogq-faint:var(--dsw-alias-label-caption,#9a9081);',
      '--ogq-border:var(--dsw-alias-border-l1,#3a352e);',
      '--ogq-subtle:var(--dsw-alias-bg-layer-3,#2e2b26);',
      '--ogq-accent:var(--dsw-alias-brand-primary,#e08a6a);',
      '--ogq-accent-ink:#eaa287;',
      '--ogq-accent-soft:rgba(224,138,106,.09);',
      '--ogq-accent-line:rgba(224,138,106,.46);',
      '--ogq-warn:#d4775a;',
      '--ogq-warn-soft:rgba(212,119,90,.12);',
      'background-image:radial-gradient(1200px 520px at 82% -14%,rgba(224,138,106,.055),transparent 70%);',
      '}',
      '.ogq-shell{width:100%;max-width:1180px;margin:0 auto;display:flex;flex:1 0 auto;flex-direction:column;gap:9px;min-height:0;}',
      '.ogq-page button{font:inherit;}',
      '.ogq-page button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--ogq-accent));outline-offset:2px;}',
      '.ogq-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
      /* header */
      '.ogq-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;min-height:64px;}',
      '.ogq-headmain{display:flex;flex-direction:column;min-width:0;}',
      '.ogq-eyebrow{display:inline-flex;align-items:center;gap:10px;font-family:var(--ogq-mono);font-size:9px;line-height:1.4;font-weight:500;letter-spacing:.28em;text-transform:uppercase;color:var(--ogq-accent-ink);}',
      '.ogq-eyebrow::before{content:"";width:22px;height:1px;background:currentColor;opacity:.55;}',
      '.ogq-title{margin:2px 0 0;font-family:var(--ogq-serif);font-size:37px;line-height:1.08;font-weight:500;letter-spacing:.02em;color:var(--ogq-ink);}',
      '.ogq-sub{margin:4px 0 0;font-family:var(--ogq-mono);font-size:10.5px;line-height:1.5;letter-spacing:.03em;color:var(--ogq-muted);}',
      '.ogq-headside{display:flex;align-items:flex-end;gap:14px;margin-left:auto;}',
      '.ogq-statuscol{display:flex;flex-direction:column;align-items:flex-end;gap:3px;}',
      '.ogq-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--ogq-border);border-radius:999px;background:var(--ogq-panel);font-family:var(--ogq-mono);font-size:9px;line-height:1.4;letter-spacing:.11em;text-transform:uppercase;color:var(--ogq-muted);}',
      '.ogq-dot{width:5px;height:5px;border-radius:50%;background:var(--ogq-accent);box-shadow:0 0 0 3px var(--ogq-accent-soft);}',
      '.ogq-badge[data-state="cached"] .ogq-dot{background:var(--ogq-muted);box-shadow:none;}',
      '.ogq-badge[data-state="stale"]{color:var(--ogq-warn);border-color:var(--ogq-warn);background:var(--ogq-warn-soft);}',
      '.ogq-badge[data-state="stale"] .ogq-dot{background:var(--ogq-warn);box-shadow:none;}',
      '.ogq-badge[data-state="error"]{color:var(--ogq-warn);border-color:var(--ogq-warn);background:var(--ogq-warn-soft);}',
      '.ogq-badge[data-state="error"] .ogq-dot{background:var(--ogq-warn);box-shadow:none;}',
      '.ogq-badge[data-state="loading"] .ogq-dot{animation:ogq-pulse 1.6s ease-in-out infinite;}',
      '.ogq-updated{font-family:var(--ogq-mono);font-size:9.5px;letter-spacing:.02em;color:var(--ogq-faint);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.ogq-refresh{display:inline-flex;align-items:center;gap:7px;appearance:none;border:1px solid var(--ogq-border);border-radius:8px;background:var(--ogq-panel);color:var(--ogq-ink);font-family:var(--ogq-mono);font-size:10.5px;line-height:1.4;letter-spacing:.04em;padding:7px 12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease;}',
      '.ogq-refresh:hover:not(:disabled){background:var(--ogq-subtle);border-color:var(--ogq-muted);}',
      '.ogq-refresh:disabled{opacity:.55;cursor:default;}',
      '.ogq-refresh svg{width:12px;height:12px;flex:none;}',
      '.ogq-refresh[aria-busy="true"] svg{animation:ogq-spin 1s linear infinite;}',
      /* stale banner */
      '.ogq-banner{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--ogq-warn);border-left-width:3px;border-radius:7px;background:var(--ogq-warn-soft);font-family:var(--ogq-mono);font-size:10px;line-height:1.6;color:var(--ogq-ink);}',
      '.ogq-banner-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--ogq-warn);color:var(--ogq-panel);font-size:11px;font-weight:600;}',
      '.ogq-banner-text{flex:1;min-width:0;}',
      '.ogq-banner-text strong{font-weight:600;color:var(--ogq-warn);}',
      '.ogq-banner-btn{flex:none;appearance:none;border:1px solid var(--ogq-warn);border-radius:5px;background:transparent;color:var(--ogq-warn);font-family:var(--ogq-mono);font-size:9.5px;letter-spacing:.03em;padding:3px 8px;cursor:pointer;}',
      '.ogq-banner-btn:hover:not(:disabled){background:var(--ogq-warn);color:var(--ogq-panel);}',
      '.ogq-banner-btn:disabled{opacity:.55;cursor:default;}',
      /* cards + grid */
      '.ogq-grid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(0,.78fr);gap:10px;align-items:stretch;}',
      '.ogq-card{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid var(--ogq-border);border-radius:12px;background:var(--ogq-panel);box-shadow:0 1px 0 rgba(29,27,22,.02),0 20px 44px -40px rgba(29,27,22,.55);}',
      '.ogq-gaugecard{padding:18px 20px;justify-content:center;min-height:0;}',
      '.ogq-gaugecap{position:absolute;left:20px;top:15px;display:flex;align-items:baseline;gap:9px;pointer-events:none;}',
      '.ogq-gaugecap-title{font-family:var(--ogq-serif);font-size:12px;line-height:1.4;color:var(--ogq-muted);}',
      '.ogq-gaugeinner{display:flex;align-items:center;gap:18px;min-width:0;}',
      '.ogq-dial{position:relative;flex:none;width:380px;max-width:100%;}',
      '.ogq-dial svg{display:block;width:100%;height:auto;overflow:visible;}',
      '.ogq-tick{stroke:var(--ogq-muted);stroke-width:1.15;stroke-linecap:round;opacity:.34;}',
      '.ogq-tick.is-major{stroke:var(--ogq-ink);stroke-width:1.5;opacity:.5;}',
      '.ogq-ring-track{stroke:var(--ogq-muted);stroke-width:1.4;stroke-linecap:round;opacity:.42;}',
      '.ogq-ring.is-focus .ogq-ring-track{stroke-width:2;opacity:.55;}',
      '.ogq-ring-fill{stroke:var(--ogq-accent);stroke-width:9;stroke-linecap:round;opacity:.30;stroke-dasharray:100;stroke-dashoffset:0;animation:ogq-draw .6s cubic-bezier(.22,.61,.36,1) both;}',
      '.ogq-ring.is-focus .ogq-ring-fill{opacity:1;stroke-width:11;}',
      '.ogq-ring.is-focus .ogq-ring-fill:not(.is-warn){filter:drop-shadow(0 0 7px rgba(218,119,86,.28));}',
      '.ogq-ring-fill.is-warn{stroke:var(--ogq-warn);}',
      '.ogq-ring-halo{fill:var(--ogq-accent-soft);}',
      '.ogq-ring-dot{fill:var(--ogq-accent);stroke:var(--ogq-panel);stroke-width:2.5;}',
      '.ogq-ring-dot.is-warn{fill:var(--ogq-warn);}',
      '.ogq-gauge-label{fill:var(--ogq-muted);font-family:var(--ogq-mono);font-size:10px;letter-spacing:.3em;}',
      '.ogq-gauge-pct{fill:var(--ogq-ink);font-family:var(--ogq-mono);font-size:56px;font-weight:500;letter-spacing:-.05em;font-variant-numeric:tabular-nums;}',
      '.ogq-gauge-pct.is-warn{fill:var(--ogq-warn);}',
      '.ogq-gauge-split{fill:var(--ogq-muted);font-family:var(--ogq-mono);font-size:10px;letter-spacing:.01em;font-variant-numeric:tabular-nums;}',
      '.ogq-gauge-reset{fill:var(--ogq-muted);font-family:var(--ogq-mono);font-size:10.5px;letter-spacing:.01em;font-variant-numeric:tabular-nums;}',
      '.ogq-legend{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0;}',
      '.ogq-leg{position:relative;appearance:none;display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px;width:100%;padding:9px 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--ogq-ink);text-align:left;cursor:pointer;transition:background .15s ease,border-color .15s ease;}',
      '.ogq-leg:hover{background:var(--ogq-subtle);}',
      '.ogq-leg[aria-pressed="true"]{border-color:var(--ogq-accent-line);background:var(--ogq-accent-soft);}',
      '.ogq-leg[aria-pressed="true"]::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--ogq-accent);}',
      '.ogq-leg-ring{display:block;width:36px;height:36px;color:var(--ogq-muted);}',
      '.ogq-leg[aria-pressed="true"] .ogq-leg-ring{color:var(--ogq-accent);}',
      '.ogq-miniring{display:block;width:100%;height:100%;}',
      '.ogq-mini-track{stroke:currentColor;stroke-opacity:.18;}',
      '.ogq-mini-fill{stroke:currentColor;}',
      '.ogq-mini-fill.is-warn{stroke:var(--ogq-warn);}',
      '.ogq-mini-core{fill:currentColor;opacity:.55;}',
      '.ogq-leg-body{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"top pct" "cd cd" "status status";align-items:baseline;gap:1px 10px;min-width:0;}',
      '.ogq-leg-top{grid-area:top;display:flex;align-items:baseline;gap:7px;min-width:0;}',
      '.ogq-leg-name{font-family:var(--ogq-mono);font-size:11px;line-height:1.4;font-weight:600;letter-spacing:.07em;color:var(--ogq-ink);}',
      '.ogq-leg[aria-pressed="true"] .ogq-leg-name{color:var(--ogq-accent-ink);}',
      '.ogq-leg-desc{font-family:var(--ogq-serif);font-size:10px;line-height:1.4;color:var(--ogq-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ogq-leg-pct{grid-area:pct;font-family:var(--ogq-mono);font-size:19px;line-height:1.2;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--ogq-ink);}',
      '.ogq-leg-cd{grid-area:cd;font-family:var(--ogq-mono);font-size:9.5px;line-height:1.5;letter-spacing:.01em;color:var(--ogq-muted);font-variant-numeric:tabular-nums;}',
      '.ogq-leg-status{grid-area:status;font-family:var(--ogq-mono);font-size:9px;line-height:1.4;letter-spacing:.02em;color:var(--ogq-warn);}',
      /* forecast card */
      '.ogq-forecast{padding:16px 20px 14px;}',
      '.ogq-cardhead{display:flex;align-items:baseline;justify-content:space-between;gap:8px 14px;flex-wrap:wrap;}',
      '.ogq-cardheading{display:flex;align-items:baseline;gap:10px;min-width:0;}',
      '.ogq-kicker{font-family:var(--ogq-mono);font-size:9px;line-height:1.4;letter-spacing:.24em;text-transform:uppercase;color:var(--ogq-accent-ink);white-space:nowrap;}',
      '.ogq-cardtitle{margin:0;font-family:var(--ogq-serif);font-size:16px;line-height:1.3;font-weight:600;letter-spacing:.02em;color:var(--ogq-ink);white-space:nowrap;}',
      '.ogq-cardnote{margin:0;font-family:var(--ogq-mono);font-size:9.5px;line-height:1.5;letter-spacing:.01em;color:var(--ogq-muted);}',
      '.ogq-fc-note{margin:0;padding-top:8px;border-top:1px solid var(--ogq-border);font-family:var(--ogq-mono);font-size:9.5px;line-height:1.6;letter-spacing:.01em;color:var(--ogq-muted);}',
      '.ogq-fc-rows{display:flex;flex:1;flex-direction:column;justify-content:space-evenly;margin-top:6px;}',
      '.ogq-fc-row{display:flex;flex:1 1 0;flex-direction:column;justify-content:center;padding:13px 0;border-top:1px solid var(--ogq-border);}',
      '.ogq-fc-row:first-child{border-top:0;}',
      '.ogq-fc-top{display:flex;align-items:baseline;gap:7px;min-width:0;}',
      '.ogq-fc-name{font-family:var(--ogq-mono);font-size:11px;line-height:1.4;font-weight:600;letter-spacing:.07em;color:var(--ogq-ink);}',
      '.ogq-fc-desc{font-family:var(--ogq-serif);font-size:10px;color:var(--ogq-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ogq-fc-proj{margin-left:auto;font-family:var(--ogq-mono);font-size:22px;line-height:1.2;font-weight:500;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ogq-accent-ink);white-space:nowrap;}',
      '.ogq-fc-proj.is-warn{color:var(--ogq-warn);}',
      '.ogq-fc-proj.is-idle{font-family:var(--ogq-serif);font-size:12px;font-weight:400;letter-spacing:.01em;color:var(--ogq-faint);}',
      '.ogq-fc-bar{position:relative;height:5px;margin-top:8px;border-radius:2px;background:var(--ogq-subtle);overflow:hidden;}',
      '.ogq-fc-bar::after{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(90deg,transparent 0 23px,var(--ogq-panel) 23px 24px);pointer-events:none;}',
      '.ogq-fc-bar span{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(218,119,86,.5),var(--ogq-accent));}',
      '.ogq-fc-bar.is-warn span{background:var(--ogq-warn);}',
      '.ogq-fc-eta{margin-top:5px;font-family:var(--ogq-mono);font-size:9.5px;line-height:1.5;letter-spacing:.01em;color:var(--ogq-warn);text-align:right;font-variant-numeric:tabular-nums;}',
      /* horizon card */
      '.ogq-horizon{padding:10px 20px 12px;}',
      '.ogq-rulers{display:flex;flex-direction:column;margin-top:3px;}',
      '.ogq-ruler{display:grid;grid-template-columns:104px minmax(0,1fr) 150px;align-items:center;gap:16px;padding:5px 0;border-top:1px solid var(--ogq-border);}',
      '.ogq-ruler:first-child{border-top:0;}',
      '.ogq-ruler-meta{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.ogq-ruler-name{font-family:var(--ogq-mono);font-size:11px;line-height:1.35;font-weight:600;letter-spacing:.07em;color:var(--ogq-muted);}',
      '.ogq-ruler.is-nearest .ogq-ruler-name{color:var(--ogq-accent-ink);}',
      '.ogq-ruler-date{font-family:var(--ogq-mono);font-size:9.5px;line-height:1.4;letter-spacing:.01em;color:var(--ogq-faint);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.ogq-ruler-track{position:relative;height:26px;min-width:0;background-image:repeating-linear-gradient(90deg,var(--ogq-border) 0 1px,transparent 1px calc(100% / 20)),repeating-linear-gradient(90deg,var(--ogq-muted) 0 1px,transparent 1px calc(100% / 4)),linear-gradient(var(--ogq-border),var(--ogq-border));background-size:100% 6px,100% 12px,100% 1px;background-position:left bottom,left bottom,left bottom;background-repeat:repeat-x;}',
      '.ogq-ruler-track::after{content:"";position:absolute;right:0;bottom:0;width:1px;height:16px;background:var(--ogq-muted);opacity:.45;}',
      '.ogq-ruler-fill{position:absolute;left:0;bottom:4px;height:3px;border-radius:2px;background:var(--ogq-muted);opacity:.45;}',
      '.ogq-ruler-dot{position:absolute;bottom:2px;width:2px;height:22px;margin-left:-1px;border-radius:1px;background:var(--ogq-muted);}',
      '.ogq-ruler-dot::after{content:"";position:absolute;left:50%;top:-3px;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:inherit;box-shadow:0 0 0 2px var(--ogq-panel);}',
      '.ogq-ruler.is-nearest .ogq-ruler-fill{background:var(--ogq-accent);opacity:.85;}',
      '.ogq-ruler.is-nearest .ogq-ruler-dot{background:var(--ogq-accent);}',
      '.ogq-ruler-cd{font-family:var(--ogq-mono);font-size:11.5px;line-height:1.4;letter-spacing:.01em;color:var(--ogq-muted);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.ogq-ruler.is-nearest .ogq-ruler-cd{color:var(--ogq-accent-ink);}',
      /* trail card */
      '.ogq-trail{padding:12px 20px 10px;}',
      '.ogq-series{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end;}',
      '.ogq-series-chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--ogq-mono);font-size:9.5px;letter-spacing:.03em;color:var(--ogq-muted);white-space:nowrap;}',
      '.ogq-series-swatch{display:inline-block;width:13px;height:2px;border-radius:2px;background:var(--ogq-muted);}',
      '.ogq-series-swatch.is-rolling{background:var(--ogq-accent);}',
      '.ogq-series-swatch.is-weekly{background:var(--ogq-ink);opacity:.7;}',
      '.ogq-series-swatch.is-monthly{background:var(--ogq-muted);opacity:.7;}',
      '.ogq-trailplot{display:grid;grid-template-columns:30px minmax(0,1fr);grid-template-rows:auto auto;gap:3px 10px;margin-top:6px;min-width:0;}',
      '.ogq-yaxis{display:flex;flex-direction:column;justify-content:space-between;height:148px;font-family:var(--ogq-mono);font-size:9px;line-height:1;color:var(--ogq-faint);text-align:right;font-variant-numeric:tabular-nums;padding:1px 0;}',
      '.ogq-trailsvg{display:block;width:100%;height:148px;overflow:visible;}',
      '.ogq-gridline{stroke:var(--ogq-border);stroke-width:1;stroke-dasharray:2 4;vector-effect:non-scaling-stroke;opacity:.9;}',
      '.ogq-gridline.is-base{stroke-dasharray:none;opacity:1;}',
      '.ogq-line{fill:none;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;}',
      '.ogq-line.is-rolling{stroke:var(--ogq-accent);stroke-width:1.8;}',
      '.ogq-line.is-weekly{stroke:var(--ogq-ink);stroke-width:1.4;opacity:.7;}',
      '.ogq-line.is-monthly{stroke:var(--ogq-muted);stroke-width:1.25;stroke-dasharray:5 4;opacity:.9;}',
      '.ogq-line-dot{stroke:var(--ogq-panel);stroke-width:1.5;}',
      '.ogq-line-dot.is-rolling{fill:var(--ogq-accent);}',
      '.ogq-line-dot.is-weekly{fill:var(--ogq-ink);opacity:.75;}',
      '.ogq-line-dot.is-monthly{fill:var(--ogq-muted);}',
      '.ogq-hit{fill:transparent;stroke:none;cursor:crosshair;}',
      '.ogq-hit:hover{fill:var(--ogq-accent);opacity:.7;}',
      '.ogq-xaxis{grid-column:2;display:flex;justify-content:space-between;gap:8px;font-family:var(--ogq-mono);font-size:9.5px;letter-spacing:.02em;color:var(--ogq-faint);font-variant-numeric:tabular-nums;}',
      '.ogq-trail-empty{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;min-height:148px;margin-top:6px;padding:14px 16px;border:1px dashed var(--ogq-border);border-radius:8px;}',
      '.ogq-empty-title{margin:0;font-family:var(--ogq-serif);font-size:13px;font-weight:600;color:var(--ogq-muted);}',
      '.ogq-empty-text{margin:0;font-family:var(--ogq-mono);font-size:9.5px;line-height:1.6;color:var(--ogq-faint);}',
      /* footer */
      '.ogq-footdisclaimer{flex:1;justify-content:flex-end;min-width:0;}',
      '.ogq-foot{display:flex;align-items:center;justify-content:space-between;gap:6px 22px;flex-wrap:wrap;margin-top:auto;padding-top:9px;border-top:1px solid var(--ogq-border);font-family:var(--ogq-mono);font-size:9.5px;line-height:1.6;letter-spacing:.015em;color:var(--ogq-muted);}',
      '.ogq-foot-group{display:inline-flex;align-items:center;gap:8px;min-width:0;}',
      '.ogq-foot-label{font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ogq-faint);}',
      '.ogq-foot-value{color:var(--ogq-muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ogq-foot-sep{width:1px;height:9px;background:var(--ogq-border);}',
      '.ogq-foot-note{color:var(--ogq-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ogq-footdisclaimer .ogq-foot-note{color:var(--ogq-faint);}',
      /* icon */
      '.ogq-panelicon{display:block;flex:none;}',
      '.ogq-panelicon[data-active="false"]{opacity:.75;}',
      /* error + loading */
      '.ogq-error{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:22px 24px;border:1px solid var(--ogq-warn);border-left-width:3px;border-radius:10px;background:var(--ogq-panel);}',
      '.ogq-error-kicker{font-family:var(--ogq-mono);font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--ogq-warn);}',
      '.ogq-error-title{margin:0;font-family:var(--ogq-serif);font-size:19px;font-weight:600;line-height:1.3;color:var(--ogq-ink);}',
      '.ogq-error-message{margin:0;font-family:var(--ogq-mono);font-size:10px;line-height:1.6;color:var(--ogq-muted);word-break:break-word;max-width:70ch;}',
      '.ogq-error-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;}',
      '.ogq-error-code{font-family:var(--ogq-mono);font-size:8.5px;letter-spacing:.04em;color:var(--ogq-warn);padding:2px 7px;border:1px solid var(--ogq-warn);border-radius:999px;}',
      '.ogq-error-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--ogq-muted);}',
      '.ogq-error .ogq-refresh{margin-top:4px;}',
      '.ogq-skeletonpage{display:flex;flex-direction:column;gap:10px;}',
      '.ogq-skgrid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(0,.78fr);gap:10px;}',
      '.ogq-skcard{display:flex;flex-direction:column;gap:12px;min-height:180px;padding:18px;border:1px solid var(--ogq-border);border-radius:10px;background:var(--ogq-panel);}',
      '.ogq-skcard.is-tall{min-height:400px;align-items:center;justify-content:center;}',
      '.ogq-sk{position:relative;overflow:hidden;border-radius:5px;background:var(--ogq-subtle);}',
      '.ogq-sk::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,var(--ogq-panel),transparent);animation:ogq-shimmer 1.6s ease-in-out infinite;}',
      '.ogq-sk-circle{width:280px;max-width:90%;aspect-ratio:1;border-radius:50%;}',
      '.ogq-sk-line{height:10px;width:100%;}',
      '.ogq-sk-line.is-short{width:46%;}',
      '.ogq-sk-line.is-mid{width:72%;}',
      '.ogq-sk-rows{display:flex;flex-direction:column;gap:10px;width:100%;}',
      '.ogq-loading-note{display:flex;align-items:baseline;gap:10px;font-family:var(--ogq-mono);font-size:9.5px;color:var(--ogq-faint);}',
      '.ogq-loading-note strong{color:var(--ogq-muted);font-weight:500;}',
      /* motion */
      '@keyframes ogq-draw{from{stroke-dashoffset:100;}to{stroke-dashoffset:0;}}',
      '@keyframes ogq-spin{to{transform:rotate(360deg);}}',
      '@keyframes ogq-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
      '@keyframes ogq-shimmer{100%{transform:translateX(100%);}}',
      /* responsive */
      '@media (max-width:1199.98px){',
      '.ogq-dial{width:340px;}',
      '}',
      '@media (max-width:1099.98px){',
      '.ogq-grid,.ogq-skgrid{grid-template-columns:minmax(0,1fr);}',
      '.ogq-gaugecard{min-height:0;padding:18px 20px;}',
      '.ogq-gaugeinner{flex-direction:row;gap:22px;justify-content:center;}',
      '.ogq-legend{display:flex;flex-direction:column;max-width:430px;}',
      '.ogq-skcard.is-tall{min-height:320px;}',
      '}',
      '@media (max-width:879.98px){',
      '.ogq-gaugeinner{flex-direction:column;gap:14px;}',
      '.ogq-dial{width:300px;}',
      '.ogq-legend{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;max-width:none;}',
      '.ogq-leg-body{grid-template-columns:minmax(0,1fr);grid-template-areas:"top" "pct" "cd" "status";}',
      '}',
      '@media (max-width:719.98px){',
      '.ogq-page{padding:14px 14px 12px;}',
      '.ogq-shell{gap:9px;}',
      '.ogq-title{font-size:27px;}',
      '.ogq-head{min-height:0;gap:10px;}',
      '.ogq-headside{width:100%;align-items:center;justify-content:space-between;margin-left:0;}',
      '.ogq-statuscol{flex-direction:row;align-items:center;gap:8px;}',
      '.ogq-gaugecard{padding:14px;}',
      '.ogq-dial{width:280px;}',
      '.ogq-legend{grid-template-columns:minmax(0,1fr);}',
      '.ogq-leg{grid-template-columns:32px minmax(0,1fr);padding:8px 10px;}',
      '.ogq-leg-body{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"top pct" "cd cd" "status status";}',
      '.ogq-ruler{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"meta cd" "track track";row-gap:3px;padding:6px 0;}',
      '.ogq-ruler-meta{grid-area:meta;flex-direction:row;align-items:baseline;gap:8px;}',
      '.ogq-ruler-track{grid-area:track;}',
      '.ogq-ruler-cd{grid-area:cd;}',
      '.ogq-cardhead{gap:6px;}',
      '.ogq-cardnote{width:100%;}',
      '.ogq-trailplot{grid-template-columns:24px minmax(0,1fr);}',
      '.ogq-yaxis,.ogq-trailsvg{height:124px;}',
      '.ogq-foot{gap:5px 14px;justify-content:flex-start;}',
      '.ogq-footdisclaimer{flex:0 0 100%;width:100%;justify-content:flex-start;}',
      '.ogq-foot-note{white-space:normal;}',
      '.ogq-series{justify-content:flex-start;}',
      '}',
      '@media (prefers-reduced-motion:reduce){',
      '.ogq-ring-fill,.ogq-refresh[aria-busy="true"] svg,.ogq-badge[data-state="loading"] .ogq-dot,.ogq-sk::after{animation:none;}',
      '.ogq-ring-fill{stroke-dashoffset:0;}',
      '}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const tagId = PKG + '/styles'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      try {
        if (document.querySelector(selector) !== null) return () => {}
      } catch (_ignored) { /* no document.head yet */ }
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = tagId
      tag.textContent = PAGE_CSS
      document.head.appendChild(tag)
      return () => {
        try { tag.remove() } catch (_ignored) { /* already gone */ }
      }
    }

    /* ------------------------------------------------------------- primitives */

    function isObject(value) {
      return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    }

    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    function numeric(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function clampPercent(value) {
      const number = Number(value)
      return Number.isFinite(number) ? clamp(number, 0, 100) : 0
    }

    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value)
    }

    function round3(value) {
      return Math.round(value * 1000) / 1000
    }

    function truncate(text) {
      if (typeof text !== 'string') return ''
      const trimmed = text.trim()
      return trimmed.length > DETAIL_MAX ? trimmed.slice(0, DETAIL_MAX - 1) + '…' : trimmed
    }

    /** Defensive translator: never throws, never returns an empty string. */
    function makeT(t) {
      if (typeof t !== 'function') return (key) => key
      return (key, vars) => {
        try {
          const value = vars === undefined ? t(key) : t(key, vars)
          return typeof value === 'string' && value !== '' ? value : key
        } catch (_ignored) {
          return key
        }
      }
    }

    /** Unit vocabulary frozen by the contract (`5h` / `weekly` / `monthly`). */
    function windowLabel(key) {
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(WINDOW_LABELS, key)) {
        return WINDOW_LABELS[key]
      }
      return typeof key === 'string' ? key : ''
    }

    /**
     * Sort windows by used percent, highest first. Unknown windows (no usable
     * percent) sort last; ties resolve to `monthly` first (then weekly, then
     * rolling) so the default focus is deterministic.
     * @param windows - array of window objects.
     * @returns a new sorted array (input untouched).
     */
    function sortWindows(windows) {
      const list = Array.isArray(windows) ? windows.slice() : []
      const tieRank = { monthly: 0, weekly: 1, rolling: 2 }
      list.sort((left, right) => {
        const a = left !== null && left !== undefined && isFiniteNumber(left.percent) ? left.percent : -1
        const b = right !== null && right !== undefined && isFiniteNumber(right.percent) ? right.percent : -1
        if (b !== a) return b - a
        const ra = left && Object.prototype.hasOwnProperty.call(tieRank, left.key) ? tieRank[left.key] : 9
        const rb = right && Object.prototype.hasOwnProperty.call(tieRank, right.key) ? tieRank[right.key] : 9
        return ra - rb
      })
      return list
    }

    /**
     * Format a used percentage. Percentages are already 0–100 (values above 100
     * are kept verbatim); missing or non-finite input is unknown (`—`), never a
     * synthetic 0%.
     * @param value - used percent.
     * @param digits - decimal places (default 1).
     * @returns e.g. `41.0%`, or `—` when unknown.
     */
    function formatPercent(value, digits) {
      if (value === null || value === undefined) return '—'
      if (typeof value === 'string' && value.trim() === '') return '—'
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      const places = Number.isInteger(digits) && digits >= 0 ? digits : 1
      return Math.max(0, number).toFixed(places) + '%'
    }

    /**
     * Countdown in 天/时/分/秒 (zh) or d/h/m/s (en). Missing/negative input is
     * unknown (`—`); zero is a real "00 秒" so callers can distinguish it from
     * a window whose `resetAt` was absent.
     * @param totalSeconds - seconds until reset.
     * @param lang - `zh` or `en`.
     * @returns the countdown string.
     */
    function formatCountdown(totalSeconds, lang) {
      const number = Number(totalSeconds)
      if (!Number.isFinite(number) || number < 0) return '—'
      const total = Math.floor(number)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const english = lang === 'en'
      const parts = []
      const hasLarger = days > 0 || hours > 0 || minutes > 0
      if (days > 0) parts.push(english ? days + 'd' : days + ' 天')
      if (days > 0 || hours > 0) {
        const hourText = days > 0 ? pad2(hours) : String(hours)
        parts.push(english ? hourText + 'h' : hourText + ' 时')
      }
      if (hasLarger) {
        parts.push(english ? pad2(minutes) + 'm' : pad2(minutes) + ' 分')
      }
      const secondText = hasLarger ? pad2(seconds) : String(seconds)
      parts.push(english ? secondText + 's' : secondText + ' 秒')
      return parts.join(' ')
    }

    /** Short duration used by the forecast footnote (`6 天 12 时`, `21 时`). */
    function formatSpan(totalSeconds, lang) {
      const number = Number(totalSeconds)
      if (!Number.isFinite(number) || number <= 0) return lang === 'en' ? '0 s' : '0 秒'
      const total = Math.floor(number)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const english = lang === 'en'
      if (days > 0) {
        return english
          ? days + 'd' + (hours > 0 ? ' ' + hours + 'h' : '')
          : days + ' 天' + (hours > 0 ? ' ' + hours + ' 时' : '')
      }
      if (hours > 0) return english ? hours + 'h' : hours + ' 时'
      return english ? Math.max(1, minutes) + 'm' : Math.max(1, minutes) + ' 分'
    }

    /** Local `MM-DD HH:mm`, used for reset horizons. */
    function formatResetAt(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return ''
      try {
        const date = new Date(value)
        return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      } catch (_ignored) {
        return ''
      }
    }

    /** Local `MM-DD`, used by the trail x axis. */
    function formatDayLabel(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return ''
      try {
        const date = new Date(value)
        return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      } catch (_ignored) {
        return ''
      }
    }

    /** Local `MM-DD HH:mm:ss`, used by trail point tooltips. */
    function formatPointTime(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return ''
      try {
        const date = new Date(value)
        return formatDayLabel(value) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
      } catch (_ignored) {
        return ''
      }
    }

    function formatRelative(ms, now, t) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return t('time.unknown')
      const base = Number.isFinite(Number(now)) ? Number(now) : Date.now()
      const delta = Math.max(0, base - value)
      if (delta < 5000) return t('time.justNow')
      const seconds = Math.floor(delta / 1000)
      if (seconds < 60) return t('time.secondsAgo', { n: seconds })
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return t('time.daysAgo', { n: days })
      return formatResetAt(value)
    }

    /** Host + path only, so the footer never shows a query or credentials. */
    function displayUrl(url) {
      if (typeof url !== 'string' || url === '') return ''
      try {
        const parsed = new URL(url)
        return parsed.host + parsed.pathname
      } catch (_ignored) {
        return url
      }
    }

    /* --------------------------------------------------------------- geometry */

    function pointOnCircle(cx, cy, radius, degrees) {
      const radians = (degrees * Math.PI) / 180
      return {
        x: cx + radius * Math.cos(radians),
        y: cy + radius * Math.sin(radians),
      }
    }

    /**
     * SVG path for one gauge arc. Angles use SVG screen coordinates: 0° is
     * 3 o'clock, positive angles turn clockwise, so `start=150, sweep=240`
     * opens at the bottom like an instrument dial.
     * @param cx - center x.
     * @param cy - center y.
     * @param r - radius.
     * @param startDeg - start angle.
     * @param sweepDeg - total sweep (positive = clockwise).
     * @param fraction - 0..1 portion of the sweep to draw.
     * @returns an absolute `M … A …` path (`''` when nothing should be drawn).
     */
    function arcPath(cx, cy, r, startDeg, sweepDeg, fraction) {
      const values = [cx, cy, r, startDeg, sweepDeg, fraction].map((value) => Number(value))
      if (!values.every((value) => Number.isFinite(value))) return ''
      const [centerX, centerY, radius, start, sweep, amountRaw] = values
      if (radius <= 0 || Math.abs(sweep) < 0.0001) return ''
      const amount = clamp(amountRaw, 0, 1)
      if (amount <= 0) return ''
      const from = pointOnCircle(centerX, centerY, radius, start)
      const to = pointOnCircle(centerX, centerY, radius, start + sweep * amount)
      const largeArc = Math.abs(sweep * amount) > 180 ? 1 : 0
      const sweepFlag = sweep >= 0 ? 1 : 0
      return 'M ' + round3(from.x) + ' ' + round3(from.y)
        + ' A ' + round3(radius) + ' ' + round3(radius) + ' 0 ' + largeArc + ' ' + sweepFlag
        + ' ' + round3(to.x) + ' ' + round3(to.y)
    }

    /**
     * Tick marks around the gauge. The 24 ticks span the 240° sweep; every sixth
     * tick is major, giving a quiet clock face around the arcs.
     * @returns an array of `{ index, major, angle, x1, y1, x2, y2 }`.
     */
    function tickMarks(count, startDeg, sweepDeg, innerR, outerR, cx, cy) {
      const total = Number.isInteger(count) && count > 0 ? count : GAUGE_TICKS
      const start = Number.isFinite(Number(startDeg)) ? Number(startDeg) : GAUGE_START
      const sweep = Number.isFinite(Number(sweepDeg)) ? Number(sweepDeg) : GAUGE_SWEEP
      const inner = Number.isFinite(Number(innerR)) ? Number(innerR) : 164
      const outer = Number.isFinite(Number(outerR)) ? Number(outerR) : 171
      const centerX = Number.isFinite(Number(cx)) ? Number(cx) : GAUGE_CENTER
      const centerY = Number.isFinite(Number(cy)) ? Number(cy) : GAUGE_CENTER
      const marks = []
      for (let index = 0; index < total; index += 1) {
        const angle = start + (sweep * index) / total
        const from = pointOnCircle(centerX, centerY, inner, angle)
        const to = pointOnCircle(centerX, centerY, outer, angle)
        marks.push({
          index,
          major: index % 6 === 0,
          angle: round3(angle),
          x1: round3(from.x),
          y1: round3(from.y),
          x2: round3(to.x),
          y2: round3(to.y),
        })
      }
      return marks
    }

    /**
     * Evenly reduce a sample list for rendering, always keeping the first and
     * last point. Never mutates and never invents values.
     */
    function downsample(values, maxPoints) {
      const list = Array.isArray(values) ? values.slice() : []
      const max = Number.isFinite(Number(maxPoints)) ? Math.floor(Number(maxPoints)) : 0
      if (list.length === 0 || max <= 0) return []
      if (list.length <= max) return list
      if (max === 1) return [list[list.length - 1]]
      const result = []
      for (let index = 0; index < max; index += 1) {
        const source = Math.round((index * (list.length - 1)) / (max - 1))
        result.push(list[source])
      }
      return result
    }

    /**
     * Least-squares slope of one sample series, in percent per second.
     * @param points - `[{ t: ms, value: percent }]`, sorted by `t`.
     * @returns the slope, or null when it cannot be established.
     */
    function sampleSlope(points) {
      const list = Array.isArray(points) ? points : []
      if (list.length < FORECAST_MIN_SAMPLES) return null
      const origin = list[0].t
      let sumX = 0
      let sumY = 0
      let sumXY = 0
      let sumXX = 0
      for (const point of list) {
        const x = (point.t - origin) / 1000
        sumX += x
        sumY += point.value
        sumXY += x * point.value
        sumXX += x * x
      }
      const count = list.length
      const denominator = count * sumXX - sumX * sumX
      if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return null
      const slope = (count * sumXY - sumX * sumY) / denominator
      return Number.isFinite(slope) ? slope : null
    }

    /**
     * Local pacing forecast for one window.
     *
     * The projection is a **sample slope**, not an elapsed-time guess: samples
     * from the last 24 h are fitted with least squares and extrapolated to the
     * reset time.
     *
     *   slope      = leastSquares(percent over t)        [percent/second]
     *   projected  = percent + slope * resetInSec
     *   etaSec     = (100 - percent) / slope             (only when it will cap)
     *
     * Fewer than two recent samples (or no usable reset time) means there is
     * nothing honest to project, so `projected` is null and the UI shows `—`.
     * `elapsedFrac` is kept only for the reset-horizon ruler and is null when
     * `resetInSec > period` (clock skew or a 31-day month): the cycle length is
     * an assumption, and a window that has not started cannot be 1% elapsed.
     * @param window - `{ key, percent, resetInSec }` (`percent` may be null).
     * @param options - `{ periodSec, samples, now }`.
     * @returns projection details (numbers finite, or null when unknown).
     */
    function forecast(window, options) {
      const opts = isObject(options) ? options : {}
      const key = window && typeof window.key === 'string' ? window.key : ''
      const percentRaw = window === null || window === undefined ? null : window.percent
      const percent = isFiniteNumber(percentRaw) ? Math.max(0, percentRaw) : null
      const periodFromOption = Number(opts.periodSec)
      const period = Number.isFinite(periodFromOption) && periodFromOption > 0
        ? periodFromOption
        : (WINDOW_PERIOD_SEC[key] || 0)
      const resetRaw = Number(window && window.resetInSec)
      const resetInSec = Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw : null
      const horizonKnown = resetInSec !== null && period > 0 && resetInSec <= period
      const elapsedFrac = horizonKnown ? clamp((period - resetInSec) / period, 0, 1) : null
      const now = isFiniteNumber(opts.now) ? opts.now : Date.now()
      const since = now - FORECAST_WINDOW_MS
      const samples = Array.isArray(opts.samples) ? opts.samples : []
      const points = []
      for (const sample of samples) {
        if (!isObject(sample) || !isFiniteNumber(sample.t)) continue
        if (sample.t < since || sample.t > now) continue
        if (!isFiniteNumber(sample[key])) continue
        points.push({ t: sample.t, value: sample[key] })
      }
      points.sort((left, right) => left.t - right.t)
      const sampleCount = points.length
      const sampleSpanSec = sampleCount >= 2 ? (points[sampleCount - 1].t - points[0].t) / 1000 : 0
      const slopePerSec = sampleCount >= FORECAST_MIN_SAMPLES
        && sampleSpanSec >= FORECAST_MIN_SPAN_SEC
        ? sampleSlope(points)
        : null
      const capped = percent !== null && percent >= 100
      let projected = null
      let beyond = false
      if (capped) {
        projected = percent
      } else if (percent !== null && slopePerSec !== null && horizonKnown) {
        const projectedRaw = percent + slopePerSec * resetInSec
        if (Number.isFinite(projectedRaw)) {
          const value = Math.max(0, projectedRaw)
          if (value > FORECAST_MAX_PROJECTED) {
            projected = FORECAST_MAX_PROJECTED
            beyond = true
          } else {
            projected = value
          }
        }
      }
      let etaSec = null
      if (projected !== null && !capped && percent !== null && slopePerSec !== null
        && slopePerSec > 0 && projected > 100) {
        const eta = (100 - percent) / slopePerSec
        if (Number.isFinite(eta) && eta >= 0) etaSec = eta
      }
      const idle = percent === 0 && (projected === null || projected === 0)
      return {
        key,
        percent,
        projected,
        slopePerSec,
        sampleCount,
        sampleSpanSec,
        elapsedFrac,
        periodSec: period,
        remainingSec: resetInSec,
        etaSec,
        capped,
        beyond,
        idle,
        known: projected !== null,
        horizonKnown,
      }
    }

    /* -------------------------------------------------------------------- rpc */

    function failure(code, message, details) {
      return {
        ok: false,
        error: {
          code: typeof code === 'string' && code !== '' ? code : 'error',
          message: typeof message === 'string' && message !== '' ? message : (typeof code === 'string' && code !== '' ? code : 'error'),
          details: isObject(details) ? details : {},
        },
      }
    }

    /**
     * Normalize one `connection.rpc.call` outcome into `{ ok:true, value }` or
     * `{ ok:false, error:{ code, message, details } }`.
     *
     * The framework rewrites the Host envelope before the page sees it
     * (`parseConnectionResponse`): success is `{ ok:true, value }` and `data` is
     * dropped, failure must carry `{ code, message, details:object }`. `data` is
     * still accepted for an older Host shape; a bare Summary is accepted too.
     * Empty success and blank failure fields are turned into valid envelopes so
     * the UI never renders an undefined Summary or `[object Object]`.
     * @param result - whatever `connection.rpc.call` resolved to.
     * @returns the normalized outcome.
     */
    function normalizeResult(result) {
      if (!isObject(result)) return failure('bad-response', 'empty server response', {})
      if (result.ok === true) {
        const payload = isObject(result.value) ? result.value : (isObject(result.data) ? result.data : null)
        if (payload === null || !isObject(payload.windows)) {
          return failure('bad-response', 'missing summary windows in successful response', {})
        }
        return { ok: true, value: payload }
      }
      if (result.ok === undefined && isObject(result.windows)) {
        return { ok: true, value: result }
      }
      const raw = isObject(result.error) ? result.error : {}
      const code = typeof raw.code === 'string' && raw.code !== '' ? raw.code : 'error'
      const message = typeof raw.message === 'string' && raw.message.trim() !== ''
        ? truncate(raw.message)
        : code
      return {
        ok: false,
        error: {
          code,
          message,
          details: isObject(raw.details) ? raw.details : {},
        },
      }
    }

    function describeFailure(failureValue) {
      if (failureValue === null || failureValue === undefined) return ''
      if (typeof failureValue === 'string') return truncate(failureValue)
      if (typeof failureValue !== 'object') return truncate(String(failureValue))
      const message = typeof failureValue.message === 'string' ? failureValue.message : ''
      if (message !== '') return truncate(message)
      try {
        const text = JSON.stringify(failureValue)
        return text === undefined ? '' : truncate(text)
      } catch (_ignored) {
        return ''
      }
    }

    /**
     * Call one endpoint of the Host half over its shared `/api` Fetch route.
     * Never throws: an unavailable host half becomes `ok:false` so the page can
     * show an error state instead of pretend zeros.
     * @param root - context that resolves `connection`.
     * @param endpoint - `summary` or `refresh`.
     * @param payload - endpoint payload (currently `{}`).
     * @returns `{ ok:true, value }` or `{ ok:false, error }`.
     */
    async function callHost(root, endpoint, payload) {
      const connection = root !== null && root !== undefined && typeof root.get === 'function'
        ? root.get('connection')
        : undefined
      const rpc = connection && connection.rpc
      if (!rpc || typeof rpc.call !== 'function') {
        return failure('host-unavailable', 'connection.rpc is unavailable', {})
      }
      try {
        const result = await rpc.call(RPC_BASE, RPC_ENDPOINT, {
          endpoint,
          payload: isObject(payload) ? payload : {},
        })
        return normalizeResult(result)
      } catch (thrown) {
        return failure('rpc-failed', describeFailure(thrown) || 'connection.rpc call failed', {})
      }
    }

    /* --------------------------------------------------------------- summary */

    function summaryString(value) {
      return typeof value === 'string' ? value : ''
    }

    /**
     * Shape the three windows. A window the host marks `unknown` (or omits) has
     * no value at all: `percent` stays null so every view renders `—` instead
     * of a synthetic 0%. `status` is carried through and surfaced when it is
     * not `ok`.
     */
    function readWindows(summary) {
      const source = isObject(summary && summary.windows) ? summary.windows : {}
      return WINDOW_KEYS.map((key) => {
        const raw = isObject(source[key]) ? source[key] : null
        const status = raw === null ? 'unknown' : (summaryString(raw.status) || 'unknown')
        const percent = raw !== null && status !== 'unknown' && isFiniteNumber(raw.percent) ? raw.percent : null
        const resetAt = raw === null ? '' : summaryString(raw.resetAt)
        let resetInSec = raw !== null && isFiniteNumber(raw.resetInSec) ? Math.max(0, raw.resetInSec) : 0
        if (resetInSec === 0 && resetAt !== '') {
          const parsed = Date.parse(resetAt)
          if (Number.isFinite(parsed)) resetInSec = Math.max(0, Math.round((parsed - Date.now()) / 1000))
        }
        return {
          key,
          label: windowLabel(key),
          status,
          percent,
          resetAt,
          resetInSec,
          known: percent !== null,
        }
      })
    }

    /**
     * Keep only complete samples. A sample with a missing/non-finite window
     * value is dropped rather than coerced to 0, so the trail and the forecast
     * never read a fake point (the host only writes finite triples).
     */
    function readSamples(summary) {
      const list = []
      const raw = Array.isArray(summary && summary.samples) ? summary.samples : []
      for (const sample of raw) {
        if (!isObject(sample) || !isFiniteNumber(sample.t)) continue
        if (!isFiniteNumber(sample.rolling) || !isFiniteNumber(sample.weekly) || !isFiniteNumber(sample.monthly)) continue
        list.push({ t: sample.t, rolling: sample.rolling, weekly: sample.weekly, monthly: sample.monthly })
      }
      list.sort((left, right) => left.t - right.t)
      return list
    }

    /** Shape the untrusted Summary into the values the page renders. */
    function readSummary(summary) {
      const source = isObject(summary) ? summary : {}
      const samples = readSamples(source)
      const rawSource = isObject(source.source) ? source.source : {}
      const rawError = isObject(source.error) ? source.error : null
      const fetchedAt = isFiniteNumber(source.fetchedAt) ? source.fetchedAt : null
      const sampledSince = isFiniteNumber(source.sampledSince)
        ? source.sampledSince
        : (samples.length > 0 ? samples[0].t : null)
      return {
        fetchedAt,
        cached: source.cached === true,
        stale: source.stale === true,
        error: rawError === null ? null : {
          code: summaryString(rawError.code) || 'error',
          message: truncate(summaryString(rawError.message)),
          details: isObject(rawError.details) ? rawError.details : {},
        },
        source: {
          baseUrl: summaryString(rawSource.baseUrl),
          usageUrl: summaryString(rawSource.usageUrl),
          keyRef: summaryString(rawSource.keyRef),
          keyHint: summaryString(rawSource.keyHint),
        },
        windows: readWindows(source),
        samples,
        sampledSince,
      }
    }

    /**
     * Seconds until reset. Prefer the absolute `resetAt` (so the countdown keeps
     * moving between polls), fall back to the host's `resetInSec` anchor, and
     * return null when the reset time is genuinely unknown.
     */
    function remainingSeconds(window, fetchedAt, now) {
      if (window && typeof window.resetAt === 'string' && window.resetAt !== '') {
        const parsed = Date.parse(window.resetAt)
        if (Number.isFinite(parsed)) return Math.max(0, Math.round((parsed - now) / 1000))
      }
      if (window && isFiniteNumber(window.resetInSec) && window.resetInSec > 0) {
        const anchor = isFiniteNumber(fetchedAt) ? fetchedAt : now
        return Math.max(0, Math.round(window.resetInSec - (now - anchor) / 1000))
      }
      return null
    }

    /* --------------------------------------------------------------- icons */

    /**
     * Sidebar glyph: three concentric 240° arcs and a center dot, stroke-only
     * with `currentColor`, no external resource. Signature `({ size, active })`.
     */
    function PanelIcon(props) {
      const size = Number.isFinite(Number(props && props.size)) ? Number(props.size) : 16
      const active = props !== null && props !== undefined && props.active === true
      const stroke = active ? 2 : 1.55
      return h('svg', {
        className: 'ogq-panelicon',
        'data-active': active ? 'true' : 'false',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: arcPath(12, 12, 9.4, 150, 240, 1),
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: arcPath(12, 12, 6.5, 150, 240, 1),
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          opacity: 0.8,
        }),
        h('path', {
          d: arcPath(12, 12, 3.6, 150, 240, 1),
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          opacity: 0.62,
        }),
        h('circle', { cx: 12, cy: 12, r: active ? 1.25 : 1.1, fill: 'currentColor' }),
      )
    }

    function MiniRing(props) {
      const percent = props && props.percent
      const known = isFiniteNumber(percent)
      const warn = known && percent > 100
      const fill = known ? clampPercent(percent) : 0
      return h('svg', {
        className: 'ogq-miniring',
        'data-known': known ? 'true' : 'false',
        viewBox: '0 0 40 40',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          className: 'ogq-mini-track',
          d: arcPath(20, 20, 14, 150, 240, 1),
          fill: 'none',
          strokeWidth: 3,
          strokeLinecap: 'round',
        }),
        known && fill > 0 ? h('path', {
          className: 'ogq-mini-fill' + (warn ? ' is-warn' : ''),
          d: arcPath(20, 20, 14, 150, 240, fill / 100),
          fill: 'none',
          strokeWidth: 3,
          strokeLinecap: 'round',
        }) : null,
        h('circle', { className: 'ogq-mini-core', cx: 20, cy: 20, r: 1.8 }),
      )
    }

    const GAUGE_MARKS = tickMarks(GAUGE_TICKS, GAUGE_START, GAUGE_SWEEP, 170, 178, GAUGE_CENTER, GAUGE_CENTER)

    /* ------------------------------------------------------------- sub views */

    function Dial(props) {
      const t = props.t
      const lang = props.lang
      const windows = props.windows
      const focusKey = props.focusKey
      const fetchedAt = props.fetchedAt
      const now = props.now
      const focus = windows.find((window) => window.key === focusKey) || windows[0]
      const percent = focus.percent
      const known = isFiniteNumber(percent)
      const clamped = known ? clampPercent(percent) : 0
      const warn = known && percent > 100
      const remaining = remainingSeconds(focus, fetchedAt, now)
      const showDot = known && clamped > 0.5
      const dot = showDot
        ? pointOnCircle(GAUGE_CENTER, GAUGE_CENTER, GAUGE_RADIUS[focus.key] || 150, GAUGE_START + GAUGE_SWEEP * (clamped / 100))
        : null
      const byKey = {
        rolling: windows.find((window) => window.key === 'rolling') || { percent: null },
        weekly: windows.find((window) => window.key === 'weekly') || { percent: null },
        monthly: windows.find((window) => window.key === 'monthly') || { percent: null },
      }
      const aria = t('gauge.aria', {
        rolling: formatPercent(byKey.rolling.percent, 1),
        weekly: formatPercent(byKey.weekly.percent, 1),
        monthly: formatPercent(byKey.monthly.percent, 1),
      })
      // Focused ring last so it paints above the two quiet ones.
      const rings = windows.slice().sort((left, right) => {
        const a = left.key === focusKey ? 1 : 0
        const b = right.key === focusKey ? 1 : 0
        return a - b
      })
      const usedText = t('gauge.used', { percent: formatPercent(percent, 1) })
      const unusedText = t('gauge.unused', { percent: formatPercent(known ? Math.max(0, 100 - clamped) : null, 1) })
      const splitText = known ? usedText + ' · ' + unusedText : t('gauge.unknown')
      const resetText = remaining === null
        ? t('legend.unknown')
        : t('gauge.reset', { countdown: formatCountdown(remaining, lang) })
      return h('svg', {
        className: 'ogq-dial-svg',
        viewBox: '0 0 360 280',
        width: 360,
        height: 280,
        role: 'img',
        'aria-label': aria,
        focusable: 'false',
      },
        h('g', { key: 'ticks', className: 'ogq-ticks' }, GAUGE_MARKS.map((mark) => h('line', {
          key: mark.index,
          className: 'ogq-tick' + (mark.major ? ' is-major' : ''),
          x1: mark.x1,
          y1: mark.y1,
          x2: mark.x2,
          y2: mark.y2,
        }))),
        h('g', { key: 'rings' }, rings.map((window) => {
          const radius = GAUGE_RADIUS[window.key] || 150
          const isFocus = window.key === focusKey
          const ringPercent = isFiniteNumber(window.percent) ? clampPercent(window.percent) : null
          return h('g', { key: window.key, className: 'ogq-ring' + (isFocus ? ' is-focus' : '') },
            h('path', {
              className: 'ogq-ring-track',
              d: arcPath(GAUGE_CENTER, GAUGE_CENTER, radius, GAUGE_START, GAUGE_SWEEP, 1),
              fill: 'none',
            }),
            ringPercent !== null && ringPercent > 0 ? h('path', {
              className: 'ogq-ring-fill' + (window.percent > 100 ? ' is-warn' : ''),
              d: arcPath(GAUGE_CENTER, GAUGE_CENTER, radius, GAUGE_START, GAUGE_SWEEP, ringPercent / 100),
              fill: 'none',
              pathLength: 100,
            }) : null,
          )
        })),
        showDot ? h('circle', { key: 'halo', className: 'ogq-ring-halo', cx: round3(dot.x), cy: round3(dot.y), r: 11 }) : null,
        showDot ? h('circle', {
          key: 'dot',
          className: 'ogq-ring-dot' + (warn ? ' is-warn' : ''),
          cx: round3(dot.x),
          cy: round3(dot.y),
          r: 5.2,
        }) : null,
        h('text', {
          key: 'label',
          className: 'ogq-gauge-label',
          x: GAUGE_CENTER,
          y: 130,
          textAnchor: 'middle',
        }, windowLabel(focus.key)),
        h('text', {
          key: 'pct',
          className: 'ogq-gauge-pct' + (warn ? ' is-warn' : ''),
          x: GAUGE_CENTER,
          y: 196,
          textAnchor: 'middle',
        }, formatPercent(percent, 1)),
        h('text', {
          key: 'split',
          className: 'ogq-gauge-split',
          x: GAUGE_CENTER,
          y: 220,
          textAnchor: 'middle',
        }, splitText),
        h('text', {
          key: 'reset',
          className: 'ogq-gauge-reset',
          x: GAUGE_CENTER,
          y: 242,
          textAnchor: 'middle',
        }, resetText),
      )
    }

    function Legend(props) {
      const t = props.t
      const lang = props.lang
      const windows = props.windows
      const focusKey = props.focusKey
      const fetchedAt = props.fetchedAt
      const now = props.now
      return h('div', {
        className: 'ogq-legend',
        role: 'group',
        'aria-label': t('legend.aria'),
      }, windows.map((window) => {
        const active = window.key === focusKey
        const remaining = remainingSeconds(window, fetchedAt, now)
        const focused = t('gauge.focus', {
          window: t('window.' + window.key),
          percent: formatPercent(window.percent, 1),
        })
        return h('button', {
          key: window.key,
          type: 'button',
          className: 'ogq-leg',
          'aria-pressed': active ? 'true' : 'false',
          title: focused,
          onClick: () => props.onFocus(window.key),
        },
          h('span', { className: 'ogq-leg-ring' }, h(MiniRing, { percent: window.percent })),
          h('span', { className: 'ogq-leg-body' },
            h('span', { className: 'ogq-leg-top' },
              h('span', { className: 'ogq-leg-name' }, windowLabel(window.key)),
              h('span', { className: 'ogq-leg-desc' }, t('window.' + window.key))),
            h('span', { className: 'ogq-leg-pct' }, formatPercent(window.percent, 1)),
            h('span', { className: 'ogq-leg-cd' }, remaining === null
              ? t('legend.unknown')
              : t('legend.reset', { countdown: formatCountdown(remaining, lang) })),
            window.status !== 'ok'
              ? h('span', { className: 'ogq-leg-status' }, t('window.status', { status: window.status }))
              : null),
        )
      }))
    }

    function ForecastCard(props) {
      const t = props.t
      const lang = props.lang
      const windows = props.windows
      const samples = props.samples
      const now = props.now
      const rows = windows.map((window) => ({
        window,
        result: forecast(window, { periodSec: WINDOW_PERIOD_SEC[window.key], samples, now }),
      }))
      // Only claim a sample basis when a slope was actually fitted. The span
      // and count describe the recent samples the projection came from.
      const used = rows.filter((row) => row.result.sampleCount >= FORECAST_MIN_SAMPLES
        && row.result.sampleSpanSec >= FORECAST_MIN_SPAN_SEC)
      const spanSec = used.length === 0 ? 0 : Math.max(...used.map((row) => row.result.sampleSpanSec))
      const usedCount = used.length === 0 ? 0 : Math.max(...used.map((row) => row.result.sampleCount))
      let note = t('forecast.noSamples')
      if (used.length > 0) note = t('forecast.samples', { span: formatSpan(spanSec, lang), n: usedCount })
      return h('section', {
        className: 'ogq-card ogq-forecast',
        'aria-label': t('section.forecast'),
      },
        h('header', { className: 'ogq-cardhead' },
          h('div', { className: 'ogq-cardheading' },
            h('span', { className: 'ogq-kicker' }, t('section.forecast.kicker')),
            h('h2', { className: 'ogq-cardtitle' }, t('section.forecast'))),
          h('p', { className: 'ogq-cardnote' }, t('forecast.note'))),
        h('div', { className: 'ogq-fc-rows' }, rows.map((row) => {
          const window = row.window
          const result = row.result
          const projected = result.projected
          const unknown = projected === null
          const idle = !unknown && result.idle
          const warn = (projected !== null && projected > 100) || (isFiniteNumber(window.percent) && window.percent > 100)
          const projectedText = unknown
            ? t('forecast.unknown')
            : idle
              ? t('forecast.now')
              : result.beyond
                ? '> ' + formatPercent(FORECAST_MAX_PROJECTED, 0)
                : '≈ ' + formatPercent(projected, projected >= 100 ? 0 : 1)
          const eta = result.etaSec !== null
            ? t('forecast.eta', { time: formatCountdown(result.etaSec, lang) })
            : isFiniteNumber(window.percent) && window.percent >= 100
              ? t('forecast.capped')
              : ''
          const fill = projected === null ? null : Math.min(100, Math.max(0, projected))
          return h('div', { key: window.key, className: 'ogq-fc-row' },
            h('div', { className: 'ogq-fc-top' },
              h('span', { className: 'ogq-fc-name' }, windowLabel(window.key)),
              h('span', { className: 'ogq-fc-desc' }, t('window.' + window.key)),
              h('span', {
                className: 'ogq-fc-proj' + (warn ? ' is-warn' : '') + (idle || unknown ? ' is-idle' : ''),
              }, projectedText)),
            fill === null ? null : h('div', { className: 'ogq-fc-bar' + (warn ? ' is-warn' : '') },
              h('span', { style: { width: fill.toFixed(1) + '%' } })),
            eta === '' ? null : h('div', { className: 'ogq-fc-eta' }, eta),
          )
        })),
        h('p', { className: 'ogq-fc-note' }, note),
      )
    }

    function HorizonCard(props) {
      const t = props.t
      const lang = props.lang
      const windows = props.windows
      const fetchedAt = props.fetchedAt
      const now = props.now
      const rows = windows.map((window) => {
        const remaining = remainingSeconds(window, fetchedAt, now)
        const elapsedFrac = forecast(window, { periodSec: WINDOW_PERIOD_SEC[window.key], now }).elapsedFrac
        return {
          window,
          remaining,
          progress: remaining === null ? null : elapsedFrac,
        }
      })
      const known = rows.filter((row) => row.remaining !== null)
      const nearest = known.length === 0
        ? null
        : known.reduce((best, row) => (row.remaining < best.remaining ? row : best))
      return h('section', {
        className: 'ogq-card ogq-horizon',
        'aria-label': t('section.horizon'),
      },
        h('header', { className: 'ogq-cardhead' },
          h('div', { className: 'ogq-cardheading' },
            h('span', { className: 'ogq-kicker' }, t('section.horizon.kicker')),
            h('h2', { className: 'ogq-cardtitle' }, t('section.horizon'))),
          h('p', { className: 'ogq-cardnote' }, nearest === null
            ? t('horizon.note')
            : t('horizon.note') + ' · ' + t('horizon.nearest', { window: windowLabel(nearest.window.key) }))),
        h('div', { className: 'ogq-rulers' }, rows.map((row) => {
          const window = row.window
          const isNearest = nearest !== null && nearest.window.key === window.key
          const countdown = row.remaining === null ? '—' : formatCountdown(row.remaining, lang)
          const progress = row.progress === null ? null : clamp(row.progress, 0, 1)
          const resetText = window.resetAt === '' ? t('horizon.unknownReset') : formatResetAt(Date.parse(window.resetAt))
          return h('div', {
            key: window.key,
            className: 'ogq-ruler' + (isNearest ? ' is-nearest' : ''),
          },
            h('div', { className: 'ogq-ruler-meta' },
              h('span', { className: 'ogq-ruler-name' }, windowLabel(window.key)),
              h('span', { className: 'ogq-ruler-date' }, resetText === '' ? t('horizon.unknownReset') : resetText)),
            h('div', {
              className: 'ogq-ruler-track',
              role: 'img',
              'aria-label': progress === null
                ? t('horizon.rowAriaUnknown', {
                  window: t('window.' + window.key),
                  countdown,
                })
                : t('horizon.rowAria', {
                  window: t('window.' + window.key),
                  progress: formatPercent(progress * 100, 0),
                  countdown,
                }),
            },
              progress === null ? null : h('span', { className: 'ogq-ruler-fill', style: { width: (progress * 100).toFixed(1) + '%' } }),
              progress === null ? null : h('span', {
                className: 'ogq-ruler-dot',
                style: { left: 'clamp(3px, ' + (progress * 100).toFixed(1) + '%, calc(100% - 3px))' },
              })),
            h('span', { className: 'ogq-ruler-cd' }, countdown),
          )
        })),
      )
    }

    function TrailCard(props) {
      const t = props.t
      const lang = props.lang
      const windows = props.windows
      const samples = props.samples
      const now = props.now
      const domainEnd = now
      const domainStart = now - TRAIL_DAYS * 86400 * 1000
      // Keep the fixed 7-day x domain honest: points outside it are not drawn.
      // Count the real windowed samples before downsampling so the header never
      // reports the drawn point count.
      const windowed = samples.filter((sample) => isObject(sample)
        && isFiniteNumber(sample.t)
        && sample.t >= domainStart - 60000
        && sample.t <= domainEnd + 60000)
      const points = downsample(windowed, TRAIL_MAX_POINTS)
      const series = [
        { key: 'rolling', className: 'is-rolling' },
        { key: 'weekly', className: 'is-weekly' },
        { key: 'monthly', className: 'is-monthly' },
      ]
      let maxSeen = 0
      for (const sample of points) {
        for (const item of series) maxSeen = Math.max(maxSeen, Number(sample[item.key]) || 0)
      }
      for (const window of windows) {
        if (isFiniteNumber(window.percent)) maxSeen = Math.max(maxSeen, window.percent)
      }
      const axisMax = Math.max(20, Math.min(100, Math.ceil(maxSeen / 20) * 20))
      const width = 1000
      const height = 124
      const xOf = (time) => ((time - domainStart) / (domainEnd - domainStart)) * width
      const yFor = (value) => height - (Math.min(axisMax, Math.max(0, Number(value) || 0)) / axisMax) * height
      const gridValues = [axisMax, axisMax * 0.75, axisMax * 0.5, axisMax * 0.25, 0]
      const xTicks = [domainStart, domainStart + (domainEnd - domainStart) / 3, domainStart + ((domainEnd - domainStart) * 2) / 3, domainEnd]
      return h('section', {
        className: 'ogq-card ogq-trail',
        'aria-label': t('section.trail'),
      },
        h('header', { className: 'ogq-cardhead' },
          h('div', { className: 'ogq-cardheading' },
            h('span', { className: 'ogq-kicker' }, t('section.trail.kicker')),
            h('h2', { className: 'ogq-cardtitle' }, t('section.trail')),
            h('p', { className: 'ogq-cardnote' }, t('trail.meta', { n: windowed.length }))),
          h('div', { className: 'ogq-series' }, series.map((item) => {
            const window = windows.find((entry) => entry.key === item.key) || { percent: null }
            return h('span', { key: item.key, className: 'ogq-series-chip' },
              h('span', { className: 'ogq-series-swatch ' + item.className }),
              windowLabel(item.key),
              h('span', null, formatPercent(window.percent, 1)))
          }))),
        windowed.length === 0
          ? h('div', { className: 'ogq-trail-empty' },
            h('p', { className: 'ogq-empty-title' }, t('trail.empty')),
            h('p', { className: 'ogq-empty-text' }, t('trail.emptyHint')))
          : points.length < 2
            ? h('div', { className: 'ogq-trail-empty' },
              h('p', { className: 'ogq-empty-title' }, t('trail.insufficient')),
              h('p', { className: 'ogq-empty-text' }, t('trail.insufficientHint')))
            : h('div', { className: 'ogq-trailplot' },
            h('div', { className: 'ogq-yaxis', 'aria-hidden': 'true' }, gridValues.map((value, index) => h('span', {
              key: index,
            }, index === 0 ? value + '%' : String(value)))),
            h('svg', {
              className: 'ogq-trailsvg',
              viewBox: '0 0 1000 124',
              preserveAspectRatio: 'none',
              role: 'img',
              'aria-label': t('trail.aria'),
              focusable: 'false',
            },
              h('g', { key: 'grid' }, gridValues.map((value, index) => h('line', {
                key: index,
                className: 'ogq-gridline' + (index === gridValues.length - 1 ? ' is-base' : ''),
                x1: 0,
                x2: width,
                y1: round3(yFor(value)),
                y2: round3(yFor(value)),
              }))),
              series.map((item) => {
                const coordinates = points.map((sample) => round3(xOf(sample.t)) + ',' + round3(yFor(sample[item.key]))).join(' ')
                // A last-point dot marks "now"; it is drawn after the polyline.
                const last = points[points.length - 1]
                return h('g', { key: item.key },
                  h('polyline', {
                    className: 'ogq-line ' + item.className,
                    points: coordinates,
                  }),
                  h('circle', {
                    className: 'ogq-line-dot ' + item.className,
                    cx: round3(xOf(last.t)),
                    cy: round3(yFor(last[item.key])),
                    r: 2.6,
                  }))
              }),
              h('g', { key: 'hits' }, points.map((sample, index) => h('circle', {
                key: index,
                className: 'ogq-hit',
                cx: round3(xOf(sample.t)),
                cy: round3(yFor(Math.max(sample.rolling, sample.weekly, sample.monthly))),
                r: 4,
              }, h('title', null, t('trail.point', {
                time: formatPointTime(sample.t),
                window: windowLabel('rolling') + ' / ' + windowLabel('weekly') + ' / ' + windowLabel('monthly'),
                percent: formatPercent(sample.rolling, 1) + ' · ' + formatPercent(sample.weekly, 1) + ' · ' + formatPercent(sample.monthly, 1),
              }))))),
            ),
            h('div', { className: 'ogq-xaxis', 'aria-hidden': 'true' }, xTicks.map((time, index) => h('span', {
              key: index,
            }, formatDayLabel(time)))),
          ),
      )
    }

    function StatusBadge(props) {
      return h('span', {
        className: 'ogq-badge',
        'data-state': props.state,
        role: 'status',
      },
        h('span', { className: 'ogq-dot', 'aria-hidden': 'true' }),
        props.label)
    }

    function StaleBanner(props) {
      const t = props.t
      const error = isObject(props.error) ? props.error : {}
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'error'
      const message = typeof error.message === 'string' && error.message !== ''
        ? error.message
        : t('error.hint.generic')
      const fetched = props.fetchedAt === null || props.fetchedAt === undefined
        ? t('time.unknown')
        : formatRelative(props.fetchedAt, props.now, t)
      return h('div', { className: 'ogq-banner', role: 'status' },
        h('span', { className: 'ogq-banner-mark', 'aria-hidden': 'true' }, '!'),
        h('div', { className: 'ogq-banner-text' },
          h('strong', null, t('stale.title') + ' '),
          t('stale.text', { code, message, time: fetched })),
        h('button', {
          type: 'button',
          className: 'ogq-banner-btn',
          disabled: props.busy,
          onClick: props.onRetry,
        }, props.busy ? t('action.refreshing') : t('stale.retry')))
    }

    function ErrorState(props) {
      const t = props.t
      const error = isObject(props.error) ? props.error : {}
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'error'
      const message = typeof error.message === 'string' ? truncate(error.message) : ''
      const hinted = 'error.hint.' + code
      const hint = t(hinted) === hinted ? t('error.hint.generic') : t(hinted)
      return h('section', { className: 'ogq-error', role: 'alert', 'aria-label': t('error.title') },
        h('span', { className: 'ogq-error-kicker' }, 'ERROR'),
        h('h2', { className: 'ogq-error-title' }, t('error.title')),
        message === '' ? null : h('p', { className: 'ogq-error-message' }, message),
        h('div', { className: 'ogq-error-meta' },
          h('span', { className: 'ogq-error-code' }, t('error.code', { code })),
          h('p', { className: 'ogq-error-hint' }, hint)),
        h('button', {
          type: 'button',
          className: 'ogq-refresh',
          disabled: props.busy,
          onClick: props.onRetry,
        },
          h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
            h('path', {
              d: 'M13.2 7a5.2 5.2 0 1 0-.5 3.1M13.2 3.4V7h-3.6',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })),
          props.busy ? t('action.refreshing') : t('error.retry')),
      )
    }

    function LoadingSkeleton(props) {
      const t = props.t
      return h('div', {
        className: 'ogq-skeletonpage',
        'aria-busy': 'true',
        'aria-label': t('loading.title'),
      },
        h('span', { className: 'ogq-sr' }, t('loading.title')),
        h('div', { className: 'ogq-skgrid' },
          h('div', { className: 'ogq-skcard is-tall' },
            h('div', { className: 'ogq-sk ogq-sk-circle' })),
          h('div', { className: 'ogq-skcard' },
            h('div', { className: 'ogq-sk ogq-sk-line is-short' }),
            h('div', { className: 'ogq-sk ogq-sk-line is-mid' }),
            h('div', { className: 'ogq-sk ogq-sk-line' }),
            h('div', { className: 'ogq-sk ogq-sk-line is-short' }),
            h('div', { className: 'ogq-sk ogq-sk-line is-mid' }),
            h('div', { className: 'ogq-sk ogq-sk-line' }))),
        h('div', { className: 'ogq-skcard' },
          h('div', { className: 'ogq-sk ogq-sk-line is-short' }),
          h('div', { className: 'ogq-sk ogq-sk-line' }),
          h('div', { className: 'ogq-sk ogq-sk-line is-mid' })),
        h('div', { className: 'ogq-skcard' },
          h('div', { className: 'ogq-sk ogq-sk-line is-short' }),
          h('div', { className: 'ogq-sk ogq-sk-line is-mid' })),
        h('p', { className: 'ogq-loading-note' },
          h('strong', null, t('loading.title')),
          t('loading.hint')),
      )
    }

    function PageHeader(props) {
      const t = props.t
      const badge = props.badge
      const updated = props.updated
      return h('header', { className: 'ogq-head' },
        h('div', { className: 'ogq-headmain' },
          h('span', { className: 'ogq-eyebrow' }, t('eyebrow')),
          h('h1', { className: 'ogq-title' }, t('title')),
          h('p', { className: 'ogq-sub' }, t('subtitle'))),
        h('div', { className: 'ogq-headside' },
          h('div', { className: 'ogq-statuscol' },
            h(StatusBadge, { state: badge, label: t('badge.' + badge) }),
            updated === '' ? null : h('span', { className: 'ogq-updated' }, updated)),
          h('button', {
            type: 'button',
            className: 'ogq-refresh',
            'aria-busy': props.busy ? 'true' : 'false',
            'aria-label': t('action.refreshAria'),
            disabled: props.busy,
            onClick: props.onRefresh,
          },
            h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
              h('path', {
                d: 'M13.2 7a5.2 5.2 0 1 0-.5 3.1M13.2 3.4V7h-3.6',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              })),
            t('action.refresh'))))
    }

    function PageFooter(props) {
      const t = props.t
      const summary = props.summary
      const badge = props.badge
      const source = summary === null ? { usageUrl: '', keyRef: '', keyHint: '' } : summary.source
      const keyText = source.keyRef === ''
        ? '—'
        : source.keyRef + (source.keyHint === '' ? '' : ' · ' + source.keyHint)
      const url = displayUrl(source.usageUrl)
      return h('footer', { className: 'ogq-foot' },
        h('div', { className: 'ogq-foot-group' },
          h('span', { className: 'ogq-foot-label' }, t('footer.source')),
          h('span', { className: 'ogq-foot-value', title: source.usageUrl }, url === '' ? '—' : url)),
        h('div', { className: 'ogq-foot-group' },
          h('span', { className: 'ogq-foot-label' }, t('footer.key')),
          h('span', { className: 'ogq-foot-value' }, keyText)),
        h('div', { className: 'ogq-foot-group' },
          h('span', { className: 'ogq-foot-note' }, t('footer.samples', { n: summary === null ? 0 : summary.samples.length })),
          h('span', { className: 'ogq-foot-sep' }),
          h('span', { className: 'ogq-foot-note' }, badge === 'live' ? t('footer.live') : t('footer.cached'))),
        h('div', { className: 'ogq-foot-group ogq-footdisclaimer' },
          h('span', { className: 'ogq-foot-note' }, t('footer.disclaimer'))))
    }

    /* ------------------------------------------------------------------- page */

    /**
     * The whole OpenCode Go quota page registered on the keyed `main` slot.
     *
     * Pulls `summary` once on mount, then every `POLL_MS` while visible; the 1 s
     * tick only moves countdowns. Both timers, the visibility listener and the
     * in-flight guard are released on unmount. A failed pull with no data is a
     * full error state; with data it is a labelled stale banner over the last
     * good numbers. A failed pull never renders synthetic zeros.
     */
    function QuotaPage(props) {
      const t = makeT(props && props.t)
      const lang = t('meta.lang') === 'en' ? 'en' : 'zh'
      const requests = React.useRef({ summary: props && props.requestSummary, refresh: props && props.requestRefresh })
      requests.current = { summary: props && props.requestSummary, refresh: props && props.requestRefresh }

      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [busy, setBusy] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [focus, setFocus] = React.useState(null)
      const loadedRef = React.useRef(null)
      const runRef = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        let inFlight = false

        const apply = (outcome) => {
          if (cancelled) return
          if (outcome !== null && outcome !== undefined && outcome.ok === true) {
            const summary = readSummary(outcome.value)
            loadedRef.current = summary
            setData(summary)
            setError(summary.stale ? summary.error : null)
            setStatus(summary.stale ? 'stale' : 'ready')
            return
          }
          const failureValue = outcome !== null && outcome !== undefined && isObject(outcome.error)
            ? outcome.error
            : { code: 'error', message: '', details: {} }
          setError(failureValue)
          setStatus(loadedRef.current === null ? 'error' : 'stale')
        }

        const run = (kind) => {
          if (inFlight) return Promise.resolve()
          inFlight = true
          if (!cancelled) setBusy(true)
          const request = kind === 'refresh' ? requests.current.refresh : requests.current.summary
          return Promise.resolve()
            .then(() => (typeof request === 'function'
              ? request()
              : { ok: false, error: { code: 'host-unavailable', message: 'connection.rpc is unavailable', details: {} } }))
            .then((outcome) => {
              if (cancelled) return
              apply(outcome)
            })
            .catch((thrown) => {
              if (!cancelled) apply({ ok: false, error: { code: 'rpc-failed', message: describeFailure(thrown), details: {} } })
            })
            .finally(() => {
              inFlight = false
              if (!cancelled) setBusy(false)
            })
        }
        runRef.current = run

        let pollTimer = null
        let tickTimer = null
        const startTimers = () => {
          if (typeof setInterval !== 'function') return
          if (tickTimer === null) {
            tickTimer = setInterval(() => {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              setNow(Date.now())
            }, 1000)
          }
          if (pollTimer === null) {
            pollTimer = setInterval(() => {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              setNow(Date.now())
              run('summary')
            }, POLL_MS)
          }
        }
        const stopTimers = () => {
          if (pollTimer !== null) {
            try { clearInterval(pollTimer) } catch (_ignored) { /* already gone */ }
            pollTimer = null
          }
          if (tickTimer !== null) {
            try { clearInterval(tickTimer) } catch (_ignored) { /* already gone */ }
            tickTimer = null
          }
        }
        const onVisibility = () => {
          if (typeof document === 'undefined') return
          if (document.visibilityState === 'hidden') {
            stopTimers()
            return
          }
          setNow(Date.now())
          startTimers()
          run('summary')
        }

        run('summary')
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') startTimers()
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }

        return () => {
          cancelled = true
          stopTimers()
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [])

      const refresh = () => {
        const run = runRef.current
        if (typeof run !== 'function') return
        run('refresh')
      }

      const windows = data === null ? readWindows(null) : data.windows
      const sorted = sortWindows(windows)
      const defaultFocus = sorted.length > 0 ? sorted[0].key : 'rolling'
      const focusKey = focus !== null && windows.some((window) => window.key === focus) ? focus : defaultFocus
      const badge = status === 'loading' && data === null
        ? 'loading'
        : status === 'error' && data === null
          ? 'error'
          : status === 'stale'
            ? 'stale'
            : data !== null && data.cached
              ? 'cached'
              : 'live'
      const updated = data !== null && data.fetchedAt !== null
        ? t('meta.updated', { time: formatRelative(data.fetchedAt, now, t) })
        : status === 'loading' && data === null
          ? ''
          : t('meta.never')

      const content = []
      if (status === 'loading' && data === null) {
        content.push(h(LoadingSkeleton, { key: 'loading', t }))
      } else if (status === 'error' && data === null) {
        content.push(h(ErrorState, { key: 'error', t, error, busy, onRetry: refresh }))
      } else {
        if (status === 'stale') {
          content.push(h(StaleBanner, {
            key: 'stale',
            t,
            error,
            busy,
            fetchedAt: data === null ? null : data.fetchedAt,
            now,
            onRetry: refresh,
          }))
        }
        content.push(h('div', { key: 'grid', className: 'ogq-grid' },
          h('section', {
            className: 'ogq-card ogq-gaugecard',
            'aria-label': t('section.windows'),
          },
            h('div', { className: 'ogq-gaugecap' },
              h('span', { className: 'ogq-kicker' }, t('section.windows.kicker')),
              h('span', { className: 'ogq-gaugecap-title' }, t('section.windows'))),
            h('div', { className: 'ogq-gaugeinner' },
              h('div', { className: 'ogq-dial' },
                h(Dial, {
                  t,
                  lang,
                  windows,
                  focusKey,
                  fetchedAt: data === null ? null : data.fetchedAt,
                  now,
                })),
              h(Legend, {
                t,
                lang,
                windows,
                focusKey,
                fetchedAt: data === null ? null : data.fetchedAt,
                now,
                onFocus: setFocus,
              }))),
          h(ForecastCard, {
            t,
            lang,
            windows,
            samples: data === null ? [] : data.samples,
            now,
          })))
        content.push(h(HorizonCard, {
          key: 'horizon',
          t,
          lang,
          windows,
          fetchedAt: data === null ? null : data.fetchedAt,
          now,
        }))
        content.push(h(TrailCard, {
          key: 'trail',
          t,
          lang,
          windows,
          samples: data === null ? [] : data.samples,
          now,
        }))
        content.push(h(PageFooter, {
          key: 'footer',
          t,
          summary: data,
          badge,
        }))
      }

      return h('section', {
        className: 'ogq-page',
        'data-panel': PANEL_ID,
        'aria-label': t('page.aria'),
      },
        h('div', { className: 'ogq-shell' },
          h(PageHeader, {
            t,
            badge,
            updated,
            busy,
            onRefresh: refresh,
          }),
          content,
        ),
      )
    }

    /* --------------------------------------------------------------- install */

    /** Register both dictionaries; the probe falls back to the per-locale form. */
    function registerDictionaries(ctx) {
      const dispose = []
      const remember = (value) => {
        if (typeof value === 'function') dispose.push(value)
      }
      const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
      if (locale === undefined || locale === null || typeof locale.register !== 'function') return () => {}
      try {
        remember(locale.register(NS, { zh, en }))
      } catch (_typedFormFailed) {
        /* fall through to the per-locale form */
      }
      const probe = typeof locale.bind === 'function' ? locale.bind(NS) : undefined
      const resolved = typeof probe === 'function'
        ? (() => {
          try { return probe('panel') } catch (_ignored) { return undefined }
        })()
        : undefined
      if (resolved === undefined || resolved === 'panel') {
        try { remember(locale.register(NS, 'zh', zh)) } catch (_ignored) { /* no locale service */ }
        try { remember(locale.register(NS, 'en', en)) } catch (_ignored) { /* no locale service */ }
      }
      return () => {
        for (const off of dispose) {
          try { off() } catch (_ignored) { /* already disposed */ }
        }
      }
    }

    /**
     * Register the page, the sidebar row and the dictionaries.
     * @param ctx - Client root context (slots/locale injected).
     */
    function install(ctx) {
      const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
      const bound = locale !== undefined && locale !== null && typeof locale.bind === 'function'
        ? locale.bind(NS)
        : undefined
      const t = makeT(bound)

      ctx.effect(() => installStyles(), PKG + ': styles')
      ctx.effect(() => registerDictionaries(ctx), PKG + ': dictionaries')

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          requestSummary: () => callHost(ctx, 'summary', {}),
          requestRefresh: () => callHost(ctx, 'refresh', {}),
        }),
      }, QuotaPage))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        locale: NS,
        label: () => t('panel'),
      }, PanelIcon))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        install(ctx)
      },
      /** Test seam: pure helpers and the two registered components. */
      __internals: {
        formatCountdown,
        formatPercent,
        formatSpan,
        formatRelative,
        forecast,
        sampleSlope,
        arcPath,
        tickMarks,
        downsample,
        normalizeResult,
        callHost,
        windowLabel,
        sortWindows,
        readSummary,
        readWindows,
        readSamples,
        Dial,
        Legend,
        ForecastCard,
        HorizonCard,
        TrailCard,
        QuotaPage,
        PanelIcon,
        PAGE_CSS,
        dictionaries: { zh, en },
        constants: {
          PKG,
          NS,
          PANEL_ID,
          PANEL_ORDER,
          RPC_BASE,
          RPC_ENDPOINT,
          POLL_MS,
          WINDOW_KEYS,
          WINDOW_PERIOD_SEC,
          FORECAST_WINDOW_MS,
          FORECAST_MIN_SAMPLES,
        },
      },
    }
  },
})
