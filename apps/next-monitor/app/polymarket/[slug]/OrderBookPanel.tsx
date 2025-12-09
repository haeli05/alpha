'use client';

import { useEffect, useState } from 'react';

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBookData {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midpoint: number | null;
}

export default function OrderBookPanel({ tokenId }: { tokenId: string }) {
  const [data, setData] = useState<OrderBookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchOrderBook() {
      try {
        const res = await fetch(`/api/polymarket/orderbook?token_id=${tokenId}`);
        if (!res.ok) throw new Error('Failed to fetch order book');
        const json = await res.json();
        if (mounted) {
          setData({
            bids: json.bids || [],
            asks: json.asks || [],
            midpoint: json.midpoint,
          });
          setError(null);
        }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchOrderBook();
    const interval = setInterval(fetchOrderBook, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [tokenId]);

  if (loading) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading order book...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Error: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        No data
      </div>
    );
  }

  const maxBidSize = Math.max(...data.bids.map((b) => parseFloat(b.size) || 0), 1);
  const maxAskSize = Math.max(...data.asks.map((a) => parseFloat(a.size) || 0), 1);

  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      {/* Asks (sells) - reversed so lowest price at bottom */}
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            color: 'var(--text-tertiary)',
            fontWeight: 600,
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 6,
          }}
        >
          <span>Price</span>
          <span style={{ textAlign: 'right' }}>Size</span>
        </div>
        {data.asks
          .slice(0, 5)
          .reverse()
          .map((level, i) => {
            const size = parseFloat(level.size);
            const pct = (size / maxAskSize) * 100;
            return (
              <div
                key={`ask-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 4,
                  padding: '3px 6px',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: `${pct}%`,
                    backgroundColor: 'var(--red-bg)',
                    borderRadius: 2,
                  }}
                />
                <span style={{ color: 'var(--red)', position: 'relative' }}>
                  ${parseFloat(level.price).toFixed(2)}
                </span>
                <span style={{ textAlign: 'right', position: 'relative', color: 'var(--text-secondary)' }}>
                  {size.toFixed(0)}
                </span>
              </div>
            );
          })}
      </div>

      {/* Spread / Midpoint */}
      <div
        style={{
          textAlign: 'center',
          padding: '8px 0',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600,
          color: 'var(--accent)',
        }}
      >
        {data.midpoint ? `Mid: $${data.midpoint.toFixed(3)}` : 'No midpoint'}
      </div>

      {/* Bids (buys) */}
      <div style={{ marginTop: 8 }}>
        {data.bids.slice(0, 5).map((level, i) => {
          const size = parseFloat(level.size);
          const pct = (size / maxBidSize) * 100;
          return (
            <div
              key={`bid-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 4,
                padding: '3px 6px',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: `${pct}%`,
                  backgroundColor: 'var(--green-bg)',
                  borderRadius: 2,
                }}
              />
              <span style={{ color: 'var(--green)', position: 'relative' }}>
                ${parseFloat(level.price).toFixed(2)}
              </span>
              <span style={{ textAlign: 'right', position: 'relative', color: 'var(--text-secondary)' }}>
                {size.toFixed(0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
