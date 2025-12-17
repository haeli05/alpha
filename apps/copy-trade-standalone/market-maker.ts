/**
 * POLYMARKET MARKET MAKER
 *
 * Provides liquidity on Up/Down markets by posting limit bids on both sides.
 * Profit comes from buying both sides at combined price < $1.00.
 *
 * STRATEGY:
 * 1. Post bids on Up and Down at prices where combined < $0.98
 * 2. Get filled by retail sellers over time
 * 3. Adjust prices based on inventory imbalance
 * 4. Hold to resolution, collect guaranteed profit
 *
 * USAGE: npx tsx market-maker.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Pricing
  TARGET_COMBINED: 0.96,      // Target combined price (4% profit margin)
  MIN_PROFIT_MARGIN: 0.02,    // Minimum 2 cents profit per pair
  BASE_UP_BID: 0.48,          // Starting Up bid
  BASE_DOWN_BID: 0.48,        // Starting Down bid

  // Order sizing
  ORDER_SIZE: 25,             // Shares per order
  MAX_POSITION: 500,          // Max shares per side per market
  MAX_IMBALANCE: 100,         // Max imbalance before aggressive rebalancing

  // Order management
  REFRESH_INTERVAL_MS: 30000, // Refresh orders every 30s
  PRICE_ADJUSTMENT: 0.02,     // Adjust price by 2 cents for imbalance

  // Trading
  ENABLE_TRADING: false,      // Set true to enable live trading
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';
const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

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
    log('No private key - running in monitor-only mode', 'WARN');
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
  endDate: Date;
}

interface Position {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upOrders: string[];   // Active order IDs
  downOrders: string[]; // Active order IDs
}

interface OrderBook {
  upBestBid: number;
  upBestAsk: number;
  downBestBid: number;
  downBestAsk: number;
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();
const orderBooks: Map<string, OrderBook> = new Map();

let totalFills = 0;
let totalPnL = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'ORDER' | 'FILL' | 'PNL' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    ORDER: '📝',
    FILL: '💰',
    PNL: '📊'
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
    // Get markets from target wallet's activity
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

      // Parse end date (note: end_date_iso may be inaccurate on Polymarket)
      const endDate = new Date(data.end_date_iso);
      // Don't filter by end date - the closed flag is more reliable

      result.push({
        conditionId,
        question: data.question,
        upTokenId: upToken.token_id,
        downTokenId: downToken.token_id,
        tickSize: data.tick_size || '0.01',
        negRisk: data.neg_risk || false,
        endDate,
      });

      await new Promise(r => setTimeout(r, 50));
    }
  } catch (error: any) {
    log(`Error finding markets: ${error.message}`, 'ERROR');
  }

  return result;
}

// ============================================================================
// ORDER BOOK MONITORING
// ============================================================================

async function fetchOrderBook(market: Market): Promise<OrderBook | null> {
  try {
    const [upRes, downRes] = await Promise.all([
      fetch(`${CLOB_HOST}/book?token_id=${market.upTokenId}`),
      fetch(`${CLOB_HOST}/book?token_id=${market.downTokenId}`),
    ]);

    const upBook = await upRes.json();
    const downBook = await downRes.json();

    return {
      upBestBid: upBook.bids?.[0]?.price ? parseFloat(upBook.bids[0].price) : 0,
      upBestAsk: upBook.asks?.[0]?.price ? parseFloat(upBook.asks[0].price) : 1,
      downBestBid: downBook.bids?.[0]?.price ? parseFloat(downBook.bids[0].price) : 0,
      downBestAsk: downBook.asks?.[0]?.price ? parseFloat(downBook.asks[0].price) : 1,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// PRICING LOGIC
// ============================================================================

function calculateBidPrices(market: Market, position: Position, book: OrderBook): { upBid: number; downBid: number } {
  let upBid = CONFIG.BASE_UP_BID;
  let downBid = CONFIG.BASE_DOWN_BID;

  // Adjust for inventory imbalance
  const imbalance = position.upShares - position.downShares;

  if (Math.abs(imbalance) > CONFIG.MAX_IMBALANCE) {
    // Aggressive rebalancing needed
    if (imbalance > 0) {
      // Too much Up, need Down
      upBid -= CONFIG.PRICE_ADJUSTMENT * 2;
      downBid += CONFIG.PRICE_ADJUSTMENT * 2;
    } else {
      // Too much Down, need Up
      upBid += CONFIG.PRICE_ADJUSTMENT * 2;
      downBid -= CONFIG.PRICE_ADJUSTMENT * 2;
    }
  } else if (Math.abs(imbalance) > 30) {
    // Mild rebalancing
    if (imbalance > 0) {
      upBid -= CONFIG.PRICE_ADJUSTMENT;
      downBid += CONFIG.PRICE_ADJUSTMENT;
    } else {
      upBid += CONFIG.PRICE_ADJUSTMENT;
      downBid -= CONFIG.PRICE_ADJUSTMENT;
    }
  }

  // Ensure combined price maintains profit margin
  const combined = upBid + downBid;
  if (combined > (1 - CONFIG.MIN_PROFIT_MARGIN)) {
    const adjustment = (combined - (1 - CONFIG.MIN_PROFIT_MARGIN)) / 2;
    upBid -= adjustment;
    downBid -= adjustment;
  }

  // Don't bid higher than current best ask minus spread
  upBid = Math.min(upBid, book.upBestAsk - 0.02);
  downBid = Math.min(downBid, book.downBestAsk - 0.02);

  // Don't bid below minimum
  upBid = Math.max(upBid, 0.10);
  downBid = Math.max(downBid, 0.10);

  // Round to tick size
  upBid = Math.round(upBid * 100) / 100;
  downBid = Math.round(downBid * 100) / 100;

  return { upBid, downBid };
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function cancelAllOrders(market: Market, position: Position): Promise<void> {
  if (!clobClient) return;

  const allOrderIds = [...position.upOrders, ...position.downOrders];

  for (const orderId of allOrderIds) {
    try {
      await clobClient.cancelOrder({ orderID: orderId });
      log(`Cancelled order ${orderId.slice(0, 16)}...`, 'ORDER');
    } catch {
      // Order may already be filled or cancelled
    }
  }

  position.upOrders = [];
  position.downOrders = [];
}

async function placeOrders(market: Market, position: Position, upBid: number, downBid: number): Promise<void> {
  if (!clobClient || !CONFIG.ENABLE_TRADING) {
    log(`[DRY RUN] Would place: Up bid $${upBid.toFixed(2)}, Down bid $${downBid.toFixed(2)}`, 'ORDER');
    return;
  }

  // Check position limits
  if (position.upShares >= CONFIG.MAX_POSITION) {
    log(`Max Up position reached (${position.upShares}), skipping Up bid`, 'WARN');
  } else {
    try {
      const upResult = await clobClient.createAndPostOrder(
        {
          tokenID: market.upTokenId,
          price: upBid,
          side: Side.BUY,
          size: CONFIG.ORDER_SIZE,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC
      );

      const upOrderId = upResult?.order_id || upResult?.orderID;
      if (upOrderId) {
        position.upOrders.push(upOrderId);
        log(`Placed Up bid: ${CONFIG.ORDER_SIZE} @ $${upBid.toFixed(2)} (${upOrderId.slice(0, 16)}...)`, 'ORDER');
      }
    } catch (error: any) {
      log(`Failed to place Up bid: ${error.message}`, 'ERROR');
    }
  }

  if (position.downShares >= CONFIG.MAX_POSITION) {
    log(`Max Down position reached (${position.downShares}), skipping Down bid`, 'WARN');
  } else {
    try {
      const downResult = await clobClient.createAndPostOrder(
        {
          tokenID: market.downTokenId,
          price: downBid,
          side: Side.BUY,
          size: CONFIG.ORDER_SIZE,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC
      );

      const downOrderId = downResult?.order_id || downResult?.orderID;
      if (downOrderId) {
        position.downOrders.push(downOrderId);
        log(`Placed Down bid: ${CONFIG.ORDER_SIZE} @ $${downBid.toFixed(2)} (${downOrderId.slice(0, 16)}...)`, 'ORDER');
      }
    } catch (error: any) {
      log(`Failed to place Down bid: ${error.message}`, 'ERROR');
    }
  }
}

// ============================================================================
// FILL MONITORING
// ============================================================================

async function checkFills(market: Market, position: Position): Promise<void> {
  if (!clobClient) return;

  try {
    // Check our recent trades
    const trades = await clobClient.getTrades({ market: market.conditionId });

    // Process fills (this is simplified - in production you'd track order states)
    // For now we'll poll the position via the data API
  } catch {
    // Ignore errors
  }
}

async function updatePositionFromTrades(market: Market, position: Position): Promise<void> {
  // In a real implementation, you'd track fills from order status
  // For now, this is a placeholder that would be filled in with proper fill tracking
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(`MARKET MAKER | Markets: ${markets.size} | Fills: ${totalFills} | Mode: ${CONFIG.ENABLE_TRADING ? 'LIVE' : 'DRY RUN'}`);
  console.log('═'.repeat(100));

  for (const [conditionId, market] of markets) {
    const position = positions.get(conditionId) || { upShares: 0, downShares: 0, upCost: 0, downCost: 0, upOrders: [], downOrders: [] };
    const book = orderBooks.get(conditionId);

    const question = market.question.slice(0, 45).padEnd(45);
    const minsLeft = Math.max(0, (market.endDate.getTime() - Date.now()) / 60000).toFixed(0);

    // Calculate current prices
    const { upBid, downBid } = book
      ? calculateBidPrices(market, position, book)
      : { upBid: CONFIG.BASE_UP_BID, downBid: CONFIG.BASE_DOWN_BID };

    const combined = upBid + downBid;
    const profitPct = ((1 - combined) * 100).toFixed(1);

    console.log(`${question} | ${minsLeft}min left`);
    console.log(`  Bids: Up $${upBid.toFixed(2)} + Down $${downBid.toFixed(2)} = $${combined.toFixed(2)} (${profitPct}% margin)`);

    // Position info
    if (position.upShares > 0 || position.downShares > 0) {
      const hedged = Math.min(position.upShares, position.downShares);
      const imbalance = position.upShares - position.downShares;
      const avgUp = position.upShares > 0 ? position.upCost / position.upShares : 0;
      const avgDown = position.downShares > 0 ? position.downCost / position.downShares : 0;
      const combinedCost = avgUp + avgDown;
      const expectedProfit = hedged * (1 - combinedCost);

      console.log(`  Position: Up ${position.upShares} @ $${avgUp.toFixed(2)} | Down ${position.downShares} @ $${avgDown.toFixed(2)}`);
      console.log(`  Hedged: ${hedged} pairs | Imbalance: ${imbalance > 0 ? '+' : ''}${imbalance} | Expected P&L: $${expectedProfit.toFixed(2)}`);
    } else {
      console.log(`  Position: None`);
    }

    console.log(`  Active Orders: ${position.upOrders.length} Up, ${position.downOrders.length} Down`);
    console.log('');
  }

  console.log('═'.repeat(100));
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketMaker(): Promise<void> {
  for (const [conditionId, market] of markets) {
    // Note: We rely on the closed flag during discovery, not endDate here

    // Get or create position
    let position = positions.get(conditionId);
    if (!position) {
      position = { upShares: 0, downShares: 0, upCost: 0, downCost: 0, upOrders: [], downOrders: [] };
      positions.set(conditionId, position);
    }

    // Fetch order book
    const book = await fetchOrderBook(market);
    if (!book) continue;
    orderBooks.set(conditionId, book);

    // Calculate bid prices
    const { upBid, downBid } = calculateBidPrices(market, position, book);

    log(`${market.question.slice(0, 40)}...`, 'INFO');
    log(`  Target: Up $${upBid.toFixed(2)} + Down $${downBid.toFixed(2)} = $${(upBid + downBid).toFixed(2)}`, 'INFO');
    log(`  Book: Up bid/ask $${book.upBestBid.toFixed(2)}/$${book.upBestAsk.toFixed(2)} | Down $${book.downBestBid.toFixed(2)}/$${book.downBestAsk.toFixed(2)}`, 'INFO');

    // Cancel existing orders and place new ones
    await cancelAllOrders(market, position);
    await placeOrders(market, position, upBid, downBid);

    // Small delay between markets
    await new Promise(r => setTimeout(r, 200));
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        POLYMARKET MARKET MAKER                                 ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Target Combined:  $${CONFIG.TARGET_COMBINED.toFixed(2)} (${((1 - CONFIG.TARGET_COMBINED) * 100).toFixed(0)}% profit target)                            ║`);
  console.log(`║  Order Size:       ${CONFIG.ORDER_SIZE} shares                                                  ║`);
  console.log(`║  Max Position:     ${CONFIG.MAX_POSITION} shares per side                                       ║`);
  console.log(`║  Refresh:          Every ${CONFIG.REFRESH_INTERVAL_MS / 1000}s                                                  ║`);
  console.log(`║  Trading:          ${CONFIG.ENABLE_TRADING ? 'ENABLED' : 'DISABLED (monitor only)'}                                          ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load CLOB client
  log('Loading CLOB client...');
  const loaded = await loadClobClient();
  if (!loaded) {
    log('Failed to load CLOB client', 'ERROR');
    process.exit(1);
  }

  // Initialize client for trading
  if (CONFIG.ENABLE_TRADING) {
    await initClobClient();
  }

  // Find active markets
  log('Finding active Up/Down markets...');
  const activeMarkets = await findActiveMarkets();
  log(`Found ${activeMarkets.length} active markets`);

  for (const market of activeMarkets) {
    markets.set(market.conditionId, market);
    const minsLeft = Math.max(0, (market.endDate.getTime() - Date.now()) / 60000).toFixed(0);
    log(`  - ${market.question} (${minsLeft}min left)`);
  }

  if (markets.size === 0) {
    log('No active markets found', 'ERROR');
    process.exit(1);
  }

  // Initial run
  log('Starting market maker...');
  await runMarketMaker();
  displayStatus();

  // Main loop
  setInterval(async () => {
    await runMarketMaker();
    displayStatus();
  }, CONFIG.REFRESH_INTERVAL_MS);

  // Refresh markets periodically
  setInterval(async () => {
    log('Refreshing market list...');
    const newMarkets = await findActiveMarkets();

    for (const market of newMarkets) {
      if (!markets.has(market.conditionId)) {
        markets.set(market.conditionId, market);
        log(`Added market: ${market.question}`);
      }
    }

    // Remove expired markets
    for (const [conditionId, market] of markets) {
      if (market.endDate < new Date()) {
        // Calculate final P&L for this market
        const position = positions.get(conditionId);
        if (position) {
          const hedged = Math.min(position.upShares, position.downShares);
          const avgUp = position.upShares > 0 ? position.upCost / position.upShares : 0;
          const avgDown = position.downShares > 0 ? position.downCost / position.downShares : 0;
          const profit = hedged * (1 - avgUp - avgDown);
          totalPnL += profit;
          log(`Market resolved: ${market.question.slice(0, 40)} | P&L: $${profit.toFixed(2)}`, 'PNL');
        }

        markets.delete(conditionId);
        positions.delete(conditionId);
        orderBooks.delete(conditionId);
      }
    }
  }, 60000);

  log('Market maker running. Press Ctrl+C to stop.');
}

main().catch(console.error);
