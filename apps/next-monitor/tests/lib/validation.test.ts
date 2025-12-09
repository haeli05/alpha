import { describe, it, expect } from 'vitest';
import {
  PaperOrderSchema,
  BinanceOrderSchema,
  WsTickerSchema,
  formatZodError,
} from '@/lib/validation';

describe('validation schemas', () => {
  describe('PaperOrderSchema', () => {
    it('should validate valid order', () => {
      const order = {
        symbol: 'btcusdt',
        side: 'buy',
        qty: 0.1,
        price: 50000,
      };

      const result = PaperOrderSchema.safeParse(order);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.symbol).toBe('BTCUSDT');
        expect(result.data.side).toBe('BUY');
      }
    });

    it('should reject invalid side', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'INVALID',
        qty: 0.1,
        price: 50000,
      };

      const result = PaperOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });

    it('should reject negative qty', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        qty: -1,
        price: 50000,
      };

      const result = PaperOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });

    it('should reject zero price', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        qty: 1,
        price: 0,
      };

      const result = PaperOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });

    it('should reject missing fields', () => {
      const order = { symbol: 'BTCUSDT' };

      const result = PaperOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });
  });

  describe('BinanceOrderSchema', () => {
    it('should validate market order with quantity', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(true);
    });

    it('should validate market order with quoteOrderQty', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'MARKET',
        quoteOrderQty: 100,
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(true);
    });

    it('should validate limit order with price', () => {
      const order = {
        symbol: 'ETHUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 0.5,
        price: 3000,
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(true);
    });

    it('should reject limit order without price', () => {
      const order = {
        symbol: 'ETHUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 0.5,
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });

    it('should reject order without quantity or quoteOrderQty', () => {
      const order = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(false);
    });

    it('should transform lowercase to uppercase', () => {
      const order = {
        symbol: 'btcusdt',
        side: 'buy',
        type: 'market',
        quantity: 0.01,
      };

      const result = BinanceOrderSchema.safeParse(order);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.symbol).toBe('BTCUSDT');
        expect(result.data.side).toBe('BUY');
        expect(result.data.type).toBe('MARKET');
      }
    });
  });

  describe('WsTickerSchema', () => {
    it('should validate WebSocket ticker message', () => {
      const ticker = {
        s: 'BTCUSDT',
        c: '50000.00',
        o: '49000.00',
        h: '51000.00',
        l: '48000.00',
        v: '1000.5',
        q: '50000000',
        P: '2.04',
      };

      const result = WsTickerSchema.safeParse(ticker);
      expect(result.success).toBe(true);
    });

    it('should reject ticker with missing required fields', () => {
      const ticker = {
        s: 'BTCUSDT',
        c: '50000.00',
        // missing other fields
      };

      const result = WsTickerSchema.safeParse(ticker);
      expect(result.success).toBe(false);
    });
  });

  describe('formatZodError', () => {
    it('should format error messages', () => {
      const result = PaperOrderSchema.safeParse({
        symbol: 'BTC',
        side: 'INVALID',
        qty: -1,
        price: 0,
      });

      if (!result.success) {
        const formatted = formatZodError(result.error);
        expect(typeof formatted).toBe('string');
        expect(formatted.length).toBeGreaterThan(0);
      }
    });
  });
});
