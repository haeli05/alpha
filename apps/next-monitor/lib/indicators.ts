export type Num = number;

export function sma(values: Num[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i + 1 >= period) out[i] = sum / period;
  }
  return out;
}

export function ema(values: Num[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i === 0) {
      prev = v;
      out[i] = v;
    } else {
      prev = v * k + (prev as number) * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stddev(values: Num[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(NaN);
  const mean = sma(values, period);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(mean[i])) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean[i];
      sumSq += d * d;
    }
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

export function bollinger(values: Num[], period: number, mult: number) {
  const m = sma(values, period);
  const s = stddev(values, period);
  const upper = m.map((v, i) => (Number.isFinite(v) && Number.isFinite(s[i]) ? v + mult * s[i] : NaN));
  const lower = m.map((v, i) => (Number.isFinite(v) && Number.isFinite(s[i]) ? v - mult * s[i] : NaN));
  return { middle: m, upper, lower };
}

// Alias for bollingerBands (returns array of objects for easier use)
export function bollingerBands(values: Num[], period: number, mult: number): { upper: number; middle: number; lower: number }[] {
  const { middle, upper, lower } = bollinger(values, period, mult);
  return middle.map((m, i) => ({
    upper: upper[i],
    middle: m,
    lower: lower[i],
  }));
}

export function rsi(values: Num[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

