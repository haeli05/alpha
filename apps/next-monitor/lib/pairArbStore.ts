/**
 * Pair Arbitrage Trade Store
 * 
 * Stores trades executed by the pair-arb strategy
 */

import fs from 'fs';
import path from 'path';

const STORE_FILE = path.join(process.cwd(), 'data', 'pair-arb-trades.json');

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

interface Store {
  trades: PairArbTrade[];
  lastUpdated: number;
}

function readStore(): Store {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = fs.readFileSync(STORE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading pair-arb store:', error);
  }
  return { trades: [], lastUpdated: Date.now() };
}

function writeStore(store: Store): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    store.lastUpdated = Date.now();
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error('Error writing pair-arb store:', error);
  }
}

export function addTrade(trade: Omit<PairArbTrade, 'id' | 'timestamp'>): PairArbTrade {
  const store = readStore();
  const newTrade: PairArbTrade = {
    ...trade,
    id: `pair-arb-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
  };
  store.trades.push(newTrade);
  writeStore(store);
  return newTrade;
}

export function updateTrade(id: string, updates: Partial<PairArbTrade>): PairArbTrade | null {
  const store = readStore();
  const trade = store.trades.find((t) => t.id === id);
  if (!trade) return null;
  Object.assign(trade, updates);
  writeStore(store);
  return trade;
}

export function getTrades(filters?: {
  status?: PairArbTrade['status'];
  marketSlug?: string;
  limit?: number;
}): PairArbTrade[] {
  const store = readStore();
  let trades = [...store.trades].reverse(); // Most recent first

  if (filters?.status) {
    trades = trades.filter((t) => t.status === filters.status);
  }
  if (filters?.marketSlug) {
    trades = trades.filter((t) => t.marketSlug === filters.marketSlug);
  }
  if (filters?.limit) {
    trades = trades.slice(0, filters.limit);
  }

  return trades;
}

export function getOpenTrades(): PairArbTrade[] {
  return getTrades({ status: 'open' });
}

export function getTradeStats(): {
  totalTrades: number;
  openTrades: number;
  filledTrades: number;
  totalPnl: number;
  avgPnl: number;
} {
  const store = readStore();
  const trades = store.trades;
  const openTrades = trades.filter((t) => t.status === 'open');
  const filledTrades = trades.filter((t) => t.status === 'filled');
  const totalPnl = filledTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
  const avgPnl = filledTrades.length > 0 ? totalPnl / filledTrades.length : 0;

  return {
    totalTrades: trades.length,
    openTrades: openTrades.length,
    filledTrades: filledTrades.length,
    totalPnl,
    avgPnl,
  };
}

/**
 * Cancel all pending trades for a market, unless one leg is already executed
 * Returns the number of trades cancelled
 */
/**
 * Get trades that have one leg filled but the other pending
 * These are trades waiting for their hedge to execute
 */
export function getPartiallyFilledTrades(marketSlug?: string): PairArbTrade[] {
  const store = readStore();
  return store.trades.filter((t) => {
    if (t.status !== 'open') return false;
    if (marketSlug && t.marketSlug !== marketSlug) return false;

    const hasYesFilled = !!t.yesFilledAt;
    const hasNoFilled = !!t.noFilledAt;

    // Return trades where exactly one leg is filled
    return (hasYesFilled && !hasNoFilled) || (!hasYesFilled && hasNoFilled);
  });
}

/**
 * Check if all open trades for a market are fully hedged (both legs filled)
 */
export function areAllTradesFullyHedged(marketSlug?: string): boolean {
  const partialTrades = getPartiallyFilledTrades(marketSlug);
  return partialTrades.length === 0;
}

/**
 * Check if YES_FIRST trades are fully hedged (no pending YES_FIRST hedges)
 * YES_FIRST = YES filled first, NO pending
 */
export function isYesFirstFullyHedged(marketSlug?: string): boolean {
  const partialTrades = getPartiallyFilledTrades(marketSlug);
  // YES_FIRST trades have yesFilledAt set but not noFilledAt
  const pendingYesFirst = partialTrades.filter(t => t.yesFilledAt && !t.noFilledAt);
  return pendingYesFirst.length === 0;
}

/**
 * Check if NO_FIRST trades are fully hedged (no pending NO_FIRST hedges)
 * NO_FIRST = NO filled first, YES pending
 */
export function isNoFirstFullyHedged(marketSlug?: string): boolean {
  const partialTrades = getPartiallyFilledTrades(marketSlug);
  // NO_FIRST trades have noFilledAt set but not yesFilledAt
  const pendingNoFirst = partialTrades.filter(t => t.noFilledAt && !t.yesFilledAt);
  return pendingNoFirst.length === 0;
}

/**
 * Mark the hedge leg of a trade as filled
 */
export function markHedgeFilled(tradeId: string, side: 'yes' | 'no'): PairArbTrade | null {
  const store = readStore();
  const trade = store.trades.find((t) => t.id === tradeId);
  if (!trade) return null;

  if (side === 'yes') {
    trade.yesFilledAt = Date.now();
  } else {
    trade.noFilledAt = Date.now();
  }

  // Check if both legs are now filled
  if (trade.yesFilledAt && trade.noFilledAt) {
    trade.status = 'filled';
    // Calculate realized PnL: profit = (1.00 - yesPrice - noPrice) * size
    trade.realizedPnl = (1.0 - trade.yesPrice - trade.noPrice) * trade.size;
    trade.notes = (trade.notes || '') + ` | Both legs filled | PnL: $${trade.realizedPnl.toFixed(4)}`;
  }

  writeStore(store);
  return trade;
}

/**
 * Calculate total profit from all filled trades
 */
export function getTotalProfit(): number {
  const store = readStore();
  return store.trades
    .filter((t) => t.status === 'filled')
    .reduce((sum, t) => {
      if (t.realizedPnl !== undefined) {
        return sum + t.realizedPnl;
      }
      return sum + (1.0 - t.yesPrice - t.noPrice) * t.size;
    }, 0);
}

/**
 * Get total PnL (realized from filled trades)
 */
export function getTotalPnL(): number {
  return getTotalProfit();
}

export function cancelPendingTradesForMarket(marketSlug: string): number {
  const store = readStore();
  let cancelledCount = 0;
  
  for (const trade of store.trades) {
    // Only process trades for this market that are still open
    if (trade.marketSlug !== marketSlug || trade.status !== 'open') {
      continue;
    }
    
    // Check if at least one leg has been executed
    const hasYesFilled = !!trade.yesFilledAt;
    const hasNoFilled = !!trade.noFilledAt;
    
    // If neither leg is filled, cancel the trade
    if (!hasYesFilled && !hasNoFilled) {
      trade.status = 'cancelled';
      trade.notes = (trade.notes || '') + ' | Cancelled on market switch';
      cancelledCount++;
    }
    // If one leg is filled but not the other, keep it open (partial fill)
    // These trades need manual attention or will be handled at settlement
  }
  
  if (cancelledCount > 0) {
    writeStore(store);
  }
  
  return cancelledCount;
}









