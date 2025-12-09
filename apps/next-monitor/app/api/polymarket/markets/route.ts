import { NextRequest } from 'next/server';
import { createPublicClient } from '@/lib/polymarket';
import { logger } from '@/lib/logger';

const client = createPublicClient();

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;

  try {
    const params = {
      active: searchParams.get('active') !== 'false',
      closed: searchParams.get('closed') === 'true',
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : 20,
      offset: searchParams.get('offset') ? Number(searchParams.get('offset')) : 0,
      order: (searchParams.get('order') as 'volume' | 'liquidity' | 'created_at') || 'volume',
      ascending: searchParams.get('ascending') === 'true',
      tag: searchParams.get('tag') || undefined,
    };

    const query = searchParams.get('q');

    let markets;
    if (query) {
      markets = await client.searchMarkets(query, params.limit);
    } else {
      markets = await client.getMarkets(params);
    }

    return Response.json({ markets, count: markets.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('PolymarketAPI', 'Failed to fetch markets', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
