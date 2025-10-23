export const MAJOR_BINANCE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'TRXUSDT',
  'LTCUSDT',
  'MATICUSDT',
  'DOTUSDT',
] as const;

export type BinanceSymbol = typeof MAJOR_BINANCE_SYMBOLS[number];

export function displayPair(symbol: string): string {
  const base = symbol.replace('USDT', '');
  return `${base}/USDT`;
}

