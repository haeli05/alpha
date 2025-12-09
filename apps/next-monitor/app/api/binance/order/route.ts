import { NextRequest } from 'next/server';
import { binanceRateLimiter, newOrder } from '@/lib/execution/binance';
import { preTradeCheck } from '@/lib/risk';
import { BinanceOrderSchema, formatZodError } from '@/lib/validation';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    // Check if live trading is enabled
    if (process.env.ENABLE_LIVE_TRADING !== 'true') {
      logger.warn('BinanceOrder', 'Live trading disabled');
      return Response.json(
        { error: 'Live trading disabled. Set ENABLE_LIVE_TRADING=true in env.' },
        { status: 403 }
      );
    }

    const body = await req.json();

    // Validate input with Zod
    const result = BinanceOrderSchema.safeParse(body);
    if (!result.success) {
      logger.warn('BinanceOrder', 'Validation failed', { issues: result.error.issues });
      return Response.json(
        { error: formatZodError(result.error) },
        { status: 400 }
      );
    }

    const { symbol, side, type, quantity, quoteOrderQty, price, markPrice } = result.data;

    // Check rate limit
    if (!binanceRateLimiter.allow()) {
      logger.warn('BinanceOrder', 'Rate limited', { symbol });
      return Response.json({ error: 'Rate limited' }, { status: 429 });
    }

    // Pre-trade risk checks
    const maxNotional = process.env.MAX_NOTIONAL_PER_ORDER ? Number(process.env.MAX_NOTIONAL_PER_ORDER) : undefined;
    const allowedSymbols = process.env.ALLOWED_SYMBOLS?.split(',').map(s => s.trim().toUpperCase());
    const priceForRisk = price ?? markPrice ?? 0;
    const qtyForRisk = quantity ?? 0;

    const risk = preTradeCheck(
      { maxNotional, allowedSymbols },
      { symbol, side, qty: qtyForRisk, price: priceForRisk }
    );

    if (!risk.ok) {
      logger.warn('BinanceOrder', 'Risk check failed', { reason: risk.reason, symbol });
      return Response.json({ error: `risk_${risk.reason}` }, { status: 400 });
    }

    logger.info('BinanceOrder', 'Placing order', { symbol, side, type, quantity, quoteOrderQty });

    const res = await newOrder({
      symbol,
      side,
      type,
      quantity,
      quoteOrderQty,
      price,
      timeInForce: type === 'LIMIT' ? 'GTC' : undefined,
    });

    logger.info('BinanceOrder', 'Order placed successfully', { symbol, orderId: res.orderId });
    return Response.json(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('BinanceOrder', 'Failed to place order', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}

