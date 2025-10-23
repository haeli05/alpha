import { NextRequest } from 'next/server';
import { binanceRateLimiter, newOrder } from '@/lib/execution/binance';
import { preTradeCheck } from '@/lib/risk';

export async function POST(req: NextRequest) {
  try {
    if (process.env.ENABLE_LIVE_TRADING !== 'true') {
      return new Response(JSON.stringify({ error: 'Live trading disabled. Set ENABLE_LIVE_TRADING=true in env.' }), { status: 403 });
    }
    const body = await req.json();
    const symbol = String(body.symbol || '').toUpperCase();
    const side = String(body.side || '').toUpperCase() as 'BUY' | 'SELL';
    const type = String(body.type || 'MARKET').toUpperCase() as 'MARKET' | 'LIMIT';
    const quantity = body.quantity != null ? Number(body.quantity) : undefined;
    const quoteOrderQty = body.quoteOrderQty != null ? Number(body.quoteOrderQty) : undefined;
    const price = body.price != null ? Number(body.price) : undefined;

    if (!symbol || (side !== 'BUY' && side !== 'SELL')) throw new Error('Invalid symbol/side');
    if (!binanceRateLimiter.allow()) return new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 });

    const maxNotional = process.env.MAX_NOTIONAL_PER_ORDER ? Number(process.env.MAX_NOTIONAL_PER_ORDER) : undefined;
    const allowedSymbols = process.env.ALLOWED_SYMBOLS ? process.env.ALLOWED_SYMBOLS.split(',').map(s => s.trim().toUpperCase()) : undefined;
    const priceForRisk = price ?? Number(body.markPrice ?? 0);
    const qtyForRisk = quantity ?? 0;
    const risk = preTradeCheck({ maxNotional, allowedSymbols }, { symbol, side, qty: qtyForRisk, price: priceForRisk });
    if (!risk.ok) return new Response(JSON.stringify({ error: `risk_${risk.reason}` }), { status: 400 });

    const res = await newOrder({ symbol, side, type, quantity, quoteOrderQty, price, timeInForce: type === 'LIMIT' ? 'GTC' : undefined });
    return Response.json(res);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 400 });
  }
}

