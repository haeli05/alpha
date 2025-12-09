import { Suspense } from 'react';
import { createPublicClient } from '@/lib/polymarket';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';

const OrderBookPanel = dynamic(() => import('./OrderBookPanel'), { ssr: false });
const TradePanel = dynamic(() => import('./TradePanel'), { ssr: false });
const PolymarketChart = dynamic(() => import('./PolymarketChart'), { ssr: false });
const StrategyPanel = dynamic(() => import('./StrategyPanel'), { ssr: false });

export const revalidate = 30;

type Props = { params: { slug: string } };

function parseOutcomePrices(outcomePrices: unknown): number[] {
  if (!outcomePrices) return [];
  if (Array.isArray(outcomePrices)) {
    return outcomePrices.map((p) => {
      const num = typeof p === 'string' ? parseFloat(p) : p;
      return isNaN(num) ? 0 : num;
    });
  }
  if (typeof outcomePrices === 'string') {
    try {
      const parsed = JSON.parse(outcomePrices);
      if (Array.isArray(parsed)) {
        return parsed.map((p) => (typeof p === 'string' ? parseFloat(p) : p) || 0);
      }
    } catch {
      return outcomePrices.split(',').map((p) => parseFloat(p.trim()) || 0);
    }
  }
  return [];
}

export default async function MarketPage({ params }: Props) {
  const client = createPublicClient();
  const market = await client.getMarketBySlug(params.slug);

  if (!market) {
    notFound();
  }

  const prices = parseOutcomePrices(market.outcomePrices);
  const yesPrice = prices[0] || 0.5;
  const noPrice = prices[1] || 0.5;

  const yesTokenId = market.tokens?.[0]?.token_id;
  const noTokenId = market.tokens?.[1]?.token_id;

  return (
    <div style={{ display: 'grid', gap: 32 }}>
      {/* Back link */}
      <Link
        href="/polymarket"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        ← Back to Markets
      </Link>

      {/* Header */}
      <header style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {market.image && (
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--bg-tertiary)',
              flexShrink: 0,
            }}
          >
            <img
              src={market.image}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        )}
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1.3,
              color: 'var(--text-primary)',
            }}
          >
            {market.question}
          </h1>
          {market.description && (
            <p
              style={{
                margin: '12px 0 0',
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
                maxWidth: 700,
              }}
            >
              {market.description.slice(0, 300)}
              {market.description.length > 300 ? '...' : ''}
            </p>
          )}
        </div>
      </header>

      {/* Price Overview */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 16,
        }}
      >
        <PriceCard outcome="Yes" price={yesPrice} isYes />
        <PriceCard outcome="No" price={noPrice} isYes={false} />
        <StatsCard label="Volume" value={formatMoney(market.volume)} />
        <StatsCard label="Liquidity" value={formatMoney(market.liquidity)} />
        <StatsCard label="24h Vol" value={formatMoney(market.volume24hr)} highlight />
        <StatsCard
          label="End Date"
          value={market.endDate ? new Date(market.endDate).toLocaleDateString() : 'N/A'}
        />
      </section>

      {/* Main content */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 380px',
          gap: 24,
        }}
      >
        <div style={{ display: 'grid', gap: 24 }}>
          {/* YES Chart */}
          <section className="card">
            <div className="card-header">
              <span className="card-title" style={{ color: 'var(--green)' }}>YES Price Chart</span>
            </div>
            <div className="card-body">
              <Suspense fallback={<LoadingPlaceholder height={350} />}>
                {yesTokenId && <PolymarketChart tokenId={yesTokenId} outcome="Yes" />}
              </Suspense>
            </div>
          </section>

          {/* NO Chart */}
          <section className="card">
            <div className="card-header">
              <span className="card-title" style={{ color: 'var(--red)' }}>NO Price Chart</span>
            </div>
            <div className="card-body">
              <Suspense fallback={<LoadingPlaceholder height={350} />}>
                {noTokenId && <PolymarketChart tokenId={noTokenId} outcome="No" />}
              </Suspense>
            </div>
          </section>

          {/* Order Books */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <section className="card">
              <div className="card-header">
                <span className="card-title" style={{ color: 'var(--green)' }}>YES Order Book</span>
              </div>
              <div className="card-body">
                <Suspense fallback={<LoadingPlaceholder height={200} />}>
                  {yesTokenId && <OrderBookPanel tokenId={yesTokenId} />}
                </Suspense>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <span className="card-title" style={{ color: 'var(--red)' }}>NO Order Book</span>
              </div>
              <div className="card-body">
                <Suspense fallback={<LoadingPlaceholder height={200} />}>
                  {noTokenId && <OrderBookPanel tokenId={noTokenId} />}
                </Suspense>
              </div>
            </section>
          </div>
        </div>

        {/* Sidebar */}
        <aside style={{ display: 'grid', gap: 24, alignContent: 'start' }}>
          <Suspense fallback={<LoadingPlaceholder height={400} />}>
            <TradePanel
              market={market}
              yesTokenId={yesTokenId}
              noTokenId={noTokenId}
              yesPrice={yesPrice}
              noPrice={noPrice}
            />
          </Suspense>

          <Suspense fallback={<LoadingPlaceholder height={300} />}>
            <StrategyPanel
              market={market}
              yesTokenId={yesTokenId}
              noTokenId={noTokenId}
              yesPrice={yesPrice}
              noPrice={noPrice}
            />
          </Suspense>
        </aside>
      </div>

      {/* Tags */}
      {market.tags && market.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {market.tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 500,
                padding: '4px 10px',
                background: 'var(--bg-tertiary)',
                borderRadius: 4,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.3px',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PriceCard({ outcome, price, isYes }: { outcome: string; price: number; isYes: boolean }) {
  const pct = Math.round(price * 100);
  const color = isYes ? 'var(--green)' : 'var(--red)';
  const bgColor = isYes ? 'var(--green-bg)' : 'var(--red-bg)';
  const borderColor = isYes ? 'var(--green-border)' : 'var(--red-border)';

  return (
    <div
      style={{
        padding: 20,
        background: bgColor,
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        {outcome}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 36,
          fontWeight: 700,
          color: color,
          lineHeight: 1,
        }}
      >
        {pct}%
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-tertiary)',
          marginTop: 8,
        }}
      >
        ${price.toFixed(2)}/share
      </div>
    </div>
  );
}

function StatsCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      style={{
        padding: 20,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 18,
          fontWeight: 600,
          color: highlight ? 'var(--accent)' : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function LoadingPlaceholder({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        background: 'var(--bg-tertiary)',
        borderRadius: 8,
        animation: 'pulse 2s ease-in-out infinite',
      }}
    />
  );
}

function formatMoney(amount: unknown): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
  if (!num || isNaN(num)) return '$0';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}
