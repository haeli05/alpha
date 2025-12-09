import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, bollingerBands } from '@/lib/indicators';

describe('indicators', () => {
  describe('sma', () => {
    it('should calculate simple moving average correctly', () => {
      const data = [1, 2, 3, 4, 5];
      const result = sma(data, 3);

      expect(result).toHaveLength(5);
      expect(result[0]).toBeNaN();
      expect(result[1]).toBeNaN();
      expect(result[2]).toBe(2); // (1+2+3)/3
      expect(result[3]).toBe(3); // (2+3+4)/3
      expect(result[4]).toBe(4); // (3+4+5)/3
    });

    it('should return NaN for periods larger than data', () => {
      const data = [1, 2, 3];
      const result = sma(data, 5);

      expect(result.every(v => isNaN(v))).toBe(true);
    });

    it('should handle empty array', () => {
      const result = sma([], 3);
      expect(result).toHaveLength(0);
    });

    it('should handle single value', () => {
      const result = sma([5], 1);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(5);
    });
  });

  describe('ema', () => {
    it('should calculate exponential moving average correctly', () => {
      const data = [1, 2, 3, 4, 5];
      const result = ema(data, 3);

      expect(result).toHaveLength(5);
      // This implementation starts EMA from first value (no NaN warm-up)
      expect(result[0]).toBe(1);
      // k = 2/(3+1) = 0.5
      // EMA[1] = 2 * 0.5 + 1 * 0.5 = 1.5
      expect(result[1]).toBe(1.5);
      // EMA[2] = 3 * 0.5 + 1.5 * 0.5 = 2.25
      expect(result[2]).toBe(2.25);
    });

    it('should handle empty array', () => {
      const result = ema([], 3);
      expect(result).toHaveLength(0);
    });
  });

  describe('rsi', () => {
    it('should calculate RSI correctly', () => {
      // Alternating up/down prices
      const data = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84];
      const result = rsi(data, 5);

      expect(result).toHaveLength(10);
      // First period-1 values should be NaN
      for (let i = 0; i < 5; i++) {
        expect(result[i]).toBeNaN();
      }
      // RSI values should be between 0 and 100
      for (let i = 5; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(0);
        expect(result[i]).toBeLessThanOrEqual(100);
      }
    });

    it('should return 100 for only gains', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = rsi(data, 3);

      // After initial period, RSI should be 100 (no losses)
      const validValues = result.filter(v => !isNaN(v));
      validValues.forEach(v => {
        expect(v).toBe(100);
      });
    });

    it('should return 0 for only losses', () => {
      const data = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      const result = rsi(data, 3);

      const validValues = result.filter(v => !isNaN(v));
      validValues.forEach(v => {
        expect(v).toBe(0);
      });
    });

    it('should handle empty array', () => {
      const result = rsi([], 14);
      expect(result).toHaveLength(0);
    });
  });

  describe('bollingerBands', () => {
    it('should calculate Bollinger Bands correctly', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = bollingerBands(data, 5, 2);

      expect(result).toHaveLength(10);

      // First period-1 values should have NaN
      for (let i = 0; i < 4; i++) {
        expect(result[i].middle).toBeNaN();
      }

      // From period onwards, should have valid bands
      for (let i = 4; i < result.length; i++) {
        expect(result[i].middle).not.toBeNaN();
        expect(result[i].upper).toBeGreaterThan(result[i].middle);
        expect(result[i].lower).toBeLessThan(result[i].middle);
      }
    });

    it('should have upper > middle > lower', () => {
      const data = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
      const result = bollingerBands(data, 3, 2);

      for (let i = 2; i < result.length; i++) {
        expect(result[i].upper).toBeGreaterThan(result[i].middle);
        expect(result[i].middle).toBeGreaterThan(result[i].lower);
      }
    });

    it('should handle empty array', () => {
      const result = bollingerBands([], 20, 2);
      expect(result).toHaveLength(0);
    });
  });
});
