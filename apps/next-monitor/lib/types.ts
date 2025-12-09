import type { UTCTimestamp } from 'lightweight-charts';

// Chart data types
export interface ChartCandle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface ChartLinePoint {
  time: UTCTimestamp;
  value: number;
}

// Helper to convert Unix ms timestamp to UTCTimestamp (seconds)
export function toChartTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

// Binance symbol type
export type BinanceSymbol = string;

// Order side type
export type OrderSide = 'BUY' | 'SELL';

// Order type
export type OrderType = 'MARKET' | 'LIMIT';

// Trade direction
export type TradeDirection = 'LONG' | 'SHORT';

// Position state
export interface Position {
  symbol: string;
  side: TradeDirection;
  qty: number;
  avgPrice: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
}

// Paper trade order
export interface PaperOrder {
  id: string;
  ts: number;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
}

// WebSocket connection state
export type WsConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Risk check result
export type RiskCheckResult =
  | { ok: true }
  | { ok: false; reason: string };
