# 架构说明

## 目标与边界

当前版本是一个零依赖、单页面的 Market Data 学习 Demo。它需要可靠地完成一条最小数据链路：

```text
Bybit Public Source
  -> normalized Bar / Trade
  -> history + live reconciliation
  -> derived indicator set
  -> DOM controller + Canvas renderer
```

当前不建设 Provider Registry、Indicator Plugin DSL、数据库、回测引擎、消息队列或交易执行模块。等第二个真实实现出现后，再从共同约束中提取接口，避免为想象中的需求提前造框架。

## 模块职责

| 模块 | 单一职责 | 不应负责 |
| --- | --- | --- |
| `data-sources/bybit-public.mjs` | Bybit Public REST / WebSocket、字段与周期映射、heartbeat、reconnect、history request lifecycle | 指标、K 线展示、DOM |
| `data-sources/gocharting-demo.mjs` | 保留的 GoCharting Demo 协议 adapter 与回归样例 | Bybit 协议、指标、DOM |
| `live-data.mjs` | 标准 Bar/Trade 的聚合、乱序策略、历史快照与请求期间 tick 合并 | Provider 字段、WebSocket、UI |
| `indicators.mjs` | EMA、RSI、MACD 等纯公式 | Dashboard 配置、Canvas |
| `indicator-set.mjs` | 当前 Dashboard 启用哪些指标，以及稳定的 derived-data shape | 数据接入、绘图细节 |
| `chart-view.mjs` | Zoom、Pan、visible window 等纯几何 | Market Data、DOM |
| `chart-renderer.mjs` | 根据 Bars、Indicators、View State 绘制 Canvas | 网络连接、业务状态变更 |
| `formatters.mjs` | 共用显示格式 | 数据计算 |
| `app.mjs` | Composition Root、DOM 事件、页面状态协调 | Provider raw protocol、指标公式、Canvas 细节 |

## 稳定数据形状

`market-data-contract.mjs` 是内部 Canonical Market Data Contract，当前版本为 v1。Data Source 输出统一对象；Provider 必须在自己的 adapter 内完成映射和校验，不把原始字段泄漏到应用层。

```js
Bar = { time, open, high, low, close, volume, lastTradeTime? }
Trade = { id?, time, price, size, side }
HistoryQuery = { symbol, interval, rows }
```

- `symbol` 使用内部 Product ID：`VENUE:MARKET_TYPE:SYMBOL`，例如 `BYBIT:FUTURE:BNBUSDT`。
- `side` 只允许 `buy` / `sell` / `unknown`，Provider 的大小写与别名在 adapter 内消化。
- Canonical Bar 会校验 OHLC 关系和非负 Volume；非法 Provider 数据不会进入指标与 renderer。
- Canonical interval 当前固定为 `1m / 5m / 15m / 1h / 1D`；Provider interval code 只存在于 adapter。

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
- 当出现“Provider A 直连、Provider B 走代理”的真实需求时，在同源 Market Data Gateway 中按 Provider ID 选择 `direct` 或命名 proxy profile；前端仍只访问同源地址。
- Proxy URL、认证信息和 API Secret 只允许存在于 Gateway 的 server-side config，不下发浏览器、不进入日志、不进入 Git。
- Gateway 不接受前端传入任意目标 URL，避免 SSRF；可访问 endpoint 必须来自受控 Provider manifest。

这样新增数据源时只增加 adapter、manifest/capability 和 contract tests，不修改指标、图表或代理实现。

## Indicator 扩展原则

新增自定义指标分两层：

1. 在独立模块中实现纯计算函数，输入标准 Bars 或 number series，输出与输入时间轴对齐的 array。
2. 在 `indicator-set.mjs` 中把它加入当前 Dashboard 的 derived-data shape，并补确定性测试。

只有当 UI 真正需要动态启停、参数编辑或第三方脚本时，才引入 registry/schema。当前 renderer 明确只支持 RSI 与 MACD，不伪装成通用插件系统。

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

### Later：持久化与回放

- 保存 OHLCV/Trades，明确 retention、timezone、adjustment 与 schema migration。
- 先支持可重复 replay，再建设 Backtest。

### Later：自定义指标与 Backtest

- 指标保持纯函数、固定 warm-up 与 closed-candle semantics。
- Backtest 单独处理 Fees、Slippage、Look-ahead Bias 与结果指标。

### Parking lot

- Footprint / Volume-at-Price、Scanner/Alert、Broker execution。
- 这些能力需要独立数据粒度或安全边界，不进入当前 Demo 的核心模块。
