#!/usr/bin/env node
/*
  Simple backtest runner over Binance CSV klines.
  Reads CSV files under ../../data/binance/klines/<SYMBOL>/<INTERVAL>/ and runs an SMA crossover strategy.

  Usage:
    npx tsx scripts/run-backtest.ts --symbol BTCUSDT --interval 15m --smaFast 20 --smaSlow 50
*/

import fs from 'node:fs';
import path from 'node:path';
import { ema, rsi } from '@/lib/indicators';
import { Candle, runBacktest, Strategy } from '@/lib/strategy/core';

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

function parseCsvLine(line: string): Candle | null {
  // Binance kline CSV columns: open_time, open, high, low, close, volume, close_time, ...
  const parts = line.split(',');
  if (parts.length < 6) return null;
  return {
    ts: Number(parts[0]),
    open: Number(parts[1]),
    high: Number(parts[2]),
    low: Number(parts[3]),
    close: Number(parts[4]),
    volume: Number(parts[5]),
  };
}

function loadCandles(dir: string): Candle[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  const rows: Candle[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('open_time')) continue;
      const c = parseCsvLine(line);
      if (c) rows.push(c);
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

async function main() {
  const symbol = (arg('symbol') || '').toUpperCase();
  const interval = arg('interval') || '15m';
  const smaFast = Number(arg('smaFast') || '20');
  const smaSlow = Number(arg('smaSlow') || '50');
  if (!symbol) {
    console.error('Missing --symbol');
    process.exit(1);
  }
  const dir = path.resolve(process.cwd(), '../../data/binance/klines', symbol, interval);
  if (!fs.existsSync(dir)) {
    console.error('Data not found:', dir);
    process.exit(1);
  }
  const candles = loadCandles(dir) as Candle[];
  // Example strategy: SMA cross + RSI filter
  const strat: Strategy = {
    name: 'SMA_CROSS_RSI',
    onCandle(ctx, all) {
      const closes = all.map(c => c.close);
      const f = ema(closes, smaFast);
      const s = ema(closes, smaSlow);
      const r = rsi(closes, 14);
      const i = ctx.index;
      if (!(Number.isFinite(f[i]) && Number.isFinite(s[i]) && Number.isFinite(f[i-1]) && Number.isFinite(s[i-1]) && Number.isFinite(r[i]))) {
        return 'hold';
      }
      const crossUp = f[i] >= s[i] && f[i - 1] < s[i - 1];
      const crossDn = f[i] <= s[i] && f[i - 1] > s[i - 1];
      if (ctx.position === 0 && crossUp && r[i] > 50) return 'buy';
      if (ctx.position > 0 && crossDn) return 'sell';
      return 'hold';
    }
  };

  const res = runBacktest(candles, strat, { initialEquity: 10000, feeBps: 1, slippageBps: 1 });
  console.log(JSON.stringify({ symbol, interval, candles: candles.length, trades: res.trades.length, totalPnl: res.totalPnl, winRate: res.winRate }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
