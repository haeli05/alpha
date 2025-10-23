"use client";
import { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, UTCTimestamp } from 'lightweight-charts';

export type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Props = {
  candles: Candle[];
  height?: number;
};

export default function CandlesChart({ candles, height = 360 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#111827' },
      grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
      crosshair: { mode: 0 },
      timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: true },
    });
    chartRef.current = chart;
    const series = chart.addCandlestickSeries({ upColor: '#16a34a', downColor: '#dc2626', borderVisible: false });
    series.setData(candles);

    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, height]);

  return <div ref={ref} style={{ width: '100%' }} />;
}

