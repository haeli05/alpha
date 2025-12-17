/**
 * POLYMARKET MARKET MAKER V4 - SEQUENTIAL MATCHING
 *
 * SAFE STRATEGY:
 * 1. Place ONE bid on each side (or neither if imbalanced)
 * 2. When one side fills, STOP and focus on matching the other side
 * 3. Be willing to cross the spread to match (limit loss)
 * 4. Only resume bidding after balanced
 *
 * This ensures we NEVER have large unhedged exposure.
 *
 * USAGE: npx tsx market-maker-v4.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Bid settings
  BID_PRICE_UP: 0.40,        // Our bid for UP tokens
  BID_PRICE_DOWN: 0.40,      // Our bid for DOWN tokens
  BID_SIZE: 25,              // Shares per bid

  // Safety
  MAX_COMBINED: 0.96,        // Max we'll pay for Up + Down (4% min profit)
  MAX_IMBALANCE: 25,         // If imbalance > this, STOP bidding heavy side
  MATCH_URGENCY_THRESHOLD: 50,  // If imbalance > this, cross spread to match

  // Matching behavior
  MATCH_SLIPPAGE: 0.05,      // Willing to pay 5c more to match quickly

  // Max position
  MAX_POSITION: 200,

  // Timing
  REFRESH_INTERVAL_MS: 8000,

  // Trading
  ENABLE_TRADING: false,
};

// ============================================================================
// API
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';
const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const OUR_WALLET = PROXY_WALLET;

// ============================================================================
// ENV
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
  lastUpdated: number;
}

interface Position {
  upShares: number;
  downShares: number;
  upAvgCost: number;
  downAvgCost: number;
  upBook: OrderBook;
  downBook: OrderBook;

  // Current orders
  upOrderId?: string;
  downOrderId?: string;
  upOrderPrice?: number;
  downOrderPrice?: number;

  // State
  state: 'balanced' | 'need_up' | 'need_down' | 'urgent_match';
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();

let totalTrades = 0;
let totalProfit = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'ORDER' | 'MATCH' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    ORDER: '📝',
    MATCH: '🎯'
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
    log(`Error: ${error.message}`, 'ERROR');
  }

  return result;
}

// ============================================================================
// ORDER BOOK
// ============================================================================

async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return { bestBid: 0, bestAsk: 1, lastUpdated: Date.now() };

    const book = await res.json();
    const bids = book.bids || [];
    const asks = book.asks || [];

    return {
      bestBid: bids.length > 0 ? parseFloat(bids[0].price) : 0,
      bestAsk: asks.length > 0 ? parseFloat(asks[0].price) : 1,
      lastUpdated: Date.now(),
    };
  } catch {
    return { bestBid: 0, bestAsk: 1, lastUpdated: Date.now() };
  }
}

// ============================================================================
// STATE CALCULATION
// ============================================================================

function calculateState(position: Position): void {
  const imbalance = position.upShares - position.downShares;

  if (Math.abs(imbalance) >= CONFIG.MATCH_URGENCY_THRESHOLD) {
    // URGENT: Need to match quickly, may cross spread
    position.state = 'urgent_match';
  } else if (imbalance > CONFIG.MAX_IMBALANCE) {
    // Need more DOWN to balance
    position.state = 'need_down';
  } else if (imbalance < -CONFIG.MAX_IMBALANCE) {
    // Need more UP to balance
    position.state = 'need_up';
  } else {
    // Balanced enough to bid on both sides
    position.state = 'balanced';
  }
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function cancelOrder(orderId: string | undefined): Promise<void> {
  if (!orderId || !clobClient) return;
  try {
    await clobClient.cancelOrder({ orderID: orderId });
  } catch {
    // Already cancelled or filled
  }
}

async function placeOrder(
  market: Market,
  position: Position,
  side: 'up' | 'down',
  price: number,
  size: number,
  orderType: 'GTC' | 'FOK' = 'GTC'
): Promise<string | undefined> {
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING || !clobClient) {
    log(`[DRY] ${side.toUpperCase()} ${orderType}: ${size} @ $${price.toFixed(2)}`, 'ORDER');
    return 'dry-run-order';
  }

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price,
        side: Side.BUY,
        size: size,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      orderType === 'FOK' ? OrderType.FOK : OrderType.GTC
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`${side.toUpperCase()} ${orderType}: ${size} @ $${price.toFixed(2)}`, 'ORDER');
    }
    return orderId;
  } catch (error: any) {
    log(`Order failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

// ============================================================================
// MATCHING LOGIC
// ============================================================================

async function tryMatch(
  market: Market,
  position: Position,
  side: 'up' | 'down',
  urgent: boolean
): Promise<void> {
  const book = side === 'up' ? position.upBook : position.downBook;
  const imbalance = Math.abs(position.upShares - position.downShares);

  // Calculate match size (match up to the imbalance)
  const matchSize = Math.min(imbalance, CONFIG.BID_SIZE);

  if (matchSize < 5) return;

  // Calculate price: willing to pay more if urgent
  let matchPrice = side === 'up' ? CONFIG.BID_PRICE_UP : CONFIG.BID_PRICE_DOWN;

  if (urgent) {
    // Cross the spread if necessary
    matchPrice = Math.min(
      book.bestAsk,  // Can't pay more than the ask
      matchPrice + CONFIG.MATCH_SLIPPAGE
    );
    log(`URGENT MATCH: ${side.toUpperCase()} - willing to pay up to $${matchPrice.toFixed(2)}`, 'MATCH');
  }

  // Check combined price won't exceed max
  const otherSideAvg = side === 'up' ? position.downAvgCost : position.upAvgCost;
  if (otherSideAvg > 0 && matchPrice + otherSideAvg > CONFIG.MAX_COMBINED) {
    log(`Match would exceed max combined ($${(matchPrice + otherSideAvg).toFixed(2)})`, 'WARN');
    matchPrice = CONFIG.MAX_COMBINED - otherSideAvg - 0.01;
    if (matchPrice < CONFIG.BID_PRICE_UP - 0.10) {
      log(`Can't match profitably, waiting`, 'WARN');
      return;
    }
  }

  // Place matching order (FOK if urgent, GTC otherwise)
  const orderType = urgent ? 'FOK' : 'GTC';

  if (side === 'up') {
    await cancelOrder(position.upOrderId);
    position.upOrderId = await placeOrder(market, position, 'up', matchPrice, matchSize, orderType);
    position.upOrderPrice = matchPrice;
  } else {
    await cancelOrder(position.downOrderId);
    position.downOrderId = await placeOrder(market, position, 'down', matchPrice, matchSize, orderType);
    position.downOrderPrice = matchPrice;
  }
}

async function placeBothSides(market: Market, position: Position): Promise<void> {
  // Cancel existing orders
  await cancelOrder(position.upOrderId);
  await cancelOrder(position.downOrderId);

  // Check if we're at max position
  if (position.upShares >= CONFIG.MAX_POSITION || position.downShares >= CONFIG.MAX_POSITION) {
    log(`Max position reached, not bidding`, 'WARN');
    return;
  }

  // Calculate bid prices ensuring combined < max
  let upBid = CONFIG.BID_PRICE_UP;
  let downBid = CONFIG.BID_PRICE_DOWN;

  // Ensure combined is safe
  if (upBid + downBid > CONFIG.MAX_COMBINED) {
    const reduction = (upBid + downBid - CONFIG.MAX_COMBINED) / 2;
    upBid -= reduction;
    downBid -= reduction;
  }

  // Place both orders
  position.upOrderId = await placeOrder(market, position, 'up', upBid, CONFIG.BID_SIZE);
  position.upOrderPrice = upBid;

  await new Promise(r => setTimeout(r, 100));

  position.downOrderId = await placeOrder(market, position, 'down', downBid, CONFIG.BID_SIZE);
  position.downOrderPrice = downBid;
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.clear();

  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V4 - SEQUENTIAL MATCHING                               ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${CONFIG.ENABLE_TRADING ? '\x1b[32mLIVE\x1b[0m' : '\x1b[33mDRY RUN\x1b[0m'}  │  Bid: $${CONFIG.BID_PRICE_UP}/$${CONFIG.BID_PRICE_DOWN}  │  Size: ${CONFIG.BID_SIZE}`.padEnd(91) + '║');
  console.log(`║  Max Combined: $${CONFIG.MAX_COMBINED}  │  Max Imbalance: ${CONFIG.MAX_IMBALANCE}  │  Trades: ${totalTrades}`.padEnd(91) + '║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

function displayPosition(market: Market, position: Position): void {
  const stateColors: Record<string, string> = {
    balanced: '\x1b[32m',     // Green
    need_up: '\x1b[33m',      // Yellow
    need_down: '\x1b[33m',    // Yellow
    urgent_match: '\x1b[31m', // Red
  };
  const color = stateColors[position.state];
  const reset = '\x1b[0m';

  const imbalance = position.upShares - position.downShares;
  const hedged = Math.min(position.upShares, position.downShares);
  const name = market.question.slice(0, 60);

  console.log(`┌─────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${name.padEnd(77)} │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);

  // Position
  console.log(`│ Up: ${position.upShares.toString().padStart(3)} @ $${position.upAvgCost.toFixed(2)}  │  Down: ${position.downShares.toString().padStart(3)} @ $${position.downAvgCost.toFixed(2)}  │  Hedged: ${hedged}  │  ${color}Imbalance: ${imbalance >= 0 ? '+' : ''}${imbalance}${reset}`.padEnd(89) + '│');

  // State
  const stateStr = {
    balanced: '✅ BALANCED - Bidding both sides',
    need_up: '⚠️  NEED UP - Only bidding UP to balance',
    need_down: '⚠️  NEED DOWN - Only bidding DOWN to balance',
    urgent_match: '🚨 URGENT - Crossing spread to match!',
  }[position.state];

  console.log(`│ ${color}${stateStr}${reset}`.padEnd(88) + '│');

  // Orders
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);

  const upOrder = position.upOrderId
    ? `UP: $${position.upOrderPrice?.toFixed(2)} × ${CONFIG.BID_SIZE} ${position.upOrderId === 'dry-run-order' ? '(dry)' : ''}`
    : 'UP: -';
  const downOrder = position.downOrderId
    ? `DOWN: $${position.downOrderPrice?.toFixed(2)} × ${CONFIG.BID_SIZE} ${position.downOrderId === 'dry-run-order' ? '(dry)' : ''}`
    : 'DOWN: -';

  console.log(`│ Orders: ${upOrder}  │  ${downOrder}`.padEnd(80) + '│');

  // Book
  console.log(`│ Book:   UP bid $${position.upBook.bestBid.toFixed(2)} / ask $${position.upBook.bestAsk.toFixed(2)}  │  DOWN bid $${position.downBook.bestBid.toFixed(2)} / ask $${position.downBook.bestAsk.toFixed(2)}`.padEnd(80) + '│');

  // Expected profit if hedged
  if (hedged > 0) {
    const totalCost = position.upAvgCost * hedged + position.downAvgCost * hedged;
    const payout = hedged; // $1 per hedged share at resolution
    const profit = payout - totalCost;
    const profitPct = ((payout / totalCost - 1) * 100).toFixed(1);
    console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`│ Hedged P&L: $${profit.toFixed(2)} (${profitPct}%) on ${hedged} shares`.padEnd(80) + '│');
  }

  console.log(`└─────────────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketMaker(): Promise<void> {
  // Update order books
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;

    const [upBook, downBook] = await Promise.all([
      fetchOrderBook(market.upTokenId),
      fetchOrderBook(market.downTokenId),
    ]);

    position.upBook = upBook;
    position.downBook = downBook;

    // Calculate state
    calculateState(position);
  }

  // Display
  displayStatus();

  // Process each market
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;

    switch (position.state) {
      case 'balanced':
        // Safe to bid on both sides
        await placeBothSides(market, position);
        break;

      case 'need_up':
        // Only bid UP to rebalance
        await cancelOrder(position.downOrderId);
        position.downOrderId = undefined;
        await tryMatch(market, position, 'up', false);
        break;

      case 'need_down':
        // Only bid DOWN to rebalance
        await cancelOrder(position.upOrderId);
        position.upOrderId = undefined;
        await tryMatch(market, position, 'down', false);
        break;

      case 'urgent_match':
        // Cross the spread to match ASAP
        const needUp = position.downShares > position.upShares;
        if (needUp) {
          await tryMatch(market, position, 'up', true);
        } else {
          await tryMatch(market, position, 'down', true);
        }
        break;
    }

    displayPosition(market, position);
  }

  console.log('');
  log(`Next refresh in ${CONFIG.REFRESH_INTERVAL_MS / 1000}s`);
}

// ============================================================================
// SIMULATION
// ============================================================================

function simulateFill(position: Position, side: 'up' | 'down', price: number, size: number): void {
  if (side === 'up') {
    const totalCost = position.upAvgCost * position.upShares + price * size;
    position.upShares += size;
    position.upAvgCost = position.upShares > 0 ? totalCost / position.upShares : 0;
    position.upOrderId = undefined;
  } else {
    const totalCost = position.downAvgCost * position.downShares + price * size;
    position.downShares += size;
    position.downAvgCost = position.downShares > 0 ? totalCost / position.downShares : 0;
    position.downOrderId = undefined;
  }

  totalTrades++;
  log(`FILL: ${size} ${side.toUpperCase()} @ $${price.toFixed(2)}`, 'MATCH');
}

async function runTestMode(): Promise<void> {
  log('TEST MODE - Simulating sequential matching');
  await new Promise(r => setTimeout(r, 2000));

  if (markets.size === 0) {
    log('No markets for test', 'ERROR');
    return;
  }

  const [conditionId, market] = markets.entries().next().value;
  const position = positions.get(conditionId)!;

  // Set reasonable order books
  position.upBook = { bestBid: 0.42, bestAsk: 0.55, lastUpdated: Date.now() };
  position.downBook = { bestBid: 0.40, bestAsk: 0.52, lastUpdated: Date.now() };

  const scenarios = [
    // Balanced start - both sides bid
    { action: 'run' },
    // Fill UP - should stop UP bidding, focus on DOWN
    { action: 'fill', side: 'up' as const, price: 0.40, size: 25 },
    { action: 'run' },
    // Fill DOWN - now balanced again
    { action: 'fill', side: 'down' as const, price: 0.40, size: 25 },
    { action: 'run' },
    // Multiple UP fills - imbalance grows
    { action: 'fill', side: 'up' as const, price: 0.38, size: 25 },
    { action: 'run' },
    { action: 'fill', side: 'up' as const, price: 0.35, size: 25 },
    { action: 'run' },
    // Now at URGENT level - should cross spread
    { action: 'fill', side: 'up' as const, price: 0.32, size: 25 },
    { action: 'run' },
  ];

  for (const scenario of scenarios) {
    if (scenario.action === 'fill') {
      simulateFill(position, scenario.side!, scenario.price!, scenario.size!);
    }
    calculateState(position);
    await runMarketMaker();
    await new Promise(r => setTimeout(r, 3000));
  }

  log('Test complete');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const testMode = process.argv.includes('--test');

  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V4 - SEQUENTIAL MATCHING                               ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                                  ║');
  console.log('║  STRATEGY:                                                                       ║');
  console.log('║  1. When BALANCED: Bid on both UP and DOWN                                       ║');
  console.log('║  2. When one fills: STOP that side, focus on matching the other                  ║');
  console.log('║  3. If imbalance urgent: Cross the spread to match quickly                       ║');
  console.log('║  4. Never have large unhedged exposure                                           ║');
  console.log('║                                                                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Bid Prices: UP $${CONFIG.BID_PRICE_UP.toFixed(2)} / DOWN $${CONFIG.BID_PRICE_DOWN.toFixed(2)}                                            ║`);
  console.log(`║  Bid Size:   ${CONFIG.BID_SIZE} shares                                                           ║`);
  console.log(`║  Max Combined: $${CONFIG.MAX_COMBINED.toFixed(2)} (${((1 - CONFIG.MAX_COMBINED) * 100).toFixed(0)}% min profit)                                      ║`);
  console.log(`║  Imbalance Limit: ${CONFIG.MAX_IMBALANCE} (soft) / ${CONFIG.MATCH_URGENCY_THRESHOLD} (urgent)                                    ║`);
  console.log(`║  Trading: ${CONFIG.ENABLE_TRADING ? 'ENABLED' : 'DISABLED (dry run)'}                                                     ║`);
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
      upBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
      downBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
      state: 'balanced',
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
            upBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
            downBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
            state: 'balanced',
          });
          log(`Added: ${market.question}`);
        }
      }
    }, 60000);
  }

  log('Press Ctrl+C to stop');
}

main().catch(console.error);
