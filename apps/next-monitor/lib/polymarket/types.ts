// Polymarket API types

export interface PolymarketMarket {
  id: string;
  question: string;
  description: string;
  slug: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  outcomes: string[];
  outcomePrices: string[];
  tokens: PolymarketToken[];
  tags: string[];
  image?: string;
  icon?: string;
}

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  markets: PolymarketMarket[];
  tags: string[];
  image?: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketPrice {
  token_id: string;
  price: string;
  side: 'BUY' | 'SELL';
}

export interface PolymarketMidpoint {
  mid: string;
}

export interface OrderArgs {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  orderType?: 'GTC' | 'FOK' | 'GTD';
  expiration?: number;
}

export interface PolymarketOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  status: 'live' | 'matched' | 'cancelled';
  outcome: string;
  owner: string;
  created_at: number;
  expiration: number;
  type: 'GTC' | 'FOK' | 'GTD';
}

export interface TradeHistory {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  fee_rate_bps: string;
  status: 'CONFIRMED' | 'PENDING' | 'FAILED';
  created_at: number;
  match_time?: number;
  outcome: string;
}

export interface Position {
  asset_id: string;
  market: string;
  outcome: string;
  size: string;
  avgPrice: string;
  currentPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
}

export interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface PolymarketConfig {
  host: string;
  chainId: number;
  privateKey?: string;
  credentials?: ApiCredentials;
}

// API Response types
export interface MarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}

export interface OrderResponse {
  success: boolean;
  order_id?: string;
  error?: string;
  errorMsg?: string;
}

export interface CancelResponse {
  success: boolean;
  canceled: string[];
  not_canceled: string[];
}
