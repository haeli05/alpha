"use client";
import { useEffect, useMemo, useState } from 'react';

type Props = {
  symbol: string;
  lastPrice: number;
};

type Position = { symbol: string; qty: number; avgPrice: number | null; realizedPnl: number } | null;

export default function TradePanel({ symbol, lastPrice }: Props) {
  const [qty, setQty] = useState('0.01');
  const [pos, setPos] = useState<Position>(null);
  const [px, setPx] = useState<number>(lastPrice);
  const [loading, setLoading] = useState(false);

  const unrealized = useMemo(() => {
    if (!pos || !pos.avgPrice || pos.qty === 0) return 0;
    const pnlPer = pos.qty > 0 ? (px - pos.avgPrice) : (pos.avgPrice - px);
    return pnlPer * Math.abs(pos.qty);
  }, [pos, px]);

  async function refresh() {
    const res = await fetch(`/api/paper/orders?symbol=${symbol}`);
    const j = await res.json();
    setPos(j.position);
  }

  useEffect(() => {
    refresh();
  }, []);

  // Live price via Binance WS
  useEffect(() => {
    const stream = symbol.toLowerCase() + '@ticker';
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
    ws.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data.toString());
        if (j && j.c) setPx(Number(j.c));
      } catch {}
    };
    return () => { ws.close(); };
  }, [symbol]);

  async function place(side: 'BUY' | 'SELL') {
    setLoading(true);
    try {
      await fetch('/api/paper/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, side, qty: Number(qty), price: px }),
      });
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, display: 'grid', gap: 8, minWidth: 320 }}>
      <div style={{ fontWeight: 600 }}>Paper Trading</div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ color: '#6b7280' }}>Quantity</span>
        <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => place('BUY')} disabled={loading} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #16a34a', background: '#16a34a', color: 'white' }}>Buy</button>
        <button onClick={() => place('SELL')} disabled={loading} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #dc2626', background: '#dc2626', color: 'white' }}>Sell</button>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>Executes at current last price; for demo only.</div>
      <div style={{ display: 'grid', gap: 4, fontSize: 14 }}>
        <div>Last Price: <b>{px}</b></div>
        <div>Position: <b>{pos?.qty ?? 0}</b></div>
        <div>Avg Price: <b>{pos?.avgPrice ?? '-'}</b></div>
        <div>Realized PnL: <b>{pos?.realizedPnl?.toFixed(4) ?? '0.0000'}</b></div>
        <div>Unrealized PnL: <b>{unrealized.toFixed(4)}</b></div>
      </div>
    </div>
  );
}
