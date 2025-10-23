#!/usr/bin/env node
/*
  Simple backtest runner over Binance CSV klines.
  Reads CSV files under ../../data/binance/klines/<SYMBOL>/<INTERVAL>/ and runs an SMA crossover strategy.

  Usage:
    npx tsx scripts/run-backtest.ts --symbol BTCUSDT --interval 15m --smaFast 20 --smaSlow 50
*/

import fs from 'node:fs';
import path from 'node:path';

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

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

function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i + 1 >= period ? sum / period : NaN);
  }
  return out;
}

type Trade = { entryTs: number; entry: number; exitTs: number; exit: number; pnl: number };

function runSmaCross(candles: Candle[], fast: number, slow: number) {
  const closes = candles.map((c) => c.close);
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  let position: 'long' | null = null;
  let entry = 0;
  let entryTs = 0;
  const trades: Trade[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (!Number.isFinite(f[i]) || !Number.isFinite(s[i]) || !Number.isFinite(f[i - 1]) || !Number.isFinite(s[i - 1])) continue;
    const crossUp = f[i] >= s[i] && f[i - 1] < s[i - 1];
    const crossDn = f[i] <= s[i] && f[i - 1] > s[i - 1];
    if (!position && crossUp) {
      position = 'long';
      entry = candles[i].close;
      entryTs = candles[i].ts;
    } else if (position === 'long' && crossDn) {
      const exit = candles[i].close;
      const pnl = (exit - entry) / entry;
      trades.push({ entryTs, entry, exitTs: candles[i].ts, exit, pnl });
      position = null;
    }
  }
  // Close any open position at last candle
  if (position === 'long') {
    const last = candles[candles.length - 1];
    trades.push({ entryTs, entry, exitTs: last.ts, exit: last.close, pnl: (last.close - entry) / entry });
  }
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  return { trades, totalPnl, winRate };
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
  const candles = loadCandles(dir);
  const { trades, totalPnl, winRate } = runSmaCross(candles, smaFast, smaSlow);
  console.log(JSON.stringify({ symbol, interval, candles: candles.length, trades: trades.length, totalPnl, winRate }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

