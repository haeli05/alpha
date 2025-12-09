import { describe, it, expect } from 'vitest';
import { preTradeCheck } from '@/lib/risk';

describe('preTradeCheck', () => {
  it('should pass with no constraints', () => {
    const result = preTradeCheck(
      {},
      { symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 50000 }
    );

    expect(result.ok).toBe(true);
  });

  it('should pass when under max notional', () => {
    const result = preTradeCheck(
      { maxNotional: 1000 },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 50000 } // 500 notional
    );

    expect(result.ok).toBe(true);
  });

  it('should fail when over max notional', () => {
    const result = preTradeCheck(
      { maxNotional: 100 },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 50000 } // 500 notional
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('max_notional_exceeded');
    }
  });

  it('should pass when symbol is in allowed list', () => {
    const result = preTradeCheck(
      { allowedSymbols: ['BTCUSDT', 'ETHUSDT'] },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 50000 }
    );

    expect(result.ok).toBe(true);
  });

  it('should fail when symbol is not in allowed list', () => {
    const result = preTradeCheck(
      { allowedSymbols: ['BTCUSDT', 'ETHUSDT'] },
      { symbol: 'DOGEUSDT', side: 'BUY', qty: 1, price: 0.1 }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('symbol_not_allowed');
    }
  });

  it('should check both notional and symbol', () => {
    const result = preTradeCheck(
      { maxNotional: 1000, allowedSymbols: ['BTCUSDT'] },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 50000 }
    );

    expect(result.ok).toBe(true);
  });

  it('should fail symbol check even if notional passes', () => {
    const result = preTradeCheck(
      { maxNotional: 1000, allowedSymbols: ['ETHUSDT'] },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 50000 }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('symbol_not_allowed');
    }
  });

  it('should handle zero qty', () => {
    const result = preTradeCheck(
      { maxNotional: 100 },
      { symbol: 'BTCUSDT', side: 'BUY', qty: 0, price: 50000 }
    );

    expect(result.ok).toBe(true); // 0 * price = 0 notional
  });

  it('should handle SELL side', () => {
    const result = preTradeCheck(
      { maxNotional: 1000, allowedSymbols: ['BTCUSDT'] },
      { symbol: 'BTCUSDT', side: 'SELL', qty: 0.01, price: 50000 }
    );

    expect(result.ok).toBe(true);
  });
});
