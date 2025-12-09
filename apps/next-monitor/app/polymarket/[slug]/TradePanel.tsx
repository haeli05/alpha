'use client';

import { useState, useCallback } from 'react';
import type { PolymarketMarket } from '@/lib/polymarket';

interface Props {
  market: PolymarketMarket;
  yesTokenId?: string;
  noTokenId?: string;
  yesPrice: number;
  noPrice: number;
}

type Outcome = 'YES' | 'NO';
type OrderType = 'MARKET' | 'LIMIT';

export default function TradePanel({ market, yesTokenId, noTokenId, yesPrice, noPrice }: Props) {
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const currentPrice = outcome === 'YES' ? yesPrice : noPrice;
  const tokenId = outcome === 'YES' ? yesTokenId : noTokenId;

  const shares = amount
    ? orderType === 'MARKET'
      ? parseFloat(amount) / currentPrice
      : parseFloat(amount) / parseFloat(limitPrice || '0')
    : 0;

  const potentialPayout = shares; // Each share pays $1 if correct
  const potentialProfit = potentialPayout - parseFloat(amount || '0');

  const handleTrade = useCallback(async () => {
    if (!amount || parseFloat(amount) <= 0) {
      setMessage({ type: 'error', text: 'Enter a valid amount' });
      return;
    }

    if (orderType === 'LIMIT' && (!limitPrice || parseFloat(limitPrice) <= 0)) {
      setMessage({ type: 'error', text: 'Enter a valid limit price' });
      return;
    }

    if (!tokenId) {
      setMessage({ type: 'error', text: 'Token not available' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      // Note: Full trading requires wallet connection and SDK
      // This is a placeholder that shows the trade would be placed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      setMessage({
        type: 'success',
        text: `Trade simulation: Buy ${shares.toFixed(2)} ${outcome} shares at $${(orderType === 'MARKET' ? currentPrice : parseFloat(limitPrice)).toFixed(2)}. Connect wallet to execute.`,
      });
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Trade failed',
      });
    } finally {
      setLoading(false);
    }
  }, [amount, limitPrice, orderType, outcome, tokenId, shares, currentPrice]);

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 20,
        position: 'sticky',
        top: 20,
      }}
    >
      <h3 style={{ margin: '0 0 16px', fontSize: 18 }}>Trade</h3>

      {/* Outcome Toggle */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <button
          onClick={() => setOutcome('YES')}
          style={{
            padding: '12px',
            fontSize: 15,
            fontWeight: 600,
            border: outcome === 'YES' ? '2px solid #22c55e' : '1px solid #e5e7eb',
            borderRadius: 6,
            backgroundColor: outcome === 'YES' ? 'rgba(34, 197, 94, 0.1)' : 'white',
            color: outcome === 'YES' ? '#22c55e' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          Yes {Math.round(yesPrice * 100)}%
        </button>
        <button
          onClick={() => setOutcome('NO')}
          style={{
            padding: '12px',
            fontSize: 15,
            fontWeight: 600,
            border: outcome === 'NO' ? '2px solid #ef4444' : '1px solid #e5e7eb',
            borderRadius: 6,
            backgroundColor: outcome === 'NO' ? 'rgba(239, 68, 68, 0.1)' : 'white',
            color: outcome === 'NO' ? '#ef4444' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          No {Math.round(noPrice * 100)}%
        </button>
      </div>

      {/* Order Type Toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setOrderType('MARKET')}
          style={{
            flex: 1,
            padding: '8px',
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            borderRadius: 4,
            backgroundColor: orderType === 'MARKET' ? '#3b82f6' : '#f3f4f6',
            color: orderType === 'MARKET' ? 'white' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          Market
        </button>
        <button
          onClick={() => setOrderType('LIMIT')}
          style={{
            flex: 1,
            padding: '8px',
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            borderRadius: 4,
            backgroundColor: orderType === 'LIMIT' ? '#3b82f6' : '#f3f4f6',
            color: orderType === 'LIMIT' ? 'white' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          Limit
        </button>
      </div>

      {/* Amount Input */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
          Amount (USDC)
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          min="0"
          step="1"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 16,
            border: '1px solid #d1d5db',
            borderRadius: 6,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Limit Price Input */}
      {orderType === 'LIMIT' && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            Limit Price ($)
          </label>
          <input
            type="number"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder={currentPrice.toFixed(2)}
            min="0.01"
            max="0.99"
            step="0.01"
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 16,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}

      {/* Quick Amount Buttons */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[10, 25, 50, 100].map((val) => (
          <button
            key={val}
            onClick={() => setAmount(String(val))}
            style={{
              flex: 1,
              padding: '6px',
              fontSize: 12,
              border: '1px solid #e5e7eb',
              borderRadius: 4,
              backgroundColor: 'white',
              cursor: 'pointer',
            }}
          >
            ${val}
          </button>
        ))}
      </div>

      {/* Trade Summary */}
      <div
        style={{
          padding: 12,
          backgroundColor: '#f9fafb',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: '#6b7280' }}>Price per share</span>
          <span>${(orderType === 'MARKET' ? currentPrice : parseFloat(limitPrice || '0')).toFixed(2)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: '#6b7280' }}>Shares</span>
          <span>{shares.toFixed(2)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: '#6b7280' }}>Potential payout</span>
          <span>${potentialPayout.toFixed(2)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontWeight: 600,
            color: potentialProfit > 0 ? '#22c55e' : '#6b7280',
          }}
        >
          <span>Potential profit</span>
          <span>+${potentialProfit.toFixed(2)}</span>
        </div>
      </div>

      {/* Trade Button */}
      <button
        onClick={handleTrade}
        disabled={loading || !amount}
        style={{
          width: '100%',
          padding: '14px',
          fontSize: 16,
          fontWeight: 600,
          color: 'white',
          backgroundColor: outcome === 'YES' ? '#22c55e' : '#ef4444',
          border: 'none',
          borderRadius: 6,
          cursor: loading || !amount ? 'not-allowed' : 'pointer',
          opacity: loading || !amount ? 0.6 : 1,
        }}
      >
        {loading ? 'Processing...' : `Buy ${outcome}`}
      </button>

      {/* Message */}
      {message && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            fontSize: 13,
            borderRadius: 6,
            backgroundColor: message.type === 'success' ? '#dcfce7' : '#fee2e2',
            color: message.type === 'success' ? '#166534' : '#991b1b',
          }}
        >
          {message.text}
        </div>
      )}

      {/* Wallet Notice */}
      <p style={{ marginTop: 16, fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>
        Connect your wallet to execute trades. This is a simulation interface.
      </p>
    </div>
  );
}
