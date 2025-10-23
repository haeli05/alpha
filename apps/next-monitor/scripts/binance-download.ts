#!/usr/bin/env node
/*
  Download Binance historical klines CSV (zipped) for spot markets.
  Stores under ../../data/binance/klines/<SYMBOL>/<INTERVAL>/

  Usage examples:
    npx tsx scripts/binance-download.ts --symbol BTCUSDT --interval 15m --year 2023 --month 01
    npx tsx scripts/binance-download.ts --symbol BTCUSDT --interval 15m --year 2023 --month 01..03
    npx tsx scripts/binance-download.ts --symbol BTCUSDT --interval 15m --years 2023,2024 --months 01..12
*/

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

type Args = {
  symbol: string;
  interval: string; // e.g., '15m'
  year?: string;
  month?: string;
  years?: string;
  months?: string;
};

function parseRange(v?: string): string[] | undefined {
  if (!v) return undefined;
  if (v.includes('..')) {
    const [a, b] = v.split('..');
    const from = parseInt(a, 10);
    const to = parseInt(b, 10);
    const width = a.length;
    const out: string[] = [];
    for (let i = from; i <= to; i++) out.push(String(i).padStart(width, '0'));
    return out;
  }
  return v.split(',').map((x) => x.trim());
}

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function downloadAndExtract(url: string, outDir: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed ${res.status} for ${url}`);
  }
  await ensureDir(outDir);
  await pipeline(res.body as any, unzipper.Extract({ path: outDir }));
}

async function main() {
  const args: Args = {
    symbol: (arg('symbol') || '').toUpperCase(),
    interval: arg('interval') || '15m',
    year: arg('year'),
    month: arg('month'),
    years: arg('years'),
    months: arg('months'),
  };

  if (!args.symbol) {
    console.error('Missing --symbol');
    process.exit(1);
  }

  const years = parseRange(args.years) || (args.year ? [args.year] : undefined);
  const months = parseRange(args.months) || (args.month ? [args.month] : undefined);
  if (!years || !months) {
    console.error('Specify --year/--years and --month/--months');
    process.exit(1);
  }

  const base = 'https://data.binance.vision/data/spot/monthly/klines';
  const targetDir = path.resolve(process.cwd(), '../../data/binance/klines', args.symbol, args.interval);

  for (const y of years) {
    for (const m of months) {
      const file = `${args.symbol}-${args.interval}-${y}-${m}.zip`;
      const url = `${base}/${args.symbol}/${args.interval}/${file}`;
      console.log('Downloading', url);
      try {
        await downloadAndExtract(url, targetDir);
        console.log('Extracted to', targetDir);
      } catch (e) {
        console.error('Failed:', String(e));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

