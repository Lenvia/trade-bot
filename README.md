# GoCharting × Codex 数据实验室

这是一个零依赖的学习 Demo，用于验证浏览器能否连接 GoCharting 官方 Demo WebSocket。

它会：

- 请求 Bybit BTCUSDT / ETHUSDT 的历史 OHLCV；
- 订阅实时逐笔成交；
- 按实时 tick 持续更新当前 K 柱，并在跨周期时自动创建下一根 K 柱；
- 显示 LIVE / DELAYED / STALE、最后 tick 年龄与传输延迟；
- WebSocket 断线后指数退避重连，每 5 分钟后台校准历史 K 线；
- 用 Canvas 绘制简化 K 线与成交量；
- 在浏览器本地计算 RSI(14) 与 MACD(12, 26, 9)；
- 使用 Crosshair 查看时间、价格和单根 OHLCV；
- 使用滚轮缩放、拖动平移、按钮或双击恢复视图；
- 根据画布宽度限制最大 Zoom，避免 K 线之间出现大面积空白；
- 在同一个 Chart Workspace 内上下排列 K 线、MACD 与 RSI，并同步时间位置；
- RSI 使用 0–100 完整尺度和扩大窗格，明确标出 30/50/70、超买区与超卖区；
- RSI 折线在越过 70 后显示红色、跌破 30 后显示蓝色，并在阈值交点精确分段；
- 展示连接日志，便于理解 WebSocket 消息流程。

它不会：

- 登录 GoCharting 账户；
- 访问你的 Watchlist 或 Workspace；
- 下单或连接 Broker；
- 提供完整 GoCharting 市场数据；
- 提供投资建议。

## 运行

需要 Node.js 20 或更高版本。

```bash
cd /Users/yy/Documents/Common/gocharting-codex-demo
npm start
```

然后打开：

```text
http://127.0.0.1:8765
```

页面不会自动联网；点击“连接并读取”后才会连接：

```text
wss://gocharting.com/sdk/ws
```

## 测试

```bash
npm test
```

测试覆盖 EMA、RSI、MACD、实时更新当前 K 柱、跨周期创建新柱和历史校准合并。

如需直接验证 GoCharting WebSocket、历史 K 线和实时成交：

```bash
npm run smoke
```

## 数据如何流动

1. 浏览器打开官方 WebSocket。
2. 发送 `timeseries` 请求获取 OHLCV。
3. 发送 `SUBSCRIBE` 订阅实时 trades。
4. 页面将 OHLCV 标准化为统一对象。
5. `indicators.mjs` 只用 Close 序列计算 RSI、MACD。
6. 实时 trade 会更新当前周期的实验性 K 线，跨过周期边界后自动创建新柱。
7. 每 5 分钟发起一次历史数据后台校准，不采用高频全量轮询。

## 重要限制

- 官方 Demo 只允许 `BYBIT:FUTURE:BTCUSDT` 和 `BYBIT:FUTURE:ETHUSDT`。
- Demo 有连接数、消息和 K 线请求速率限制。
- 当前 K 线尚未收盘时，Close、High、Low、Volume 会继续变化。
- 本 Demo 的指标初始化方法可能与其他平台略有差异。
- 实时 trades 只保存在内存中，刷新页面后会消失。

官方文档：<https://gocharting.com/sdk/docs/guides/demo-websocket>

## 后续可以尝试

- 把实时 trades 保存到 SQLite / DuckDB；
- 按价格分组生成 Volume-at-Price；
- 计算 Buy Volume、Sell Volume、Delta；
- 加入自定义指标编辑器；
- 增加历史回测和条件提醒；
- 用独立行情 API 扩展更多 Crypto 和股票。
