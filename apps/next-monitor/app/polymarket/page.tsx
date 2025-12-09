import { Suspense } from 'react';
import { createPublicClient } from '@/lib/polymarket';
import PolymarketSearch from './PolymarketSearch';
import MarketsList from './MarketsList';

export const revalidate = 60;

export default async function PolymarketPage() {
  const client = createPublicClient();

  const markets = await client.getMarkets({
    active: true,
    limit: 20,
    order: 'volume',
    ascending: false,
  });

  return (
    <div style={{ display: 'grid', gap: 32 }}>
      {/* Hero Section */}
      <header
        style={{
          display: 'grid',
          gap: 16,
          padding: '24px 0',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '-0.5px',
              color: 'var(--text-primary)',
            }}
          >
            POLYMARKET
          </h1>
          <span
            style={{
              padding: '4px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              background: 'var(--accent-bg)',
              border: '1px solid var(--accent-border)',
              borderRadius: 100,
              color: 'var(--accent)',
            }}
          >
            Prediction Markets
          </span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: 'var(--text-secondary)',
            maxWidth: 600,
          }}
        >
          Trade prediction markets on real-world events. Prices represent probabilities from 0-100%.
          Buy YES or NO shares and earn $1 per share if your prediction is correct.
        </p>
      </header>

      {/* Search */}
      <Suspense
        fallback={
          <div
            style={{
              height: 48,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              animation: 'pulse 2s ease-in-out infinite',
            }}
          />
        }
      >
        <PolymarketSearch />
      </Suspense>

      {/* Markets Grid */}
      <section style={{ display: 'grid', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--text-tertiary)',
            }}
          >
            Top Markets by Volume
          </h2>
          <div
            style={{
              flex: 1,
              height: 1,
              background: 'var(--border)',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            {markets.length} markets
          </span>
        </div>

        <Suspense
          fallback={
            <div
              style={{
                display: 'grid',
                gap: 12,
              }}
            >
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  style={{
                    height: 100,
                    background: 'var(--bg-secondary)',
                    borderRadius: 12,
                    animation: 'pulse 2s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`,
                  }}
                />
              ))}
            </div>
          }
        >
          <MarketsList initialMarkets={markets} />
        </Suspense>
      </section>
    </div>
  );
}
