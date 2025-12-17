/**
 * POLYMARKET MARKET MAKER V5 - PRODUCTION READY
 *
 * Improvements over V4:
 * 1. Higher bid prices (~$0.48) to be competitive with target wallet
 * 2. Fill rate tracking - increase price if not getting fills
 * 3. Market expiry handling - exit positions before resolution
 * 4. Live trading ready
 *
 * USAGE: npx tsx market-maker-v5.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Base bid prices (competitive with target wallet)
  BASE_BID_UP: 0.47,
  BASE_BID_DOWN: 0.47,
  BID_SIZE: 10,  // Reduced from 20 to prevent overexposure

  // Price bounds
  MIN_BID: 0.35,
  MAX_BID: 0.49,
  MAX_COMBINED: 0.98,  // 2% min profit

  // Dynamic pricing (fill rate)
  PRICE_INCREMENT: 0.01,      // Increase by 1c if no fills
  PRICE_DECREMENT: 0.005,     // Decrease by 0.5c after fill
  NO_FILL_TIMEOUT_MS: 60000,  // 1 min without fill = increase price

  // Risk limits - TIGHTENED to prevent overexposure
  MAX_IMBALANCE: 15,          // Reduced from 20
  URGENT_IMBALANCE: 25,       // Reduced from 40
  MAX_POSITION: 50,           // Reduced from 150
  MAX_TOTAL_DOLLARS: 100,     // NEW: max total exposure across all positions

  // Matching
  MATCH_SLIPPAGE: 0.03,

  // Market expiry
  EXIT_BEFORE_EXPIRY_MS: 120000,  // Exit 2 min before market closes

  // Timing
  REFRESH_INTERVAL_MS: 6000,
  EXPIRY_CHECK_MS: 30000,

  // Trading - SET TO TRUE FOR LIVE
  ENABLE_TRADING: true,
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
    log('No private key - cannot trade', 'ERROR');
    process.exit(1);
  }

  const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);

  try {
    // Auto-derive API credentials
    const tempClient = new ClobClient(CLOB_HOST, 137, wallet, undefined, 2, PROXY_WALLET);
    const creds = await tempClient.createOrDeriveApiKey();
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, creds, 2, PROXY_WALLET);
    log('CLOB client initialized with derived credentials');
  } catch (error: any) {
    // Fall back to env credentials
    log(`Falling back to env credentials: ${error.message}`, 'WARN');
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
      key: POLYMARKET_API_KEY,
      secret: POLYMARKET_SECRET,
      passphrase: POLYMARKET_PASSPHRASE,
    }, 2, PROXY_WALLET);
  }
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
  endTime?: Date;
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

  // Orders
  upOrderId?: string;
  downOrderId?: string;

  // Dynamic pricing
  currentUpBid: number;
  currentDownBid: number;
  lastUpFill: number;
  lastDownFill: number;

  // State
  state: 'balanced' | 'need_up' | 'need_down' | 'urgent' | 'exiting';
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();

let totalTrades = 0;
let totalProfit = 0;
let startTime = Date.now();

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'FILL' | 'PRICE' | 'EXIT' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    FILL: '💰',
    PRICE: '📈',
    EXIT: '🚪'
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

      // Parse end time from question (end_date_iso is often midnight and unreliable)
      // Format: "Bitcoin Up or Down - December 15, 10:15AM-10:30AM ET"
      let endTime: Date | undefined;
      const timeMatch = data.question.match(/(\d{1,2}):?(\d{2})?(AM|PM)\s*ET$/i)
        || data.question.match(/(\d{1,2})(AM|PM)\s*ET$/i);

      if (timeMatch) {
        const now = new Date();
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const ampm = timeMatch[timeMatch.length - 1].toUpperCase();

        if (ampm === 'PM' && hour !== 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;

        // ET is UTC-5 (or UTC-4 in DST), assume UTC-5
        const etToUtc = 5;
        endTime = new Date(now);
        endTime.setUTCHours(hour + etToUtc, minute, 0, 0);

        // If the time has passed today, it's tomorrow
        if (endTime < now) {
          endTime.setDate(endTime.getDate() + 1);
        }
      }

      result.push({
        conditionId,
        question: data.question,
        upTokenId: upToken.token_id,
        downTokenId: downToken.token_id,
        tickSize: data.tick_size || '0.01',
        negRisk: data.neg_risk || false,
        endTime,
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
// POSITION TRACKING FROM API
// ============================================================================

async function fetchOurPositions(): Promise<void> {
  try {
    const res = await fetch(`${DATA_API_HOST}/trades?user=${OUR_WALLET}&limit=200`);
    if (!res.ok) return;

    const trades = await res.json();

    // Group by market
    const posMap: Map<string, { up: number; down: number; upCost: number; downCost: number }> = new Map();

    for (const trade of trades) {
      const conditionId = trade.conditionId;
      if (!conditionId) continue;

      const market = markets.get(conditionId);
      if (!market) continue;

      let pos = posMap.get(conditionId);
      if (!pos) {
        pos = { up: 0, down: 0, upCost: 0, downCost: 0 };
        posMap.set(conditionId, pos);
      }

      const size = parseFloat(trade.size) || 0;
      const price = parseFloat(trade.price) || 0;
      const isUp = trade.asset_id === market.upTokenId || trade.outcome === 'Up';
      const isBuy = trade.side === 'BUY' || trade.side === 'buy';

      if (isUp) {
        if (isBuy) {
          pos.up += size;
          pos.upCost += size * price;
        } else {
          pos.up -= size;
        }
      } else {
        if (isBuy) {
          pos.down += size;
          pos.downCost += size * price;
        } else {
          pos.down -= size;
        }
      }
    }

    // Update positions
    for (const [conditionId, pos] of posMap) {
      const position = positions.get(conditionId);
      if (!position) continue;

      const prevUp = position.upShares;
      const prevDown = position.downShares;

      position.upShares = Math.max(0, pos.up);
      position.downShares = Math.max(0, pos.down);
      position.upAvgCost = position.upShares > 0 ? pos.upCost / position.upShares : 0;
      position.downAvgCost = position.downShares > 0 ? pos.downCost / position.downShares : 0;

      // Detect fills and update timing
      if (position.upShares > prevUp) {
        const fillSize = position.upShares - prevUp;
        log(`FILL: +${fillSize.toFixed(0)} UP @ ~$${position.upAvgCost.toFixed(2)}`, 'FILL');
        position.lastUpFill = Date.now();
        totalTrades++;

        // Decrease bid price after fill (got a good price)
        position.currentUpBid = Math.max(CONFIG.MIN_BID, position.currentUpBid - CONFIG.PRICE_DECREMENT);
      }

      if (position.downShares > prevDown) {
        const fillSize = position.downShares - prevDown;
        log(`FILL: +${fillSize.toFixed(0)} DOWN @ ~$${position.downAvgCost.toFixed(2)}`, 'FILL');
        position.lastDownFill = Date.now();
        totalTrades++;

        position.currentDownBid = Math.max(CONFIG.MIN_BID, position.currentDownBid - CONFIG.PRICE_DECREMENT);
      }
    }
  } catch (error: any) {
    // Silently fail
  }
}

// ============================================================================
// DYNAMIC PRICING
// ============================================================================

function updateDynamicPricing(position: Position): void {
  const now = Date.now();

  // If no UP fill for a while, increase UP bid
  if (now - position.lastUpFill > CONFIG.NO_FILL_TIMEOUT_MS) {
    const oldPrice = position.currentUpBid;
    position.currentUpBid = Math.min(CONFIG.MAX_BID, position.currentUpBid + CONFIG.PRICE_INCREMENT);
    if (position.currentUpBid !== oldPrice) {
      log(`No UP fills - increasing bid: $${oldPrice.toFixed(2)} → $${position.currentUpBid.toFixed(2)}`, 'PRICE');
    }
    position.lastUpFill = now; // Reset timer
  }

  // Same for DOWN
  if (now - position.lastDownFill > CONFIG.NO_FILL_TIMEOUT_MS) {
    const oldPrice = position.currentDownBid;
    position.currentDownBid = Math.min(CONFIG.MAX_BID, position.currentDownBid + CONFIG.PRICE_INCREMENT);
    if (position.currentDownBid !== oldPrice) {
      log(`No DOWN fills - increasing bid: $${oldPrice.toFixed(2)} → $${position.currentDownBid.toFixed(2)}`, 'PRICE');
    }
    position.lastDownFill = now;
  }

  // Ensure combined doesn't exceed max
  if (position.currentUpBid + position.currentDownBid > CONFIG.MAX_COMBINED) {
    const excess = (position.currentUpBid + position.currentDownBid - CONFIG.MAX_COMBINED) / 2;
    position.currentUpBid -= excess;
    position.currentDownBid -= excess;
  }
}

// ============================================================================
// STATE CALCULATION
// ============================================================================

function calculateState(position: Position, market: Market): void {
  const imbalance = position.upShares - position.downShares;

  // Check if market is about to expire
  if (market.endTime) {
    const timeToExpiry = market.endTime.getTime() - Date.now();
    if (timeToExpiry < CONFIG.EXIT_BEFORE_EXPIRY_MS && timeToExpiry > 0) {
      position.state = 'exiting';
      return;
    }
  }

  if (Math.abs(imbalance) >= CONFIG.URGENT_IMBALANCE) {
    position.state = 'urgent';
  } else if (imbalance > CONFIG.MAX_IMBALANCE) {
    position.state = 'need_down';
  } else if (imbalance < -CONFIG.MAX_IMBALANCE) {
    position.state = 'need_up';
  } else {
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
    // Already filled or cancelled
  }
}

async function placeOrder(
  market: Market,
  side: 'up' | 'down',
  price: number,
  size: number,
  orderType: 'GTC' | 'FOK' = 'GTC'
): Promise<string | undefined> {
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING || !clobClient) {
    log(`[DRY] ${side.toUpperCase()} ${orderType}: ${size} @ $${price.toFixed(2)}`, 'INFO');
    return undefined;
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
      log(`${side.toUpperCase()} ${orderType}: ${size} @ $${price.toFixed(2)} [${orderId.slice(0, 8)}]`, 'INFO');
    }
    return orderId;
  } catch (error: any) {
    log(`Order failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

async function sellOrder(
  market: Market,
  side: 'up' | 'down',
  price: number,
  size: number
): Promise<string | undefined> {
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING || !clobClient) {
    log(`[DRY] SELL ${side.toUpperCase()}: ${size} @ $${price.toFixed(2)}`, 'EXIT');
    return undefined;
  }

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price,
        side: Side.SELL,
        size: size,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`SELL ${side.toUpperCase()}: ${size} @ $${price.toFixed(2)}`, 'EXIT');
    }
    return orderId;
  } catch (error: any) {
    log(`Sell failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

// ============================================================================
// TRADING LOGIC
// ============================================================================

function getTotalExposure(): number {
  let total = 0;
  for (const [_, pos] of positions) {
    total += pos.upShares * pos.upAvgCost;
    total += pos.downShares * pos.downAvgCost;
  }
  return total;
}

async function processMarket(market: Market, position: Position): Promise<void> {
  // Cancel existing orders first
  await cancelOrder(position.upOrderId);
  await cancelOrder(position.downOrderId);
  position.upOrderId = undefined;
  position.downOrderId = undefined;

  // Check total exposure before placing new orders
  const totalExposure = getTotalExposure();
  if (totalExposure > CONFIG.MAX_TOTAL_DOLLARS && position.state === 'balanced') {
    log(`Total exposure $${totalExposure.toFixed(0)} > $${CONFIG.MAX_TOTAL_DOLLARS} limit - pausing new bids`, 'WARN');
    return;
  }

  switch (position.state) {
    case 'balanced':
      // Bid on both sides
      if (position.upShares < CONFIG.MAX_POSITION) {
        position.upOrderId = await placeOrder(market, 'up', position.currentUpBid, CONFIG.BID_SIZE);
      }
      await new Promise(r => setTimeout(r, 100));
      if (position.downShares < CONFIG.MAX_POSITION) {
        position.downOrderId = await placeOrder(market, 'down', position.currentDownBid, CONFIG.BID_SIZE);
      }
      break;

    case 'need_up':
      // Only bid UP
      const upPrice = Math.min(CONFIG.MAX_BID, position.currentUpBid + CONFIG.MATCH_SLIPPAGE);
      position.upOrderId = await placeOrder(market, 'up', upPrice, CONFIG.BID_SIZE);
      break;

    case 'need_down':
      // Only bid DOWN
      const downPrice = Math.min(CONFIG.MAX_BID, position.currentDownBid + CONFIG.MATCH_SLIPPAGE);
      position.downOrderId = await placeOrder(market, 'down', downPrice, CONFIG.BID_SIZE);
      break;

    case 'urgent':
      // Use aggressive GTC bid to match (FOK often fails due to no liquidity)
      const imbalance = position.upShares - position.downShares;
      if (imbalance > 0) {
        // Need DOWN urgently - bid aggressively
        const urgentPrice = Math.min(CONFIG.MAX_BID + 0.02, position.downBook.bestAsk - 0.01);
        position.downOrderId = await placeOrder(market, 'down', Math.max(0.40, urgentPrice), CONFIG.BID_SIZE, 'GTC');
        log(`URGENT: Need ${imbalance} DOWN - bidding $${urgentPrice.toFixed(2)}`, 'WARN');
      } else {
        // Need UP urgently
        const urgentPrice = Math.min(CONFIG.MAX_BID + 0.02, position.upBook.bestAsk - 0.01);
        position.upOrderId = await placeOrder(market, 'up', Math.max(0.40, urgentPrice), CONFIG.BID_SIZE, 'GTC');
        log(`URGENT: Need ${-imbalance} UP - bidding $${urgentPrice.toFixed(2)}`, 'WARN');
      }
      break;

    case 'exiting':
      // Sell unhedged position before expiry
      const exitImbalance = position.upShares - position.downShares;
      if (exitImbalance > 5) {
        // Sell excess UP
        const sellPrice = Math.max(0.01, position.upBook.bestBid - 0.02);
        await sellOrder(market, 'up', sellPrice, exitImbalance);
        log(`EXITING: Selling ${exitImbalance} excess UP before market closes`, 'EXIT');
      } else if (exitImbalance < -5) {
        // Sell excess DOWN
        const sellPrice = Math.max(0.01, position.downBook.bestBid - 0.02);
        await sellOrder(market, 'down', sellPrice, -exitImbalance);
        log(`EXITING: Selling ${-exitImbalance} excess DOWN before market closes`, 'EXIT');
      }
      break;
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.clear();

  const runtime = Math.floor((Date.now() - startTime) / 1000);
  const runtimeStr = `${Math.floor(runtime / 60)}m ${runtime % 60}s`;
  const totalExposure = getTotalExposure();
  const exposureColor = totalExposure > CONFIG.MAX_TOTAL_DOLLARS ? '\x1b[31m' : '\x1b[32m';

  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V5 - PRODUCTION                                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${CONFIG.ENABLE_TRADING ? '\x1b[32mLIVE TRADING\x1b[0m' : '\x1b[33mDRY RUN\x1b[0m'}  │  Runtime: ${runtimeStr}  │  Trades: ${totalTrades}`.padEnd(91) + '║');
  console.log(`║  Size: ${CONFIG.BID_SIZE}  │  Max Pos: ${CONFIG.MAX_POSITION}  │  ${exposureColor}Exposure: $${totalExposure.toFixed(0)}/$${CONFIG.MAX_TOTAL_DOLLARS}\x1b[0m`.padEnd(91) + '║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

function displayPosition(market: Market, position: Position): void {
  const stateColors: Record<string, string> = {
    balanced: '\x1b[32m',
    need_up: '\x1b[33m',
    need_down: '\x1b[33m',
    urgent: '\x1b[31m',
    exiting: '\x1b[35m',
  };
  const color = stateColors[position.state];
  const reset = '\x1b[0m';

  const imbalance = position.upShares - position.downShares;
  const hedged = Math.min(position.upShares, position.downShares);
  const name = market.question.slice(0, 55);

  // Time to expiry
  let expiryStr = '';
  if (market.endTime) {
    const ttl = market.endTime.getTime() - Date.now();
    if (ttl > 0) {
      const mins = Math.floor(ttl / 60000);
      const secs = Math.floor((ttl % 60000) / 1000);
      expiryStr = `Expires: ${mins}m ${secs}s`;
    } else {
      expiryStr = 'EXPIRED';
    }
  }

  console.log(`┌─────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${name.padEnd(55)} │ ${expiryStr.padEnd(20)} │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);

  // Position
  console.log(`│ Up: ${position.upShares.toString().padStart(3)} @ $${position.upAvgCost.toFixed(2)}  │  Down: ${position.downShares.toString().padStart(3)} @ $${position.downAvgCost.toFixed(2)}  │  Hedged: ${hedged}  │  ${color}Imbal: ${imbalance >= 0 ? '+' : ''}${imbalance}${reset}`.padEnd(89) + '│');

  // State and current bids
  const stateStr = {
    balanced: '✅ BALANCED',
    need_up: '⚠️  NEED UP',
    need_down: '⚠️  NEED DOWN',
    urgent: '🚨 URGENT',
    exiting: '🚪 EXITING',
  }[position.state];

  console.log(`│ ${color}${stateStr}${reset}  │  Bids: UP $${position.currentUpBid.toFixed(2)} / DOWN $${position.currentDownBid.toFixed(2)}  │  Combined: $${(position.currentUpBid + position.currentDownBid).toFixed(2)}`.padEnd(88) + '│');

  // P&L
  if (hedged > 0) {
    const cost = position.upAvgCost * hedged + position.downAvgCost * hedged;
    const profit = hedged - cost;
    const pct = ((hedged / cost - 1) * 100).toFixed(1);
    console.log(`│ Hedged P&L: $${profit.toFixed(2)} (${pct}%) on ${hedged} shares`.padEnd(80) + '│');
  }

  console.log(`└─────────────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketMaker(): Promise<void> {
  // Fetch our actual positions
  await fetchOurPositions();

  // Update order books and state
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;

    const [upBook, downBook] = await Promise.all([
      fetchOrderBook(market.upTokenId),
      fetchOrderBook(market.downTokenId),
    ]);

    position.upBook = upBook;
    position.downBook = downBook;

    // Update dynamic pricing
    updateDynamicPricing(position);

    // Calculate state
    calculateState(position, market);
  }

  // Display
  displayStatus();

  // Process each market
  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId)!;
    await processMarket(market, position);
    displayPosition(market, position);
  }

  console.log('');
  log(`Next refresh in ${CONFIG.REFRESH_INTERVAL_MS / 1000}s`);
}

// ============================================================================
// MARKET EXPIRY CHECK
// ============================================================================

async function checkMarketExpiry(): Promise<void> {
  const now = Date.now();

  for (const [conditionId, market] of markets) {
    if (!market.endTime) continue;

    const ttl = market.endTime.getTime() - now;

    // Remove expired markets
    if (ttl < 0) {
      log(`Removing expired market: ${market.question.slice(0, 40)}...`, 'INFO');
      markets.delete(conditionId);
      positions.delete(conditionId);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              MARKET MAKER V5 - PRODUCTION                                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                                  ║');
  console.log('║  FEATURES:                                                                       ║');
  console.log('║  • Competitive bid prices (~$0.47) to match target wallet                        ║');
  console.log('║  • Dynamic pricing: increases bid if no fills, decreases after fill              ║');
  console.log('║  • Market expiry handling: exits positions 2min before close                     ║');
  console.log('║  • Sequential matching: stops bidding on heavy side                              ║');
  console.log('║  • Urgent mode: crosses spread if imbalance critical                             ║');
  console.log('║                                                                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Trading: ${CONFIG.ENABLE_TRADING ? '\x1b[32mENABLED\x1b[0m' : '\x1b[33mDISABLED\x1b[0m'}                                                                 ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!CONFIG.ENABLE_TRADING) {
    log('Running in DRY RUN mode - no real orders', 'WARN');
  } else {
    log('LIVE TRADING ENABLED - Real orders will be placed!', 'WARN');
  }

  await loadClobClient();
  await initClobClient();

  log('Finding active markets...');
  const activeMarkets = await findActiveMarkets();
  log(`Found ${activeMarkets.length} active markets`);

  const now = Date.now();
  for (const market of activeMarkets) {
    markets.set(market.conditionId, market);
    positions.set(market.conditionId, {
      upShares: 0,
      downShares: 0,
      upAvgCost: 0,
      downAvgCost: 0,
      upBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
      downBook: { bestBid: 0, bestAsk: 1, lastUpdated: 0 },
      currentUpBid: CONFIG.BASE_BID_UP,
      currentDownBid: CONFIG.BASE_BID_DOWN,
      lastUpFill: now,
      lastDownFill: now,
      state: 'balanced',
    });

    const ttl = market.endTime ? Math.floor((market.endTime.getTime() - now) / 60000) : '?';
    log(`  - ${market.question} (expires in ${ttl}m)`);
  }

  if (markets.size === 0) {
    log('No active markets found', 'ERROR');
    process.exit(1);
  }

  // Initial run
  await runMarketMaker();

  // Main loop
  setInterval(runMarketMaker, CONFIG.REFRESH_INTERVAL_MS);

  // Market expiry check
  setInterval(checkMarketExpiry, CONFIG.EXPIRY_CHECK_MS);

  // Refresh market list
  setInterval(async () => {
    const newMarkets = await findActiveMarkets();
    const now = Date.now();
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
          currentUpBid: CONFIG.BASE_BID_UP,
          currentDownBid: CONFIG.BASE_BID_DOWN,
          lastUpFill: now,
          lastDownFill: now,
          state: 'balanced',
        });
        log(`Added new market: ${market.question}`);
      }
    }
  }, 45000);

  log('Market maker running. Press Ctrl+C to stop.');
}

main().catch(console.error);
