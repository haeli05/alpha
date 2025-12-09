import { NextRequest } from 'next/server';
import { createPublicClient } from '@/lib/polymarket';
import { logger } from '@/lib/logger';

const client = createPublicClient();

export async function GET(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get('token_id');

  if (!tokenId) {
    return Response.json({ error: 'token_id is required' }, { status: 400 });
  }

  try {
    const [orderbook, midpoint] = await Promise.all([
      client.getOrderBook(tokenId),
      client.getMidpoint(tokenId),
    ]);

    if (!orderbook) {
      return Response.json({ error: 'Order book not found' }, { status: 404 });
    }

    return Response.json({
      ...orderbook,
      midpoint,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('PolymarketAPI', 'Failed to fetch orderbook', { error: message, tokenId });
    return Response.json({ error: message }, { status: 500 });
  }
}
