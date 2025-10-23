# Alpha Trading Bot Monorepo

Event‑driven trading system with a Next.js monitoring UI, supporting CEX/DeFi. This repo currently includes a monitoring app with Binance 15m markets, TradingView‑style charts, 24h stats, and a TypeScript backtest toolkit (data downloader + simple runner).

## Apps

- `apps/next-monitor` — Next.js 14 (TypeScript) monitoring UI

## Features

- Markets view with major Binance symbols on 15m timeframe
- Symbol detail view with TradingView lightweight‑charts candlesticks
- 24h stats (price change %, high/low, volume)
- Backtest data downloader for Binance CSV klines
- Simple SMA‑crossover backtest runner (TS)
- Paper trading demo (market orders at last price) with REST endpoints
- Live markets page updates via Binance WebSocket
- Symbol chart overlays: EMA20/EMA50, Bollinger Bands (20,2), RSI(14) + volume pane
- Strategy SDK and backtest engine scaffold (TS)
- Execution adapters:
  - CEX: Binance REST (signed) with idempotency key generation
  - DeFi: viem-based simulate + send (scaffold)

## Quickstart

Prereqs: Node 18+ (Node 22 recommended)

1) Install and run the monitor UI

```
cd apps/next-monitor
npm install
npm run dev
# open http://localhost:3000
```

2) Build for production

```
npm run build
npm start
```

## Monitoring UI

- Markets page: `apps/next-monitor/app/markets/page.tsx`
  - Fetches 15m klines and 24h stats for major pairs (edit list in `apps/next-monitor/lib/markets.ts:1`).
  - Renders sparkline, last price, 24h change, and volume.

- Symbol page: `apps/next-monitor/app/markets/[symbol]/page.tsx`
  - TradingView lightweight‑charts via `apps/next-monitor/components/AdvancedChart.tsx`
  - 24h stats: last price, 24h change, high/low, quote volume
  - Paper trading panel (demo): buy/sell at current WS last price and track PnL
  - Overlays: EMA20/EMA50, Bollinger Bands, RSI(14) and volume histogram

## Backtesting Toolkit (TypeScript)

The toolkit uses Binance’s official historical CSVs (data.binance.vision) and a simple SMA‑crossover strategy to illustrate the flow. Data is stored under `data/binance/klines/<SYMBOL>/<INTERVAL>/` at the repo root.

### Download historical data

In `apps/next-monitor`:

```
# Download BTCUSDT 15m for Jan–Mar 2023
npm run download:binance -- --symbol BTCUSDT --interval 15m --year 2023 --month 01..03

# Multiple years/months
npm run download:binance -- --symbol BTCUSDT --interval 15m --years 2023,2024 --months 01..12
```

Outputs: CSV files in `data/binance/klines/BTCUSDT/15m/`.

### Run a simple backtest

```
# SMA 20/50 crossover on downloaded data
npm run backtest -- --symbol BTCUSDT --interval 15m --smaFast 20 --smaSlow 50
```

Output example:

```
{
  "symbol": "BTCUSDT",
  "interval": "15m",
  "candles": 123456,
  "trades": 42,
  "totalPnl": 0.1234,
  "winRate": 54.76
}
```

### Implement your own strategy

Use `apps/next-monitor/scripts/run-backtest.ts` as a guide. The core concepts:

- Candle type: `{ ts, open, high, low, close, volume }`
- Strategy interface (conceptual):
  - `onCandle(candle) => signal` where `signal` can be `enter/exit/hold`
  - Maintain internal state (indicators, positions)
  - Record trades when signals occur

Steps to add a new strategy:

1. Create a new script (e.g., `scripts/run-mystrategy.ts`) and import the engine from `@/lib/strategy/core`.
2. Implement a `Strategy` with `onCandle(ctx, candles)` returning `buy` | `sell` | `hold`.
3. Use indicators from `@/lib/indicators`.
4. Run with `runBacktest(candles, strategy, { initialEquity: 10000, feeBps: 1, slippageBps: 1 })`.
5. Print metrics (total PnL, win rate, max DD, Sharpe, etc.).

Tip: Keep your strategy logic independent from the data loader so you can reuse it in live trading later.

## Paper Trading API (demo)

- Endpoint: `GET /api/paper/orders?symbol=BTCUSDT` → current orders and aggregated position
- Endpoint: `POST /api/paper/orders` with JSON `{ symbol, side: 'BUY'|'SELL', qty, price }`

From the UI, use the trade panel on a symbol page; or via curl:

```
curl -X POST http://localhost:3000/api/paper/orders \
  -H 'content-type: application/json' \
  -d '{"symbol":"BTCUSDT","side":"BUY","qty":0.01,"price":68000}'
```

## Code Map

- UI
  - `apps/next-monitor/app/layout.tsx` — app shell
  - `apps/next-monitor/app/markets/page.tsx` — markets table (15m)
  - `apps/next-monitor/app/markets/[symbol]/page.tsx` — symbol detail + candlesticks + 24h stats
  - `apps/next-monitor/components/CandlesChart.tsx` — TradingView‑style chart
  - `apps/next-monitor/components/Sparkline.tsx` — sparkline component

- Data/Helpers
  - `apps/next-monitor/lib/binance.ts` — Binance klines + 24h ticker fetchers
  - `apps/next-monitor/lib/markets.ts` — major symbol list and display helpers

- Backtest
  - `apps/next-monitor/scripts/binance-download.ts` — downloader for Binance CSVs
  - `apps/next-monitor/scripts/run-backtest.ts` — simple SMA crossover backtest

## Roadmap (next steps)

- Live 15m candle aggregation and streaming to UI
- Indicator toggles and multi-timeframe support
- Per‑strategy dashboards (PnL, drawdown, win‑rate, latency)
- Strategy SDK: add orders/position sizing, multi-asset portfolio
- Execution services: CEX/DeFi executors integrated via API routes (server-only), risk checks, kill switches
- Persistence: TimescaleDB/ClickHouse and NATS/Kafka for events
- Secrets: Vault/KMS integration and per-service short‑lived creds

If you want, I can start wiring a backend service for order routing and a simple risk layer next, then expose it to the UI.
Trading bot
## CEX Execution (Binance REST) — Experimental

Env (copy `.env.local.example` to `.env.local` under `apps/next-monitor`):

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_BASE_URL=https://api.binance.com
ENABLE_LIVE_TRADING=false
MAX_NOTIONAL_PER_ORDER=100
ALLOWED_SYMBOLS=BTCUSDT,ETHUSDT
```

Usage (server-side scripts or API routes only — do not expose keys to client):

```ts
import { accountInfo, newOrder } from '@/lib/execution/binance';

const acct = await accountInfo();
const res = await newOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: 100 });
```

Note: Includes idempotency via `newClientOrderId`. Add external persistence for full safety and rate‑limit tracking in production.

API route for convenience (disabled unless `ENABLE_LIVE_TRADING=true`):

```
POST /api/binance/order
{ "symbol":"BTCUSDT", "side":"BUY", "type":"MARKET", "quoteOrderQty":100 }
```
Respects `MAX_NOTIONAL_PER_ORDER` and `ALLOWED_SYMBOLS`.

## DeFi Execution (viem) — Scaffold

Env:

```
RPC_URL_MAINNET=...
PRIVATE_KEY_MAINNET=0x...
```

Usage:

```ts
import { simulateAndSend } from '@/lib/execution/defi';

await simulateAndSend({
  cfg: { rpcUrl: process.env.RPC_URL_MAINNET!, privateKey: process.env.PRIVATE_KEY_MAINNET as `0x${string}` },
  to: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  data: '0x...', // calldata from your router/aggregator with slippage constraints
});
```

Recommendation: Use an aggregator (0x/1inch/CoW) or Uniswap SO Router to produce calldata, then simulate with viem before sending.
