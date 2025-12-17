'use client';

import { useEffect, useState } from 'react';

interface PairArbTrade {
  id: string;
  timestamp: number;
  marketSlug: string;
  yesTokenId: string;
  noTokenId: string;
  yesOrderId?: string;
  noOrderId?: string;
  yesPrice: number;
  noPrice: number;
  size: number;
  status: 'open' | 'filled' | 'cancelled' | 'failed';
  yesFilledAt?: number;
  noFilledAt?: number;
  realizedPnl?: number;
  notes?: string;
}

interface TradeStats {
  totalTrades: number;
  openTrades: number;
  filledTrades: number;
  totalPnl: number;
  avgPnl: number;
}

export default function PairArbPage() {
  const [trades, setTrades] = useState<PairArbTrade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'open' | 'filled'>('all');

  async function fetchData() {
    try {
      setLoading(true);
      const [tradesRes, statsRes] = await Promise.all([
        fetch(`/api/pair-arb/trades?status=${filter === 'all' ? '' : filter}`),
        fetch('/api/pair-arb/trades?stats=true'),
      ]);

      const tradesData = await tradesRes.json();
      const statsData = await statsRes.json();

      setTrades(tradesData.trades || []);
      setStats(statsData);
    } catch (error) {
      console.error('Failed to fetch trades:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [filter]);

  const formatPrice = (price: number) => `$${price.toFixed(4)}`;
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };
  const formatPnl = (pnl?: number) => {
    if (pnl === undefined) return '-';
    const sign = pnl >= 0 ? '+' : '';
    const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    return <span style={{ color }}>{sign}${pnl.toFixed(4)}</span>;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'open':
        return 'var(--accent)';
      case 'filled':
        return 'var(--green)';
      case 'cancelled':
        return 'var(--text-tertiary)';
      case 'failed':
        return 'var(--red)';
      default:
        return 'var(--text-secondary)';
    }
  };

  return (
    <div style={{ display: 'grid', gap: 32 }}>
      {/* Header */}
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
            PAIR ARBITRAGE
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
            Live Trading
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
          Track all open and executed trades from the pair arbitrage strategy. Monitors YES/NO pairs
          with trailing stop entries and hedged positions.
        </p>
      </header>

      {/* Stats */}
      {stats && (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 16,
          }}
        >
          <StatCard label="Total Trades" value={stats.totalTrades.toString()} />
          <StatCard label="Open Trades" value={stats.openTrades.toString()} color="var(--accent)" />
          <StatCard label="Filled Trades" value={stats.filledTrades.toString()} color="var(--green)" />
          <StatCard
            label="Total P&L"
            value={formatPnl(stats.totalPnl)}
            color={stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}
          />
          <StatCard
            label="Avg P&L"
            value={formatPnl(stats.avgPnl)}
            color={stats.avgPnl >= 0 ? 'var(--green)' : 'var(--red)'}
          />
        </section>
      )}

      {/* Filters */}
      <section>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['all', 'open', 'filled'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '6px 12px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                background: filter === f ? 'var(--accent-bg)' : 'var(--bg-secondary)',
                border: `1px solid ${filter === f ? 'var(--accent-border)' : 'var(--border)'}`,
                borderRadius: 6,
                color: filter === f ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      {/* Trades Table */}
      <section>
        {loading ? (
          <div
            style={{
              padding: 48,
              textAlign: 'center',
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
            }}
          >
            Loading trades...
          </div>
        ) : trades.length === 0 ? (
          <div
            style={{
              padding: 48,
              textAlign: 'center',
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
            }}
          >
            No trades found
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              <thead>
                <tr style={{ background: 'var(--bg-secondary)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    Time
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    Market
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    YES Price
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    NO Price
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    Size
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    Status
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    P&L
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-tertiary)' }}>
                    Orders
                  </th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade, i) => (
                  <tr
                    key={trade.id}
                    style={{
                      borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                      background: i % 2 === 0 ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                    }}
                  >
                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>
                      {formatTime(trade.timestamp)}
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--text-primary)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontWeight: 600 }}>{trade.marketSlug}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>ID: {trade.id.slice(-8)}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {formatPrice(trade.yesPrice)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {formatPrice(trade.noPrice)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {trade.size}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      <span
                        style={{
                          padding: '4px 8px',
                          borderRadius: 4,
                          background: `${getStatusColor(trade.status)}20`,
                          color: getStatusColor(trade.status),
                          fontWeight: 600,
                          fontSize: 10,
                          textTransform: 'uppercase',
                        }}
                      >
                        {trade.status}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600 }}>
                      {formatPnl(trade.realizedPnl)}
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 10 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {trade.yesOrderId && <span>YES: {trade.yesOrderId.slice(0, 8)}...</span>}
                        {trade.noOrderId && <span>NO: {trade.noOrderId.slice(0, 8)}...</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        padding: 20,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 24,
          fontWeight: 700,
          color: color || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}









