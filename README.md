# dsh-opencode-go-usage

在 DeepSeek Harness Web GUI 左侧栏加一个 **OpenCode Go 订阅用量**入口，点开是一整页仪表盘：官方接口的 **5 小时 / 每周 / 每月** 三档额度已用百分比、重置倒计时，以及本地采样出来的轨迹与节奏预测。页面顶部可以**添加多把 API Key、在多个账号之间切换**，适合同时订阅了多个 OpenCode Go 账号的人。

> 新装（或改了宿主半）的 bundle **需要重启 DSH 才生效**；只改客户端半时重新加载插件即可热更新。

## 界面

- **左栏入口**：侧栏「OpenCode Go 用量」，图标是三个同心弧 + 中心点，跟随主题色（`currentColor`）。
- **整页仪表盘**，自上而下：
  1. **页头**：标题、口径副标、最后取数时间、刷新按钮；数据来自兜底缓存时显示「旧数据」徽标与失败原因。
  2. **账号栏**：默认账号 + 每个自定义账号 + 「添加账号」；右侧「管理」展开内联的账号面板（改名 / 换 Key / 删除 / 添加）。
  3. **三环仪表**：`5h` / `weekly` / `monthly` 三档嵌套在同一个 240° 仪表盘里（开口在底部，外环月、中环周、内环 5h），圆心是当前聚焦档的大字已用百分比、未用比例与重置倒计时；右侧三行图例可切换聚焦档，默认选已用最高的一档。超过 100% 时该圈改为警示色。
  4. **节奏预测**：用采样斜率（至少 2 个点、跨度 ≥1 小时）推算「按当前速率到重置时大约会到多少」，标注样本跨度；不足 1 小时显示「采样不足」，外推超过 300% 显示 `> 300%`。**只用本轮周期内的采样**：每档在重置时会归零（5h 每 5 小时归零一次），跨过重置点的样本不参与拟合，否则那一跌会被当成「正在下降」，重置后几小时里一直算出 `≈ 0.0%`。这是本地推算，不是官方配额。
  5. **重置地平线**：一条时间轴标出三档的下次重置，最近的那档高亮。
  6. **采样轨迹**：7 天的三档折线（零依赖 SVG），可看到额度是怎么被用掉的。
- 视觉沿用 Claude Code 桌面端主题：暖米色表面 `#f5f3ee`、墨色文字 `#1d1b16`、陶土橙强调 `#da7756`、描边 `#e3ddd1`；界面宋体、数字等宽；深色模式是同一套配色的暖暗版（`#24221f` 表面）。
- **跟着列宽换版式，不跟窗口宽度**：宿主把页面压窄（侧栏、缩放、分屏）时，二栏变单栏、仪表与三档图例上下堆叠、重置地平线收成两行，任何宽度下文字都不会互相压住。

## 数据源与口径

只有一个数据源，官方接口：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

返回 `{ "usage": { "rolling": {…}, "weekly": {…}, "monthly": {…} } }`，每档是 `{ "status", "percent", "resetsAt" }`。

口径说明：

- `percent` 是**已用**百分比，不是剩余。界面上所有数字都写「已用」。
- 三档窗口：`rolling` = **5 小时滚动窗口**（界面写作 `5h`）、`weekly` = 每周、`monthly` = 每月。
- 重置时间取上游 `resetsAt`（ISO 8601），倒计时由本地时间换算；上游没给或格式不对就显示 `—`。
- 数字**不修补**：上游给了 100 以上就照原值显示（环画满 + 警示），缺档显示 `—`，不会编一个 0。
- 请求超时 15 秒；同一时刻只有一个在途请求，连续刷新会合并。
- 内存缓存 30 秒：30 秒内打开/切回页面直接读缓存，不重复打接口；「刷新」按钮强制穿透缓存。
- 页面可见时每 60 秒自动取一次数（界面副标写作「60 秒采样」），切换标签页隐藏时暂停。缓存 30 秒短于轮询间隔，所以每次轮询都会取一次上游最新值。

## 密钥解析

插件**不写自己的密钥文件**，所有 key 都交给 DSH credentials 保管。**默认账号**复用 `OPENCODE_GO_API_KEY`，解析顺序：

1. 插件配置项 `apiKeyEnv`（默认 `OPENCODE_GO_API_KEY`）——这是**引用名**；
2. 否则读当前 profile 的 `llm-pi-ai` 服务里 `providers['opencode-go'].apiKeyEnv`（本机已指向同一个引用名）；
3. 用这个引用名向 DSH credentials 取值（`credentials.resolve`）；
4. 取不到再退回同名环境变量 `process.env[引用名]`。

`baseURL` 的兜底顺序是：插件配置 `baseUrl` → `llm-pi-ai` 的 `providers['opencode-go'].baseURL` → `llm-deepseek` 的 `providers['opencode-go'].baseURL`（**只取该路由的 baseURL**）→ 默认 `https://opencode.ai`。

> `llm-deepseek` 只用来兜底 baseURL，**绝不读它的 `apiKeyEnv`**：两个订阅方的额度不能混在一起看。

界面上只显示账号标签和密钥后 4 位（如 `…A1b2`），完整密钥不会出现在页面、日志或错误信息里。

## 多账号

页面顶部的账号栏里：

- **默认账号**：就是 DSH 里 `OPENCODE_GO_API_KEY` 对应的账号，不能删除、不能在插件里换 Key（去 DSH 凭据里改）。
- **添加账号**：填一个标签（可选）和一把 OpenCode Go API Key，点「验证并添加」。插件先把 Key 写进 DSH 凭据库，再用它真打一次官方接口：401/403 会回滚、不保存；网络/上游故障会保留账号，页面显示该账号的错误态。
- 每个自定义账号的 Key 存在 `.credentials.yaml` 的 `refs` 下，引用名形如 `OPENCODE_GO_USAGE_ACC_1A2B3C4D`。插件自己的 `accounts.json` 只存标签、id 和引用名，**不存 Key**。
- **切换**：点账号 chip 即可；主仪表、预测、重置地平线、轨迹和页脚都跟着当前账号。选择会记住，下次打开还是这个账号。
- **管理**：可以改名、换 Key、删除；删除会同时删掉该账号的本地采样。默认账号只能改名。
- 最多 **8 个账号**（含默认）；所有账号共用同一个 `baseUrl`。

切换账号只改变「看哪个号」，不会改 DSH 的模型路由配置；采样和轨迹按账号分开，互不串数。

## 安装

在插件目录所在机器上，把本目录以 link 方式装进 `desktop` profile：

```bash
# 1) 建立 link 依赖（等价于在 profile 目录执行 pnpm add link:<本目录>）
dsh plugin --profile desktop add link:"D:/deep seek harness/chat task/dsh-opencode-go-usage"

# 2) 把包名加进 profile 的 bundle 层（dsh plugin 只转发 pnpm，不会改 bundles）
#    编辑 ~/.dsh/profiles/desktop/package.json：
#    "dsh": { "profile": { "bundles": [ ..., "dsh-opencode-go-usage" ] } }
```

也可以直接从 GitHub 安装（适合没有本地目录的机器）：

```bash
dsh plugin --profile desktop add github:moondrop12138/dsh-opencode-go-usage
```

装完同样要确认 `dsh.profile.bundles` 里有 `dsh-opencode-go-usage`；关键是 **依赖 + `dsh.profile.bundles` 两处都要有**。用 DSH 插件管理界面安装时，这两处会一并处理。

装完 **重启 DSH**，侧栏出现「OpenCode Go 用量」入口即成功。重启前宿主半不会加载，刷新页面也不会出现入口。

前置条件：

- 已在 DSH credentials 里配置 `OPENCODE_GO_API_KEY`（有效、且账号有 OpenCode Go 订阅）；
- profile 使用 Web GUI（Desktop 或 Web profile 均可）。

## 配置项

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKeyEnv` | string | `OPENCODE_GO_API_KEY` | 凭据的**引用名**（不是密钥本身），用于 credentials / 环境变量查值 |
| `baseUrl` | string | 空（等价 `https://opencode.ai`） | 仅在走企业代理/镜像时需要；会拼成 `<baseUrl>/zen/go/v1/usage` |

两项都可留空，留空即用上表默认。未知配置项会被忽略。

## 本地采样

官方接口只给「此刻的百分比」，没有历史。所以宿主半会在本地维护一份采样：

- 位置：`$DSH_HOME/opencode-go-usage/samples.json`（`DSH_HOME` 缺省 `~/.dsh`）；
- 按账号分桶（v2）：`{ "version": 2, "accounts": { "<accountId>": { "fingerprint": "…", "samples": [...] } } }`；旧的 v1 文件启动时自动迁移到 `default` 桶，旧轨迹不丢；
- 每个桶保留 **7 天**、最多 **10080** 点（7 天 × 60 秒）；删除账号或换 Key 时删桶；
- 桶里存 Key 的 SHA-256 前 16 位指纹；指纹变化（比如默认账号在 DSH 里换了 Key）会自动清空该桶，不会把两个号画成一条线；
- **30 秒**去重：30 秒内重复取数会就地覆盖最后一点，不会长出锯齿；
- 只在**成功取数、且三档都是有限数**时追加；失败或部分 200 不写（避免把旧值重复采样成一条假平线，或给缺失档补假 0）；
- 写入是 best-effort 原子写（临时文件 + rename），IO 失败只记本地日志，不影响页面返回；
- 文件损坏时当空对象处理并重建，不会让页面报错。

删掉这个文件即可清空历史（页面会回到「还没有采样」空态，不影响实时百分比）。

## 限制

- **官方接口只有三档百分比**。没有 token 数、没有金额/成本、没有按模型或按会话的明细——本插件也不去猜、不去估算。需要 token 级明细请看 `dsh-token-usage`（那是本地会话日志口径，和订阅额度不是一回事）。
- 百分比是上游口径，可能滞后于你刚发出的请求；界面不做任何补偿。
- 节奏预测是**本地线性外推**，只表示「照这个速度用下去大概到哪」，与实际配额策略无关。
- 采样是单机本地数据，不跨设备同步；DSH 未运行时不会采样（轨迹会有空档，折线按真实时间横轴绘制）。
- **只给当前查看的账号采样**：没打开的账号不会在后台打接口，所以它的轨迹从第一次被查看时才开始积累（预测同理）。
- 多账号只支持 OpenCode Go 的 Key；其它订阅或无效 Key 会被上游 401/403，添加时直接回滚。
- 自定义账号的 Key 与默认 Key 存在同一个 `.credentials.yaml` 里，保护级别相同（同 OS 用户可读，见 DSH 凭据说明）。
- 依赖官方接口的路径与字段形状；接口变动会表现为 `bad-response` 错误，需要更新插件。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-opencode-go-usage
```

重启 DSH 后侧栏入口与整页一起消失。宿主半会一并撤销 RPC 路由与内存缓存；采样文件不会自动删除，需要的话手动删 `$DSH_HOME/opencode-go-usage/`。

## 开发与测试

```bash
cd "D:/deep seek harness/chat task/dsh-opencode-go-usage"

node --test                # 单测（宿主半 + 客户端半）
node --check lib/host.js   # 宿主半语法
node --check lib/client.js # 客户端半语法
node scripts/probe-live.mjs # 真打一次官方接口，打印 HTTP 状态与三档百分比（不打印密钥）
```

- 接口契约、错误码、Summary 形状、采样规则全部冻结在 [INTERFACES.md](INTERFACES.md)，改实现前先读它。
- 宿主半改动（`lib/host.js`、`cordis.patch.yml`）**必须重启 DSH**；客户端半改动重新加载插件即可。
- 运行时零依赖：宿主半只用 Node 内置模块与全局 `fetch`，客户端半只 `require('react')`。
