import crypto from 'node:crypto';

const BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';

function sign(query: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

function qs(params: Record<string, string | number | boolean | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}

async function signedFetch(path: string, method: 'GET'|'POST'|'DELETE', params: Record<string, any> = {}) {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error('Missing BINANCE_API_KEY/SECRET');
  const timestamp = Date.now();
  const recvWindow = 5000;
  const query = qs({ ...params, timestamp, recvWindow });
  const signature = sign(query, secret);
  const url = `${BASE}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': key } });
  if (!res.ok) throw new Error(`Binance ${method} ${path} ${res.status}`);
  return res.json();
}

export async function accountInfo() {
  return signedFetch('/api/v3/account', 'GET');
}

export type NewOrderParams = {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity?: number; // base qty
  quoteOrderQty?: number; // quote qty
  price?: number; // for LIMIT
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  newClientOrderId?: string; // idempotency key
};

export async function newOrder(p: NewOrderParams) {
  const params = { ...p } as any;
  if (!params.newClientOrderId) {
    params.newClientOrderId = `alpha_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  }
  return signedFetch('/api/v3/order', 'POST', params);
}

export async function getOpenOrders(symbol?: string) {
  const params: any = {};
  if (symbol) params.symbol = symbol;
  return signedFetch('/api/v3/openOrders', 'GET', params);
}

export async function getOrder(symbol: string, origClientOrderId: string) {
  return signedFetch('/api/v3/order', 'GET', { symbol, origClientOrderId });
}

// Simple in-memory token bucket rate limiter per key
class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }
  allow(cost = 1): boolean {
    const now = Date.now();
    const delta = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillPerSec);
    if (this.tokens >= cost) { this.tokens -= cost; return true; }
    return false;
  }
}

export const binanceRateLimiter = new RateLimiter(10, 10); // 10 req burst, 10 rps

