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





