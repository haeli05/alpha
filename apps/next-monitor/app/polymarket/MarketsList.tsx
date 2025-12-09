'use client';

import Link from 'next/link';
import type { PolymarketMarket } from '@/lib/polymarket';

interface Props {
  initialMarkets: PolymarketMarket[];
}

function formatVolume(volume: unknown): string {
  const num = typeof volume === 'string' ? parseFloat(volume) : Number(volume);
  if (!num || isNaN(num)) return '$0';
  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `$${(num / 1_000).toFixed(1)}K`;
  }
  return `$${num.toFixed(0)}`;
}

// Safely parse outcomes (API returns string, array, or JSON string)
function parseOutcomes(outcomes: unknown): string[] {
  if (!outcomes) return ['Yes', 'No'];

  if (Array.isArray(outcomes)) {
    return outcomes.map((o) => String(o));
  }

  if (typeof outcomes === 'string') {
    try {
      const parsed = JSON.parse(outcomes);
      if (Array.isArray(parsed)) {
        return parsed.map((o) => String(o));
      }
    } catch {
      return outcomes.split(',').map((o) => o.trim());
    }
  }

  return ['Yes', 'No'];
}

// Safely parse outcome prices (API returns string, array, or JSON string)
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
        return parsed.map((p) => {
          const num = typeof p === 'string' ? parseFloat(p) : p;
          return isNaN(num) ? 0 : num;
        });
      }
    } catch {
      return outcomePrices.split(',').map((p) => parseFloat(p.trim()) || 0);
    }
  }

  return [];
}

function ProbabilityBar({ label, probability, isYes }: { label: string; probability: number; isYes: boolean }) {
  const pct = Math.round(probability * 100);
  const color = isYes ? 'var(--green)' : 'var(--red)';
  const bgColor = isYes ? 'var(--green-bg)' : 'var(--red-bg)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 140 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-tertiary)',
          width: 28,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'var(--bg-tertiary)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 3,
            boxShadow: `0 0 8px ${bgColor}`,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          fontWeight: 700,
          color: color,
          width: 42,
          textAlign: 'right',
        }}
      >
        {pct}%
      </span>
    </div>
  );
}

export default function MarketsList({ initialMarkets }: Props) {
  if (!initialMarkets || initialMarkets.length === 0) {
    return (
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        No markets found.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }} className="stagger-children">
      {initialMarkets.map((market) => {
        const prices = parseOutcomePrices(market.outcomePrices);
        const outcomes = parseOutcomes(market.outcomes);
        const yesPrice = prices[0] || 0.5;
        const noPrice = prices[1] || 0.5;

        return (
          <Link
            key={market.id}
            href={`/polymarket/${market.slug}`}
            className="list-card"
          >
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* Image */}
              {market.image && (
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 10,
                    overflow: 'hidden',
                    background: 'var(--bg-tertiary)',
                    flexShrink: 0,
                  }}
                >
                  <img
                    src={market.image}
                    alt=""
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                </div>
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Question */}
                <h3
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 600,
                    lineHeight: 1.4,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {market.question}
                </h3>

                {/* Probabilities and stats */}
                <div
                  style={{
                    display: 'flex',
                    gap: 24,
                    marginTop: 16,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  {/* Probability bars */}
                  <div style={{ display: 'flex', gap: 16 }}>
                    {outcomes.slice(0, 2).map((outcome, i) => (
                      <ProbabilityBar
                        key={outcome}
                        label={outcome}
                        probability={i === 0 ? yesPrice : noPrice}
                        isYes={outcome.toLowerCase() === 'yes'}
                      />
                    ))}
                  </div>

                  {/* Stats */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 20,
                      marginLeft: 'auto',
                    }}
                  >
                    <Stat label="Volume" value={formatVolume(market.volume)} />
                    <Stat label="Liquidity" value={formatVolume(market.liquidity)} />
                    {Number(market.volume24hr) > 0 && (
                      <Stat label="24h" value={formatVolume(market.volume24hr)} highlight />
                    )}
                  </div>
                </div>

                {/* Tags */}
                {market.tags && market.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                    {market.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          fontWeight: 500,
                          padding: '3px 8px',
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
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-muted)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 600,
          color: highlight ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
