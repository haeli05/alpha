'use client';

import { useEffect, useState, useRef } from 'react';

interface PricePoint {
  t: number;
  p: number;
}

export default function PriceChart({ tokenId, outcome }: { tokenId: string; outcome: string }) {
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchHistory() {
      setLoading(true);
      try {
        const now = Math.floor(Date.now() / 1000);
        let startTs: number;
        let fidelity: number;

        switch (timeframe) {
          case '24h':
            startTs = now - 86400;
            fidelity = 60; // 1 min intervals
            break;
          case '7d':
            startTs = now - 7 * 86400;
            fidelity = 3600; // 1 hour intervals
            break;
          case '30d':
            startTs = now - 30 * 86400;
            fidelity = 14400; // 4 hour intervals
            break;
          default:
            startTs = now - 365 * 86400;
            fidelity = 86400; // 1 day intervals
        }

        // Using the internal API route
        const res = await fetch(
          `https://clob.polymarket.com/prices-history?token_id=${tokenId}&startTs=${startTs}&endTs=${now}&fidelity=${fidelity}`
        );
        if (!res.ok) throw new Error('Failed to fetch price history');
        const json = await res.json();

        if (mounted) {
          setData(json.history || []);
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

    fetchHistory();

    return () => {
      mounted = false;
    };
  }, [tokenId, timeframe]);

  // Draw chart on canvas
  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 10, right: 10, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const prices = data.map((d) => d.p);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 0.1;

    // Scale functions
    const xScale = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
    const yScale = (p: number) =>
      padding.top + chartHeight - ((p - minPrice) / priceRange) * chartHeight;

    // Draw grid lines
    ctx.strokeStyle = '#f3f4f6';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (i / 4) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    // Draw price labels
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const price = maxPrice - (i / 4) * priceRange;
      const y = padding.top + (i / 4) * chartHeight;
      ctx.fillText(`$${price.toFixed(2)}`, padding.left - 5, y + 4);
    }

    // Draw area fill
    ctx.beginPath();
    ctx.moveTo(xScale(0), height - padding.bottom);
    data.forEach((d, i) => {
      ctx.lineTo(xScale(i), yScale(d.p));
    });
    ctx.lineTo(xScale(data.length - 1), height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = outcome === 'Yes' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    ctx.fill();

    // Draw line
    ctx.beginPath();
    data.forEach((d, i) => {
      if (i === 0) {
        ctx.moveTo(xScale(i), yScale(d.p));
      } else {
        ctx.lineTo(xScale(i), yScale(d.p));
      }
    });
    ctx.strokeStyle = outcome === 'Yes' ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw time labels
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    const labelCount = 5;
    for (let i = 0; i < labelCount; i++) {
      const dataIndex = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const point = data[dataIndex];
      if (point) {
        const date = new Date(point.t * 1000);
        let label: string;
        if (timeframe === '24h') {
          label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          label = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
        ctx.fillText(label, xScale(dataIndex), height - 10);
      }
    }
  }, [data, outcome]);

  return (
    <div>
      {/* Timeframe selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['24h', '7d', '30d', 'all'] as const).map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            style={{
              padding: '4px 12px',
              fontSize: 12,
              border: 'none',
              borderRadius: 4,
              backgroundColor: timeframe === tf ? '#3b82f6' : '#f3f4f6',
              color: timeframe === tf ? 'white' : '#6b7280',
              cursor: 'pointer',
            }}
          >
            {tf.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Chart */}
      {loading ? (
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
          Loading chart...
        </div>
      ) : error ? (
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}>
          {error}
        </div>
      ) : data.length === 0 ? (
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
          No price history available
        </div>
      ) : (
        <canvas ref={canvasRef} style={{ width: '100%', height: 300, display: 'block' }} />
      )}

      {/* Current price */}
      {data.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 13, color: '#6b7280', textAlign: 'right' }}>
          Current: ${data[data.length - 1].p.toFixed(2)} ({Math.round(data[data.length - 1].p * 100)}%)
        </div>
      )}
    </div>
  );
}
