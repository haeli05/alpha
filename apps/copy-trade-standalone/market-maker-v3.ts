/**
 * POLYMARKET MARKET MAKER V3 - WITH RISK CONTROLS
 *
 * Key protections:
 * 1. Dollar-based exposure limits (not just share counts)
 * 2. Hard stop when imbalance exceeds threshold
 * 3. Order book awareness - bid relative to market
 * 4. Cross-market risk aggregation
 * 5. Position polling to detect fills
 *
 * USAGE:
 *   npx tsx market-maker-v3.ts          # Normal mode
 *   npx tsx market-maker-v3.ts --test   # Simulate fills to demo risk controls
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Ladder settings
  NUM_LEVELS: 4,
  LEVEL_SPACING: 0.04,        // 4 cents between levels
  BASE_SIZE: 15,
  SIZE_INCREMENT: 10,

  // Price bounds
  MIN_BID: 0.20,              // Aggressive bottom
  MAX_BID: 0.48,              // Never bid above this
  MAX_COMBINED: 0.96,         // Ensures 4% minimum profit

  // RISK CONTROLS (DOLLAR-BASED)
  MAX_UNHEDGED_DOLLARS: 50,   // Max $ exposure on one side
  MAX_TOTAL_EXPOSURE: 200,    // Max total $ in positions
  SOFT_IMBALANCE_DOLLARS: 20, // Start adjusting prices
  HARD_IMBALANCE_DOLLARS: 40, // Stop bidding heavy side

  // Position limits
  MAX_SHARES_PER_SIDE: 400,

  // Order book intelligence
  MIN_SPREAD_FROM_BEST: 0.03, // Bid at least 3c below best ask
  MAX_BID_VS_BEST: 0.02,      // Don't bid more than 2c above current best bid

  // Timing
  REFRESH_INTERVAL_MS: 12000,
  ORDERBOOK_REFRESH_MS: 5000,

  // Trading
  ENABLE_TRADING: false,
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';
const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

// Our wallet for position checking
const OUR_WALLET = PROXY_WALLET;

// ============================================================================
// ENVIRONMENT
// ============================================================================

const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

// ============================================================================
// CLOB CLIENT
// ============================================================================

let ClobClient: any;
let OrderType: any;
let Side: any;
let clobClient: any;

async function loadClobClient(): Promise<boolean> {
  try {
    const clobModule = await import('@polymarket/clob-client');
    ClobClient = clobModule.ClobClient;
    OrderType = clobModule.OrderType;
    Side = clobModule.Side;
    return true;
  } catch (error) {
    console.error('Failed to load CLOB client:', error);
    return false;
  }
}

async function initClobClient(): Promise<void> {
  if (!POLYMARKET_PRIVATE_KEY) {
    log('No private key - monitor only mode', 'WARN');
    return;
  }

  const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);
  clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
    key: POLYMARKET_API_KEY,
    secret: POLYMARKET_SECRET,
    passphrase: POLYMARKET_PASSPHRASE,
  }, 2, PROXY_WALLET);
  log('CLOB client initialized');
}

// ============================================================================
// TYPES
// ============================================================================

interface Market {
  conditionId: string;
  question: string;
  upTokenId: string;
  downTokenId: string;
  tickSize: string;
  negRisk: boolean;
}

interface OrderBook {
  bestBid: number;
  bestAsk: number;
  bidLiquidity: number;
  askLiquidity: number;
  lastUpdated: number;
}

interface BidLevel {
  price: number;
  size: number;
  orderId?: string;
}

interface Position {
  // Actual shares
  upShares: number;
  downShares: number;
  upAvgCost: number;
  downAvgCost: number;

  // Order books
  upBook: OrderBook;
  downBook: OrderBook;

  // Current bids
  upLadder: BidLevel[];
  downLadder: BidLevel[];

  // Risk metrics (DOLLAR-BASED)
  upDollars: number;        // Total $ in Up position
  downDollars: number;      // Total $ in Down position
  hedgedDollars: number;    // $ that's hedged
  unhedgedDollars: number;  // $ exposure
  unhedgedSide: 'up' | 'down' | 'none';
  riskStatus: 'safe' | 'soft' | 'hard' | 'critical';
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();

// Aggregate stats
let totalUnhedgedDollars = 0;
let totalPositionDollars = 0;
let totalTrades = 0;
let totalProfit = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'FILL' | 'RISK' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    FILL: '💰',
    RISK: '🛡️'
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

async function findActiveMarkets(): Promise<Market[]> {
  const result: Market[] = [];
  const seenConditions = new Set<string>();

  try {
    // Get markets from target's recent trades
    const res = await fetch(`${DATA_API_HOST}/trades?user=${TARGET_WALLET}&limit=30`);
    if (!res.ok) return result;

    const trades = await res.json();
    for (const trade of trades) {
      const conditionId = trade.conditionId;
      if (!conditionId || seenConditions.has(conditionId)) continue;
      seenConditions.add(conditionId);

      const marketRes = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
      if (!marketRes.ok) continue;

      const data = await marketRes.json();
      if (!data.question?.includes('Up or Down')) continue;
      if (data.closed) continue;

      const tokens = data.tokens || [];
      const upToken = tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
      );
      const downToken = tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'down' || t.outcome?.toLowerCase() === 'no'
      );

      if (!upToken || !downToken) continue;

      result.push({
        conditionId,
        question: data.question,
        upTokenId: upToken.token_id,
        downTokenId: downToken.token_id,
        tickSize: data.tick_size || '0.01',
        negRisk: data.neg_risk || false,
      });

      await new Promise(r => setTimeout(r, 50));
    }
  } catch (error: any) {
    log(`Error finding markets: ${error.message}`, 'ERROR');
  }

  return result;
}

// ============================================================================
// ORDER BOOK FETCHING
// ============================================================================

async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const defaultBook: OrderBook = {
    bestBid: 0,
    bestAsk: 1,
    bidLiquidity: 0,
    askLiquidity: 0,
    lastUpdated: Date.now(),
  };

  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return defaultBook;

    const book = await res.json();

    const bids = book.bids || [];
    const asks = book.asks || [];

    return {
      bestBid: bids.length > 0 ? parseFloat(bids[0].price) : 0,
      bestAsk: asks.length > 0 ? parseFloat(asks[0].price) : 1,
      bidLiquidity: bids.reduce((sum: number, b: any) => sum + parseFloat(b.size), 0),
      askLiquidity: asks.reduce((sum: number, a: any) => sum + parseFloat(a.size), 0),
      lastUpdated: Date.now(),
    };
  } catch {
    return defaultBook;
  }
}

// ============================================================================
// POSITION TRACKING - FETCH ACTUAL POSITIONS FROM API
// ============================================================================

async function fetchOurPositions(): Promise<void> {
  try {
    // Fetch our trades to calculate positions
    const res = await fetch(`${DATA_API_HOST}/trades?user=${OUR_WALLET}&limit=500`);
    if (!res.ok) return;

    const trades = await res.json();

    // Group by conditionId and token
    const positionMap: Map<string, { upShares: number; downShares: number; upCost: number; downCost: number }> = new Map();

    for (const trade of trades) {
      const conditionId = trade.conditionId;
      if (!conditionId) continue;

      // Only process markets we're tracking
      const market = markets.get(conditionId);
      if (!market) continue;

      let pos = positionMap.get(conditionId);
      if (!pos) {
        pos = { upShares: 0, downShares: 0, upCost: 0, downCost: 0 };
        positionMap.set(conditionId, pos);
      }

      const size = parseFloat(trade.size) || 0;
      const price = parseFloat(trade.price) || 0;
      const isUp = trade.asset_id === market.upTokenId || trade.outcome === 'Up' || trade.outcome === 'Yes';
      const isBuy = trade.side === 'BUY' || trade.side === 'buy';

      if (isUp) {
        if (isBuy) {
          pos.upShares += size;
          pos.upCost += size * price;
        } else {
          pos.upShares -= size;
          pos.upCost -= size * price;
        }
      } else {
        if (isBuy) {
          pos.downShares += size;
          pos.downCost += size * price;
        } else {
          pos.downShares -= size;
          pos.downCost -= size * price;
        }
      }
    }

    // Update our position state
    for (const [conditionId, pos] of positionMap) {
      const position = positions.get(conditionId);
      if (!position) continue;

      const prevUp = position.upShares;
      const prevDown = position.downShares;

      position.upShares = Math.max(0, pos.upShares);
      position.downShares = Math.max(0, pos.downShares);
      position.upAvgCost = position.upShares > 0 ? pos.upCost / position.upShares : 0;
      position.downAvgCost = position.downShares > 0 ? pos.downCost / position.downShares : 0;

      // Detect fills
      if (position.upShares > prevUp) {
        const fillSize = position.upShares - prevUp;
        log(`FILL DETECTED: +${fillSize} UP shares`, 'FILL');
        totalTrades++;
      }
      if (position.downShares > prevDown) {
        const fillSize = position.downShares - prevDown;
        log(`FILL DETECTED: +${fillSize} DOWN shares`, 'FILL');
        totalTrades++;
      }
    }
  } catch (error: any) {
    // Silently fail - will retry next cycle
  }
}

function calculateRiskMetrics(position: Position): void {
  // Dollar exposure = shares × average cost
  position.upDollars = position.upShares * position.upAvgCost;
  position.downDollars = position.downShares * position.downAvgCost;

  // Hedged $ = min of both sides
  position.hedgedDollars = Math.min(position.upDollars, position.downDollars);

  // Unhedged = the excess on one side
  position.unhedgedDollars = Math.abs(position.upDollars - position.downDollars);

  position.unhedgedSide = position.upDollars > position.downDollars ? 'up'
    : position.downDollars > position.upDollars ? 'down' : 'none';

  // Risk status based on DOLLAR exposure
  if (position.unhedgedDollars >= CONFIG.HARD_IMBALANCE_DOLLARS) {
    position.riskStatus = 'hard';
  } else if (position.unhedgedDollars >= CONFIG.SOFT_IMBALANCE_DOLLARS) {
    position.riskStatus = 'soft';
  } else {
    position.riskStatus = 'safe';
  }
}

function calculateAggregateRisk(): void {
  totalUnhedgedDollars = 0;
  totalPositionDollars = 0;

  for (const position of positions.values()) {
    totalUnhedgedDollars += position.unhedgedDollars;
    totalPositionDollars += position.upDollars + position.downDollars;
  }
}

// ============================================================================
// INTELLIGENT LADDER CALCULATION
// ============================================================================

function calculateLadder(
  position: Position,
  side: 'up' | 'down'
): BidLevel[] {
  const ladder: BidLevel[] = [];
  const book = side === 'up' ? position.upBook : position.downBook;
  const currentShares = side === 'up' ? position.upShares : position.downShares;
  const currentDollars = side === 'up' ? position.upDollars : position.downDollars;

  // Would this side increase our unhedged exposure?
  const wouldIncreaseExposure =
    (side === 'up' && position.unhedgedSide === 'up') ||
    (side === 'down' && position.unhedgedSide === 'down') ||
    (position.unhedgedSide === 'none');

  // HARD STOP: If at limit and this would make it worse
  if (position.riskStatus === 'hard' && position.unhedgedSide === side) {
    log(`RISK STOP: ${side.toUpperCase()} blocked - $${position.unhedgedDollars.toFixed(2)} unhedged`, 'RISK');
    return [];
  }

  // Check aggregate exposure
  if (totalUnhedgedDollars >= CONFIG.MAX_UNHEDGED_DOLLARS && wouldIncreaseExposure) {
    log(`AGGREGATE RISK: ${side.toUpperCase()} blocked - total $${totalUnhedgedDollars.toFixed(2)} unhedged`, 'RISK');
    return [];
  }

  // Check position limits
  if (currentShares >= CONFIG.MAX_SHARES_PER_SIDE) {
    return [];
  }

  // Calculate smart price range based on order book
  let maxPrice = CONFIG.MAX_BID;

  // Don't bid above best ask minus spread (only if ask is reasonable)
  if (book.bestAsk < 0.90 && book.bestAsk > 0.10) {
    maxPrice = Math.min(maxPrice, book.bestAsk - CONFIG.MIN_SPREAD_FROM_BEST);
  }

  // Only use best bid as ceiling if there's meaningful liquidity (>100 shares)
  // This prevents us from being too conservative when books are thin
  if (book.bestBid > 0.10 && book.bidLiquidity > 100) {
    maxPrice = Math.min(maxPrice, book.bestBid + CONFIG.MAX_BID_VS_BEST);
  }

  // Adjust aggressiveness based on imbalance
  let priceAdjust = 0;
  if (position.riskStatus === 'soft') {
    if (position.unhedgedSide === side) {
      // Heavy side: bid less aggressively
      priceAdjust = -0.04;
    } else if (position.unhedgedSide !== 'none') {
      // Light side: bid more aggressively to catch up
      priceAdjust = +0.03;
    }
  }

  // Generate ladder from worst (lowest) to best (highest)
  const basePrice = Math.min(maxPrice, (CONFIG.MIN_BID + maxPrice) / 2) + priceAdjust;

  for (let i = 0; i < CONFIG.NUM_LEVELS; i++) {
    const price = Math.min(maxPrice, Math.max(CONFIG.MIN_BID,
      basePrice - (CONFIG.NUM_LEVELS - 1 - i) * CONFIG.LEVEL_SPACING
    ));

    // Size increases at better prices
    let size = CONFIG.BASE_SIZE + i * CONFIG.SIZE_INCREMENT;

    // Reduce size if approaching limits
    const dollarsLeft = CONFIG.MAX_UNHEDGED_DOLLARS - position.unhedgedDollars;
    if (wouldIncreaseExposure && position.riskStatus === 'soft') {
      const maxDollars = Math.max(10, dollarsLeft);
      size = Math.min(size, Math.floor(maxDollars / price));
    }

    const roomLeft = CONFIG.MAX_SHARES_PER_SIDE - currentShares;
    size = Math.min(size, Math.max(5, Math.floor(roomLeft / CONFIG.NUM_LEVELS)));

    const roundedPrice = Math.round(price * 100) / 100;

    if (size >= 5 && roundedPrice >= CONFIG.MIN_BID) {
      ladder.push({ price: roundedPrice, size: Math.round(size) });
    }
  }

  return ladder;
}

function validateLadder(upLadder: BidLevel[], downLadder: BidLevel[]): boolean {
  if (upLadder.length === 0 || downLadder.length === 0) {
    return true; // Empty is valid (risk controls)
  }

  // Check worst case combined price
  const worstUp = Math.max(...upLadder.map(l => l.price));
  const worstDown = Math.max(...downLadder.map(l => l.price));

  if (worstUp + worstDown > CONFIG.MAX_COMBINED) {
    log(`Ladder invalid: $${worstUp} + $${worstDown} = $${(worstUp + worstDown).toFixed(2)} > $${CONFIG.MAX_COMBINED}`, 'WARN');
    return false;
  }

  return true;
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function cancelAllOrders(position: Position): Promise<void> {
  if (!clobClient) return;

  const allOrders = [
    ...position.upLadder.filter(l => l.orderId).map(l => l.orderId!),
    ...position.downLadder.filter(l => l.orderId).map(l => l.orderId!),
  ];

  for (const orderId of allOrders) {
    try {
      await clobClient.cancelOrder({ orderID: orderId });
    } catch {
      // Ignore - already filled or cancelled
    }
  }

  position.upLadder.forEach(l => l.orderId = undefined);
  position.downLadder.forEach(l => l.orderId = undefined);
}

async function placeLadder(
  market: Market,
  position: Position,
  ladder: BidLevel[],
  side: 'up' | 'down'
): Promise<void> {
  if (ladder.length === 0) return;

  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  for (const level of ladder) {
    if (!CONFIG.ENABLE_TRADING || !clobClient) {
      // Dry run logging handled in display
      continue;
    }

    try {
      const result = await clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: level.price,
          side: Side.BUY,
          size: level.size,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC
      );

      level.orderId = result?.order_id || result?.orderID;
    } catch (error: any) {
      log(`Order failed: ${error.message}`, 'ERROR');
    }

    await new Promise(r => setTimeout(r, 80));
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayHeader(): void {
  console.clear();

  const riskColor = totalUnhedgedDollars >= CONFIG.HARD_IMBALANCE_DOLLARS ? '\x1b[31m'
    : totalUnhedgedDollars >= CONFIG.SOFT_IMBALANCE_DOLLARS ? '\x1b[33m' : '\x1b[32m';
  const reset = '\x1b[0m';

  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V3 - DOLLAR-BASED RISK CONTROLS                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${CONFIG.ENABLE_TRADING ? '\x1b[32mLIVE\x1b[0m' : '\x1b[33mDRY RUN\x1b[0m'}  │  Trades: ${totalTrades}  │  Profit: $${totalProfit.toFixed(2)}`.padEnd(91) + '║');
  console.log(`║  Total Position: $${totalPositionDollars.toFixed(2)}  │  ${riskColor}Unhedged: $${totalUnhedgedDollars.toFixed(2)}${reset} / $${CONFIG.MAX_UNHEDGED_DOLLARS}`.padEnd(100) + '║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

function displayPosition(market: Market, position: Position): void {
  const riskColors: Record<string, string> = {
    safe: '\x1b[32m',
    soft: '\x1b[33m',
    hard: '\x1b[31m',
    critical: '\x1b[35m'
  };
  const color = riskColors[position.riskStatus];
  const reset = '\x1b[0m';

  // Truncate market name
  const name = market.question.length > 55 ? market.question.slice(0, 52) + '...' : market.question;

  console.log(`┌────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${name.padEnd(76)} │`);
  console.log(`├────────────────────────────────────────────────────────────────────────────────┤`);

  // Position summary
  const upStr = `Up: ${position.upShares} ($${position.upDollars.toFixed(2)})`;
  const downStr = `Down: ${position.downShares} ($${position.downDollars.toFixed(2)})`;
  const hedgedStr = `Hedged: $${position.hedgedDollars.toFixed(2)}`;
  const unhedgedStr = `${color}Unhedged: $${position.unhedgedDollars.toFixed(2)} ${position.unhedgedSide.toUpperCase()}${reset}`;

  console.log(`│ ${upStr.padEnd(22)} │ ${downStr.padEnd(22)} │ ${hedgedStr} │ ${unhedgedStr}`.padEnd(89) + '│');

  // Order book info
  const upBook = `Up: bid $${position.upBook.bestBid.toFixed(2)} / ask $${position.upBook.bestAsk.toFixed(2)}`;
  const downBook = `Down: bid $${position.downBook.bestBid.toFixed(2)} / ask $${position.downBook.bestAsk.toFixed(2)}`;
  console.log(`│ Book: ${upBook}  │  ${downBook}`.padEnd(79) + '│');

  console.log(`├──────────────────────────────────────┬─────────────────────────────────────────┤`);

  // Ladders side by side
  const maxLevels = Math.max(position.upLadder.length, position.downLadder.length, 1);

  if (position.upLadder.length === 0 && position.downLadder.length === 0) {
    console.log(`│ ${color}⚠️  ALL BIDDING PAUSED - RISK LIMIT${reset}`.padEnd(86) + '│');
  } else {
    console.log(`│ UP BIDS                              │ DOWN BIDS                               │`);

    for (let i = 0; i < maxLevels; i++) {
      const up = position.upLadder[i];
      const down = position.downLadder[i];

      let upStr = '  -';
      let downStr = '  -';

      if (up) {
        upStr = `  $${up.price.toFixed(2)} × ${up.size}`;
      } else if (position.upLadder.length === 0 && i === 0) {
        upStr = `  ${color}BLOCKED${reset}`;
      }

      if (down) {
        downStr = `  $${down.price.toFixed(2)} × ${down.size}`;
      } else if (position.downLadder.length === 0 && i === 0) {
        downStr = `  ${color}BLOCKED${reset}`;
      }

      console.log(`│${upStr.padEnd(37)} │${downStr.padEnd(48)}│`);
    }
  }

  // Combined price range
  if (position.upLadder.length > 0 && position.downLadder.length > 0) {
    const worstUp = Math.max(...position.upLadder.map(l => l.price));
    const worstDown = Math.max(...position.downLadder.map(l => l.price));
    const bestUp = Math.min(...position.upLadder.map(l => l.price));
    const bestDown = Math.min(...position.downLadder.map(l => l.price));

    const worstCombined = worstUp + worstDown;
    const bestCombined = bestUp + bestDown;

    console.log(`├──────────────────────────────────────┴─────────────────────────────────────────┤`);
    console.log(`│ Combined: $${bestCombined.toFixed(2)} (${((1-bestCombined)*100).toFixed(0)}% profit) → $${worstCombined.toFixed(2)} (${((1-worstCombined)*100).toFixed(0)}% profit)`.padEnd(79) + '│');
  }

  console.log(`└────────────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// SIMULATION FOR TESTING
// ============================================================================

function simulateFill(position: Position, side: 'up' | 'down', price: number, size: number): void {
  if (side === 'up') {
    const totalCost = position.upAvgCost * position.upShares + price * size;
    position.upShares += size;
    position.upAvgCost = position.upShares > 0 ? totalCost / position.upShares : 0;
  } else {
    const totalCost = position.downAvgCost * position.downShares + price * size;
    position.downShares += size;
    position.downAvgCost = position.downShares > 0 ? totalCost / position.downShares : 0;
  }

  calculateRiskMetrics(position);
  totalTrades++;

  log(`FILL: ${size} ${side.toUpperCase()} @ $${price.toFixed(2)} | Unhedged: $${position.unhedgedDollars.toFixed(2)} ${position.unhedgedSide}`, 'FILL');
}

async function runTestMode(): Promise<void> {
  log('TEST MODE - Simulating fills to demonstrate risk controls');
  await new Promise(r => setTimeout(r, 2000));

  if (markets.size === 0) {
    log('No markets for test', 'ERROR');
    return;
  }

  const [conditionId, market] = markets.entries().next().value;
  const position = positions.get(conditionId)!;

  // Simulate order books
  position.upBook = { bestBid: 0.45, bestAsk: 0.52, bidLiquidity: 500, askLiquidity: 300, lastUpdated: Date.now() };
  position.downBook = { bestBid: 0.44, bestAsk: 0.50, bidLiquidity: 400, askLiquidity: 350, lastUpdated: Date.now() };

  const scenarios = [
    // Balanced fills
    { side: 'up' as const, price: 0.35, size: 40 },    // $14 up
    { side: 'down' as const, price: 0.38, size: 35 },  // $13.30 down
    // Getting imbalanced toward UP
    { side: 'up' as const, price: 0.32, size: 50 },    // +$16 up
    { side: 'up' as const, price: 0.30, size: 45 },    // +$13.50 up
    // Now heavily UP - should trigger soft then hard limit
    { side: 'up' as const, price: 0.28, size: 40 },    // Should be limited
    // Try to balance with DOWN
    { side: 'down' as const, price: 0.35, size: 60 },
    { side: 'down' as const, price: 0.33, size: 50 },
  ];

  for (const fill of scenarios) {
    simulateFill(position, fill.side, fill.price, fill.size);
    calculateAggregateRisk();
    await runMarketMaker();
    await new Promise(r => setTimeout(r, 2500));
  }

  log('Test complete - observe risk controls in action');
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketMaker(): Promise<void> {
  // Fetch actual positions (only in live mode)
  if (CONFIG.ENABLE_TRADING) {
    await fetchOurPositions();
  }

  // Update order books
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;

    const [upBook, downBook] = await Promise.all([
      fetchOrderBook(market.upTokenId),
      fetchOrderBook(market.downTokenId),
    ]);

    position.upBook = upBook;
    position.downBook = downBook;
  }

  // Calculate risk metrics
  for (const position of positions.values()) {
    calculateRiskMetrics(position);
  }
  calculateAggregateRisk();

  // Display header
  displayHeader();

  // Process each market
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;

    // Cancel existing orders
    await cancelAllOrders(position);

    // Calculate ladders with risk controls
    const upLadder = calculateLadder(position, 'up');
    const downLadder = calculateLadder(position, 'down');

    // Validate combined prices
    if (!validateLadder(upLadder, downLadder)) {
      // Adjust ladders to be safe
      continue;
    }

    // Store
    position.upLadder = upLadder;
    position.downLadder = downLadder;

    // Place orders
    await placeLadder(market, position, upLadder, 'up');
    await placeLadder(market, position, downLadder, 'down');

    // Display
    displayPosition(market, position);
  }

  console.log('');
  log(`Next refresh in ${CONFIG.REFRESH_INTERVAL_MS / 1000}s`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const testMode = process.argv.includes('--test');

  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V3 - DOLLAR-BASED RISK CONTROLS                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Price Range:       $${CONFIG.MIN_BID.toFixed(2)} - $${CONFIG.MAX_BID.toFixed(2)}                                          ║`);
  console.log(`║  Max Combined:      $${CONFIG.MAX_COMBINED.toFixed(2)} (${((1 - CONFIG.MAX_COMBINED) * 100).toFixed(0)}% min profit)                                    ║`);
  console.log(`║  Soft Limit:        $${CONFIG.SOFT_IMBALANCE_DOLLARS} unhedged (adjust prices)                             ║`);
  console.log(`║  Hard Limit:        $${CONFIG.HARD_IMBALANCE_DOLLARS} unhedged (STOP bidding heavy side)                   ║`);
  console.log(`║  Max Total:         $${CONFIG.MAX_UNHEDGED_DOLLARS} max unhedged exposure                                ║`);
  console.log(`║  Trading:           ${CONFIG.ENABLE_TRADING ? 'ENABLED' : 'DISABLED (monitor only)'}                                        ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await loadClobClient();

  if (CONFIG.ENABLE_TRADING) {
    await initClobClient();
  }

  log('Finding active markets...');
  const activeMarkets = await findActiveMarkets();
  log(`Found ${activeMarkets.length} active markets`);

  for (const market of activeMarkets) {
    markets.set(market.conditionId, market);
    positions.set(market.conditionId, {
      upShares: 0,
      downShares: 0,
      upAvgCost: 0,
      downAvgCost: 0,
      upBook: { bestBid: 0, bestAsk: 1, bidLiquidity: 0, askLiquidity: 0, lastUpdated: 0 },
      downBook: { bestBid: 0, bestAsk: 1, bidLiquidity: 0, askLiquidity: 0, lastUpdated: 0 },
      upLadder: [],
      downLadder: [],
      upDollars: 0,
      downDollars: 0,
      hedgedDollars: 0,
      unhedgedDollars: 0,
      unhedgedSide: 'none',
      riskStatus: 'safe',
    });
    log(`  - ${market.question}`);
  }

  if (markets.size === 0) {
    log('No active markets found', 'ERROR');
    process.exit(1);
  }

  if (testMode) {
    await runTestMode();
  } else {
    await runMarketMaker();
    setInterval(runMarketMaker, CONFIG.REFRESH_INTERVAL_MS);

    // Refresh market list periodically
    setInterval(async () => {
      const newMarkets = await findActiveMarkets();
      for (const market of newMarkets) {
        if (!markets.has(market.conditionId)) {
          markets.set(market.conditionId, market);
          positions.set(market.conditionId, {
            upShares: 0,
            downShares: 0,
            upAvgCost: 0,
            downAvgCost: 0,
            upBook: { bestBid: 0, bestAsk: 1, bidLiquidity: 0, askLiquidity: 0, lastUpdated: 0 },
            downBook: { bestBid: 0, bestAsk: 1, bidLiquidity: 0, askLiquidity: 0, lastUpdated: 0 },
            upLadder: [],
            downLadder: [],
            upDollars: 0,
            downDollars: 0,
            hedgedDollars: 0,
            unhedgedDollars: 0,
            unhedgedSide: 'none',
            riskStatus: 'safe',
          });
          log(`Added: ${market.question}`);
        }
      }
    }, 60000);
  }

  log('Press Ctrl+C to stop');
}

main().catch(console.error);
