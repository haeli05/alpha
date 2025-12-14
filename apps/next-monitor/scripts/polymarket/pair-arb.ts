/**
 * ============================================================================
 * POLYMARKET PAIR ARBITRAGE STRATEGY
 * ============================================================================
 *
 * STRATEGY OVERVIEW:
 * -----------------
 * 1. Monitor a Bitcoin up/down prediction market on Polymarket
 * 2. Execute hedge trade when trailing stop triggers:
 *    - Option A (YES_FIRST): Buy YES first, then sell NO
 *    - Option B (NO_FIRST): Buy NO first, then sell YES
 * 3. Trailing stop monitors the first token price
 * 4. When triggered, buy first token and immediately sell second token
 * 5. Wait for second order to execute, then repeat
 *
 * USAGE:
 * ------
 * npx tsx scripts/polymarket/pair-arb.ts
 *
 * REQUIRED ENV VARS:
 * ------------------
 * POLYMARKET_API_KEY
 * POLYMARKET_SECRET
 * POLYMARKET_PASSPHRASE
 * POLYMARKET_PRIVATE_KEY (for real trading)
 *
 * ============================================================================
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env.local file (Next.js convention)
dotenv.config({ path: resolve(process.cwd(), '.env.local') });
// Also try .env as fallback
dotenv.config({ path: resolve(process.cwd(), '.env') });

import crypto from 'crypto';
import WebSocket from 'ws';
import { addTrade, updateTrade, getTrades, cancelPendingTradesForMarket, getPartiallyFilledTrades, areAllTradesFullyHedged, isYesFirstFullyHedged, isNoFirstFullyHedged, markHedgeFilled, getTotalPnL } from '../../lib/pairArbStore';
import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// WEBSOCKET CONFIGURATION
// ============================================================================

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Real-time price state (updated by WebSocket)
interface PriceState {
  yesPrice: number;
  noPrice: number;
  yesBestBid: number;
  yesBestAsk: number;
  noBestBid: number;
  noBestAsk: number;
  lastUpdate: number;
}

let priceState: PriceState = {
  yesPrice: 0,
  noPrice: 0,
  yesBestBid: 0,
  yesBestAsk: 0,
  noBestBid: 0,
  noBestAsk: 0,
  lastUpdate: 0,
};

let wsConnection: WebSocket | null = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;

// Dynamic import for ClobClient to handle build issues
let ClobClient: any;
let OrderType: any;
let Side: any;

async function loadClobClient(): Promise<boolean> {
  try {
    // @ts-ignore - Module may not be built
    const clobModule = await import('@polymarket/clob-client');
    
    // Direct exports (not default export)
    ClobClient = clobModule.ClobClient;
    OrderType = clobModule.OrderType;
    Side = clobModule.Side;
    
    // Verify exports
    if (!ClobClient || typeof ClobClient !== 'function') {
      throw new Error(`ClobClient is not a constructor. Type: ${typeof ClobClient}, Available keys: ${Object.keys(clobModule).join(', ')}`);
    }
    
    if (!OrderType) {
      throw new Error(`OrderType not found. Available keys: ${Object.keys(clobModule).join(', ')}`);
    }
    
    if (!Side) {
      throw new Error(`Side not found. Available keys: ${Object.keys(clobModule).join(', ')}`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to load @polymarket/clob-client: ${error}`);
    console.error('   The package may need to be built. Try:');
    console.error('   1. cd node_modules/@polymarket/clob-client');
    console.error('   2. npm install');
    console.error('   3. npm run build');
    return false;
  }
}

// ============================================================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================================================

/**
 * USE_DYNAMIC_MARKET: If true, automatically generates market slug for next hour
 * If false, uses fixed MARKET_SLUG below
 */
const USE_DYNAMIC_MARKET = true;

/**
 * MARKET_SLUG: Fixed market slug (only used if USE_DYNAMIC_MARKET is false)
 * Find this in the URL: polymarket.com/event/{MARKET_SLUG}
 *
 * Examples:
 * - 'bitcoin-up-or-down-december-11-3am-et'
 * - 'bitcoin-above-100000-on-december-31'
 */
const MARKET_SLUG: string | null = 'bitcoin-up-or-down-december-11-3am-et';

/**
 * MARKET_REFRESH_INTERVAL_MS: How often to refresh the market slug (milliseconds)
 * Set to 0 to only refresh once at startup
 * Recommended: 5-10 minutes (markets update hourly)
 */
const MARKET_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * TRAILING_STOP_CENTS: Trailing stop distance in cents
 * When price drops by this amount from peak, execute buy
 */
const TRAILING_STOP_CENTS = 0.02; // 2 cents

/**
 * TARGET_SPREAD_CENTS: Target profit spread in cents
 * Hedge leg is placed at (1 - firstPrice - spread) to capture this profit
 */
const TARGET_SPREAD_CENTS = 0.05; // 5 cents profit target

/**
 * SHARE_SIZE: Number of shares to trade per leg (YES and NO)
 * Set to 5 for standardized position sizing
 */
const DEFAULT_SHARE_SIZE = 5; // 5 shares per leg
const SHARE_SIZE = parseFloat(process.env.PAIR_ARB_SHARE_SIZE || '') || DEFAULT_SHARE_SIZE;

/**
 * TRADE_MODE: Trading mode
 * - 'SINGLE': Trade one direction only (YES_FIRST or NO_FIRST)
 * - 'DUAL': Trade both YES_FIRST and NO_FIRST simultaneously
 */
const TRADE_MODE: 'SINGLE' | 'DUAL' = 'DUAL';

/**
 * TRADE_DIRECTION: Which token to buy first (only used if TRADE_MODE is 'SINGLE')
 * - 'YES_FIRST': Buy YES first, then sell NO (default)
 * - 'NO_FIRST': Buy NO first, then sell YES
 */
const TRADE_DIRECTION: 'YES_FIRST' | 'NO_FIRST' = 'YES_FIRST';

/**
 * LOOP_INTERVAL_MS: Time between strategy cycles (milliseconds)
 */
const LOOP_INTERVAL_MS = 1000; // 1 second

/**
 * MAX_LOSS_USD: Stop trading if total profit drops below this threshold
 * Set to negative value (e.g., -10 means stop if we lose $10)
 * Set to null to disable stop loss
 */
const MAX_LOSS_USD: number | null = -10; // Stop if we lose $10

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface Token {
  token_id: string;
  outcome: string;
  price?: number;
}

interface Market {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  liquidity: number;
  volume: number;
  active: boolean;
  closed: boolean;
  endDate?: string; // Market expiration date
}

interface OrderBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

interface TradeState {
  inPosition: boolean;
  firstEntryPrice: number | null; // Price of first token (YES or NO depending on direction)
  secondOrderPrice: number | null; // Price of second token (NO or YES depending on direction)
  peakPrice: number;
  trailingStopTriggered: boolean;
  tradeId?: string; // ID of the trade pair in the store
}

interface DualTradeState {
  yesFirstState: TradeState; // State for YES_FIRST trades
  noFirstState: TradeState; // State for NO_FIRST trades
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * log: Prints timestamped message to console
 * @param message - Message to log
 * @param level - Log level (INFO, WARN, ERROR, TRADE)
 */
function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    TRADE: '💰',
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

/**
 * sleep: Pause execution for specified milliseconds
 * @param ms - Milliseconds to sleep
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// WEBSOCKET FUNCTIONS
// ============================================================================

let currentYesTokenId: string = '';
let currentNoTokenId: string = '';

/**
 * Connect to Polymarket WebSocket for real-time price updates
 */
function connectWebSocket(yesTokenId: string, noTokenId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    currentYesTokenId = yesTokenId;
    currentNoTokenId = noTokenId;

    log(`🔌 Connecting to WebSocket...`, 'INFO');
    log(`   YES Token: ${yesTokenId.slice(0, 20)}...`, 'INFO');
    log(`   NO Token:  ${noTokenId.slice(0, 20)}...`, 'INFO');

    wsConnection = new WebSocket(WS_URL);

    wsConnection.on('open', () => {
      log(`✅ WebSocket connected!`, 'INFO');
      wsReconnectAttempts = 0;

      // Subscribe to both token price updates
      const subscribeMsg = {
        assets_ids: [yesTokenId, noTokenId],
        type: 'market',
      };

      wsConnection?.send(JSON.stringify(subscribeMsg));
      log(`📡 Subscribed to price updates for YES and NO tokens`, 'INFO');

      // Start ping interval to keep connection alive
      const pingInterval = setInterval(() => {
        if (wsConnection?.readyState === WebSocket.OPEN) {
          wsConnection.send('PING');
        } else {
          clearInterval(pingInterval);
        }
      }, 10000);

      resolve();
    });

    wsConnection.on('message', (data: WebSocket.Data) => {
      try {
        const message = data.toString();

        // Ignore PONG responses
        if (message === 'PONG') return;

        const parsed = JSON.parse(message);
        handleWebSocketMessage(parsed);
      } catch (error) {
        // Ignore parse errors for non-JSON messages
      }
    });

    wsConnection.on('error', (error) => {
      log(`WebSocket error: ${error.message}`, 'ERROR');
    });

    wsConnection.on('close', () => {
      log(`WebSocket disconnected`, 'WARN');

      // Attempt reconnection
      if (wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        wsReconnectAttempts++;
        log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (attempt ${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, 'INFO');
        setTimeout(() => {
          connectWebSocket(currentYesTokenId, currentNoTokenId).catch(() => {});
        }, RECONNECT_DELAY_MS);
      } else {
        log(`Max reconnection attempts reached. Falling back to REST API.`, 'ERROR');
      }
    });

    // Timeout if connection takes too long
    setTimeout(() => {
      if (wsConnection?.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket connection timeout'));
      }
    }, 10000);
  });
}

/**
 * Handle incoming WebSocket messages
 */
function handleWebSocketMessage(message: any): void {
  const eventType = message.event_type;

  if (eventType === 'book') {
    // Initial order book snapshot
    handleBookMessage(message);
  } else if (eventType === 'price_change') {
    // Price update
    handlePriceChangeMessage(message);
  } else if (eventType === 'last_trade_price') {
    // Trade executed
    handleLastTradePriceMessage(message);
  }
}

/**
 * Handle book (order book snapshot) message
 */
function handleBookMessage(message: any): void {
  const assetId = message.asset_id;
  const bids = message.bids || [];
  const asks = message.asks || [];

  // Get best bid and ask
  const bestBid = bids.length > 0 ? parseFloat(bids[0].price || bids[0][1] || '0') : 0;
  const bestAsk = asks.length > 0 ? parseFloat(asks[0].price || asks[0][1] || '1') : 1;
  const midPrice = (bestBid + bestAsk) / 2;

  if (assetId === currentYesTokenId) {
    priceState.yesPrice = midPrice;
    priceState.yesBestBid = bestBid;
    priceState.yesBestAsk = bestAsk;
  } else if (assetId === currentNoTokenId) {
    priceState.noPrice = midPrice;
    priceState.noBestBid = bestBid;
    priceState.noBestAsk = bestAsk;
  }

  priceState.lastUpdate = Date.now();
}

/**
 * Handle price_change message
 */
function handlePriceChangeMessage(message: any): void {
  const changes = message.price_changes || [];

  for (const change of changes) {
    const assetId = change.asset_id;
    const bestBid = parseFloat(change.best_bid || '0');
    const bestAsk = parseFloat(change.best_ask || '1');
    const midPrice = (bestBid + bestAsk) / 2;

    if (assetId === currentYesTokenId) {
      priceState.yesPrice = midPrice;
      priceState.yesBestBid = bestBid;
      priceState.yesBestAsk = bestAsk;
    } else if (assetId === currentNoTokenId) {
      priceState.noPrice = midPrice;
      priceState.noBestBid = bestBid;
      priceState.noBestAsk = bestAsk;
    }
  }

  priceState.lastUpdate = Date.now();
}

/**
 * Handle last_trade_price message
 */
function handleLastTradePriceMessage(message: any): void {
  const assetId = message.asset_id;
  const price = parseFloat(message.price || '0');

  if (assetId === currentYesTokenId && price > 0) {
    priceState.yesPrice = price;
  } else if (assetId === currentNoTokenId && price > 0) {
    priceState.noPrice = price;
  }

  priceState.lastUpdate = Date.now();
}

/**
 * Get current prices from WebSocket state (or fallback to REST API)
 */
async function getCurrentPrices(yesTokenId: string, noTokenId: string): Promise<{ yesPrice: number; noPrice: number }> {
  // If WebSocket has recent data (within 5 seconds), use it
  const isRecent = Date.now() - priceState.lastUpdate < 5000;

  if (isRecent && priceState.yesPrice > 0 && priceState.noPrice > 0) {
    return {
      yesPrice: priceState.yesPrice,
      noPrice: priceState.noPrice,
    };
  }

  // Fallback to REST API
  try {
    const [yesPrice, noPrice] = await Promise.all([
      getMidpoint(yesTokenId),
      getMidpoint(noTokenId),
    ]);

    // Update state
    priceState.yesPrice = yesPrice;
    priceState.noPrice = noPrice;
    priceState.lastUpdate = Date.now();

    return { yesPrice, noPrice };
  } catch (error) {
    // Return last known prices if REST also fails
    if (priceState.yesPrice > 0 && priceState.noPrice > 0) {
      return {
        yesPrice: priceState.yesPrice,
        noPrice: priceState.noPrice,
      };
    }
    throw error;
  }
}

/**
 * Close WebSocket connection
 */
function closeWebSocket(): void {
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
}

/**
 * displayTradePairsTable: Display a table of all trade pairs
 * @param currentMarketSlug - Current market being traded (optional)
 */
function displayTradePairsTable(currentMarketSlug?: string) {
  const trades = getTrades({ limit: 20 }); // Get last 20 trades
  const openTrades = trades.filter(t => t.status === 'open');
  
  // Table header with current market info
  console.log('┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│                                        TRADE PAIRS TABLE                                                    │');
  if (currentMarketSlug) {
    const marketDisplay = currentMarketSlug.length > 80 ? currentMarketSlug.slice(0, 77) + '...' : currentMarketSlug;
    console.log(`│  Market: ${marketDisplay.padEnd(102)} │`);
    const polymarketUrl = `https://polymarket.com/event/${currentMarketSlug}`;
    console.log(`│  URL: ${polymarketUrl.padEnd(106)} │`);
  }
  console.log('├──────────┬──────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────┤');
  console.log('│   ID     │      Market           │  YES Price   │  NO Price    │ YES Executed │ NO Executed  │    Status    │ Size │');
  console.log('├──────────┼──────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────┤');
  
  if (trades.length === 0) {
    console.log('│  No trades yet                                                                                              │');
    console.log('└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘');
    return;
  }
  
  // Display trades (most recent first, limit to 10 for readability)
  const displayTrades = trades.slice(0, 10);
  for (const trade of displayTrades) {
    const id = trade.id.slice(-6); // Last 6 chars of ID
    const market = trade.marketSlug.length > 20 ? trade.marketSlug.slice(0, 17) + '...' : trade.marketSlug;
    const yesPrice = `$${trade.yesPrice.toFixed(4)}`;
    const noPrice = `$${trade.noPrice.toFixed(4)}`;
    const yesExecuted = trade.yesFilledAt ? '✅ YES' : '⏳ Pending';
    const noExecuted = trade.noFilledAt ? '✅ YES' : '⏳ Pending';
    const status = trade.status.toUpperCase().padEnd(10);
    const size = trade.size.toString();
    
    // Color status
    let statusDisplay = status;
    if (trade.status === 'filled') {
      statusDisplay = `✅ ${status}`;
    } else if (trade.status === 'open') {
      statusDisplay = `🟡 ${status}`;
    } else if (trade.status === 'failed' || trade.status === 'cancelled') {
      statusDisplay = `❌ ${status}`;
    }
    
    // Highlight current market
    const marketDisplay = (currentMarketSlug && trade.marketSlug === currentMarketSlug) 
      ? `▶ ${market}`.padEnd(20)
      : market.padEnd(20);
    
    console.log(
      `│ ${id.padEnd(8)} │ ${marketDisplay} │ ${yesPrice.padEnd(12)} │ ${noPrice.padEnd(12)} │ ${yesExecuted.padEnd(12)} │ ${noExecuted.padEnd(12)} │ ${statusDisplay.padEnd(12)} │ ${size.padEnd(4)} │`
    );
  }
  
  console.log('├──────────┴──────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────┤');
  console.log(`│  Total Trades: ${trades.length}  │  Open: ${openTrades.length}  │  Filled: ${trades.filter(t => t.status === 'filled').length}  │`);
  console.log('└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘');
}

// ============================================================================
// MARKET SLUG GENERATION
// ============================================================================

/**
 * generateNextHourMarketSlug: Generate market slug for the next hour
 * Format: bitcoin-up-or-down-{month}-{day}-{hour}{am/pm}-et
 * 
 * @returns Market slug for the next hour in ET timezone
 */
function generateNextHourMarketSlug(): string {
  const now = new Date();
  
  // Approximate ET offset (EST = UTC-5, EDT = UTC-4)
  // EDT roughly Mar-Nov (months 2-10), EST otherwise
  const month = now.getUTCMonth();
  const isDST = month >= 2 && month <= 10; // Mar-Nov is roughly EDT
  const etOffsetHours = isDST ? 4 : 5;
  
  // Get current ET time
  const etTime = new Date(now.getTime() - (etOffsetHours * 60 * 60 * 1000));
  
  // Get next hour in ET
  const nextHourET = new Date(etTime);
  // Use current hour (market "8pm" runs 8pm-9pm, ends at 9pm)
  nextHourET.setUTCMinutes(0);
  nextHourET.setUTCSeconds(0);
  nextHourET.setUTCMilliseconds(0);
  
  // Format components
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  
  const monthName = monthNames[nextHourET.getUTCMonth()];
  const day = nextHourET.getUTCDate();
  let etHour = nextHourET.getUTCHours();
  
  // Convert to 12-hour format with am/pm
  const period = etHour >= 12 ? 'pm' : 'am';
  let hour12 = etHour % 12;
  if (hour12 === 0) hour12 = 12;
  
  // Generate slug
  const slug = `bitcoin-up-or-down-${monthName}-${day}-${hour12}${period}-et`;
  
  return slug;
}

// ============================================================================
// POLYMARKET API FUNCTIONS
// ============================================================================

/**
 * getMarketBySlug: Fetch market info from Polymarket Gamma API
 *
 * @param slug - Market slug from URL
 * @returns Market data
 */
async function getMarketBySlug(slug: string): Promise<Market> {
  // Remove query parameters if present
  const cleanSlug = slug.split('?')[0];
  log(`Fetching market: ${cleanSlug}`);

  const res = await fetch(`${GAMMA_HOST}/markets/slug/${cleanSlug}`);
  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to fetch market: ${res.status} - ${errorText}`);
  }

  const market = await res.json();
  log(`Market found: "${market.question}"`);
  return market;
}

/**
 * getClobMarket: Fetch market tokens from CLOB API
 *
 * NOTE: Gamma API doesn't include token IDs, must use CLOB API
 *
 * @param conditionId - Market condition ID
 * @returns Market with tokens
 */
async function getClobMarket(conditionId: string): Promise<{ tokens: Token[] }> {
  log(`Fetching CLOB market: ${conditionId.slice(0, 20)}...`);

  const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch CLOB market: ${res.status}`);
  }

  const data = await res.json();
  log(`Found ${data.tokens?.length || 0} tokens`);
  return data;
}

/**
 * checkOrderFilled: Check if an order has been filled via CLOB API
 *
 * @param clobClient - CLOB client instance
 * @param orderId - Order ID to check
 * @returns { filled: boolean, sizeMatched: number }
 */
async function checkOrderFilled(
  clobClient: any,
  orderId: string
): Promise<{ filled: boolean; sizeMatched: number }> {
  try {
    const order = await clobClient.getOrder(orderId);
    if (!order) {
      return { filled: false, sizeMatched: 0 };
    }

    const sizeMatched = parseFloat(order.size_matched || order.sizeMatched || '0');
    const originalSize = parseFloat(order.original_size || order.size || '1');

    // Consider filled if at least 95% matched (to handle rounding)
    const filled = sizeMatched >= originalSize * 0.95;

    return { filled, sizeMatched };
  } catch (error) {
    // If order not found, it might have been filled and removed
    return { filled: false, sizeMatched: 0 };
  }
}

/**
 * checkAndUpdatePendingHedges: Check all pending hedge orders and update when filled
 *
 * @param clobClient - CLOB client instance
 * @param marketSlug - Current market slug
 * @returns Number of hedges that were filled
 */
async function checkAndUpdatePendingHedges(
  clobClient: any,
  marketSlug: string
): Promise<number> {
  const partialTrades = getPartiallyFilledTrades(marketSlug);

  if (partialTrades.length === 0) {
    return 0;
  }

  log(`Checking ${partialTrades.length} pending hedge order(s)...`, 'INFO');

  let filledCount = 0;

  for (const trade of partialTrades) {
    // Determine which side is pending
    const pendingSide = trade.yesFilledAt ? 'no' : 'yes';
    const pendingOrderId = pendingSide === 'yes' ? trade.yesOrderId : trade.noOrderId;
    const pendingTokenId = pendingSide === 'yes' ? trade.yesTokenId : trade.noTokenId;
    const pendingPrice = pendingSide === 'yes' ? trade.yesPrice : trade.noPrice;

    // If we have an order ID, check it directly
    if (pendingOrderId) {
      try {
        const { filled, sizeMatched } = await checkOrderFilled(clobClient, pendingOrderId);

        if (filled) {
          log(`✅ HEDGE FILLED: Trade ${trade.id.slice(-6)} ${pendingSide.toUpperCase()} leg filled (${sizeMatched} shares)`, 'TRADE');
          markHedgeFilled(trade.id, pendingSide);
          filledCount++;
        } else {
          log(`⏳ Trade ${trade.id.slice(-6)} ${pendingSide.toUpperCase()} hedge still pending`, 'INFO');
        }
      } catch (error) {
        log(`Error checking order ${pendingOrderId}: ${error}`, 'WARN');
      }
    } else {
      // No order ID - try to find by checking open orders for this token/price
      log(`Trade ${trade.id.slice(-6)} missing ${pendingSide} order ID - checking open orders...`, 'WARN');

      try {
        // Get all open orders
        const openOrders = await clobClient.getOpenOrders();

        if (openOrders && Array.isArray(openOrders)) {
          // Look for an order matching this token and approximate price
          const matchingOrder = openOrders.find((o: any) => {
            const orderToken = o.asset_id || o.token_id;
            const orderPrice = parseFloat(o.price || '0');
            const priceMatch = Math.abs(orderPrice - pendingPrice) < 0.02; // Within 2 cents
            return orderToken === pendingTokenId && priceMatch;
          });

          if (matchingOrder) {
            const orderId = matchingOrder.id || matchingOrder.order_id;
            log(`Found matching order: ${orderId}`, 'INFO');

            // Update the trade with the order ID
            updateTrade(trade.id, {
              [pendingSide === 'yes' ? 'yesOrderId' : 'noOrderId']: orderId,
            });

            // Check if it's filled
            const { filled, sizeMatched } = await checkOrderFilled(clobClient, orderId);
            if (filled) {
              log(`✅ HEDGE FILLED: Trade ${trade.id.slice(-6)} ${pendingSide.toUpperCase()} leg filled (${sizeMatched} shares)`, 'TRADE');
              markHedgeFilled(trade.id, pendingSide);
              filledCount++;
            }
          } else {
            // No open order found - might already be filled, check position
            log(`No open order found for ${pendingSide.toUpperCase()} @ $${pendingPrice.toFixed(2)}`, 'WARN');
            log(`   Trade may need manual verification or the hedge order failed`, 'WARN');
          }
        }
      } catch (error) {
        log(`Error searching open orders: ${error}`, 'WARN');
      }
    }
  }

  return filledCount;
}

/**
 * getOrderBook: Fetch order book for a specific token
 *
 * @param tokenId - Token ID to get order book for
 * @returns Order book with bids and asks
 */
async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch orderbook: ${res.status}`);
  }
  return res.json();
}

/**
 * getMidpoint: Get midpoint price for a token
 *
 * @param tokenId - Token ID
 * @returns Midpoint price
 */
async function getMidpoint(tokenId: string): Promise<number> {
  // Cache-bust + no-store: avoids any intermediate caching returning stale mids
  const url = `${CLOB_HOST}/midpoint?token_id=${tokenId}&_ts=${Date.now()}`;
  const res = await fetch(url, {
    // Node fetch supports this option; harmless if ignored
    cache: 'no-store' as any,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to fetch midpoint: ${res.status} - ${errorText}`);
  }
  const data = await res.json();
  if (!data.mid) {
    throw new Error(`Midpoint data missing in response: ${JSON.stringify(data)}`);
  }
  return parseFloat(data.mid);
}

// ============================================================================
// TRADING LOGIC
// ============================================================================

/**
 * executeTradePair: Execute a complete trade pair (buy first token, sell hedge token)
 * 
 * @param clobClient - ClobClient instance
 * @param direction - 'YES_FIRST' or 'NO_FIRST'
 * @param yesToken - YES token
 * @param noToken - NO token
 * @param currentPrice - Current price of the first token
 * @param state - Trade state for this direction
 * @param marketSlug - Current market slug
 * @param marketInfo - Market info
 */
async function executeTradePair(
  clobClient: any,
  direction: 'YES_FIRST' | 'NO_FIRST',
  yesToken: Token,
  noToken: Token,
  currentPrice: number,
  yesPriceCurrent: number,
  noPriceCurrent: number,
  state: TradeState,
  marketSlug: string,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<boolean> {
  const monitorToken = direction === 'YES_FIRST' ? yesToken : noToken;
  const monitorTokenName = direction === 'YES_FIRST' ? 'YES' : 'NO';
  const hedgeToken = direction === 'YES_FIRST' ? noToken : yesToken;
  const hedgeTokenName = direction === 'YES_FIRST' ? 'NO' : 'YES';

  try {
    // Validate inputs to avoid undefined/NaN errors
    if (!Number.isFinite(currentPrice)) {
      log(`Invalid currentPrice for ${monitorTokenName}: ${currentPrice}`, 'WARN');
      return false;
    }
    if (!Number.isFinite(yesPriceCurrent) || !Number.isFinite(noPriceCurrent)) {
      log(`Invalid yes/no prices (yes=${yesPriceCurrent}, no=${noPriceCurrent})`, 'WARN');
      return false;
    }
    const tickNumeric = Number.parseFloat(marketInfo.tickSize);
    if (!Number.isFinite(tickNumeric) || tickNumeric <= 0) {
      log(`Invalid tick size "${marketInfo.tickSize}", using fallback 0.01`, 'WARN');
      marketInfo.tickSize = '0.01';
    }

    log(`TRAILING STOP TRIGGERED (${direction}) - Executing ${monitorTokenName} AGGRESSIVE BUY...`, 'TRADE');

    log(`Share size per leg: ${SHARE_SIZE} shares`, 'INFO');

    // === FIRST LEG: MARKET ORDER (guaranteed fill) ===
    let firstResult: { price: number; orderId: string | null; filledSize: number; filled: boolean };
    try {
      firstResult = await executeAggressiveBuy(
        clobClient,
        monitorToken.token_id,
        monitorTokenName,
        SHARE_SIZE,
        marketInfo
      );
    } catch (error) {
      log(`❌ Failed to execute ${monitorTokenName} aggressive buy: ${error}`, 'ERROR');
      log(`   Skipping this trade pair`, 'WARN');
      return false;
    }

    const firstFillPrice = firstResult.price;
    const firstFillSize = firstResult.filledSize;
    const firstLegFilled = firstResult.filled;

    // Verify first leg actually filled before proceeding
    if (!firstLegFilled) {
      log(`⚠️  First leg order not filled - aborting trade pair`, 'WARN');
      return false;
    }

    state.firstEntryPrice = firstFillPrice;
    state.inPosition = true;

    log(`✅ ${monitorTokenName} FILLED @ $${firstFillPrice.toFixed(4)} for ${firstFillSize} shares`, 'TRADE');

    // === SECOND LEG: LIMIT ORDER (hedge at complementary price) ===
    // Hedge at (1 - firstPrice - spread) to capture the target spread profit
    const hedgeLimitPriceRaw = 1 - firstFillPrice - TARGET_SPREAD_CENTS;
    const hedgeLimitPrice = applyTickSize(hedgeLimitPriceRaw, marketInfo.tickSize);
    log(`Hedge ${hedgeTokenName} limit: 1 - ${firstFillPrice.toFixed(2)} - ${TARGET_SPREAD_CENTS.toFixed(2)} = ${hedgeLimitPrice.toFixed(2)} (${TARGET_SPREAD_CENTS * 100}¢ spread)`);

    // Hedge with same share size as first leg (to maintain balanced position)
    const hedgeShareSize = firstFillSize;

    let hedgeResult: { price: number; orderId: string | null };
    try {
      hedgeResult = await executeBuy(
        clobClient,
        hedgeToken.token_id,
        hedgeTokenName,
        hedgeLimitPrice,
        hedgeShareSize,
        marketInfo
      );
      log(`✅ ${hedgeTokenName} LIMIT placed @ $${hedgeLimitPrice.toFixed(4)} for ${hedgeShareSize} shares`, 'TRADE');
    } catch (error) {
      log(`❌ Failed to place ${hedgeTokenName} hedge limit: ${error}`, 'ERROR');
      log(`   First leg filled but hedge failed!`, 'WARN');
      hedgeResult = { price: hedgeLimitPrice, orderId: null };
    }

    // Save trade to store
    // First leg was verified as filled above, so we can set the filled timestamp
    const now = Date.now();
    try {
      const trade = addTrade({
        marketSlug: marketSlug,
        yesTokenId: yesToken.token_id,
        noTokenId: noToken.token_id,
        yesOrderId: direction === 'YES_FIRST' ? (firstResult.orderId || undefined) : (hedgeResult.orderId || undefined),
        noOrderId: direction === 'YES_FIRST' ? (hedgeResult.orderId || undefined) : (firstResult.orderId || undefined),
        yesPrice: direction === 'YES_FIRST' ? firstFillPrice : hedgeLimitPrice,
        noPrice: direction === 'YES_FIRST' ? hedgeLimitPrice : firstFillPrice,
        yesFilledAt: direction === 'YES_FIRST' ? now : undefined, // First leg verified filled
        noFilledAt: direction === 'NO_FIRST' ? now : undefined,   // First leg verified filled
        size: hedgeShareSize,
        status: 'open',
        notes: `${monitorTokenName} FILLED @ $${firstFillPrice.toFixed(4)}, ${hedgeTokenName} limit @ $${hedgeLimitPrice.toFixed(4)}`,
      });
      state.tradeId = trade.id;
      log(`Trade saved: ${trade.id}`, 'TRADE');
    } catch (error) {
      log(`⚠️  Failed to save trade: ${error}`, 'WARN');
    }

    state.secondOrderPrice = hedgeLimitPrice;

    // Display updated table after new trade
    console.log('');
    log(`New ${direction} trade pair created!`, 'TRADE');
    displayTradePairsTable(marketSlug);
    console.log('');

    // Note: We don't reset peakPrice here - allows for multiple entries
    // Position will be held until market expires
    return true;
  } catch (error) {
    log(`❌ Critical error in executeTradePair (${direction}): ${error}`, 'ERROR');
    log(`   Resetting state and continuing...`, 'WARN');
    state.inPosition = false;
    state.firstEntryPrice = null;
    state.secondOrderPrice = null;
    return false;
  }
}

/**
 * calculateTrailingStop: Determine if trailing stop should trigger
 *
 * LOGIC:
 * - Track the peak price since monitoring started
 * - If current price drops TRAILING_STOP_CENTS below peak, trigger buy
 *
 * @param currentPrice - Current YES token price
 * @param peakPrice - Highest price seen
 * @returns { triggered: boolean, newPeak: number }
 */
function calculateTrailingStop(
  currentPrice: number,
  peakPrice: number
): { triggered: boolean; newPeak: number } {
  // Update peak if current price is higher
  const newPeak = Math.max(currentPrice, peakPrice);

  // Check if price dropped enough from peak
  const dropFromPeak = newPeak - currentPrice;
  const triggered = dropFromPeak >= TRAILING_STOP_CENTS;

  log(`Peak: $${newPeak.toFixed(4)} | Current: $${currentPrice.toFixed(4)} | Drop: $${dropFromPeak.toFixed(4)}`);

  if (triggered) {
    log(`TRAILING STOP TRIGGERED! Drop of $${dropFromPeak.toFixed(4)} >= $${TRAILING_STOP_CENTS}`, 'TRADE');
  }

  return { triggered, newPeak };
}

/**
 * getMarketInfo: Get market info including tickSize and negRisk
 */
async function getMarketInfo(conditionId: string): Promise<{ tickSize: string; negRisk: boolean }> {
  const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch market info: ${res.status}`);
  }
  const data = await res.json();
  // Default values if not found
  return {
    tickSize: data.tick_size || '0.0001',
    negRisk: data.neg_risk || false,
  };
}

/**
 * applyTickSize: Round a price to the market tick size
 */
function applyTickSize(price: number, tickSizeStr: string): number {
  const tickRaw = Number.parseFloat(tickSizeStr || '0.01');
  const tick = Number.isFinite(tickRaw) && tickRaw > 0 ? tickRaw : 0.01;
  const tickEnforced = Math.max(tick, 0.01);
  const rounded = Math.round(price / tickEnforced) * tickEnforced;
  const decimals = tickEnforced.toString().split('.')[1]?.length || 0;
  const result = Number(rounded.toFixed(decimals)); return Math.max(result, tickEnforced); // Never go below tick size
}

/**
 * cancelAllOpenOrders: Cancel all open orders on this account
 * Called when market expires/matures before switching to next market
 */
async function cancelAllOpenOrders(clobClient: any): Promise<void> {
  log('═'.repeat(60));
  log('CANCELLING ALL OPEN ORDERS (Market Expiring)', 'TRADE');
  log('═'.repeat(60));
  
  try {
    const result = await clobClient.cancelAll();
    log('✅ All orders cancelled successfully', 'TRADE');
    if (result) {
      log('Response: ' + JSON.stringify(result), 'INFO');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('no open orders') || errorMsg.includes('404')) {
      log('No open orders to cancel', 'INFO');
    } else {
      log('⚠️  Error cancelling orders: ' + errorMsg, 'WARN');
    }
  }
  
  log('═'.repeat(60));
}



/**
 * executeAggressiveBuy: Buy with aggressive limit that crosses the spread
 * Places limit at best ask + buffer to ensure immediate fill
 */
async function executeAggressiveBuy(
  clobClient: any,
  tokenId: string,
  tokenName: string,
  shareSize: number,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<{ price: number; orderId: string | null; filledSize: number; filled: boolean }> {
  if (!Number.isFinite(shareSize) || shareSize <= 0) {
    throw new Error(`Invalid share size for ${tokenName} buy: ${shareSize}`);
  }

  log('='.repeat(60));
  log(`EXECUTING ${tokenName} AGGRESSIVE BUY`, 'TRADE');
  log('='.repeat(60));
  log(`Token ID: ${tokenId.slice(0, 30)}...`);
  log(`Shares:   ${shareSize}`);
  log('');

  try {
    // Get current orderbook to find best ask
    const book = await getOrderBook(tokenId);
    
    if (!book.asks || book.asks.length === 0) {
      throw new Error('No asks in orderbook - cannot execute buy');
    }

    // Best ask is lowest price someone is willing to sell at
    // Sort asks by price ascending and get the best (lowest) one
    const sortedAsks = book.asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestAsk = parseFloat(sortedAsks[0].price);
    
    // Add small buffer to ensure we cross the spread (2 cents)
    const aggressivePrice = Math.min(bestAsk + 0.02, 0.99);
    // Ensure price has max 2 decimals (Polymarket requirement for maker amount precision)
    const tickAdjustedPrice = applyTickSize(aggressivePrice, marketInfo.tickSize);
    const finalPrice = Math.round(tickAdjustedPrice * 100) / 100;

    // Use the provided share size, but ensure minimum $1.05 order value
    const MIN_ORDER_VALUE = 1.05;
    const minSharesForValue = Math.ceil(MIN_ORDER_VALUE / finalPrice);
    const roundedShares = Math.max(shareSize, minSharesForValue);

    // Calculate order value
    const orderValue = roundedShares * finalPrice;

    log(`Best Ask: $${bestAsk.toFixed(4)}`);
    log(`Aggressive Price: $${finalPrice.toFixed(2)} (+$0.02 buffer)`);
    log(`Shares: ${roundedShares} (order value: $${orderValue.toFixed(2)})`);
    log('');

    // Place FOK (Fill or Kill) order - guarantees immediate fill or rejection
    // This ensures we don't leave unfilled orders on the book
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: finalPrice,
        side: Side.BUY,
        size: roundedShares,
        feeRateBps: 0,
      },
      {
        tickSize: marketInfo.tickSize,
        negRisk: marketInfo.negRisk,
      },
      OrderType.FOK
    );

    if (!response) {
      throw new Error('Order returned no response');
    }

    // Check for error responses (SDK may return error object instead of throwing)
    if (response.error || response.status === 403 || response.status === 401) {
      const errorMsg = response.error || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`Order rejected: ${errorMsg}`);
    }

    // Check for Cloudflare block (HTML response)
    if (typeof response === 'string' && response.includes('Cloudflare')) {
      throw new Error('Request blocked by Cloudflare WAF - try again later or use a different IP');
    }

    const orderId = response?.order_id || response?.orderID || response?.id || null;
    const status = response?.status || 'UNKNOWN';

    // Verify we got a valid order ID
    if (!orderId) {
      log(`⚠️  Order may not have been placed - no order ID returned`, 'WARN');
      log(`Response: ${JSON.stringify(response).slice(0, 200)}`, 'WARN');
      throw new Error('No order ID returned - order may not have been placed');
    }

    log(`Order placed - ID: ${orderId}`, 'TRADE');
    log(`Initial status: ${status}`);

    // Verify order was filled by checking order status
    // For FOK orders, if we get an order ID, it should be filled
    // But we verify to be sure
    let filled = false;
    let filledPrice = finalPrice;
    let actualFilledSize = roundedShares;

    try {
      // Wait a moment for order to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check order status
      const orderInfo = await clobClient.getOrder(orderId);
      log(`Order status check: ${JSON.stringify(orderInfo).slice(0, 200)}`);

      if (orderInfo) {
        const orderStatus = orderInfo.status || orderInfo.order_status || '';
        const sizeFilled = parseFloat(orderInfo.size_matched || orderInfo.filled_size || '0');
        const avgPrice = parseFloat(orderInfo.average_price || orderInfo.price || finalPrice.toString());

        if (orderStatus.toUpperCase() === 'MATCHED' || orderStatus.toUpperCase() === 'FILLED') {
          filled = true;
          actualFilledSize = sizeFilled > 0 ? sizeFilled : roundedShares;
          filledPrice = avgPrice > 0 ? avgPrice : finalPrice;
          log(`✅ ORDER FILLED! Size: ${actualFilledSize}, Avg Price: $${filledPrice.toFixed(4)}`, 'TRADE');
        } else if (orderStatus.toUpperCase() === 'LIVE' || orderStatus.toUpperCase() === 'OPEN') {
          log(`⚠️  Order is LIVE/OPEN - not filled yet`, 'WARN');
          filled = false;
        } else {
          log(`Order status: ${orderStatus}`, 'INFO');
          // For FOK, if order was accepted it should be filled
          filled = orderId !== null;
        }
      }
    } catch (e) {
      log(`⚠️  Could not verify order status: ${e}`, 'WARN');
      // For FOK orders, if we got an order ID without error, assume filled
      filled = true;
    }

    log(`Price: $${filledPrice.toFixed(4)}`);
    log(`Size: ${actualFilledSize} shares`);
    log(`Filled: ${filled ? 'YES' : 'NO'}`);
    log('='.repeat(60));

    return {
      price: filledPrice,
      orderId,
      filledSize: actualFilledSize,
      filled
    };
  } catch (error) {
    log(`❌ Failed to execute ${tokenName} aggressive buy: ${error}`, 'ERROR');
    log('='.repeat(60));
    throw error;
  }
}

/**
 * executeBuy: Buy shares (REAL TRADING) - Generic function for both YES and NO
 *
 * @param clobClient - Initialized ClobClient instance
 * @param tokenId - Token ID (YES or NO)
 * @param tokenName - Token name for logging ('YES' or 'NO')
 * @param price - Limit price
 * @param size - Number of shares
 * @param marketInfo - Market info with tickSize and negRisk
 * @returns Execution price and order ID
 */
async function executeBuy(
  clobClient: any,
  tokenId: string,
  tokenName: string,
  price: number,
  size: number,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<{ price: number; orderId: string | null }> {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for ${tokenName} buy: ${price}`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size for ${tokenName} buy: ${size}`);
  }
  const adjustedPrice = applyTickSize(price, marketInfo.tickSize);
  if (adjustedPrice !== price) {
    log(`Price adjusted to tick size ${marketInfo.tickSize}: ${price.toFixed(4)} -> ${adjustedPrice.toFixed(4)}`, 'INFO');
  }

  log('='.repeat(60));
  log(`EXECUTING ${tokenName} BUY ORDER`, 'TRADE');
  log('='.repeat(60));
  log(`Token ID: ${tokenId.slice(0, 30)}...`);
  log(`Side:     BUY`);
  log(`Size:     ${size} shares`);
  log(`Price:    $${adjustedPrice.toFixed(4)}`);
  log(`Total:    $${(adjustedPrice * size).toFixed(4)}`);
  log('');

  try {
    // Use official SDK to create and post order
    // According to official docs: https://github.com/Polymarket/clob-client
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: adjustedPrice,
        side: Side.BUY,
        size: size,
        feeRateBps: 0, // Fee rate in basis points (0 = no fee)
      },
      {
        tickSize: marketInfo.tickSize,
        negRisk: marketInfo.negRisk,
      },
      OrderType.GTC
    );

    // Check for error responses (SDK may return error object instead of throwing)
    if (!response) {
      throw new Error('Order returned no response');
    }
    
    if (response.error || response.status === 403 || response.status === 401) {
      const errorMsg = response.error || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`Order rejected: ${errorMsg}`);
    }

    // Check for Cloudflare block (HTML response)
    if (typeof response === 'string' && response.includes('Cloudflare')) {
      throw new Error('Request blocked by Cloudflare WAF - try again later or use a different IP');
    }

    const orderId = response?.order_id || response?.id || null;
    
    // Verify we got a valid order ID
    if (!orderId) {
      log(`⚠️  Order may not have been placed - no order ID returned`, 'WARN');
      log(`Response: ${JSON.stringify(response).slice(0, 200)}`, 'WARN');
      throw new Error('No order ID returned - order may not have been placed');
    }
    
    log(`✅ Order placed successfully!`, 'TRADE');
    log(`Order ID: ${orderId}`);
    log(`Status: ${response?.status || 'PENDING'}`);
    log('='.repeat(60));

    // Return execution price and order ID
    return { price: adjustedPrice, orderId };
  } catch (error) {
    log(`❌ Failed to place ${tokenName} buy order: ${error}`, 'ERROR');
    log('='.repeat(60));
    throw error;
  }
}

/**
 * executeSell: Sell shares (REAL TRADING) - Generic function for both YES and NO
 *
 * STRATEGY: Sell second token at (1 - first token execution price)
 * This creates a hedged position where:
 * - If market resolves in favor of first token: We profit from first position
 * - If market resolves in favor of second token: We profit from second short position
 *
 * @param clobClient - Initialized ClobClient instance
 * @param tokenId - Token ID (YES or NO)
 * @param tokenName - Token name for logging ('YES' or 'NO')
 * @param price - Limit price (should be 1 - firstPrice)
 * @param size - Number of shares
 * @param marketInfo - Market info with tickSize and negRisk
 * @returns Order placed successfully with order ID
 */
async function executeSell(
  clobClient: any,
  tokenId: string,
  tokenName: string,
  price: number,
  size: number,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<{ success: boolean; orderId: string | null }> {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for ${tokenName} sell: ${price}`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size for ${tokenName} sell: ${size}`);
  }
  const adjustedPrice = applyTickSize(price, marketInfo.tickSize);
  if (adjustedPrice !== price) {
    log(`Price adjusted to tick size ${marketInfo.tickSize}: ${price.toFixed(4)} -> ${adjustedPrice.toFixed(4)}`, 'INFO');
  }

  log('='.repeat(60));
  log(`EXECUTING ${tokenName} SELL ORDER`, 'TRADE');
  log('='.repeat(60));
  log(`Token ID: ${tokenId.slice(0, 30)}...`);
  log(`Side:     SELL`);
  log(`Size:     ${size} shares`);
  log(`Price:    $${adjustedPrice.toFixed(4)}`);
  log(`Total:    $${(adjustedPrice * size).toFixed(4)}`);
  log('');

  try {
    // Use official SDK to create and post order
    // According to official docs: https://github.com/Polymarket/clob-client
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: adjustedPrice,
        side: Side.SELL,
        size: size,
        feeRateBps: 0, // Fee rate in basis points (0 = no fee)
      },
      {
        tickSize: marketInfo.tickSize,
        negRisk: marketInfo.negRisk,
      },
      OrderType.GTC
    );

    // Check for error responses (SDK may return error object instead of throwing)
    if (!response) {
      throw new Error('Order returned no response');
    }
    
    if (response.error || response.status === 403 || response.status === 401) {
      const errorMsg = response.error || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`Order rejected: ${errorMsg}`);
    }

    // Check for Cloudflare block (HTML response)
    if (typeof response === 'string' && response.includes('Cloudflare')) {
      throw new Error('Request blocked by Cloudflare WAF - try again later or use a different IP');
    }

    const orderId = response?.order_id || response?.id || null;
    
    // Verify we got a valid order ID
    if (!orderId) {
      log(`⚠️  Order may not have been placed - no order ID returned`, 'WARN');
      log(`Response: ${JSON.stringify(response).slice(0, 200)}`, 'WARN');
      throw new Error('No order ID returned - order may not have been placed');
    }
    
    log(`✅ Order placed successfully!`, 'TRADE');
    log(`Order ID: ${orderId}`);
    log(`Status: ${response?.status || 'PENDING'}`);
    log('='.repeat(60));

    return { success: true, orderId };
  } catch (error) {
    log(`❌ Failed to place ${tokenName} sell order: ${error}`, 'ERROR');
    log('='.repeat(60));
    throw error;
  }
}

// ============================================================================
// MAIN STRATEGY LOOP
// ============================================================================

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     POLYMARKET PRICE PREDICTION ARBITRAGE STRATEGY         ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Market:         Bitcoin Up/Down Prediction                ║');
  console.log(`║  Mode:           ${TRADE_MODE === 'DUAL' ? 'Dual (YES_FIRST + NO_FIRST simultaneously)' : `Single (${TRADE_DIRECTION})`.padEnd(40)} ║`);
  console.log('║  Entry:          2 cent trailing stop                      ║');
  console.log('║  Hedge:          Sell opposite at (1 - buy price)         ║');
  console.log('║  Re-entry:       Enabled after successful execution        ║');
  console.log('║  Hold:           Until market expires                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // -------------------------------------------------------------------------
  // STEP 1: Validate environment and credentials
  // -------------------------------------------------------------------------
  log('STEP 1: Validating configuration...');

  const hasCredentials = POLYMARKET_API_KEY && POLYMARKET_SECRET && POLYMARKET_PASSPHRASE;
  const hasPrivateKey = !!POLYMARKET_PRIVATE_KEY;

  log(`API Credentials: ${hasCredentials ? '✓ Set' : '✗ Missing'}`);
  log(`Private Key:     ${hasPrivateKey ? '✓ Set (real trading enabled)' : '✗ Missing (simulation only)'}`);
  log(`Market Slug:     ${MARKET_SLUG}`);
  log(`Trailing Stop:   ${TRAILING_STOP_CENTS * 100} cents`);
  log(`Share Size:      ${SHARE_SIZE} shares per leg`);
  console.log('');

  // Validate private key is set for real trading
  if (!POLYMARKET_PRIVATE_KEY) {
    log('❌ POLYMARKET_PRIVATE_KEY is required for real trading', 'ERROR');
    log('   Set it in your environment variables', 'ERROR');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // STEP 1.5: Load ClobClient SDK
  // -------------------------------------------------------------------------
  log('STEP 1.5: Loading ClobClient SDK...');

  const sdkLoaded = await loadClobClient();
  if (!sdkLoaded) {
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // STEP 1.6: Initialize ClobClient
  // -------------------------------------------------------------------------
  log('STEP 1.6: Initializing ClobClient...');

  let clobClient: any;
let marketInfo: { tickSize: string; negRisk: boolean } = { tickSize: '0.01', negRisk: false };
  try {
    // Format private key (remove 0x prefix if present, ensure it's the right format)
    const privateKey = POLYMARKET_PRIVATE_KEY.startsWith('0x')
      ? POLYMARKET_PRIVATE_KEY
      : `0x${POLYMARKET_PRIVATE_KEY}`;

    // Create ethers wallet from private key
    const signer = new Wallet(privateKey);

    log(`Wallet Address: ${signer.address}`);

    // Verify ClobClient is loaded
    if (!ClobClient || typeof ClobClient !== 'function') {
      throw new Error(`ClobClient not properly loaded. Type: ${typeof ClobClient}, Value: ${ClobClient}`);
    }

    // Polymarket Proxy Wallet (smart account) - funds are held here
    // Signature types: 0 = EOA, 1 = Poly Proxy (MagicLink), 2 = Gnosis Safe (MetaMask)
    const signatureType = 2; // 2 = Gnosis Safe (your wallet is a Gnosis Safe v1.3.0)
    const funder = "0x2163f00898fb58f47573e89940ff728a5e07ac09";

    // Use existing API credentials or create/derive new ones
    let creds: any;
    let apiKeyCreated = false;

    // Always try to derive fresh API credentials using the SDK
    // IMPORTANT: Must derive with signatureType and funder set for proxy wallet
    log(`Deriving fresh API credentials using SDK...`);
    log(`   Using proxy wallet: ${funder}`);
    try {
      // Create temp client WITH funder and signatureType to derive correct credentials
      const tempClient = new ClobClient(CLOB_HOST, 137, signer, undefined, signatureType, funder);
      const derivedCreds = await tempClient.createOrDeriveApiKey();
      
      // Check if creds is valid (should have apiKey and apiSecret properties)
      if (derivedCreds && (derivedCreds.apiKey || derivedCreds.key)) {
        creds = derivedCreds;
        apiKeyCreated = true;
        log(`✅ API credentials derived successfully`);
        log(`   API Key: ${(derivedCreds.apiKey || derivedCreds.key || '').slice(0, 10)}...`);
      } else {
        log(`⚠️  API key derivation returned unexpected format`, 'WARN');
        log(`   Response keys: ${Object.keys(derivedCreds || {}).join(', ')}`);
        // Fall back to .env.local credentials if available
        if (hasCredentials) {
          log(`   Falling back to .env.local credentials`);
          creds = {
            key: POLYMARKET_API_KEY,
            secret: POLYMARKET_SECRET,
            passphrase: POLYMARKET_PASSPHRASE,
          };
          apiKeyCreated = true;
        } else {
          creds = null;
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`⚠️  API key derivation failed: ${errorMsg}`, 'WARN');
      
      // Fall back to .env.local credentials if available
      if (hasCredentials) {
        log(`   Falling back to .env.local credentials`);
        creds = {
          key: POLYMARKET_API_KEY,
          secret: POLYMARKET_SECRET,
          passphrase: POLYMARKET_PASSPHRASE,
        };
        apiKeyCreated = true;
      } else {
        log(`   No fallback credentials available`, 'WARN');
        log(`   Common causes:`, 'WARN');
        log(`   - Wallet not registered/verified on Polymarket`, 'WARN');
        log(`   - Wallet needs to complete account setup on polymarket.com`, 'WARN');
        log(`   - Rate limiting or temporary API issues`, 'WARN');
        creds = null;
      }
    }

    // Initialize ClobClient with proxy wallet configuration
    try {
      // @ts-ignore - ClobClient API
      clobClient = new ClobClient(CLOB_HOST, 137, signer, creds, signatureType, funder);
      
      if (apiKeyCreated) {
        if (hasCredentials) {
          log(`✅ ClobClient initialized successfully with provided API credentials`);
        } else {
          log(`✅ ClobClient initialized successfully with derived API key`);
        }
      } else {
        log(`⚠️  ClobClient initialized WITHOUT API key`, 'WARN');
        log(`   Trading operations may fail - check wallet permissions`, 'WARN');
      }
    } catch (error) {
      // If we tried to use provided credentials and it failed, try alternative format
      if (hasCredentials && creds) {
        log(`⚠️  Initialization with provided credentials failed, trying alternative format...`, 'WARN');
        try {
          // Try alternative credential format (some SDKs use api_key instead of apiKey)
          const altCreds = {
            key: POLYMARKET_API_KEY,
            secret: POLYMARKET_SECRET,
            passphrase: POLYMARKET_PASSPHRASE,
          };
          // @ts-ignore
          clobClient = new ClobClient(CLOB_HOST, 137, signer, altCreds, signatureType, funder);
          log(`✅ ClobClient initialized with alternative credential format`);
        } catch (altError) {
          log(`⚠️  Alternative format also failed, falling back to minimal client...`, 'WARN');
          // Create a minimal client that might still work
          try {
            // @ts-ignore
            clobClient = new ClobClient(CLOB_HOST, 137, signer, null, signatureType, funder);
            log(`⚠️  Minimal ClobClient created - operations may be limited`, 'WARN');
            log(`   Note: Provided API credentials may not be compatible with SDK format`, 'WARN');
            log(`   Consider using createOrDeriveApiKey() instead`, 'WARN');
          } catch (minimalError) {
            log(`❌ Failed to create even minimal ClobClient: ${minimalError}`, 'ERROR');
            throw minimalError;
          }
        }
      } else {
        log(`❌ ClobClient initialization failed: ${error}`, 'ERROR');
        log(`   Attempting to create minimal client...`, 'WARN');
        // Create a minimal client that might still work
        try {
          // @ts-ignore
          clobClient = new ClobClient(CLOB_HOST, 137, signer, null, signatureType, funder);
          log(`⚠️  Minimal ClobClient created - operations may be limited`, 'WARN');
        } catch (minimalError) {
          log(`❌ Failed to create even minimal ClobClient: ${minimalError}`, 'ERROR');
          throw minimalError;
        }
      }
    }
    console.log('');
  } catch (error) {
    log(`❌ Failed to initialize ClobClient: ${error}`, 'ERROR');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // STEP 2: Get market slug (dynamic or fixed)
  // -------------------------------------------------------------------------
  let currentMarketSlug: string;
  
  if (USE_DYNAMIC_MARKET) {
    currentMarketSlug = generateNextHourMarketSlug();
    log(`Generated market slug for next hour: ${currentMarketSlug}`);
  } else {
    if (!MARKET_SLUG) {
      log('❌ MARKET_SLUG is required when USE_DYNAMIC_MARKET is false', 'ERROR');
      process.exit(1);
    }
    currentMarketSlug = MARKET_SLUG;
    log(`Using fixed market slug: ${currentMarketSlug}`);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // STEP 3: Fetch Polymarket market data
  // -------------------------------------------------------------------------
  log('STEP 3: Fetching Polymarket market data...');
  
  let market: Market;
  let yesToken: Token;
  let noToken: Token;
  
  async function refreshMarket() {
    const slug = USE_DYNAMIC_MARKET ? generateNextHourMarketSlug() : (MARKET_SLUG || '');
    const m = await getMarketBySlug(slug);
    
    if (m.closed) {
    log('Market is CLOSED. Cannot trade.', 'ERROR');
      return null;
  }

    if (!m.active) {
    log('Market is not ACTIVE. Cannot trade.', 'ERROR');
      return null;
  }

  log(`Market Status: ACTIVE`);
    log(`Condition ID:  ${m.conditionId}`);
  console.log('');

    // Fetch tokens
    const clobMarket: any = await getClobMarket(m.conditionId);
    const tokens = (clobMarket.tokens || []) as Token[];

    // Capture market tick size / negRisk (fallback to sensible defaults)
    const rawTickSize = Number(clobMarket.tick_size ?? clobMarket.tickSize ?? 0.01);
    const tickSizeNum = Number.isFinite(rawTickSize) && rawTickSize > 0 ? rawTickSize : 0.01;
    const minTickSizeNum = Math.max(tickSizeNum, 0.01); // enforce at least 0.01
    const tickSize = minTickSizeNum.toString();
    const negRisk = clobMarket.neg_risk || clobMarket.negRisk || false;
    marketInfo = { tickSize, negRisk };
    log(`Market tick size: ${tickSize}`);
    log(`Market negRisk:   ${negRisk}`);

    const yes = tokens.find(
    (t) => t.outcome.toLowerCase() === 'yes' || t.outcome.toLowerCase() === 'up'
  );

    const no = tokens.find(
    (t) => t.outcome.toLowerCase() === 'no' || t.outcome.toLowerCase() === 'down'
  );

    if (!yes || !no) {
    log(`Could not find YES/NO tokens. Available: ${tokens.map((t) => t.outcome).join(', ')}`, 'ERROR');
      return null;
    }
    
    return { market: m, yesToken: yes, noToken: no };
  }
  
  const marketData = await refreshMarket();
  if (!marketData) {
    process.exit(1);
  }
  
  market = marketData.market;
  yesToken = marketData.yesToken;
  noToken = marketData.noToken;

  log(`YES Token: ${yesToken.outcome} (${yesToken.token_id.slice(0, 20)}...)`);
  log(`NO Token:  ${noToken.outcome} (${noToken.token_id.slice(0, 20)}...)`);
  console.log('');

  // -------------------------------------------------------------------------
  // STEP 4: Connect to WebSocket for real-time price updates
  // -------------------------------------------------------------------------
  log('STEP 4: Connecting to WebSocket for real-time prices...');
  try {
    await connectWebSocket(yesToken.token_id, noToken.token_id);
    log('✅ WebSocket connected - using real-time price feed');
  } catch (error) {
    log(`⚠️ WebSocket connection failed, will use REST API fallback: ${error}`, 'WARN');
  }
  console.log('');

  // -------------------------------------------------------------------------
  // STEP 5: Initialize trade state
  // -------------------------------------------------------------------------
  log('STEP 5: Initializing trade state...');

  // Initialize dual trade states for simultaneous YES and NO trading
  const dualState: DualTradeState = {
    yesFirstState: {
    inPosition: false,
      firstEntryPrice: null,
      secondOrderPrice: null,
    peakPrice: 0,
    trailingStopTriggered: false,
    },
    noFirstState: {
      inPosition: false,
      firstEntryPrice: null,
      secondOrderPrice: null,
      peakPrice: 0,
      trailingStopTriggered: false,
    },
  };

  // For single mode, use only one state
  const state: TradeState = TRADE_MODE === 'DUAL' 
    ? dualState.yesFirstState // Will use both states in dual mode
    : {
        inPosition: false,
        firstEntryPrice: null,
        secondOrderPrice: null,
        peakPrice: 0,
        trailingStopTriggered: false,
      };

  log(`Trade Mode:      ${TRADE_MODE}`);
  if (TRADE_MODE === 'SINGLE') {
    log(`Trade Direction: ${TRADE_DIRECTION}`);
  } else {
    log(`Trading:         YES_FIRST and NO_FIRST simultaneously`);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // STEP 5: Main trading loop
  // -------------------------------------------------------------------------
  log('STEP 5: Starting main trading loop...');
  console.log('');
  console.log('─'.repeat(60));
  console.log('');

  let cycleCount = 0;
  let lastTableDisplay = 0;
  const TABLE_DISPLAY_INTERVAL = 10; // Display table every 10 cycles
  let lastYesPrice: number | null = null;
  let lastNoPrice: number | null = null;
  let yesStaleCount = 0;
  let noStaleCount = 0;
  const STALE_ORDERBOOK_CHECK_CYCLES = 30;

  // Track if this is the first trade on a new market (execute immediately, no trailing stop)
  // Check if there are existing open trades for this market - if so, don't treat as "new market"
  const existingTrades = getTrades({ marketSlug: currentMarketSlug, status: 'open' });
  let isFirstTradeOnMarket = existingTrades.length === 0;

  if (existingTrades.length > 0) {
    log(`Found ${existingTrades.length} existing open trade(s) for this market - resuming`, 'INFO');
    // Set inPosition flags based on existing trades
    const hasYesFirstTrade = existingTrades.some(t => t.yesFilledAt && !t.noFilledAt);
    const hasNoFirstTrade = existingTrades.some(t => t.noFilledAt && !t.yesFilledAt);
    if (hasYesFirstTrade) {
      dualState.yesFirstState.inPosition = true;
      log(`YES_FIRST has pending hedge - resuming position`, 'INFO');
    }
    if (hasNoFirstTrade) {
      dualState.noFirstState.inPosition = true;
      log(`NO_FIRST has pending hedge - resuming position`, 'INFO');
    }
  } else {
    log(`No existing trades for this market - will execute first trades immediately`, 'INFO');
  }

  while (true) {
    cycleCount++;
    log(`═══ CYCLE ${cycleCount} ═══`);
    console.log('');

    // ---------------------------------------------------------------------
    // STOP LOSS CHECK - Track profit, not cash balance
    // ---------------------------------------------------------------------
    if (MAX_LOSS_USD !== null) {
      const totalPnL = getTotalPnL();
      log(`Total P&L: $${totalPnL.toFixed(2)}`, totalPnL < 0 ? 'WARN' : 'INFO');

      if (totalPnL < MAX_LOSS_USD) {
        log('');
        log('╔════════════════════════════════════════════════════════════╗', 'ERROR');
        log('║  🛑 STOP LOSS TRIGGERED - STOPPING TRADING                 ║', 'ERROR');
        log('╠════════════════════════════════════════════════════════════╣', 'ERROR');
        log(`║  Total P&L: $${totalPnL.toFixed(2)}                                        ║`, 'ERROR');
        log(`║  Max Loss:  $${MAX_LOSS_USD.toFixed(2)}                                        ║`, 'ERROR');
        log('╚════════════════════════════════════════════════════════════╝', 'ERROR');
        log('');

        // Cancel all open orders before exiting
        await cancelAllOpenOrders(clobClient);
        log('Cancelled all open orders. Exiting...', 'ERROR');
        process.exit(1);
      }
    }

    // Display trade pairs table periodically
    if (cycleCount % TABLE_DISPLAY_INTERVAL === 0 || cycleCount === 1) {
      displayTradePairsTable(currentMarketSlug);
      console.log('');
    }

    try {
      // ---------------------------------------------------------------------
      // 6a: Check if market has expired or become unavailable
      // ---------------------------------------------------------------------
      let marketExpired = false;
      let marketUnavailable = false;
      
      if (market.endDate) {
        const endDate = new Date(market.endDate);
        const now = new Date();
        if (now >= endDate) {
          marketExpired = true;
          log(`Market "${market.question}" has expired (ended at ${endDate.toISOString()})`, 'INFO');
        }
      }
      
      // Check if market is still active
      if (market.closed || !market.active) {
        marketUnavailable = true;
        log(`Market "${market.question}" is no longer active (closed: ${market.closed}, active: ${market.active})`, 'INFO');
      }

      // If market expired or unavailable, switch to next hour's market
      if (marketExpired || marketUnavailable) {
        log('Market expired/maturing - cancelling orders and switching...', 'INFO');
        
        // Cancel all open orders before switching
        await cancelAllOpenOrders(clobClient);
        
        // Cancel pending trades in our store (unless one leg already executed)
        const cancelledCount = cancelPendingTradesForMarket(currentMarketSlug);
        if (cancelledCount > 0) {
          log(`Cancelled ${cancelledCount} pending trade(s) for ${currentMarketSlug}`, 'INFO');
        }
        
        if (USE_DYNAMIC_MARKET) {
          // Generate next hour's market slug
          const nextSlug = generateNextHourMarketSlug();
          log(`New market slug: ${nextSlug}`, 'INFO');
          
          // Try to refresh market data
          try {
            const newMarketData = await refreshMarket();
            if (newMarketData) {
              market = newMarketData.market;
              yesToken = newMarketData.yesToken;
              noToken = newMarketData.noToken;
              currentMarketSlug = nextSlug;
              
              // Reset trade states for new market
              if (TRADE_MODE === 'DUAL') {
                dualState.yesFirstState.inPosition = false;
                dualState.yesFirstState.firstEntryPrice = null;
                dualState.yesFirstState.secondOrderPrice = null;
                dualState.yesFirstState.peakPrice = 0;
                dualState.yesFirstState.tradeId = undefined;
                
                dualState.noFirstState.inPosition = false;
                dualState.noFirstState.firstEntryPrice = null;
                dualState.noFirstState.secondOrderPrice = null;
                dualState.noFirstState.peakPrice = 0;
                dualState.noFirstState.tradeId = undefined;
              } else {
                state.inPosition = false;
                state.firstEntryPrice = null;
                state.secondOrderPrice = null;
                state.peakPrice = 0;
                state.tradeId = undefined;
              }
              
              log(`✅ Switched to new market: "${market.question}"`, 'INFO');
              log(`Market Status: ${market.active ? 'ACTIVE' : 'INACTIVE'}, Closed: ${market.closed}`, 'INFO');
              if (market.endDate) {
                const newEndDate = new Date(market.endDate);
                log(`Market expires at: ${newEndDate.toISOString()}`, 'INFO');
              }
              console.log('');

              // Reset first trade flag for new market (execute immediately on first trade)
              isFirstTradeOnMarket = true;
              log(`🚀 First trade on new market will execute immediately (no trailing stop)`, 'TRADE');

              // Reconnect WebSocket to new market tokens
              try {
                if (wsConnection) {
                  wsConnection.close();
                }
                await connectWebSocket(yesToken.token_id, noToken.token_id);
                log('✅ WebSocket reconnected for new market');
              } catch (error) {
                log(`⚠️ WebSocket reconnection failed: ${error}`, 'WARN');
              }

              // Continue to next cycle to start trading new market
              await sleep(LOOP_INTERVAL_MS);
              continue;
            } else {
              log(`⚠️  Failed to fetch new market data. Retrying in next cycle...`, 'WARN');
        await sleep(LOOP_INTERVAL_MS);
        continue;
            }
          } catch (error) {
            log(`❌ Error switching to new market: ${error}`, 'ERROR');
            log(`   Retrying in next cycle...`, 'WARN');
            await sleep(LOOP_INTERVAL_MS);
            continue;
          }
        } else {
          log(`⚠️  Market expired/unavailable but USE_DYNAMIC_MARKET is false.`, 'WARN');
          log(`   Set USE_DYNAMIC_MARKET=true to enable automatic market switching.`, 'WARN');
          await sleep(LOOP_INTERVAL_MS);
          continue;
        }
      }

      // ---------------------------------------------------------------------
      // 6b: Fetch current prices for both tokens (via WebSocket or REST fallback)
      // ---------------------------------------------------------------------
      log('Fetching current token prices...');

      let yesPrice: number | null = null;
      let noPrice: number | null = null;
      let priceFetchError = false;

      try {
        // Use WebSocket prices if available, fallback to REST API
        const prices = await getCurrentPrices(yesToken.token_id, noToken.token_id);
        yesPrice = prices.yesPrice;
        noPrice = prices.noPrice;

        // Log source
        const isWebSocketData = Date.now() - priceState.lastUpdate < 5000;
        if (isWebSocketData) {
          log(`📡 Using WebSocket real-time prices`);
        } else {
          log(`🔄 Using REST API prices (WebSocket stale)`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`⚠️  Error fetching prices: ${errorMsg}`, 'WARN');

        // Check if it's a 404 (orderbook doesn't exist) - market might be settling
        if (errorMsg.includes('404') || errorMsg.includes('No orderbook exists')) {
          log(`Orderbook unavailable - market may be settling`, 'INFO');
        }
        priceFetchError = true;
      }

      // If we got 404 errors (orderbook doesn't exist), check if market expired
      if (priceFetchError && (!yesPrice || !noPrice)) {
        if (market.endDate) {
          const endDate = new Date(market.endDate);
          const now = new Date();
          if (now >= endDate) {
            log(`Market has expired and orderbook is unavailable (settling). Cancelling orders...`, 'INFO');
            await cancelAllOpenOrders(clobClient);
            marketExpired = true;
            // Will trigger market switch in next iteration
            await sleep(LOOP_INTERVAL_MS);
            continue;
          }
        }
      }

      if (!yesPrice || isNaN(yesPrice) || !noPrice || isNaN(noPrice)) {
        // If we detected market expiration, trigger switch in next cycle
        if (marketExpired) {
          log('Market appears expired. Will switch in next cycle.', 'INFO');
        } else {
          log('Failed to fetch token midpoint prices. Skipping cycle.', 'WARN');
          log('   Will retry on next cycle...', 'INFO');
        }
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      log(`YES Current Price: $${yesPrice.toFixed(4)}`);
      log(`NO Current Price:  $${noPrice.toFixed(4)}`);

      // Staleness / delta diagnostics (helps distinguish "flat market" vs "stale midpoint")
      if (lastYesPrice !== null) {
        const dYes = yesPrice - lastYesPrice;
        yesStaleCount = dYes === 0 ? yesStaleCount + 1 : 0;
        log(`YES Δ: ${dYes >= 0 ? '+' : ''}${dYes.toFixed(4)} (stale ${yesStaleCount})`);
      }
      if (lastNoPrice !== null) {
        const dNo = noPrice - lastNoPrice;
        noStaleCount = dNo === 0 ? noStaleCount + 1 : 0;
        log(`NO  Δ: ${dNo >= 0 ? '+' : ''}${dNo.toFixed(4)} (stale ${noStaleCount})`);
      }
      lastYesPrice = yesPrice;
      lastNoPrice = noPrice;

      // If midpoint is "stuck" for a while, spot-check top-of-book to validate the midpoint endpoint
      if (yesStaleCount === STALE_ORDERBOOK_CHECK_CYCLES || noStaleCount === STALE_ORDERBOOK_CHECK_CYCLES) {
        try {
          const [yesBook, noBook] = await Promise.all([
            getOrderBook(yesToken.token_id),
            getOrderBook(noToken.token_id),
          ]);
          const yesBestBid = Number(yesBook?.bids?.[0]?.price);
          const yesBestAsk = Number(yesBook?.asks?.[0]?.price);
          const noBestBid = Number(noBook?.bids?.[0]?.price);
          const noBestAsk = Number(noBook?.asks?.[0]?.price);

          const yesMidManual =
            Number.isFinite(yesBestBid) && Number.isFinite(yesBestAsk) ? (yesBestBid + yesBestAsk) / 2 : NaN;
          const noMidManual =
            Number.isFinite(noBestBid) && Number.isFinite(noBestAsk) ? (noBestBid + noBestAsk) / 2 : NaN;

          log(
            `Orderbook spot-check (stale=${STALE_ORDERBOOK_CHECK_CYCLES}): YES bid/ask=${yesBestBid}/${yesBestAsk} mid≈${Number.isFinite(yesMidManual) ? yesMidManual.toFixed(4) : 'n/a'}`,
            'INFO'
          );
          log(
            `Orderbook spot-check (stale=${STALE_ORDERBOOK_CHECK_CYCLES}): NO  bid/ask=${noBestBid}/${noBestAsk} mid≈${Number.isFinite(noMidManual) ? noMidManual.toFixed(4) : 'n/a'}`,
            'INFO'
          );
        } catch (error) {
          log(`⚠️  Orderbook spot-check failed: ${error}`, 'WARN');
        }
      }

      // ---------------------------------------------------------------------
      // 6b: Check pending hedge orders and update fill status
      // ---------------------------------------------------------------------
      const hedgesFilled = await checkAndUpdatePendingHedges(clobClient, currentMarketSlug);
      if (hedgesFilled > 0) {
        log(`${hedgesFilled} hedge order(s) filled this cycle`, 'TRADE');

        // Reset inPosition flags so new trades can be opened
        // Check which direction's hedge just filled and reset that state
        if (TRADE_MODE === 'DUAL') {
          // Reset YES_FIRST state if its trade is now fully filled
          if (dualState.yesFirstState.inPosition && dualState.yesFirstState.tradeId) {
            const yesFirstTrades = getTrades({ marketSlug: currentMarketSlug, status: 'filled' });
            const isYesFirstFilled = yesFirstTrades.some(t => t.id === dualState.yesFirstState.tradeId);
            if (isYesFirstFilled) {
              log(`YES_FIRST trade ${dualState.yesFirstState.tradeId?.slice(-6)} fully hedged - ready for new trade`, 'TRADE');
              dualState.yesFirstState.inPosition = false;
              dualState.yesFirstState.firstEntryPrice = null;
              dualState.yesFirstState.secondOrderPrice = null;
              dualState.yesFirstState.peakPrice = 0;
              dualState.yesFirstState.tradeId = undefined;
            }
          }

          // Reset NO_FIRST state if its trade is now fully filled
          if (dualState.noFirstState.inPosition && dualState.noFirstState.tradeId) {
            const noFirstTrades = getTrades({ marketSlug: currentMarketSlug, status: 'filled' });
            const isNoFirstFilled = noFirstTrades.some(t => t.id === dualState.noFirstState.tradeId);
            if (isNoFirstFilled) {
              log(`NO_FIRST trade ${dualState.noFirstState.tradeId?.slice(-6)} fully hedged - ready for new trade`, 'TRADE');
              dualState.noFirstState.inPosition = false;
              dualState.noFirstState.firstEntryPrice = null;
              dualState.noFirstState.secondOrderPrice = null;
              dualState.noFirstState.peakPrice = 0;
              dualState.noFirstState.tradeId = undefined;
            }
          }
        } else {
          // SINGLE mode - reset state if trade is fully filled
          if (state.inPosition && state.tradeId) {
            const singleTrades = getTrades({ marketSlug: currentMarketSlug, status: 'filled' });
            const isSingleFilled = singleTrades.some(t => t.id === state.tradeId);
            if (isSingleFilled) {
              log(`Trade ${state.tradeId?.slice(-6)} fully hedged - ready for new trade`, 'TRADE');
              state.inPosition = false;
              state.firstEntryPrice = null;
              state.secondOrderPrice = null;
              state.peakPrice = 0;
              state.tradeId = undefined;
            }
          }
        }
      }

      // ---------------------------------------------------------------------
      // 6c: Execute trades based on mode
      // RULE: Only ONE unhedged trade per side PER MARKET
      // New market = fresh start, execute immediately
      // ---------------------------------------------------------------------
      if (TRADE_MODE === 'DUAL') {
        // DUAL MODE: Monitor both YES and NO independently

        // Check hedge status for CURRENT MARKET ONLY
        const yesFirstHedged = isYesFirstFullyHedged(currentMarketSlug);
        const noFirstHedged = isNoFirstFullyHedged(currentMarketSlug);

        // FIRST TRADE ON NEW MARKET: Execute immediately (fresh start)
        if (isFirstTradeOnMarket) {
          log(`🚀 NEW MARKET - Executing first trades immediately!`, 'TRADE');

          // Execute YES_FIRST
          if (!dualState.yesFirstState.inPosition) {
            try {
              const success = await executeTradePair(
                clobClient,
                'YES_FIRST',
                yesToken,
                noToken,
                yesPrice,
                yesPrice,
                noPrice,
                dualState.yesFirstState,
                currentMarketSlug,
                marketInfo
              );

              if (!success) {
                log(`YES_FIRST immediate trade failed`, 'WARN');
                dualState.yesFirstState.inPosition = false;
              }
            } catch (error) {
              log(`⚠️  Error executing YES_FIRST: ${error}`, 'WARN');
            }
          }

          // Execute NO_FIRST
          if (!dualState.noFirstState.inPosition) {
            try {
              const success = await executeTradePair(
                clobClient,
                'NO_FIRST',
                yesToken,
                noToken,
                noPrice,
                yesPrice,
                noPrice,
                dualState.noFirstState,
                currentMarketSlug,
                marketInfo
              );

              if (!success) {
                log(`NO_FIRST immediate trade failed`, 'WARN');
                dualState.noFirstState.inPosition = false;
              }
            } catch (error) {
              log(`⚠️  Error executing NO_FIRST: ${error}`, 'WARN');
            }
          }

          isFirstTradeOnMarket = false;
          log(`First trades executed. Now using trailing stop for subsequent trades.`, 'INFO');

        } else {
          // SUBSEQUENT TRADES: Check hedge status before allowing new trades

          // === YES_FIRST SIDE ===
          if (!yesFirstHedged) {
            log(`⏳ YES_FIRST: Waiting for hedge to fill`, 'INFO');
          } else if (!dualState.yesFirstState.inPosition) {
            // Hedge filled, can start new trade with trailing stop
            const { triggered, newPeak } = calculateTrailingStop(yesPrice, dualState.yesFirstState.peakPrice);
            dualState.yesFirstState.peakPrice = newPeak;

            if (triggered) {
              log(`YES_FIRST trailing stop triggered!`, 'TRADE');
              try {
                const success = await executeTradePair(
                  clobClient,
                  'YES_FIRST',
                  yesToken,
                  noToken,
                  yesPrice,
                  yesPrice,
                  noPrice,
                  dualState.yesFirstState,
                  currentMarketSlug,
                  marketInfo
                );

                if (!success) {
                  dualState.yesFirstState.inPosition = false;
                }
              } catch (error) {
                log(`⚠️  Error processing YES_FIRST: ${error}`, 'WARN');
              }
            }
          }

          // === NO_FIRST SIDE ===
          if (!noFirstHedged) {
            log(`⏳ NO_FIRST: Waiting for hedge to fill`, 'INFO');
          } else if (!dualState.noFirstState.inPosition) {
            // Hedge filled, can start new trade with trailing stop
            const { triggered, newPeak } = calculateTrailingStop(noPrice, dualState.noFirstState.peakPrice);
            dualState.noFirstState.peakPrice = newPeak;

            if (triggered) {
              log(`NO_FIRST trailing stop triggered!`, 'TRADE');
              try {
                const success = await executeTradePair(
                  clobClient,
                  'NO_FIRST',
                  yesToken,
                  noToken,
                  noPrice,
                  yesPrice,
                  noPrice,
                  dualState.noFirstState,
                  currentMarketSlug,
                  marketInfo
                );

                if (!success) {
                  dualState.noFirstState.inPosition = false;
                }
              } catch (error) {
                log(`⚠️  Error processing NO_FIRST: ${error}`, 'WARN');
              }
            }
          }
        }

        // If either pair executed, continue monitoring (don't reset)
        // Positions will be held until market expires

      } else {
        // SINGLE MODE: Original logic
        const monitorToken = TRADE_DIRECTION === 'YES_FIRST' ? yesToken : noToken;
        const monitorTokenName = TRADE_DIRECTION === 'YES_FIRST' ? 'YES' : 'NO';
        const hedgeToken = TRADE_DIRECTION === 'YES_FIRST' ? noToken : yesToken;
        const hedgeTokenName = TRADE_DIRECTION === 'YES_FIRST' ? 'NO' : 'YES';
        const currentPrice = TRADE_DIRECTION === 'YES_FIRST' ? yesPrice : noPrice;

        if (!state.inPosition) {
          try {
            log('Monitoring for trailing stop entry...');

            const { triggered, newPeak } = calculateTrailingStop(currentPrice, state.peakPrice);
            state.peakPrice = newPeak;

            if (triggered) {
              const success = await executeTradePair(
                clobClient,
                TRADE_DIRECTION,
                yesToken,
                noToken,
                currentPrice,
                yesPrice,
                noPrice,
                state,
                currentMarketSlug,
                marketInfo
              );
              
              if (!success) {
                // Trade failed - reset state to allow retry
                log(`Trade failed, resetting state for retry`, 'WARN');
                state.inPosition = false;
                state.firstEntryPrice = null;
                state.secondOrderPrice = null;
              }
              // Don't reset peak - allow multiple entries on success
            }
          } catch (error) {
            log(`⚠️  Error processing trade: ${error}`, 'WARN');
            // Continue execution
          }
        }
      }

      // ---------------------------------------------------------------------
      // 6c: Check if positions are filled and allow re-entry
      // ---------------------------------------------------------------------
      if (TRADE_MODE === 'DUAL') {
        // Check YES_FIRST pair - if both legs filled, allow re-entry
        if (dualState.yesFirstState.inPosition && dualState.yesFirstState.tradeId) {
          const trade = getTrades({ limit: 100 }).find(t => t.id === dualState.yesFirstState.tradeId);
          if (trade && trade.yesFilledAt && trade.noFilledAt) {
            log(`YES_FIRST pair fully executed! Allowing re-entry...`, 'TRADE');
            // Reset state to allow new entry, but keep track of filled trade
            dualState.yesFirstState.inPosition = false;
            dualState.yesFirstState.firstEntryPrice = null;
            dualState.yesFirstState.secondOrderPrice = null;
            dualState.yesFirstState.peakPrice = 0; // Reset peak for new entry
            // Keep tradeId to track the filled position
          }
        }

        // Check NO_FIRST pair - if both legs filled, allow re-entry
        if (dualState.noFirstState.inPosition && dualState.noFirstState.tradeId) {
          const trade = getTrades({ limit: 100 }).find(t => t.id === dualState.noFirstState.tradeId);
          if (trade && trade.yesFilledAt && trade.noFilledAt) {
            log(`NO_FIRST pair fully executed! Allowing re-entry...`, 'TRADE');
            // Reset state to allow new entry
            dualState.noFirstState.inPosition = false;
            dualState.noFirstState.firstEntryPrice = null;
            dualState.noFirstState.secondOrderPrice = null;
            dualState.noFirstState.peakPrice = 0; // Reset peak for new entry
          }
        }
      } else {
        // Single mode - check if position is filled
        if (state.inPosition && state.tradeId) {
          const trade = getTrades({ limit: 100 }).find(t => t.id === state.tradeId);
          if (trade && trade.yesFilledAt && trade.noFilledAt) {
            log(`Trade pair fully executed! Allowing re-entry...`, 'TRADE');
        state.inPosition = false;
            state.firstEntryPrice = null;
            state.secondOrderPrice = null;
            state.peakPrice = 0;
          }
        }
      }

      // ---------------------------------------------------------------------
      // 6d: Check if market has expired and claim profit if needed
      // ---------------------------------------------------------------------
      try {
        // Check market end date
        if (market.endDate) {
          const endDate = new Date(market.endDate);
          const now = new Date();
          
          if (now >= endDate) {
            log('Market has expired! Checking for profit claiming...', 'TRADE');
            
            try {
              // Get all open trades for this market
              const openTrades = getTrades({ marketSlug: currentMarketSlug, status: 'open' });
              
              for (const trade of openTrades) {
                try {
                  if (trade.yesFilledAt && trade.noFilledAt) {
                    // Both legs filled - can claim profit
                    log(`Trade ${trade.id} is ready for profit claiming`, 'TRADE');
                    // TODO: Implement actual profit claiming via Polymarket API
                    // This would involve redeeming the winning tokens
                    
                    // Update trade status
                    try {
                      updateTrade(trade.id, { 
                        status: 'filled',
                        realizedPnl: 0, // Calculate actual PnL based on market resolution
                      });
                      log(`Trade ${trade.id} marked as filled`, 'TRADE');
                    } catch (error) {
                      log(`⚠️  Failed to update trade ${trade.id}: ${error}`, 'WARN');
                    }
                  }
                } catch (error) {
                  log(`⚠️  Error processing trade ${trade.id} for profit claiming: ${error}`, 'WARN');
                }
              }
            } catch (error) {
              log(`⚠️  Error fetching trades for profit claiming: ${error}`, 'WARN');
            }
          }
        }
      } catch (error) {
        log(`⚠️  Error in market expiration check: ${error}`, 'WARN');
      }

    } catch (error) {
      log(`Error in cycle: ${error}`, 'ERROR');
    }

    console.log('');
    log(`Waiting ${LOOP_INTERVAL_MS / 1000} seconds before next cycle...`);
    console.log('─'.repeat(60));
    console.log('');

    await sleep(LOOP_INTERVAL_MS);
  }
}

// ============================================================================
// HOURLY CLAIM CHECK
// ============================================================================

const DATA_HOST = 'https://data-api.polymarket.com';
const CTF_ADDRESS_CHECK = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS_CHECK = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_RPC_CHECK = 'https://polygon-rpc.com';

// Track last claim check time
let lastClaimCheckTime = 0;
const CLAIM_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check for claimable positions and display notification
 */
async function checkClaimablePositions(): Promise<void> {
  const now = Date.now();

  // Only run once per hour
  if (now - lastClaimCheckTime < CLAIM_CHECK_INTERVAL_MS) {
    return;
  }

  lastClaimCheckTime = now;

  log('');
  log('═'.repeat(60));
  log('HOURLY CLAIM CHECK', 'TRADE');
  log('═'.repeat(60));

  try {
    // Fetch positions from Data API
    const funderAddress = '0x2163f00898fb58f47573e89940ff728a5e07ac09';
    const res = await fetch(`${DATA_HOST}/positions?user=${funderAddress}`);

    if (!res.ok) {
      log('Could not fetch positions for claim check', 'WARN');
      return;
    }

    const positions = await res.json();

    if (!positions || positions.length === 0) {
      log('No positions to check', 'INFO');
      return;
    }

    // Group by condition ID
    const conditionIds = new Set<string>();
    for (const pos of positions) {
      if (pos.conditionId || pos.condition_id) {
        conditionIds.add(pos.conditionId || pos.condition_id);
      }
    }

    let resolvedCount = 0;
    let totalClaimable = 0;

    for (const conditionId of conditionIds) {
      // Check if market is resolved
      const gammaRes = await fetch(`${GAMMA_HOST}/markets?condition_id=${conditionId}`);
      if (!gammaRes.ok) continue;

      const markets = await gammaRes.json();
      const market = markets?.[0];

      if (market?.closed || market?.resolved) {
        resolvedCount++;

        // Get balance (simplified - sum position sizes)
        const positionsForCondition = positions.filter(
          (p: any) => (p.conditionId || p.condition_id) === conditionId
        );
        const totalSize = positionsForCondition.reduce(
          (sum: number, p: any) => sum + parseFloat(p.size || p.amount || '0'),
          0
        );
        totalClaimable += totalSize;
      }
    }

    if (resolvedCount > 0) {
      log('');
      log('╔════════════════════════════════════════════════════════════╗', 'TRADE');
      log('║  💰 CLAIMABLE WINNINGS AVAILABLE!                          ║', 'TRADE');
      log('╠════════════════════════════════════════════════════════════╣', 'TRADE');
      log(`║  Resolved Markets: ${resolvedCount}                                       ║`, 'TRADE');
      log(`║  Estimated Value:  ~$${totalClaimable.toFixed(2)} USDC                           ║`, 'TRADE');
      log('╠════════════════════════════════════════════════════════════╣', 'TRADE');
      log('║  Claim at: https://polymarket.com/portfolio                ║', 'TRADE');
      log('╚════════════════════════════════════════════════════════════╝', 'TRADE');
      log('');
    } else {
      log('No claimable positions found', 'INFO');
    }

  } catch (error) {
    log(`Claim check error: ${error}`, 'WARN');
  }

  log('═'.repeat(60));
  log('');
}

// ============================================================================
// RUN STRATEGY
// ============================================================================

// Run initial claim check on startup
checkClaimablePositions().catch(() => {});

// Schedule hourly claim checks (runs in background during main loop)
setInterval(() => {
  checkClaimablePositions().catch(() => {});
}, CLAIM_CHECK_INTERVAL_MS);

main().catch((error) => {
  log(`Fatal error: ${error}`, 'ERROR');
  process.exit(1);
});
