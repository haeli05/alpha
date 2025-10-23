export type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export type Signal = 'buy' | 'sell' | 'hold';

export interface StrategyContext {
  index: number;
  candle: Candle;
  position: number; // base units (can be negative if short in future)
  equity: number; // quote currency
}

export interface Strategy {
  name: string;
  init?(candles: Candle[]): void;
  onCandle(ctx: StrategyContext, candles: Candle[]): Signal;
}

export type BacktestOptions = {
  initialEquity: number;
  feeBps?: number; // per trade side
  slippageBps?: number; // on price
};

export type Trade = { entryTs: number; entry: number; exitTs: number; exit: number; qty: number; pnl: number };

export type BacktestResult = {
  trades: Trade[];
  equityCurve: { ts: number; equity: number }[];
  totalPnl: number;
  winRate: number;
};

export function runBacktest(candles: Candle[], strategy: Strategy, opts: BacktestOptions): BacktestResult {
  const fee = (opts.feeBps ?? 0) / 10000;
  const slip = (opts.slippageBps ?? 0) / 10000;
  let equity = opts.initialEquity;
  let position = 0; // base units
  let entryPrice = 0;
  let entryTs = 0;
  const trades: Trade[] = [];
  const curve: { ts: number; equity: number }[] = [];

  strategy.init?.(candles);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ctx: StrategyContext = { index: i, candle: c, position, equity };
    const sig = strategy.onCandle(ctx, candles) || 'hold';
    // Simple long-only engine: buy full, sell full
    if (sig === 'buy' && position === 0) {
      const px = c.close * (1 + slip);
      const qty = Math.max(0, (equity * (1 - fee)) / px);
      if (qty > 0) {
        position = qty;
        entryPrice = px;
        entryTs = c.ts;
        equity = 0; // fully deployed
      }
    } else if (sig === 'sell' && position > 0) {
      const px = c.close * (1 - slip);
      let proceeds = position * px;
      proceeds *= (1 - fee);
      const pnl = (px - entryPrice) * position;
      trades.push({ entryTs, entry: entryPrice, exitTs: c.ts, exit: px, qty: position, pnl });
      position = 0;
      equity += proceeds;
    }
    const mark = equity + position * c.close;
    curve.push({ ts: c.ts, equity: mark });
  }

  // Close at last candle
  const last = candles[candles.length - 1];
  if (position > 0) {
    const px = last.close * (1 - slip);
    let proceeds = position * px;
    proceeds *= (1 - fee);
    const pnl = (px - entryPrice) * position;
    trades.push({ entryTs, entry: entryPrice, exitTs: last.ts, exit: px, qty: position, pnl });
    position = 0;
    equity += proceeds;
    curve[curve.length - 1] = { ts: last.ts, equity };
  }

  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  return { trades, equityCurve: curve, totalPnl, winRate };
}

