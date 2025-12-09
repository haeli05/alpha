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
    const [buyPrice, sellPrice, midpoint] = await Promise.all([
      client.getPrice(tokenId, 'BUY'),
      client.getPrice(tokenId, 'SELL'),
      client.getMidpoint(tokenId),
    ]);

    return Response.json({
      token_id: tokenId,
      buy: buyPrice?.price || null,
      sell: sellPrice?.price || null,
      mid: midpoint,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('PolymarketAPI', 'Failed to fetch prices', { error: message, tokenId });
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token_ids, side } = body;

    if (!Array.isArray(token_ids) || token_ids.length === 0) {
      return Response.json({ error: 'token_ids array is required' }, { status: 400 });
    }

    if (!side || !['BUY', 'SELL'].includes(side)) {
      return Response.json({ error: 'side must be BUY or SELL' }, { status: 400 });
    }

    const prices = await client.getPrices(token_ids, side);
    return Response.json({ prices });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('PolymarketAPI', 'Failed to fetch prices', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
