import { z } from 'zod';

// Paper trading order schema
export const PaperOrderSchema = z.object({
  symbol: z.string().min(2).max(20).transform(s => s.toUpperCase()),
  side: z.enum(['BUY', 'SELL', 'buy', 'sell']).transform(s => s.toUpperCase() as 'BUY' | 'SELL'),
  qty: z.number().positive().finite(),
  price: z.number().positive().finite(),
});

export type PaperOrderInput = z.infer<typeof PaperOrderSchema>;

// Binance order schema
export const BinanceOrderSchema = z.object({
  symbol: z.string().min(2).max(20).transform(s => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]+$/, 'Invalid symbol format')),
  side: z.enum(['BUY', 'SELL', 'buy', 'sell']).transform(s => s.toUpperCase() as 'BUY' | 'SELL'),
  type: z.enum(['MARKET', 'LIMIT', 'market', 'limit']).default('MARKET').transform(s => s.toUpperCase() as 'MARKET' | 'LIMIT'),
  quantity: z.number().positive().finite().optional(),
  quoteOrderQty: z.number().positive().finite().optional(),
  price: z.number().positive().finite().optional(),
  markPrice: z.number().positive().finite().optional(),
}).refine(
  data => data.quantity !== undefined || data.quoteOrderQty !== undefined,
  { message: 'Either quantity or quoteOrderQty must be provided' }
).refine(
  data => data.type !== 'LIMIT' || data.price !== undefined,
  { message: 'Price is required for LIMIT orders' }
);

export type BinanceOrderInput = z.infer<typeof BinanceOrderSchema>;

// Kline response schema (from Binance API)
export const KlineRawSchema = z.tuple([
  z.number(), // open time
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number(), // close time
  z.string(), // quote asset volume
  z.number(), // number of trades
  z.string(), // taker buy base asset volume
  z.string(), // taker buy quote asset volume
  z.string(), // ignore
]);

export const KlinesResponseSchema = z.array(KlineRawSchema);

// Ticker 24h response schema
export const Ticker24hRawSchema = z.object({
  symbol: z.string(),
  priceChange: z.string(),
  priceChangePercent: z.string(),
  weightedAvgPrice: z.string(),
  prevClosePrice: z.string(),
  lastPrice: z.string(),
  lastQty: z.string(),
  bidPrice: z.string(),
  askPrice: z.string(),
  openPrice: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  volume: z.string(),
  quoteVolume: z.string(),
  openTime: z.number(),
  closeTime: z.number(),
});

// WebSocket ticker message schema
export const WsTickerSchema = z.object({
  e: z.literal('24hrTicker').optional(),
  s: z.string(), // symbol
  c: z.string(), // close price
  o: z.string(), // open price
  h: z.string(), // high
  l: z.string(), // low
  v: z.string(), // volume
  q: z.string(), // quote volume
  P: z.string(), // price change percent
});

export type WsTicker = z.infer<typeof WsTickerSchema>;

// WebSocket stream message schema
export const WsStreamMessageSchema = z.object({
  stream: z.string(),
  data: WsTickerSchema,
});

// Environment schema
export const EnvSchema = z.object({
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_BASE_URL: z.string().url().default('https://api.binance.com'),
  ENABLE_LIVE_TRADING: z.string().default('false').transform(v => v === 'true'),
  MAX_NOTIONAL_PER_ORDER: z.string().transform(v => v ? Number(v) : undefined).optional(),
  ALLOWED_SYMBOLS: z.string().transform(v => v ? v.split(',').map(s => s.trim().toUpperCase()) : undefined).optional(),
  RPC_URL_MAINNET: z.string().url().optional(),
  PRIVATE_KEY_MAINNET: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
});

// Helper to format Zod errors for API responses
export function formatZodError(error: z.ZodError): string {
  // Zod 4 uses 'issues', Zod 3 uses 'errors'
  const issues = (error as any).issues || (error as any).errors || [];
  if (!Array.isArray(issues) || issues.length === 0) {
    return error.message || 'Validation failed';
  }
  return issues.map((e: { path?: (string | number)[]; message?: string }) => {
    const path = e.path?.join('.') || '';
    const message = e.message || 'Invalid value';
    return path ? `${path}: ${message}` : message;
  }).join(', ');
}
