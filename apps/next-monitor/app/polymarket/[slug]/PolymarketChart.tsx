'use client';

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';

interface PricePoint {
  t: number;
  p: number;
}

interface Props {
  tokenId: string;
  outcome: 'Yes' | 'No';
  entryPrice?: number;    // Show entry line
  stopLossPrice?: number; // Show stop loss line
  takeProfitPrice?: number; // Show take profit line
  height?: number;
}

type Timeframe = '24h' | '7d' | '30d' | 'all';

export default function PolymarketChart({
  tokenId,
  outcome,
  entryPrice,
  stopLossPrice,
  takeProfitPrice,
  height = 350,
}: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    let mounted = true;

    async function fetchAndRender() {
      setLoading(true);
      setError(null);

      try {
        // Dynamically import lightweight-charts to avoid SSR issues
        const { createChart, ColorType, LineStyle } = await import('lightweight-charts');

        const now = Math.floor(Date.now() / 1000);
        let startTs: number;
        let fidelity: number;

        switch (timeframe) {
          case '24h':
            startTs = now - 86400;
            fidelity = 60;
            break;
          case '7d':
            startTs = now - 7 * 86400;
            fidelity = 900; // 15 min
            break;
          case '30d':
            startTs = now - 30 * 86400;
            fidelity = 3600;
            break;
          default:
            startTs = now - 365 * 86400;
            fidelity = 86400;
        }

        const res = await fetch(
          `/api/polymarket/prices-history?token_id=${tokenId}&startTs=${startTs}&endTs=${now}&fidelity=${fidelity}`
        );

        if (!res.ok) throw new Error('Failed to fetch price data');

        const json = await res.json();
        const history: PricePoint[] = json.history || [];

        if (!mounted || !chartRef.current) return;
        if (history.length === 0) {
          setError('No price history available');
          setLoading(false);
          return;
        }

        // Clean up previous chart
        if (chartInstanceRef.current) {
          chartInstanceRef.current.remove();
          chartInstanceRef.current = null;
        }

        const lineColor = outcome === 'Yes' ? '#00ff88' : '#ff3366';
        const areaColor = outcome === 'Yes' ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 51, 102, 0.1)';

        const chart = createChart(chartRef.current, {
          width: chartRef.current.clientWidth,
          height,
          layout: {
            background: { type: ColorType.Solid, color: '#0f0f14' },
            textColor: '#9898a6',
          },
          grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.06)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.06)' },
          },
          timeScale: {
            timeVisible: true,
            secondsVisible: false,
            borderColor: 'rgba(255, 255, 255, 0.1)',
          },
          rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: { top: 0.1, bottom: 0.1 },
          },
          crosshair: {
            mode: 1,
            vertLine: { width: 1, color: '#5c5c6d', style: LineStyle.Dashed },
            horzLine: { width: 1, color: '#5c5c6d', style: LineStyle.Dashed },
          },
        });

        chartInstanceRef.current = chart;

        // Area series for price
        const areaSeries = chart.addAreaSeries({
          lineColor,
          topColor: areaColor,
          bottomColor: 'rgba(255, 255, 255, 0)',
          lineWidth: 2,
          priceFormat: {
            type: 'price',
            precision: 3,
            minMove: 0.001,
          },
        });

        const chartData = history.map((p) => ({
          time: p.t as UTCTimestamp,
          value: p.p,
        }));

        areaSeries.setData(chartData);
        setCurrentPrice(history[history.length - 1].p);

        // Entry price line
        if (entryPrice !== undefined) {
          areaSeries.createPriceLine({
            price: entryPrice,
            color: '#00d4ff',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Entry',
          });
        }

        // Stop loss line
        if (stopLossPrice !== undefined) {
          areaSeries.createPriceLine({
            price: stopLossPrice,
            color: '#ff3366',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Stop',
          });
        }

        // Take profit line
        if (takeProfitPrice !== undefined) {
          areaSeries.createPriceLine({
            price: takeProfitPrice,
            color: '#00ff88',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'TP',
          });
        }

        chart.timeScale().fitContent();

        // Resize observer
        const resizeObserver = new ResizeObserver(() => {
          if (chartRef.current && chartInstanceRef.current) {
            chartInstanceRef.current.applyOptions({
              width: chartRef.current.clientWidth,
            });
          }
        });

        resizeObserver.observe(chartRef.current);

        return () => {
          resizeObserver.disconnect();
        };
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchAndRender();

    return () => {
      mounted = false;
      if (chartInstanceRef.current) {
        chartInstanceRef.current.remove();
        chartInstanceRef.current = null;
      }
    };
  }, [tokenId, timeframe, outcome, height, entryPrice, stopLossPrice, takeProfitPrice]);

  return (
    <div>
      {/* Timeframe selector */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['24h', '7d', '30d', 'all'] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              style={{
                padding: '6px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: timeframe === tf ? 600 : 500,
                border: 'none',
                borderRadius: 4,
                backgroundColor: timeframe === tf ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: timeframe === tf ? 'var(--bg-primary)' : 'var(--text-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                textTransform: 'uppercase',
              }}
            >
              {tf}
            </button>
          ))}
        </div>

        {currentPrice !== null && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 600,
              color: outcome === 'Yes' ? 'var(--green)' : 'var(--red)',
            }}
          >
            {outcome}: ${currentPrice.toFixed(3)} ({Math.round(currentPrice * 100)}%)
          </div>
        )}
      </div>

      {/* Chart container */}
      {loading ? (
        <div
          style={{
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--bg-tertiary)',
            borderRadius: 8,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          Loading chart...
        </div>
      ) : error ? (
        <div
          style={{
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--red-bg)',
            borderRadius: 8,
            color: 'var(--red)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : (
        <div ref={chartRef} style={{ borderRadius: 8, overflow: 'hidden' }} />
      )}
    </div>
  );
}
