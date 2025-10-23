"use client";
import { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, UTCTimestamp } from 'lightweight-charts';

export type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type LinePoint = { time: UTCTimestamp; value: number };

type Props = {
  candles: Candle[];
  ema20?: LinePoint[];
  ema50?: LinePoint[];
  bbUpper?: LinePoint[];
  bbLower?: LinePoint[];
  rsi14?: LinePoint[];
  height?: number;
};

export default function AdvancedChart({ candles, ema20, ema50, bbUpper, bbLower, rsi14, height = 480 }: Props) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!mainRef.current || !rsiRef.current) return;
    const mainChart = createChart(mainRef.current, {
      autoSize: true,
      height: Math.round(height * 0.7),
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#111827' },
      grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    mainChartRef.current = mainChart;
    const candleSeries = mainChart.addCandlestickSeries({ upColor: '#16a34a', downColor: '#dc2626', wickUpColor: '#16a34a', wickDownColor: '#dc2626', borderVisible: false });
    candleSeries.setData(candles);

    // Overlays
    if (ema20 && ema20.length) {
      const s = mainChart.addLineSeries({ color: '#3b82f6', lineWidth: 2 });
      s.setData(ema20);
    }
    if (ema50 && ema50.length) {
      const s = mainChart.addLineSeries({ color: '#a855f7', lineWidth: 2 });
      s.setData(ema50);
    }
    if (bbUpper && bbUpper.length) {
      const s1 = mainChart.addLineSeries({ color: '#6b7280', lineWidth: 1 });
      s1.setData(bbUpper);
    }
    if (bbLower && bbLower.length) {
      const s2 = mainChart.addLineSeries({ color: '#6b7280', lineWidth: 1 });
      s2.setData(bbLower);
    }

    // Volume histogram (overlayed on main chart, separate price scale)
    const volSeries = mainChart.addHistogramSeries({
      color: '#9ca3af',
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    });
    mainChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const volData = candles.map((c, i) => ({
      time: c.time,
      value: c.volume || 0,
      color: ((candles[i]?.close ?? 0) >= (candles[i - 1]?.close ?? 0)) ? 'rgba(22,163,74,0.6)' : 'rgba(220,38,38,0.6)'
    }));
    volSeries.setData(volData);

    // RSI chart
    const rsiChart = createChart(rsiRef.current, {
      autoSize: true,
      height: Math.round(height * 0.3),
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#111827' },
      grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } },
    });
    rsiChartRef.current = rsiChart;
    const rsiSeries = rsiChart.addLineSeries({ color: '#f59e0b', lineWidth: 2 });
    rsiSeries.setData((rsi14 || []).filter(p => Number.isFinite(p.value)));
    // Overbought/oversold guides: 70/30
    const ob = rsiChart.addLineSeries({ color: 'rgba(239,68,68,0.4)', lineWidth: 1 });
    const os = rsiChart.addLineSeries({ color: 'rgba(16,185,129,0.4)', lineWidth: 1 });
    const guide = (v: number) => candles.map(c => ({ time: c.time, value: v as number }));
    ob.setData(guide(70));
    os.setData(guide(30));

    const ro1 = new ResizeObserver(() => mainChart.applyOptions({}));
    const ro2 = new ResizeObserver(() => rsiChart.applyOptions({}));
    ro1.observe(mainRef.current);
    ro2.observe(rsiRef.current);

    return () => {
      ro1.disconnect();
      ro2.disconnect();
      mainChart.remove();
      rsiChart.remove();
      mainChartRef.current = null;
      rsiChartRef.current = null;
    };
  }, [candles, ema20, ema50, bbUpper, bbLower, rsi14, height]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div ref={mainRef} />
      <div ref={rsiRef} />
    </div>
  );
}
