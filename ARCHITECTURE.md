# 架构说明

## 目标与边界

当前版本是一个零依赖、单页面的 Market Data 学习 Demo。它需要可靠地完成一条最小数据链路：

```text
Bybit Public Source
  -> normalized Bar / Trade
  -> history + live reconciliation
  -> active indicator registry entries
  -> keyed panes + primitive Canvas renderers
```

当前不建设 Provider Registry、Indicator Script DSL、数据库、回测引擎、消息队列或交易执行模块。指标只保留一层轻量 Definition Registry；它解决现有的动态启停与未知数量窗格，不承担任意脚本沙箱、参数编辑或拖拽布局。

## 模块职责

目录先按运行时分为浏览器端与 Node.js 服务端，再在浏览器端按领域分层：

```text
trade-bot/
├── public/                    # HTML / CSS 静态入口
├── src/
│   ├── client/               # 仅在浏览器运行
│   │   ├── app.mjs           # Composition Root 与页面状态
│   │   ├── formatters.mjs
│   │   ├── charts/           # Canvas renderer 与共享视图状态
│   │   ├── indicators/       # 公式、Registry、内建指标
│   │   └── market/           # Canonical contract、实时聚合、Provider adapters
│   └── server/               # 本地静态服务与运行环境诊断
├── test/                     # 按 src 结构镜像组织
└── scripts/                  # 独立 smoke / 运维脚本
```

`src/client` 不允许导入 `src/server`；Provider adapter 不允许导入 chart、indicator 或 DOM 层。静态服务器只暴露 `public/` 与 `src/client/`，不会把服务端诊断代码暴露给浏览器。

| 模块 | 单一职责 | 不应负责 |
| --- | --- | --- |
| `src/client/market/sources/bybit-public.mjs` | Bybit Public REST / WebSocket、字段与周期映射、heartbeat、reconnect、history request lifecycle | 指标、K 线展示、DOM |
| `src/client/market/sources/gocharting-demo.mjs` | 保留的 GoCharting Demo 协议 adapter 与回归样例 | Bybit 协议、指标、DOM |
| `src/client/market/live-data.mjs` | 标准 Bar/Trade 的聚合、乱序策略、历史快照与请求期间 tick 合并 | Provider 字段、WebSocket、UI |
| `src/client/indicators/calculations.mjs` | EMA、RSI、MACD 等纯公式 | Dashboard 配置、Canvas |
| `src/client/indicators/registry.mjs` | 指标 Definition 注册、schema 校验、按 active IDs 计算与故障隔离 | 指标公式、DOM、Canvas |
| `src/client/indicators/builtins.mjs` | 内建指标 Definition 与默认启用集合 | 页面布局、绘图算法 |
| `src/client/charts/view.mjs` | Zoom、Pan、visible window 等纯几何 | Market Data、DOM |
| `src/client/charts/price-renderer.mjs` | 根据 Bars 与共享 View State 绘制价格 Canvas | 网络连接、指标特判 |
| `src/client/charts/indicator-renderer.mjs` | 按 pane schema 绘制通用 line / histogram / threshold-line primitive | RSI/MACD 身份判断、指标公式 |
| `src/client/formatters.mjs` | 共用显示格式 | 数据计算 |
| `src/client/app.mjs` | Composition Root、DOM 事件、页面状态协调 | Provider raw protocol、指标公式、Canvas 细节 |
| `src/server/server.mjs` | 仅暴露 public assets、client modules 与受控本地 API | Provider 协议、页面状态 |

## 稳定数据形状

`src/client/market/contract.mjs` 是内部 Canonical Market Data Contract，当前版本为 v1。Data Source 输出统一对象；Provider 必须在自己的 adapter 内完成映射和校验，不把原始字段泄漏到应用层。

```js
Bar = { time, open, high, low, close, volume, lastTradeTime? }
Trade = { id?, time, price, size, side }
HistoryQuery = { symbol, interval, rows }
```

- `symbol` 使用内部 Product ID：`VENUE:MARKET_TYPE:SYMBOL`，例如 `BYBIT:FUTURE:BNBUSDT`。
- `side` 只允许 `buy` / `sell` / `unknown`，Provider 的大小写与别名在 adapter 内消化。
- Canonical Bar 会校验 OHLC 关系和非负 Volume；非法 Provider 数据不会进入指标与 renderer。
- Canonical interval 当前固定为 `1m / 5m / 15m / 30m / 1h / 2h / 4h / 6h / 12h / 1D`；Provider interval code 只存在于 adapter。

- 时间使用 Unix milliseconds。
- `lastTradeTime` 是本地实时聚合 watermark，用来防止乱序 trade 让 Close 回退。
- 只有 Provider 提供稳定 `id` 时才去重；不使用 `time + price + size` 猜测 ID，以免误删同毫秒内的真实成交。
- 历史快照没有 exchange watermark。请求期间 tick 会被缓存并合并；High/Low 取并集、Close 保留最新已观察实时成交、Volume 使用保守合并并等待下一轮 reconcile 校正。

## Data Source 最小契约

`BybitPublicSource` 与 `GoChartingDemoSource` 共享以下最小行为契约，但各自保留 Provider-specific protocol：

- `connect(selection)` / `disconnect()`
- `updateSelection(selection)`
- `requestHistory({ background })`
- `reconnectNow()`
- callbacks：connection state、history start/result/error、normalized trades、log

两个 Provider 都通过独立测试证明该行为。暂不引入继承层或复杂 Registry；Symbol mapping 与 Provider-specific interval mapping 留在各自 adapter 内，等 UI 真正需要运行时切换 Provider 时再增加 composition router。

## Transport 与代理边界

Provider Adapter、Transport、Runtime Routing 是三个不同层次：

```text
App / Indicators / Renderer
  -> Canonical Data Source Contract
  -> Provider Adapter (Bybit / GoCharting / future providers)
  -> Transport (HTTP / WebSocket)
  -> Runtime Route Policy (direct / system proxy / named proxy profile)
```

- Provider adapter 只知道 endpoint、协议消息和字段映射；不得读取代理环境变量、硬编码 `127.0.0.1`，也不得持有代理凭据。
- HTTP client 与 WebSocket constructor 通过依赖注入进入 adapter，因此测试与未来 Transport 替换不需要改业务逻辑。
- 当前浏览器版本使用 macOS/浏览器的 system proxy，属于一个全局 Transport profile。
- `/api/network-route` 只读取 macOS system proxy 的启用状态并探测本地端口是否可连接；UI 用它区分 proxy ready、proxy down、direct 与 unknown。它不会读取代理凭据，也不会声称能绕过浏览器扩展或独立代理设置来证明单个请求的真实路由。
- 当出现“Provider A 直连、Provider B 走代理”的真实需求时，在同源 Market Data Gateway 中按 Provider ID 选择 `direct` 或命名 proxy profile；前端仍只访问同源地址。
- Proxy URL、认证信息和 API Secret 只允许存在于 Gateway 的 server-side config，不下发浏览器、不进入日志、不进入 Git。
- Gateway 不接受前端传入任意目标 URL，避免 SSRF；可访问 endpoint 必须来自受控 Provider manifest。

这样新增数据源时只增加 adapter、manifest/capability 和 contract tests，不修改指标、图表或代理实现。

## Indicator 扩展原则

`src/client/indicators/registry.mjs` 定义当前稳定的扩展契约。一个指标 Definition 包含：

```js
{
  id,
  label,
  shortLabel,
  compute(bars),
  pane: {
    height,
    scale: { mode: "fixed" | "auto" | "symmetric" },
    bands,
    levels,
    series: [{ key, type: "line" | "histogram" | "threshold-line", ...style }],
    readouts: [{ key, label }]
  }
}
```

新增自定义指标时，在独立模块实现纯 `compute(bars)`，返回与 Bars 等长、仅含 finite number 或 `null` 的 series，再注册 Definition。应用层按 active IDs 计算并按 key 创建窗格；Renderer 只识别绘图 primitive，不识别 `rsi`、`macd` 等指标名称。因此增加普通指标无需修改 `app.mjs`、HTML 或布局计算。

- 未启用的指标不计算。
- 一个 Definition 对应一个独立纵轴窗格，内部可组合多条 series。
- 所有窗格共享同一个 X 轴 visible window、hover、zoom 与 pan state。
- 单个指标计算失败会成为该 Registry entry 的 error，只在自己的窗格显示，不遮挡价格图和其他指标。
- 当前 Definition 来自受信任的本地代码；任意用户脚本需要独立沙箱、安全和资源限制，不能直接复用这层 Registry 冒充安全执行环境。

## 失败与恢复策略

- History request 有唯一 request ID、selection snapshot 和 15 秒 timeout。
- 新的前台请求会 supersede 旧请求；迟到且 request ID 不匹配的响应被丢弃。
- 请求期间的 normalized trades 会被保存，并在 history final 后重放/合并。
- PING 每 20 秒发送；45 秒未收到 PONG 会主动关闭半开连接并指数退避重连。
- Reconnect attempt 只在收到 `Welcome-` 后归零，避免 transport 反复 open/close 时形成 1 秒重连风暴。
- 每 5 分钟后台 history reconcile；页面重新可见且上次同步超过 15 秒时触发一次校准。

## 版本阶梯

### 当前：真实 Crypto Data Source

- Bybit adapter 通过 Public REST 获取历史 Kline，通过 Public WebSocket 获取实时 trades。
- 初始 Watchlist 为 BNBUSDT / BTCUSDT / ETHUSDT linear perpetual。
- adapter 输出相同 Bar/Trade shape，指标公式与 renderer 不感知 Provider。
- 常用周期 `15m / 1h / 4h / 1D` 固定在工具栏，低频周期统一放入下拉框。
- 右侧观察列表只切换当前 Source selection，不为未选中市场建立额外订阅。
- RSI 与 MACD 可动态启停；窗格由 Registry definition 驱动。

### Later：持久化与回放

- 保存 OHLCV/Trades，明确 retention、timezone、adjustment 与 schema migration。
- 先支持可重复 replay，再建设 Backtest。

### Later：自定义指标与 Backtest

- 指标保持纯函数、固定 warm-up 与 closed-candle semantics。
- Backtest 单独处理 Fees、Slippage、Look-ahead Bias 与结果指标。

### Parking lot

- Footprint / Volume-at-Price、Scanner/Alert、Broker execution。
- 这些能力需要独立数据粒度或安全边界，不进入当前 Demo 的核心模块。
