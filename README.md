# Codex 数据实验室

这是一个零依赖的 Market Data 学习 Demo，默认连接 Bybit 官方 Public REST / WebSocket。

它会：

- 请求 Bybit BNBUSDT / BTCUSDT / ETHUSDT 永续合约的历史 OHLCV；
- 订阅实时逐笔成交；
- 按实时 tick 持续更新当前 K 柱，并在跨周期时自动创建下一根 K 柱；
- 显示 LIVE / DELAYED / STALE、最后 tick 年龄与传输延迟；
- 显示 macOS 系统代理状态，并区分代理可用、代理端口失联、直连与未知状态；
- WebSocket 断线后指数退避重连，每 5 分钟后台校准历史 K 线；
- 用 Canvas 绘制简化 K 线与成交量；
- 将 15m、1h、4h、1D 固定为快捷周期，其他周期收进统一下拉框；
- 用右侧固定观察列表快速切换 BNB / BTC / ETH；
- 在浏览器本地按需计算并选择显示 RSI(14) 与 MACD(12, 26, 9)；
- 使用 Crosshair 查看时间、价格和单根 OHLCV；
- 使用滚轮缩放、拖动平移、按钮或双击恢复视图；
- 根据画布宽度限制最大 Zoom，避免 K 线之间出现大面积空白；
- 在同一个 Chart Workspace 内动态创建指标窗格，并同步时间位置、缩放和平移；
- RSI 使用 0–100 完整尺度和扩大窗格，明确标出 30/50/70、超买区与超卖区；
- RSI 折线在越过 70 后显示红色、跌破 30 后显示蓝色，并在阈值交点精确分段；
- 展示连接日志，便于理解 WebSocket 消息流程。

它不会：

- 登录 Bybit 或读取 API Key；
- 访问你的 Watchlist 或 Workspace；
- 下单或连接 Broker；
- 读取账户、订单、持仓等 Private Data；
- 提供投资建议。

## 运行

需要 Node.js 20 或更高版本。

```bash
cd /Users/yy/Projects/trade-bot
npm start
```

然后打开：

```text
http://127.0.0.1:8765
```

页面打开后会自动连接并读取默认的 BNBUSDT 15 分钟行情；“重新连接”按钮可手动重建连接：

```text
wss://stream.bybit.com/v5/public/linear
```

Bybit 官方限制来自 Mainland China 的 API 流量。如果本机网络直接访问超时，浏览器会沿用 macOS 已启用的系统代理；项目不会保存代理地址或凭据。

## 测试

```bash
npm test
```

测试覆盖 EMA、RSI、MACD、Indicator Registry 与故障隔离、4 小时 K 柱、实时更新当前 K 柱、乱序 trade、请求期间 tick 合并、Bybit / GoCharting payload normalization、历史请求 error/timeout 和 WebSocket heartbeat recovery。

保留的 GoCharting Demo smoke test 可通过以下命令运行：

```bash
npm run smoke
```

## 数据如何流动

1. `src/client/market/sources/bybit-public.mjs` 通过 Bybit REST / WebSocket 获取数据，并映射到 `src/client/market/contract.mjs` 定义的 Canonical Bar / Trade。
2. `src/client/market/live-data.mjs` 合并历史 OHLCV 与实时 trades，处理请求期间 tick 和乱序 Close。
3. `src/client/indicators/registry.mjs` 只计算当前启用的 Definition，并校验输出时间轴、隔离单指标错误。
4. `src/client/app.mjs` 根据 active IDs 管理 keyed panes；`charts/price-renderer.mjs` 与 `charts/indicator-renderer.mjs` 分别绘制价格和通用指标 primitive。
5. 每 5 分钟发起一次历史数据后台校准，不采用高频全量轮询。

完整模块边界和未来扩展原则见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 重要限制

- Bybit API 有连接与请求速率限制，并可能受地区网络策略影响。
- 当前 K 线尚未收盘时，Close、High、Low、Volume 会继续变化。
- 本 Demo 的指标初始化方法可能与其他平台略有差异。
- 实时 trades 只保存在内存中，刷新页面后会消失。

官方文档：<https://bybit-exchange.github.io/docs/v5/ws/connect>

## 后续可以尝试

- 把实时 trades 保存到 SQLite / DuckDB；
- 按价格分组生成 Volume-at-Price；
- 计算 Buy Volume、Sell Volume、Delta；
- 注册更多本地自定义指标；参数编辑器与任意脚本沙箱留待单独设计；
- 增加历史回测和条件提醒；
- 用独立行情 API 扩展更多 Crypto 和股票。
