import { fetch24hTicker, fetchKlines } from '@/lib/binance';
import { displayPair, MAJOR_BINANCE_SYMBOLS } from '@/lib/markets';
import dynamic from 'next/dynamic';
import Link from 'next/link';

const Chart = dynamic(() => import('@/components/CandlesChart'), { ssr: false });
const TradePanel = dynamic(() => import('./TradePanel'), { ssr: false });

export const revalidate = 30;

type Props = { params: { symbol: string } };

export default async function SymbolPage({ params }: Props) {
  const symbol = params.symbol.toUpperCase();
  const isKnown = MAJOR_BINANCE_SYMBOLS.includes(symbol as any);
  const [klines, ticker] = await Promise.all([
    fetchKlines(symbol, '15m', 192),
    fetch24hTicker(symbol),
  ]);
  const closes = klines.map((k) => k.close);
  const candles = klines.map((k) => ({
    time: Math.floor(k.openTime / 1000) as any,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
  }));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{displayPair(symbol)}</h1>
        {!isKnown && <span style={{ color: '#6b7280' }}>(custom)</span>}
      </div>
      <section style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{ticker.lastPrice?.toString() ?? '-'}</div>
          <div style={{ color: ticker.priceChangePercent >= 0 ? '#16a34a' : '#dc2626' }}>
            {ticker.priceChangePercent.toFixed(2)}% 24h
          </div>
        </div>
        <div style={{ color: '#6b7280' }}>
          <div>24h High: <b>{ticker.highPrice}</b></div>
          <div>24h Low: <b>{ticker.lowPrice}</b></div>
          <div>24h Volume (quote): <b>{Number(ticker.quoteVolume).toLocaleString()}</b></div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
          <Chart candles={candles as any} height={360} />
        </div>
        <TradePanel symbol={symbol} lastPrice={Number(ticker.lastPrice)} />
      </div>
      <div style={{ color: '#6b7280' }}>
        Showing last {closes.length} 15m candles from Binance REST.
      </div>
      <div>
        <Link href="/markets">Back to Markets</Link>
      </div>
    </div>
  );
}
