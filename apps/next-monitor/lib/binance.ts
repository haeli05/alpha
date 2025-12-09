import { logger } from '@/lib/logger';

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export interface Kline {
  openTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number; // ms
}

// Raw kline response from Binance API
type KlineRaw = [
  number,   // 0: Open time
  string,   // 1: Open
  string,   // 2: High
  string,   // 3: Low
  string,   // 4: Close
  string,   // 5: Volume
  number,   // 6: Close time
  string,   // 7: Quote asset volume
  number,   // 8: Number of trades
  string,   // 9: Taker buy base asset volume
  string,   // 10: Taker buy quote asset volume
  string,   // 11: Ignore
];

// Fetch klines from Binance REST. Defaults to 15m.
export async function fetchKlines(
  symbol: string,
  interval: Interval = '15m',
  limit: number = 96 // 24h of 15m candles
): Promise<Kline[]> {
  const qs = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const url = `https://api.binance.com/api/v3/klines?${qs.toString()}`;

  const res = await fetch(url, { next: { revalidate: 30 } });
  if (!res.ok) {
    logger.error('Binance', `Klines error ${res.status} for ${symbol}`);
    throw new Error(`Binance klines error ${res.status} for ${symbol}`);
  }

  const raw: KlineRaw[] = await res.json();

  return raw.map((r): Kline => ({
    openTime: r[0],
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
    closeTime: r[6],
  }));
}

export function pctChange(a: number, b: number): number {
  if (a === 0) return 0;
  return ((b - a) / a) * 100;
}

export interface Ticker24h {
  symbol: string;
  priceChange: number;
  priceChangePercent: number;
  weightedAvgPrice: number;
  prevClosePrice: number;
  lastPrice: number;
  lastQty: number;
  bidPrice: number;
  askPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
  openTime: number;
  closeTime: number;
}

export async function fetch24hTicker(symbol: string): Promise<Ticker24h> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await fetch(url, { next: { revalidate: 10 } });
  if (!res.ok) throw new Error(`Binance 24h error ${res.status} for ${symbol}`);
  const j = await res.json();
  return {
    symbol: j.symbol,
    priceChange: parseFloat(j.priceChange),
    priceChangePercent: parseFloat(j.priceChangePercent),
    weightedAvgPrice: parseFloat(j.weightedAvgPrice),
    prevClosePrice: parseFloat(j.prevClosePrice),
    lastPrice: parseFloat(j.lastPrice),
    lastQty: parseFloat(j.lastQty),
    bidPrice: parseFloat(j.bidPrice),
    askPrice: parseFloat(j.askPrice),
    openPrice: parseFloat(j.openPrice),
    highPrice: parseFloat(j.highPrice),
    lowPrice: parseFloat(j.lowPrice),
    volume: parseFloat(j.volume),
    quoteVolume: parseFloat(j.quoteVolume),
    openTime: j.openTime,
    closeTime: j.closeTime,
  };
}
