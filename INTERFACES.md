# dsh-opencode-go-usage — 冻结接口契约（写作前必读）

所有并行写作都以此文件为准。**改契约必须先改本文件并通知 Lead。**

## 0. 目标与已确认决策

左侧栏一个「OpenCode Go 用量」入口 → 打开整页「额度观测窗」，展示官方订阅接口返回的 **5h / weekly / monthly 三档已用百分比**、重置时间，以及本地采样出来的趋势与节奏预测。

已确认决策（不要再讨论、不要再改）：

1. **插件整页**。不做侧栏卡片、不做浮窗/HUD、不注入宿主外壳 DOM、不改宿主主题 Token。侧栏只加一个入口行，点击进入 keyed `main` 页。
2. **只用官方接口** `GET https://opencode.ai/zen/go/v1/usage`。不抓网页、不解析控制台 DOM、不做 token/成本/模型维度的估算。
3. **密钥只放 DSH credentials**。默认账号复用 `OPENCODE_GO_API_KEY`；用户在页面里添加的账号由插件生成独立 ref，用 `credentials.set` 写进同一个 DSH 凭据库（`.credentials.yaml`）。插件不写自己的密钥文件、不打印密钥、不在页面显示完整 key；`accounts.json` 只存标签、id 与 ref。多账号切换只影响“看哪个号”，不改变 DSH 的路由配置。
4. **本地采样**。官方接口只给瞬时百分比，所以由宿主半在本地落一份 7 天采样，用于绘制轨迹与节奏预测。采样是本插件**唯一的持久化状态**。
5. **运行时零依赖**。不新增 `dependencies`；宿主半只用 Node 内置模块 + 全局 `fetch`，客户端半只 `require('react')`。
6. **视觉对齐 Claude Code 桌面端主题**：暖米色表面、陶土橙强调、宋体界面、暖色深色版。

## 1. 文件所有权（写入范围互不重叠）

| 文件 | 所有者 | 说明 |
|---|---|---|
| `package.json` / `cordis.patch.yml` / `locale/zh.json` / `locale/en.json` / `icon.svg` / `README.md` / `INTERFACES.md` / `.gitignore` | contract | 已冻结（本文件负责人写完即只读） |
| `lib/host.js` / `test/host.test.mjs` / `scripts/probe-live.mjs` | host | 宿主半、宿主单测、活体探针 |
| `lib/client.js` / `test/client.test.mjs` / `tools/*` | client | 客户端半、客户端单测、调试工具 |
| `artifacts/*`（截图、对照图） + `lib/client.js` 中**仅视觉 CSS 段** | visual | 只改颜色/字距/间距/圆角这类样式常量 |

冲突规则：

- `visual` 只能动 `client.js` 里的样式常量与 CSS 文本，**不得**改数据流、RPC 调用、注册参数、locale 键。
- `host` 与 `client` 各自只写自己的文件；`test/` 下按 `host.test.mjs` / `client.test.mjs` 分摊。
- 任何契约变更（字段、错误码、路径、order、超时/采样参数）先改本文件。

## 2. 常量（两端必须逐字一致）

```js
const PKG = 'dsh-opencode-go-usage'
const NS = 'opencode-go-usage'          // locale namespace + 侧栏 label 的 i18n ns
const PANEL_ID = 'opencode-go-usage'    // sidebar.panellist id === main key
const PANEL_ORDER = 30                  // 插件页=0，自动化任务=10，token 用量=20
const RPC_BASE = '/api'
const RPC_ENDPOINT = 'dsh-opencode-go-usage/call'
const RPC_PATH = '/api/dsh-opencode-go-usage/call'
```

## 3. 官方接口与响应形状

请求：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
Accept: application/json
```

`200` 响应（已实测）：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 12.5, "resetsAt": "2026-10-21T18:00:00.000Z" },
    "weekly":  { "status": "ok", "percent": 41.0, "resetsAt": "2026-10-26T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 8.25, "resetsAt": "2026-11-01T00:00:00.000Z" }
  }
}
```

口径与容错（一律按**不可信输入**处理）：

- `percent` 是**已用百分比**（0–100），不是剩余。所有文案写「已用」/「已使用」，**禁止**写「剩余」。
- 三档语义固定：`rolling` = 5 小时滚动窗口（UI label `5h`）、`weekly` = 周窗口、`monthly` = 月窗口。键名不得改写成别的（如 `fiveHour` / `week`）。
- `resetsAt` 是 ISO 8601 字符串，用 `Date.parse` 算 `resetInSec`；不可解析时保留原字符串且 `resetInSec = 0`（UI 显示 `—`）。
- `percent` 非有限数（NaN/Infinity/非 number/缺失）→ 该档 `percent: null`（UI 显示 `—`，**绝不补 0**）。整档缺失 → 该档 `status: 'unknown'`、`percent: null`、`resetAt: ''`、`resetInSec: 0`，**不抛错**。
- 某档有有限 `percent` 但 `status` 缺失/不是非空字符串时，`status` 记为 `ok`；`status` 是空字符串且 `percent` 不可用时记为 `unknown`。
- `percent` **保留上游原值**（可能 >100），不在 host 侧 clamp；客户端绘制时自己 clamp 到 `[0,100]`。
- `status` 原样透传（字符串）。`status: 'unknown'`（或整档缺失）优先于同档 percent，客户端显示 `—` 而不是那个可疑数字；若上游只给了有限 percent 而没给 status，host 补 `status: 'ok'`，客户端正常渲染。
- 超时 15s（`AbortSignal.timeout(15_000)`，可被配置 `timeoutMs` 覆盖）。同一时刻只允许 **1 个在途请求**，并发调用合并到同一个 Promise。
- 请求头只带 `Authorization` + `Accept`；**不要**带 `cookie`、`origin`、浏览器 UA 伪装。

## 4. 密钥解析（唯一允许的路径）

按从高到低的优先级，取第一个能给出**非空字符串**的结果：

1. `config.apiKeyEnv` —— 插件配置项，默认 `'OPENCODE_GO_API_KEY'`。它是**引用名**，不是密钥值。
2. `settings.get('llm-pi-ai').providers['opencode-go'].apiKeyEnv` —— 当前 profile 已把它指向 `OPENCODE_GO_API_KEY`；同处可读 `baseURL`。
3. 拿到引用名 `ref` 后取值：`credentials.resolve(ref)`。
4. `credentials.resolve(ref)` 取不到 → `process.env[ref]`。

硬约束（违反即视为 bug）：

- **`llm-deepseek` 只允许作为 `baseURL` 的最后兜底，绝不读它的 `apiKeyEnv`。** 两个订阅方的用量不能混在一个页面上。
- 不遍历 `process.env` 猜密钥、不读其它插件目录/配置文件里的 key、不做“第一个 Bearer 长串”之类的启发式。
- 解析不到或空串 → 直接 `no-key`，**不要**发一个没有 `Authorization` 的请求去试。
- `source.keyRef` 只放**引用名**（如 `OPENCODE_GO_API_KEY`）；`source.keyHint` 只放**后 4 位**（如 `…A1b2`），密钥长度 < 8 时放 `'…'`。密钥值绝不进 Summary、绝不进日志、绝不进错误 message。

`baseURL` 归一（同优先级链，但第 3 步只允许 baseURL）：

1. `config.baseUrl`（如有）→ 2. `llm-pi-ai … providers['opencode-go'].baseURL` → 3. `llm-deepseek … providers['opencode-go'].baseURL`（**仅 baseURL**）→ 4. 缺省 `https://opencode.ai`。

`usageUrl` 推导：baseUrl 去掉尾部 `/` 后，若已以 `/zen/go/v1` 结尾 → `baseUrl + '/usage'`；否则 → `baseUrl + '/zen/go/v1/usage'`。`source.baseUrl` 存归一后（去尾斜杠）的值。

### 4.1 多账号

账号 = 一个 key 引用 + 一个标签，**不是** DSH provider。

| id | label | key 来源 | 可换 Key | 可删 |
|---|---|---|---|---|
| `default` | `accounts.json.defaultLabel`（空则 UI 显示本地化「默认账号」） | §4 的解析链 | 否（去 DSH 凭据改 `OPENCODE_GO_API_KEY`） | 否 |
| `acc-xxxxxxxx` | `accounts.json` 里的 label（空则 UI 显示「账号 …后4位」） | 插件生成的 ref → `credentials.resolve(ref)` → `process.env[ref]` | 是 | 是 |

- 最多 **8** 个账号（含 default）。id 形如 `acc-[a-z0-9]{8}`，ref 形如 `OPENCODE_GO_USAGE_ACC_[A-Z0-9]{8}`。
- key 规范化：trim → 去一个前导 `Bearer `（忽略大小写）→ 去 CR/LF → 拒绝任何空白 → 长度 8–512。
- 新 key 与 default 或任何现有账号解析出的 key 相同 → `duplicate-key`，不写入。
- 默认账号未配置且已有已配置的自定义账号时，初始 active 取第一个已配置账号；`summary` 不带 `accountId` 时也按这条走。
- 自定义账号的 ref 被外部删掉 → 该账号 `configured:false`，页面显示 `no-key`，可换 Key 或删除。
- 所有账号共用同一个 `baseUrl`（§4 的 baseURL 链），不做每账号 baseURL。

## 5. 插件 RPC

宿主半注册一条 `POST /api/dsh-opencode-go-usage/call`，与 `dsh-token-usage` 同款信封：

```js
// host
ctx.connection.fetch.register({
  path: RPC_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handleApiRequest,
})
// client
connection.rpc.call(RPC_BASE, RPC_ENDPOINT, { endpoint, payload })
```

**请求**：

```json
{ "type":"client-request", "rpcId":"<uuid>",
  "method":"dsh-opencode-go-usage/call",
  "payload":{ "endpoint":"summary", "payload":{} } }
```

端点七个：

| endpoint | payload | 成功 value |
|---|---|---|
| `summary` | `{accountId?}` | Summary |
| `refresh` | `{accountId?}` | Summary |
| `accounts.list` | `{}` | `{activeId, accounts:[AccountInfo]}` |
| `accounts.add` | `{label?, apiKey}` | `{accounts, activeId, summary, warning?}` |
| `accounts.update` | `{id, label?, apiKey?}` | `{accounts, activeId, summary}` |
| `accounts.remove` | `{id}` | `{accounts, activeId}` |
| `accounts.activate` | `{id}` | `{accounts, activeId}` |

- `summary` / `refresh`：`accountId` 缺省时用当前 active；未知 id → `account-not-found`。`refresh` 永远绕过该账号的 TTL，但仍受 15s 超时与单飞约束。
- `AccountInfo = { id, label, keyRef, keyHint, isDefault, configured }`；`activeId` 是 host 持久化的 active（见 §4.1 的回落规则）。
- `accounts.add`：先校验 key、写凭据、写元数据，再用该 key 实时打一次上游。401/403 → 回滚（`unset` + 删元数据）并返回 `unauthorized`；`network`/`upstream` → 保留账号，`summary:null` 且带 `warning:{code,message}`。
- `accounts.update`：`id=default` 时只接受 `label`；传 `apiKey` → `default-key-managed`。自定义账号换 Key 会清空该账号缓存与采样桶；校验 401 时恢复旧 key。
- `accounts.remove`：删元数据、`unset` ref（best effort）、删采样桶；`id=default` → `cannot-remove-default`。
- `accounts.activate`：只持久化 active，不触发取数；客户端随后自行调用 `summary`。
- 所有 payload 必须容忍缺失、非对象、多余字段（未知参数忽略，不报错）。未知 `endpoint` → `ok:false, code:'unknown-endpoint'`。

**响应（★ 已被运行期证伪一次，务必照此写）**：

```json
{ "type":"server-response", "rpcId":"<same>",
  "result":{ "ok":true, "value": <Summary> } }

{ "type":"server-response", "rpcId":"<same>",
  "result":{ "ok":false, "error":{ "code":"…", "message":"…", "details": {} } } }
```

框架约束（证据：`@deepseek-ai/dsh-client-connection/lib/client.browser.js` 的 `parseConnectionResponse`，token-usage 实测踩过）：

- 成功的 `result` **只被读 `value`**。写 `data` 会被丢弃，客户端拿到 `{ok:true, value:undefined}`。
- 失败的 `error` 必须是 `{ code: string, message: string, details: object }`。缺 `message`，或 `details` 不是对象 → 直接抛 `invalid server-response failure`。
- 因此两端都要有 `normalizeResult` 收口：`ok:true` 但 value 为空 → 转成 failure；failure 的 code/message 为空 → 填默认值，details 非对象 → `{}`。
- `connection.rpc.call` 最终返回框架重写后的 `{ok:true,value}` / `{ok:false,error}`。

## 6. Summary（客户端唯一数据源）

```js
{
  fetchedAt: number,          // 最近一次【成功】上游取数的 ms；从未成功 = 本次响应生成时间
  cached: boolean,            // true = 本次没打上游（TTL 命中或兜底旧值）
  stale: boolean,             // true = 本次取数失败，值是兜底旧数据
  error: { code: string, message: string } | null,   // null = 本次数据来自成功取数
  source: { baseUrl: string, usageUrl: string, keyRef: string, keyHint: string },
  account: { id: string, label: string, keyRef: string, keyHint: string, isDefault: boolean },
  windows: {
    rolling: { key: 'rolling', label: '5h',      status: string, percent: number | null, resetAt: string, resetInSec: number },
    weekly:  { key: 'weekly',  label: 'weekly',  status: string, percent: number | null, resetAt: string, resetInSec: number },
    monthly: { key: 'monthly', label: 'monthly', status: string, percent: number | null, resetAt: string, resetInSec: number }
  },
  samples: [{ t: number, rolling: number, weekly: number, monthly: number }],  // 升序
  sampledSince: number | null   // 最早样本 t；无样本 → null
}
```

字段语义：

- `fetchedAt` 只表示“这份数字是什么时候从上游拿到的”，不是响应生成时间（唯一例外：从未成功过）。
- `label` 固定为 `'5h' | 'weekly' | 'monthly'`（单位语汇，**不翻译**，不随 locale 变）。中文说明由 UI 在 label 旁另加，不改契约值。
- `account.label` 对 default 是 `accounts.json.defaultLabel`（可为空，UI 回退到本地化「默认账号」）；对自定义账号是用户填的标签（可为空，UI 回退到「账号 …后4位」）。`account` 里永远没有 key。
- `resetInSec = max(0, round((Date.parse(resetAt) - now) / 1000))`；解析失败 → `0`。
- `samples` / `sampledSince` 必须与 `windows` 同源（同一次成功取数才追加），不得为了“图好看”插值或补点。
- 所有数字是真 `number`，不用字符串数字；未知一律 0 / `null`（UI 显示 `—`），绝不 NaN。

缓存与节奏参数（默认值，改动须改本文件）：

| 参数 | 值 | 含义 |
|---|---|---|
| 内存软 TTL | 30s | **按账号**：TTL 内 `summary` 回该账号缓存，`cached:true, stale:false` |
| `refresh` | 永远绕过 TTL | 但受 15s 超时与单飞约束；只刷新请求的那个账号 |
| 兜底可用窗口 | 6h | **按账号**：超过 6h 的旧值不再兜底 → `ok:false` |
| 客户端轮询 | 60s | 只轮询当前 active 账号；页面不可见时暂停 |

> 上表三个时限以当前实现为准，且必须与代码逐字一致：`lib/host.js` 的 `DEFAULT_CONFIG.cacheTtlMs = 30_000` / `timeoutMs = 15_000`，`lib/client.js` 的 `POLL_MS = 60_000`（对应界面副标「60 秒采样」），`scripts/probe-live.mjs` 的 `TIMEOUT_MS = 15_000`。轮询间隔大于软 TTL，所以每次轮询都会真正打一次上游；改任一处都必须同步改本表与 README。

错误码（5 个业务码 + 2 个框架码是正常路径；`empty-result` / `serialization-failed` / 裸 `error` 只作内部兜底，正常不应出现）：

| code | 触发条件 | UI 提示方向 |
|---|---|---|
| `no-key` | 没解析到密钥，或解析到空串 | 去 DSH credentials 配置 `OPENCODE_GO_API_KEY` |
| `unauthorized` | 上游 401 / 403 | 密钥无效，或该账号没有 Go 订阅 |
| `network` | DNS / 连接失败 / TLS / 超时 | 网络不通，稍后重试 |
| `upstream` | 其它非 2xx（429、5xx…） | 上游临时故障 |
| `bad-response` | 2xx 但 JSON 不符合 §3 的结构 | 接口可能变了，需更新插件 |
| `bad-request` | 信封不合法（框架级） | 内部错误 |
| `unknown-endpoint` | 未知 endpoint（框架级） | 内部错误 |
| `host-unavailable` / `rpc-failed` | 客户端拿不到 `connection.rpc` 或传输失败 | 宿主半未加载 / 刷新重试 |
| `invalid-key` | 添加/换 Key 时 key 为空、含空白、长度不在 8–512、或不是字符串 | 提示检查粘贴内容 |
| `duplicate-key` | 新 key 与 default 或任一现有账号相同 | 提示这个号已经加过 |
| `too-many-accounts` | 已有 8 个账号（含 default） | 提示先删一个 |
| `key-store-unavailable` | `ctx.credentials.set` 不存在、抛错或服务不可用 | 提示 DSH 凭据服务不可用，未保存 |
| `account-not-found` | 未知 / 已删除的 accountId | 刷新账号列表 |
| `default-key-managed` | 试图给 default 换 key | 去 DSH 凭据改 `OPENCODE_GO_API_KEY` |
| `cannot-remove-default` | 试图删除 default | 默认账号不能删 |
| `account-store-failed` | `accounts.json` 写失败（凭据已回滚） | 提示重试 |
| `account-changed` | 请求在途时该账号被换 Key / 删除，结果不再可信 | 自动重试；页面显示短暂错误 |

`stale` 判定表（**照表实现，不要自行发挥**）：

| 情况 | RPC result | Summary |
|---|---|---|
| 上游成功 | `ok:true` | `fetchedAt=now, cached:false, stale:false, error:null` |
| TTL 内命中缓存 | `ok:true` | `cached:true, stale:false, error:null` |
| 取数失败 + 有 ≤6h 旧值 | `ok:true` | `cached:true, stale:true, error:{code,message}` |
| 取数失败 + 无旧值 / 旧值 >6h | `ok:false` | `error.code` = 上表 5 个业务码之一 |
| `no-key` | `ok:false`，**即使有缓存** | 配置错误优先于兜底，避免用户误以为还在正常读数 |

`details` 可以放 `{ status, usageUrl, reason }` 之类的诊断信息，**不得**放密钥、不得放上游响应全文（避免整包塞进日志/界面）。

## 7. 本地采样

- 路径：`<DSH_HOME>/opencode-go-usage/samples.json`，`DSH_HOME` 缺省 `~/.dsh`。
- 文件形状（v2，按账号分桶）：

```json
{ "version": 2, "updatedAt": 1792570000000,
  "accounts": {
    "default": { "fingerprint": "a1b2c3d4e5f60718",
                 "samples": [ { "t": 0, "rolling": 12, "weekly": 41, "monthly": 8 } ] }
  } }
```

- v1 `{version:1, samples:[…]}` 或裸数组在加载时自动迁移到 `default` 桶，旧轨迹保留。
- `fingerprint = sha256(apiKey).slice(0,16)`，只存在采样文件里，**不返回客户端、不进日志**。读取或追加时发现指纹与桶里记录的不同 → 清空该桶（默认账号在 DSH 里换 key、或外部改了 ref 时，轨迹不会串号）。
- **只在成功取数、且三档 `percent` 都是有限数时写入**。失败或部分 200 不写 —— 否则会把旧值重复采样成一条平线，或给缺失档补一条假 0 线，污染节奏预测。
- 去重：若最后一点与本次相差 `< 30_000ms` → **就地替换**最后一点；否则追加。
- 裁剪：每桶先丢 `t < now - 7*86400*1000`，再从头部丢到 ≤ **10080** 点（7 天 × 60s）。账号上限 8，总点数有界。
- 删除账号或给它换 Key 时删掉该桶（`drop`），避免孤儿数据。
- 写：best-effort 原子写（`mkdir -p` 目录 → 写 `samples.json.tmp.<pid>` → `renameSync`）。任何 IO 失败只写本地日志，**绝不影响 RPC 返回**。
- 读：进程启动时容错解析；坏文件当空对象处理，并（best effort）覆盖为新文件；不因采样失败阻塞页面。
- 进程内常驻内存副本；`summary` 只读当前账号的桶，不读盘。
- 采样不做跨设备同步，也不进 DSH 的 session 日志。**非当前账号不采样**：轨迹与预测只在该账号被查看时增长。

## 8. 客户端注册契约

```js
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: PANEL_ID, locale: NS,
  inject: () => ({
    requestSummary: (accountId) => callHost(ctx, 'summary', accountId ? { accountId } : {}),
    requestRefresh: (accountId) => callHost(ctx, 'refresh', accountId ? { accountId } : {}),
    requestAccounts: () => callHost(ctx, 'accounts.list', {}),
    requestAddAccount: (input) => callHost(ctx, 'accounts.add', input),
    requestUpdateAccount: (input) => callHost(ctx, 'accounts.update', input),
    requestRemoveAccount: (id) => callHost(ctx, 'accounts.remove', { id }),
    requestActivateAccount: (id) => callHost(ctx, 'accounts.activate', { id }),
  }),
}, QuotaPage))

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, locale: NS,
  label: () => t('panel'),
}, UsageIcon))   // 组件签名 ({ size, active }) => JSX
```

- `PANEL_ORDER = 30`（排在插件页 0 / 自动化任务 10 / token 用量 20 之后）。
- 词典：`ctx.effect(() => registerDictionaries(ctx), PKG + ': dictionaries')`，用 `locale.register(NS, { zh, en })`，并用 `locale.bind(NS)('panel')` 探针回落逐语言注册形式（参考 `dsh-token-usage/lib/client.js:1038-1065`）。
- 样式：`ctx.effect(() => installStyles(), PKG + ': styles')`，样式只注入一次、卸载时移除。
- 页面轮询 60s + 手动刷新（`POLL_MS = 60_000`，界面副标「60 秒采样」与此一致）；`document.visibilityState === 'hidden'` 时暂停轮询；卸载清定时器（走 `ctx.effect` 的 dispose）。
- `inject: ['slots', 'locale']`；`ctx.get('connection')` 取 RPC 客户端，取不到时给 `host-unavailable` 错误态，**不要**假装 0%。
- 图标必须 `currentColor`，不写死颜色，不依赖外部资源。

## 9. 客户端模块格式

```js
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ctx.locale.register / bind, ctx.slots.inject ...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) { install(ctx) },
      __internals: { /* 纯函数测试缝：格式化、clamp、预测、normalizeResult、callHost */ },
    }
  },
})
```

- **只 `require('react')`**。禁止 `require` 任何 `@deepseek-ai/*` 包；禁止 import 本包的 `lib/host.js`（客户端半在浏览器里跑）。
- 文件是纯 `.js`，**不用 JSX**，一律 `h(...)`。
- 客户端不 import `lib/*`；百分比/相对时间/紧凑数字等小函数在 `client.js` 内自带一份（刻意的少量重复）。
- 所有可见文案走 ns `opencode-go-usage`，zh/en 键一一对应；`locale/*.json` 只放插件市场展示的 `meta.title/description`。

## 10. 设计 token 与布局概念

主题是「额度观测窗」：安静、纸感、只有一处彩色重音。

| token | 浅色 | 深色（暖） | 用途 |
|---|---|---|---|
| surface | `#f5f3ee` | `#24221f` | 页面背景 |
| panel | `#faf8f3` | `#2b2824` | 卡片/仪表底 |
| ink | `#1d1b16` | `#f0ece4` | 主文字、环底色 |
| muted | `#7f7869` | `#a49c8d` | 次级标签、刻度 |
| border | `#e3ddd1` | `#3a352e` | 1px 分隔与卡片描边 |
| subtle | `#ece7dd` | `#2e2b26` | 轨道、hover 底 |
| accent | `#da7756` | `#e08a6a` | 已用弧、当前档、唯一重音 |
| accent-soft | `rgba(218,119,86,.12)` | `rgba(224,138,106,.16)` | 高亮底、预测带 |
| warn | `#b4552f` | `#d4775a` | 接近/超过 100% 的环与文案 |

字体：UI `"思源宋体 VF", "Source Han Serif", "Noto Serif SC", serif`；数字与刻度 `"SF Mono", "Consolas", monospace`（等宽避免百分比跳动）。数字用 `font-variant-numeric: tabular-nums`。

布局（从上到下，最大宽约 1160px 居中，外层是一张 12px 圆角的「窗口」卡片）：

1. **页头**：`OPENCODE GO` eyebrow + 标题「额度观测窗」+ 副标「官方 /zen/go/v1/usage · 60 秒采样」+ 状态徽标（实时/缓存/stale/加载）+ 最后取数时间（相对时间）+ 刷新按钮。
2. **账号栏（全宽）**：一排 chip（默认账号 + 每个自定义账号 + 「添加账号」），右侧「管理」。当前账号用 accent-soft 底 + accent 描边；未配置的 chip 带 warn 小点。窄屏横向滚动。**不做**总览条、不做并排仪表。
3. **管理面板（账号栏下方内联展开）**：默认账号可改名（不可换 Key / 删除）；自定义账号可改名、换 Key、删除（行内二次确认）；底部是添加表单（标签可选 + key 密码框 + 验证并添加）。不用 `position:fixed` 遮罩。
4. **三档额度卡（左）**：三环嵌套的 240° 仪表（外环 monthly、中环 weekly、内环 rolling，起点 150° 顺时针 240°），24 个刻度；圆心只显示当前聚焦档的大字百分比（`clamp` 后绘制）、已用/未用与重置倒计时；弧按 `clamp(percent,0,100)` 画，>100 时该圈改为 `warn` 色（不额外叠环）。右侧三行真实按钮图例（迷你环 + 名称/说明 + 百分比 + 倒计时），默认聚焦已用最高的档。
5. **节奏预测卡（右）**：用最近 24h 的采样斜率推「按当前速率，到重置时约 X%」，三档各一行，带分段进度条；至少需要 2 个采样且跨度 ≥ 1 小时，否则显示 `—` 与「采样不足，稍后自动更新」；外推 > 300% 时显示 `> 300%`。**必须**带「预测」字样与样本跨度/数量，不得描述成官方配额。只使用当前账号的桶。
6. **重置地平线（全宽）**：三条时间刻度尺（5h / 7d / 30d），填充表示窗口已过时间，指针在「现在」，右端是重置端帽 + 实时倒计时；最近的一档用 `accent` 高亮。这是时间轴，不是用量条，页头需注明「窗口进度按 5h / 7d / 30d 周期估算」。
7. **采样轨迹（全宽）**：7 天、三档折线的零依赖 SVG，悬停点显示 `t` 与 percent；0 个样本显示「还没有采样」，1 个样本显示「采样不足」，不画假折线。只画当前账号的桶。
8. **页脚**：`source.usageUrl`（只显示 host + path）+ 「账号标签 · keyHint」+ 采样点数 + 实时/缓存 + 一句「数据来自 OpenCode Go 官方接口，仅供参考」。

禁忌：编造数值、显示完整密钥、用「剩余」措辞、把颜色字面量散落在组件里（统一走上面的 token 常量）、用 `position:fixed` 覆盖宿主外壳。

## 11. 验证命令

```bash
cd "D:/deep seek harness/chat task/dsh-opencode-go-usage" && node --test
node --check lib/host.js
node --check lib/client.js
node scripts/probe-live.mjs
```

- `probe-live.mjs`：真打一次官方接口，打印 `usageUrl`、HTTP 状态、三档 `percent` 与 `resetAt`，**不打印密钥**（最多打印 `keyHint`）。
- 宿主半诊断日志（best effort）：`%TEMP%\opencode-go-usage-host.log`，只写 code、URL、耗时，不写密钥与响应全文。
- 安装/更新：**新 bundle 的宿主半（`lib/host.js` + `cordis.patch.yml`）需要重启 DSH 才生效**；客户端半改完重新加载插件即热更新。
