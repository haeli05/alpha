import { NextRequest } from 'next/server';
import { computePosition, listOrders, placeOrder } from '@/lib/paperStore';
import { PaperOrderSchema, formatZodError } from '@/lib/validation';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase();
  const orders = listOrders(symbol || undefined);
  const position = orders.length > 0 ? computePosition(orders) : null;
  return Response.json({ orders, position });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Validate input with Zod
    const result = PaperOrderSchema.safeParse(body);
    if (!result.success) {
      logger.warn('PaperOrders', 'Validation failed', { issues: result.error.issues });
      return Response.json(
        { error: formatZodError(result.error) },
        { status: 400 }
      );
    }

    const { symbol, side, qty, price } = result.data;
    logger.info('PaperOrders', 'Placing order', { symbol, side, qty, price });

    const order = placeOrder(symbol, side, qty, price);
    const orders = listOrders(symbol);
    const position = computePosition(orders);

    return Response.json({ order, position });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('PaperOrders', 'Failed to place order', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}

