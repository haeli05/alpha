import { NextRequest } from 'next/server';
import { createPublicClient } from '@/lib/polymarket';

const client = createPublicClient();

export async function GET(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get('token_id');
  const startTs = req.nextUrl.searchParams.get('startTs');
  const endTs = req.nextUrl.searchParams.get('endTs');
  const fidelity = req.nextUrl.searchParams.get('fidelity');

  if (!tokenId) {
    return Response.json({ error: 'token_id is required' }, { status: 400 });
  }

  try {
    const history = await client.getPriceHistory(tokenId, {
      startTs: startTs ? parseInt(startTs) : undefined,
      endTs: endTs ? parseInt(endTs) : undefined,
      fidelity: fidelity ? parseInt(fidelity) : undefined,
    });

    return Response.json({ history });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}
