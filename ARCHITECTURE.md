# 架构说明

## 目标与边界

当前版本是一个零依赖、单页面的 Market Data 学习 Demo。它需要可靠地完成一条最小数据链路：

```text
GoCharting Demo Source
  -> normalized Bar / Trade
  -> history + live reconciliation
  -> derived indicator set
  -> DOM controller + Canvas renderer
```

当前不建设 Provider Registry、Indicator Plugin DSL、数据库、回测引擎、消息队列或交易执行模块。等第二个真实实现出现后，再从共同约束中提取接口，避免为想象中的需求提前造框架。

## 模块职责

| 模块 | 单一职责 | 不应负责 |
| --- | --- | --- |
| `data-sources/gocharting-demo.mjs` | GoCharting WebSocket 协议、raw payload normalization、heartbeat、reconnect、history request lifecycle | 指标、K 线展示、DOM |
| `live-data.mjs` | 标准 Bar/Trade 的聚合、乱序策略、历史快照与请求期间 tick 合并 | Provider 字段、WebSocket、UI |
| `indicators.mjs` | EMA、RSI、MACD 等纯公式 | Dashboard 配置、Canvas |
| `indicator-set.mjs` | 当前 Dashboard 启用哪些指标，以及稳定的 derived-data shape | 数据接入、绘图细节 |
| `chart-view.mjs` | Zoom、Pan、visible window 等纯几何 | Market Data、DOM |
| `chart-renderer.mjs` | 根据 Bars、Indicators、View State 绘制 Canvas | 网络连接、业务状态变更 |
| `formatters.mjs` | 共用显示格式 | 数据计算 |
| `app.mjs` | Composition Root、DOM 事件、页面状态协调 | Provider raw protocol、指标公式、Canvas 细节 |

## 稳定数据形状

Data Source 输出统一对象；后续 Provider 应在自己的 adapter 内转换，不把原始字段泄漏到应用层。

```js
Bar = { time, open, high, low, close, volume, lastTradeTime? }
Trade = { id?, time, price, size, side }
HistoryQuery = { symbol, interval, rows }
```

- 时间使用 Unix milliseconds。
- `lastTradeTime` 是本地实时聚合 watermark，用来防止乱序 trade 让 Close 回退。
- 只有 Provider 提供稳定 `id` 时才去重；不使用 `time + price + size` 猜测 ID，以免误删同毫秒内的真实成交。
- 历史快照没有 exchange watermark。请求期间 tick 会被缓存并合并；High/Low 取并集、Close 保留最新已观察实时成交、Volume 使用保守合并并等待下一轮 reconcile 校正。

## Data Source 最小契约

当前 `GoChartingDemoSource` 暴露的能力就是下一数据源需要证明的最小集合：

- `connect(selection)` / `disconnect()`
- `updateSelection(selection)`
- `requestHistory({ background })`
- `reconnectNow()`
- callbacks：connection state、history start/result/error、normalized trades、log

第二个 Provider 到来时，先实现相同行为并写 contract tests；只有出现真实重复代码后，才提取 shared interface 或 factory。Symbol mapping 与 Provider-specific interval mapping 应留在 adapter 内。

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

### vNext：真实 Crypto Data Source

- 选择一个交易所与小型 Watchlist。
- 新 adapter 输出相同 Bar/Trade shape，并通过 Data Source contract tests。
- 不改指标公式与 renderer。

### Later：持久化与回放

- 保存 OHLCV/Trades，明确 retention、timezone、adjustment 与 schema migration。
- 先支持可重复 replay，再建设 Backtest。

### Later：自定义指标与 Backtest

- 指标保持纯函数、固定 warm-up 与 closed-candle semantics。
- Backtest 单独处理 Fees、Slippage、Look-ahead Bias 与结果指标。

### Parking lot

- Footprint / Volume-at-Price、Scanner/Alert、Broker execution。
- 这些能力需要独立数据粒度或安全边界，不进入当前 Demo 的核心模块。
