import { NextRequest } from 'next/server';
import { getTrades, getTradeStats, addTrade, updateTrade } from '@/lib/pairArbStore';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const status = searchParams.get('status') as 'open' | 'filled' | 'cancelled' | 'failed' | null;
    const marketSlug = searchParams.get('marketSlug') || undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
    const stats = searchParams.get('stats') === 'true';

    if (stats) {
      const tradeStats = getTradeStats();
      return Response.json(tradeStats);
    }

    const trades = getTrades({
      status: status || undefined,
      marketSlug,
      limit,
    });

    return Response.json({ trades });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('PairArbTrades', 'Failed to fetch trades', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const trade = addTrade(body);
    logger.info('PairArbTrades', 'Trade added', { tradeId: trade.id });
    return Response.json({ trade });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('PairArbTrades', 'Failed to add trade', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) {
      return Response.json({ error: 'Trade ID is required' }, { status: 400 });
    }
    const trade = updateTrade(id, updates);
    if (!trade) {
      return Response.json({ error: 'Trade not found' }, { status: 404 });
    }
    logger.info('PairArbTrades', 'Trade updated', { tradeId: id, updates });
    return Response.json({ trade });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('PairArbTrades', 'Failed to update trade', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}






