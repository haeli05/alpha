"use client";
import React, { useCallback, useMemo, useState } from 'react';
import Sparkline from '@/components/Sparkline';
import Link from 'next/link';
import { useBinanceStream } from '@/hooks/useWebSocket';
import { WsTickerSchema } from '@/lib/validation';
import { logger } from '@/lib/logger';

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

interface WsTickerData {
  s: string;
  c: string;
  P: string;
  q: string;
  [key: string]: unknown;
}

export default function MarketsLiveTable({ rows }: Props) {
  const [map, setMap] = useState<Record<string, MarketRow>>(() =>
    Object.fromEntries(rows.map(r => [r.symbol, r]))
  );

  const symbols = useMemo(() => rows.map(r => r.symbol), [rows]);
  const streams = useMemo(
    () => symbols.map(s => s.toLowerCase() + '@ticker'),
    [symbols]
  );

  const handleMessage = useCallback((data: WsTickerData) => {
    // Validate incoming data
    const result = WsTickerSchema.safeParse(data);
    if (!result.success) {
      logger.warn('MarketsLiveTable', 'Invalid ticker data received', {
        issues: result.error.issues,
      });
      return;
    }

    const ticker = result.data;
    const sym = ticker.s;
    const last = Number(ticker.c);
    const pcp = Number(ticker.P);
    const qv = Number(ticker.q);

    setMap(prev => {
      const cur = prev[sym];
      if (!cur) return prev;
      return {
        ...prev,
        [sym]: {
          ...cur,
          last,
          ticker: {
            priceChangePercent: isFinite(pcp) ? pcp : (cur.ticker?.priceChangePercent ?? 0),
            quoteVolume: isFinite(qv) ? qv : (cur.ticker?.quoteVolume ?? 0),
          },
        },
      };
    });
  }, []);

  const { status, reconnectCount } = useBinanceStream<WsTickerData>(streams, handleMessage);

  const list = Object.values(map);

  return (
    <div>
      {/* Connection status indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '12px',
        fontSize: '12px',
        color: '#6b7280',
      }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor:
              status === 'connected' ? '#16a34a' :
              status === 'connecting' ? '#f59e0b' :
              status === 'error' ? '#dc2626' : '#6b7280',
          }}
        />
        <span>
          {status === 'connected' ? 'Live' :
           status === 'connecting' ? 'Connecting...' :
           status === 'error' ? 'Connection error' : 'Disconnected'}
          {reconnectCount > 0 && ` (retry ${reconnectCount})`}
        </span>
      </div>

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
    </div>
  );
}

