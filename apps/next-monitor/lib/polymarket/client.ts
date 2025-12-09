// Polymarket CLOB API Client
import { logger } from '@/lib/logger';
import type {
  PolymarketConfig,
  PolymarketMarket,
  OrderBook,
  PolymarketPrice,
  PolymarketMidpoint,
  OrderArgs,
  PolymarketOrder,
  TradeHistory,
  Position,
  OrderResponse,
  CancelResponse,
} from './types';

// API endpoints
const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

// Rate limiter for API calls
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor(maxTokens = 10, refillRate = 2) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  allow(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export const polymarketRateLimiter = new RateLimiter(10, 2);

// Public API client (no auth required)
export class PolymarketPublicClient {
  private clobHost: string;
  private gammaHost: string;

  constructor(config?: Partial<PolymarketConfig>) {
    this.clobHost = config?.host || CLOB_HOST;
    this.gammaHost = GAMMA_HOST;
  }

  // Fetch active markets from Gamma API
  async getMarkets(params?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
    order?: 'volume' | 'liquidity' | 'created_at';
    ascending?: boolean;
    tag?: string;
  }): Promise<PolymarketMarket[]> {
    const searchParams = new URLSearchParams();
    if (params?.active !== undefined) searchParams.set('active', String(params.active));
    if (params?.closed !== undefined) searchParams.set('closed', String(params.closed));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.offset) searchParams.set('offset', String(params.offset));
    if (params?.order) searchParams.set('order', params.order);
    if (params?.ascending !== undefined) searchParams.set('ascending', String(params.ascending));
    if (params?.tag) searchParams.set('tag_slug', params.tag);

    const url = `${this.gammaHost}/markets?${searchParams.toString()}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Gamma markets error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch markets', { error: String(e) });
      throw e;
    }
  }

  // Get single market by ID
  async getMarket(marketId: string): Promise<PolymarketMarket | null> {
    try {
      const res = await fetch(`${this.gammaHost}/markets/${marketId}`);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Gamma market error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch market', { error: String(e), marketId });
      return null;
    }
  }

  // Get market by slug
  async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
    try {
      const res = await fetch(`${this.gammaHost}/markets/slug/${slug}`);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Gamma market error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch market by slug', { error: String(e), slug });
      return null;
    }
  }

  // Search markets
  async searchMarkets(query: string, limit = 20): Promise<PolymarketMarket[]> {
    try {
      const res = await fetch(
        `${this.gammaHost}/markets?_q=${encodeURIComponent(query)}&limit=${limit}&active=true`
      );
      if (!res.ok) {
        throw new Error(`Gamma search error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to search markets', { error: String(e), query });
      return [];
    }
  }

  // Get order book for a token
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    try {
      const res = await fetch(`${this.clobHost}/book?token_id=${tokenId}`);
      if (!res.ok) {
        throw new Error(`CLOB book error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch order book', { error: String(e), tokenId });
      return null;
    }
  }

  // Get price for a token and side
  async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<PolymarketPrice | null> {
    try {
      const res = await fetch(`${this.clobHost}/price?token_id=${tokenId}&side=${side}`);
      if (!res.ok) {
        throw new Error(`CLOB price error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch price', { error: String(e), tokenId, side });
      return null;
    }
  }

  // Get midpoint price
  async getMidpoint(tokenId: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.clobHost}/midpoint?token_id=${tokenId}`);
      if (!res.ok) {
        throw new Error(`CLOB midpoint error ${res.status}`);
      }
      const data: PolymarketMidpoint = await res.json();
      return parseFloat(data.mid);
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch midpoint', { error: String(e), tokenId });
      return null;
    }
  }

  // Get prices for multiple tokens
  async getPrices(tokenIds: string[], side: 'BUY' | 'SELL'): Promise<Record<string, string>> {
    try {
      const res = await fetch(`${this.clobHost}/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_ids: tokenIds, side }),
      });
      if (!res.ok) {
        throw new Error(`CLOB prices error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch prices', { error: String(e) });
      return {};
    }
  }

  // Get bid-ask spreads
  async getSpreads(tokenIds: string[]): Promise<Record<string, { bid: string; ask: string; spread: string }>> {
    try {
      const res = await fetch(`${this.clobHost}/spreads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_ids: tokenIds }),
      });
      if (!res.ok) {
        throw new Error(`CLOB spreads error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch spreads', { error: String(e) });
      return {};
    }
  }

  // Get price history
  async getPriceHistory(
    tokenId: string,
    params?: { startTs?: number; endTs?: number; interval?: string; fidelity?: number }
  ): Promise<Array<{ t: number; p: number }>> {
    const searchParams = new URLSearchParams({ token_id: tokenId });
    if (params?.startTs) searchParams.set('startTs', String(params.startTs));
    if (params?.endTs) searchParams.set('endTs', String(params.endTs));
    if (params?.interval) searchParams.set('interval', params.interval);
    if (params?.fidelity) searchParams.set('fidelity', String(params.fidelity));

    try {
      const res = await fetch(`${this.clobHost}/prices-history?${searchParams.toString()}`);
      if (!res.ok) {
        throw new Error(`CLOB price history error ${res.status}`);
      }
      const data = await res.json();
      return data.history || [];
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch price history', { error: String(e), tokenId });
      return [];
    }
  }
}

// Authenticated API client (requires credentials for trading)
export class PolymarketClient extends PolymarketPublicClient {
  private credentials?: {
    apiKey: string;
    apiSecret: string;
    passphrase: string;
  };

  constructor(config: PolymarketConfig) {
    super(config);
    this.credentials = config.credentials;
  }

  // Check if client has trading credentials
  hasCredentials(): boolean {
    return !!(this.credentials?.apiKey && this.credentials?.apiSecret && this.credentials?.passphrase);
  }

  // Get L2 auth headers
  private getAuthHeaders(): Record<string, string> {
    if (!this.credentials) {
      throw new Error('Trading credentials not configured');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();

    return {
      'POLY_ADDRESS': '', // Wallet address - should be set from config
      'POLY_SIGNATURE': '', // Signature - would need proper signing
      'POLY_TIMESTAMP': timestamp,
      'POLY_API_KEY': this.credentials.apiKey,
      'POLY_PASSPHRASE': this.credentials.passphrase,
    };
  }

  // Get active orders
  async getActiveOrders(market?: string): Promise<PolymarketOrder[]> {
    if (!this.hasCredentials()) {
      logger.warn('Polymarket', 'No credentials for getActiveOrders');
      return [];
    }

    const params = market ? `?market=${market}` : '';

    try {
      const res = await fetch(`${CLOB_HOST}/orders${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`CLOB orders error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch orders', { error: String(e) });
      return [];
    }
  }

  // Get trade history
  async getTradeHistory(params?: {
    market?: string;
    limit?: number;
    before?: string;
    after?: string;
  }): Promise<TradeHistory[]> {
    if (!this.hasCredentials()) {
      logger.warn('Polymarket', 'No credentials for getTradeHistory');
      return [];
    }

    const searchParams = new URLSearchParams();
    if (params?.market) searchParams.set('market', params.market);
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.before) searchParams.set('before', params.before);
    if (params?.after) searchParams.set('after', params.after);

    try {
      const res = await fetch(`${CLOB_HOST}/trades?${searchParams.toString()}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`CLOB trades error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch trades', { error: String(e) });
      return [];
    }
  }

  // Get positions
  async getPositions(): Promise<Position[]> {
    if (!this.hasCredentials()) {
      logger.warn('Polymarket', 'No credentials for getPositions');
      return [];
    }

    try {
      const res = await fetch(`${CLOB_HOST}/positions`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`CLOB positions error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to fetch positions', { error: String(e) });
      return [];
    }
  }

  // Place order (requires full SDK integration for signing)
  async placeOrder(args: OrderArgs): Promise<OrderResponse> {
    if (!this.hasCredentials()) {
      return { success: false, error: 'Trading credentials not configured' };
    }

    // Note: Full order placement requires EIP-712 signing with the Polymarket SDK
    // This is a simplified placeholder - actual implementation would use @polymarket/clob-client
    logger.info('Polymarket', 'Order placement requested', {
      tokenId: args.tokenId,
      side: args.side,
      price: args.price,
      size: args.size,
    });

    return {
      success: false,
      error: 'Full order signing not implemented. Use @polymarket/clob-client SDK for trading.',
    };
  }

  // Cancel order
  async cancelOrder(orderId: string): Promise<CancelResponse> {
    if (!this.hasCredentials()) {
      return { success: false, canceled: [], not_canceled: [orderId] };
    }

    try {
      const res = await fetch(`${CLOB_HOST}/order/${orderId}`, {
        method: 'DELETE',
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`CLOB cancel error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to cancel order', { error: String(e), orderId });
      return { success: false, canceled: [], not_canceled: [orderId] };
    }
  }

  // Cancel all orders
  async cancelAllOrders(market?: string): Promise<CancelResponse> {
    if (!this.hasCredentials()) {
      return { success: false, canceled: [], not_canceled: [] };
    }

    const params = market ? `?market=${market}` : '';

    try {
      const res = await fetch(`${CLOB_HOST}/orders${params}`, {
        method: 'DELETE',
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`CLOB cancel all error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      logger.error('Polymarket', 'Failed to cancel all orders', { error: String(e) });
      return { success: false, canceled: [], not_canceled: [] };
    }
  }
}

// Create a public client instance
export function createPublicClient(): PolymarketPublicClient {
  return new PolymarketPublicClient();
}

// Create an authenticated client instance
export function createClient(config: PolymarketConfig): PolymarketClient {
  return new PolymarketClient(config);
}
