import { NextRequest } from 'next/server';
import { computePosition, listOrders, placeOrder, type OrderSide } from '@/lib/paperStore';

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
    const symbol = String(body.symbol || '').toUpperCase();
    const side = String(body.side || '').toUpperCase() as OrderSide;
    const qty = Number(body.qty);
    const price = Number(body.price);
    if (!symbol || (side !== 'BUY' && side !== 'SELL')) throw new Error('Invalid symbol/side');
    const order = placeOrder(symbol, side, qty, price);
    const orders = listOrders(symbol);
    const position = computePosition(orders);
    return Response.json({ order, position });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 400 });
  }
}

