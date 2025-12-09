// Polymarket Trading Strategy Logic
// Isolated trade logic for YES/NO hedge positions

import { logger } from '@/lib/logger';

export interface HedgeStrategyConfig {
  // Entry conditions
  yesEntryPrice: number;      // Target price to buy YES (e.g., 0.40)
  noEntryPrice: number;       // Target price to buy NO for hedge (e.g., 0.55)

  // Position sizing
  yesSize: number;            // Amount in USDC for YES position
  noSize: number;             // Amount in USDC for NO hedge

  // Risk parameters
  maxSlippageBps: number;     // Max slippage in basis points
  stopLossPrice?: number;     // Optional stop loss price
  takeProfitPrice?: number;   // Optional take profit price
}

export interface StrategyPosition {
  yesShares: number;
  noShares: number;
  yesAvgPrice: number;
  noAvgPrice: number;
  totalCost: number;
  maxPayout: number;          // If YES wins
  minPayout: number;          // If NO wins (hedge payout)
  breakEvenYesPrice: number;
  breakEvenNoPrice: number;
}

export interface TradeSignal {
  action: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'HOLD';
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface MarketState {
  yesPrice: number;
  noPrice: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  timestamp: number;
}

/**
 * Calculate position metrics for a hedge strategy
 */
export function calculateHedgePosition(
  config: HedgeStrategyConfig,
  yesPrice: number,
  noPrice: number
): StrategyPosition {
  const yesShares = config.yesSize / yesPrice;
  const noShares = config.noSize / noPrice;
  const totalCost = config.yesSize + config.noSize;

  // If YES wins: YES shares pay $1 each, NO shares worth $0
  const maxPayout = yesShares;

  // If NO wins: NO shares pay $1 each, YES shares worth $0
  const minPayout = noShares;

  // Break-even: price where selling covers cost
  const breakEvenYesPrice = totalCost / yesShares;
  const breakEvenNoPrice = totalCost / noShares;

  return {
    yesShares,
    noShares,
    yesAvgPrice: yesPrice,
    noAvgPrice: noPrice,
    totalCost,
    maxPayout,
    minPayout,
    breakEvenYesPrice,
    breakEvenNoPrice,
  };
}

/**
 * Calculate P&L scenarios for the hedge
 */
export function calculatePnLScenarios(position: StrategyPosition): {
  yesWins: { payout: number; pnl: number; roi: number };
  noWins: { payout: number; pnl: number; roi: number };
  guaranteed: { minPnl: number; maxPnl: number };
} {
  const yesWinsPnl = position.maxPayout - position.totalCost;
  const noWinsPnl = position.minPayout - position.totalCost;

  return {
    yesWins: {
      payout: position.maxPayout,
      pnl: yesWinsPnl,
      roi: (yesWinsPnl / position.totalCost) * 100,
    },
    noWins: {
      payout: position.minPayout,
      pnl: noWinsPnl,
      roi: (noWinsPnl / position.totalCost) * 100,
    },
    guaranteed: {
      minPnl: Math.min(yesWinsPnl, noWinsPnl),
      maxPnl: Math.max(yesWinsPnl, noWinsPnl),
    },
  };
}

/**
 * Check if current market prices meet entry conditions
 */
export function checkEntryConditions(
  config: HedgeStrategyConfig,
  market: MarketState
): { yesEntry: boolean; noEntry: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Check YES entry (buy when price drops to target)
  const yesEntry = market.yesAsk <= config.yesEntryPrice;
  if (yesEntry) {
    reasons.push(`YES ask ${market.yesAsk.toFixed(3)} <= target ${config.yesEntryPrice}`);
  }

  // Check NO entry (buy when price drops to target for hedge)
  const noEntry = market.noAsk <= config.noEntryPrice;
  if (noEntry) {
    reasons.push(`NO ask ${market.noAsk.toFixed(3)} <= target ${config.noEntryPrice}`);
  }

  return { yesEntry, noEntry, reasons };
}

/**
 * Generate trade signals based on strategy config and market state
 */
export function generateSignals(
  config: HedgeStrategyConfig,
  market: MarketState,
  currentPosition?: Partial<StrategyPosition>
): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const hasYesPosition = (currentPosition?.yesShares || 0) > 0;
  const hasNoPosition = (currentPosition?.noShares || 0) > 0;

  const { yesEntry, noEntry } = checkEntryConditions(config, market);

  // Signal to buy YES if conditions met and no position
  if (yesEntry && !hasYesPosition) {
    signals.push({
      action: 'BUY_YES',
      tokenId: '', // To be filled by caller
      side: 'BUY',
      price: market.yesAsk,
      size: config.yesSize,
      reason: `YES at ${market.yesAsk.toFixed(3)} (target: ${config.yesEntryPrice})`,
      urgency: market.yesAsk < config.yesEntryPrice * 0.95 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Signal to buy NO hedge if conditions met and no position
  if (noEntry && !hasNoPosition) {
    signals.push({
      action: 'BUY_NO',
      tokenId: '', // To be filled by caller
      side: 'BUY',
      price: market.noAsk,
      size: config.noSize,
      reason: `NO hedge at ${market.noAsk.toFixed(3)} (target: ${config.noEntryPrice})`,
      urgency: market.noAsk < config.noEntryPrice * 0.95 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Check stop loss conditions
  if (config.stopLossPrice && hasYesPosition) {
    if (market.yesBid < config.stopLossPrice) {
      signals.push({
        action: 'SELL_YES',
        tokenId: '',
        side: 'SELL',
        price: market.yesBid,
        size: currentPosition?.yesShares || 0,
        reason: `Stop loss triggered: ${market.yesBid.toFixed(3)} < ${config.stopLossPrice}`,
        urgency: 'HIGH',
      });
    }
  }

  // Check take profit conditions
  if (config.takeProfitPrice && hasYesPosition) {
    if (market.yesBid >= config.takeProfitPrice) {
      signals.push({
        action: 'SELL_YES',
        tokenId: '',
        side: 'SELL',
        price: market.yesBid,
        size: currentPosition?.yesShares || 0,
        reason: `Take profit: ${market.yesBid.toFixed(3)} >= ${config.takeProfitPrice}`,
        urgency: 'HIGH',
      });
    }
  }

  return signals;
}

/**
 * Validate order parameters before execution
 */
export function validateOrder(
  price: number,
  size: number,
  slippageBps: number,
  expectedPrice: number
): { valid: boolean; error?: string } {
  if (price <= 0 || price >= 1) {
    return { valid: false, error: 'Price must be between 0 and 1' };
  }

  if (size <= 0) {
    return { valid: false, error: 'Size must be positive' };
  }

  const slippagePct = Math.abs(price - expectedPrice) / expectedPrice * 10000;
  if (slippagePct > slippageBps) {
    return {
      valid: false,
      error: `Slippage ${slippagePct.toFixed(0)}bps exceeds max ${slippageBps}bps`
    };
  }

  return { valid: true };
}

/**
 * Create order parameters for execution
 */
export function createOrderParams(signal: TradeSignal, tokenId: string) {
  return {
    tokenId,
    price: signal.price,
    size: signal.side === 'BUY' ? signal.size / signal.price : signal.size,
    side: signal.side,
    orderType: 'GTC' as const,
  };
}

/**
 * Strategy executor class for managing the hedge strategy
 */
export class HedgeStrategyExecutor {
  private config: HedgeStrategyConfig;
  private position: Partial<StrategyPosition> = {};
  private signals: TradeSignal[] = [];

  constructor(config: HedgeStrategyConfig) {
    this.config = config;
  }

  updateMarket(market: MarketState): TradeSignal[] {
    this.signals = generateSignals(this.config, market, this.position);

    if (this.signals.length > 0) {
      logger.info('HedgeStrategy', 'Signals generated', {
        count: this.signals.length,
        signals: this.signals.map(s => s.action),
      });
    }

    return this.signals;
  }

  getPosition(): Partial<StrategyPosition> {
    return this.position;
  }

  getSignals(): TradeSignal[] {
    return this.signals;
  }

  // Simulate order fill
  fillOrder(signal: TradeSignal, fillPrice: number, fillSize: number) {
    if (signal.action === 'BUY_YES') {
      const shares = fillSize / fillPrice;
      this.position.yesShares = (this.position.yesShares || 0) + shares;
      this.position.yesAvgPrice = fillPrice;
      this.position.totalCost = (this.position.totalCost || 0) + fillSize;
    } else if (signal.action === 'BUY_NO') {
      const shares = fillSize / fillPrice;
      this.position.noShares = (this.position.noShares || 0) + shares;
      this.position.noAvgPrice = fillPrice;
      this.position.totalCost = (this.position.totalCost || 0) + fillSize;
    }

    logger.info('HedgeStrategy', 'Order filled', {
      action: signal.action,
      fillPrice,
      fillSize,
      position: this.position,
    });
  }

  getProjectedPnL(): ReturnType<typeof calculatePnLScenarios> | null {
    if (!this.position.yesShares || !this.position.noShares) {
      return null;
    }

    return calculatePnLScenarios(this.position as StrategyPosition);
  }

  reset() {
    this.position = {};
    this.signals = [];
  }
}
