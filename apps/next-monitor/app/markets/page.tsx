import Link from 'next/link';
import { MAJOR_BINANCE_SYMBOLS, displayPair } from '@/lib/markets';
import { fetchKlines, pctChange, fetch24hTicker } from '@/lib/binance';
import dynamic from 'next/dynamic';

const Sparkline = dynamic(() => import('@/components/Sparkline'), { ssr: false });

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
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th style={{ textAlign: 'right' }}>Last</th>
            <th style={{ textAlign: 'right' }}>Change (window)</th>
            <th style={{ textAlign: 'right' }}>24h Change</th>
            <th style={{ textAlign: 'right' }}>24h Vol</th>
            <th>Trend</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const color = (r.changePct || 0) >= 0 ? '#16a34a' : '#dc2626';
            return (
              <tr key={r.symbol}>
                <td style={{ fontWeight: 600 }}>{displayPair(r.symbol)}</td>
                <td style={{ textAlign: 'right' }}>{Number.isFinite(r.last) ? r.last.toFixed(4) : '-'}</td>
                <td style={{ textAlign: 'right', color }}>
                  {Number.isFinite(r.changePct) ? `${r.changePct.toFixed(2)}%` : '-'}
                </td>
                <td style={{ textAlign: 'right', color: r.ticker && r.ticker.priceChangePercent >= 0 ? '#16a34a' : '#dc2626' }}>
                  {r.ticker ? `${r.ticker.priceChangePercent.toFixed(2)}%` : '-'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r.ticker ? Number(r.ticker.quoteVolume).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
                </td>
                <td>
                  {r.closes.length > 0 ? (
                    <Sparkline data={r.closes} width={160} height={40} stroke={color} fill={color} />
                  ) : (
                    <span style={{ color: '#6b7280' }}>no data</span>
                  )}
                </td>
                <td>
                  <Link href={`/markets/${r.symbol}`}>View</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
