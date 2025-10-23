import { MAJOR_BINANCE_SYMBOLS } from '@/lib/markets';
import { fetchKlines, pctChange, fetch24hTicker } from '@/lib/binance';
import dynamic from 'next/dynamic';

const MarketsLiveTable = dynamic(() => import('@/components/MarketsLiveTable'), { ssr: false });

export const revalidate = 30; // seconds

export default async function MarketsPage() {
  const results = await Promise.all(
    MAJOR_BINANCE_SYMBOLS.map(async (symbol) => {
      try {
        const [k, t] = await Promise.all([
          fetchKlines(symbol, '15m', 96),
          fetch24hTicker(symbol),
        ]);
        const closes = k.map((x) => x.close);
        const last = closes[closes.length - 1];
        const changePct = pctChange(closes[0], last);
        return { symbol, closes, last, changePct, ticker: t };
      } catch (e) {
        return { symbol, closes: [], last: NaN, changePct: NaN, error: String(e) };
      }
    })
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h1>Binance Markets (15m)</h1>
      <MarketsLiveTable rows={results as any} />
    </div>
  );
}
