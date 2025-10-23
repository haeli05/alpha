"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sparkline from '@/components/Sparkline';
import Link from 'next/link';

export type MarketRow = {
  symbol: string;
  closes: number[];
  last: number;
  changePct: number;
  ticker?: { priceChangePercent: number; quoteVolume: number } | null;
};

type Props = {
  rows: MarketRow[];
};

export default function MarketsLiveTable({ rows }: Props) {
  const [map, setMap] = useState<Record<string, MarketRow>>(() => Object.fromEntries(rows.map(r => [r.symbol, r])));
  const symbols = useMemo(() => rows.map(r => r.symbol), [rows]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const streams = symbols.map(s => s.toLowerCase() + '@ticker').join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data.toString());
        const j = payload.data || payload; // combined stream wraps in {stream, data}
        const sym = (j.s || j.symbol) as string;
        const last = Number(j.c);
        const pcp = Number(j.P);
        const qv = Number(j.q);
        setMap(prev => {
          const cur = prev[sym];
          if (!cur) return prev;
          return { ...prev, [sym]: { ...cur, last, ticker: { priceChangePercent: isFinite(pcp) ? pcp : (cur.ticker?.priceChangePercent ?? 0), quoteVolume: isFinite(qv) ? qv : (cur.ticker?.quoteVolume ?? 0) } } };
        });
      } catch {}
    };
    return () => { ws.close(); };
  }, [symbols.join(',')]);

  const list = Object.values(map);

  return (
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
        {list.map((r) => {
          const color = (r.changePct || 0) >= 0 ? '#16a34a' : '#dc2626';
          const pair = r.symbol.replace('USDT', '') + '/USDT';
          return (
            <tr key={r.symbol}>
              <td style={{ fontWeight: 600 }}>{pair}</td>
              <td style={{ textAlign: 'right' }}>{isFinite(r.last) ? r.last.toFixed(4) : '-'}</td>
              <td style={{ textAlign: 'right', color }}>{isFinite(r.changePct) ? `${r.changePct.toFixed(2)}%` : '-'}</td>
              <td style={{ textAlign: 'right', color: (r.ticker?.priceChangePercent ?? 0) >= 0 ? '#16a34a' : '#dc2626' }}>
                {r.ticker ? `${r.ticker.priceChangePercent.toFixed(2)}%` : '-'}
              </td>
              <td style={{ textAlign: 'right' }}>{r.ticker ? Number(r.ticker.quoteVolume).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</td>
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
  );
}

