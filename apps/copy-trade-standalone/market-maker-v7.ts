/**
 * ══════════════════════════════════════════════════════════════════════════════
 * POLYMARKET MARKET MAKER V7 - DURATION RISK STRATEGY
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * OVERVIEW
 * --------
 * This bot trades Polymarket's 15-minute crypto prediction markets (BTC, ETH, XRP, SOL).
 * These markets ask "Will [CRYPTO] go UP or DOWN in the next 15 minutes?"
 *
 * The bot buys BOTH outcomes (UP and DOWN tokens) at favorable prices, creating a
 * "hedged" position that profits regardless of which direction the crypto moves.
 *
 * CORE CONCEPT: BINARY MARKET ARBITRAGE
 * ------------------------------------
 * In binary markets, UP + DOWN tokens always pay out $1.00 total at resolution:
 *   - If BTC goes UP:   UP token = $1.00, DOWN token = $0.00
 *   - If BTC goes DOWN: UP token = $0.00, DOWN token = $1.00
 *
 * PROFIT FORMULA:
 *   If you buy UP @ $0.48 and DOWN @ $0.48
 *   Combined cost = $0.96
 *   Guaranteed payout = $1.00 (one side wins)
 *   PROFIT = $1.00 - $0.96 = $0.04 per share (4¢)
 *
 * KEY INSIGHT: WHY "DURATION RISK"?
 * ---------------------------------
 * Instant arbitrage (buying both sides simultaneously) rarely works because:
 *   - Spreads are tight (combined price ~$0.99-1.01)
 *   - You'd make only 0-1¢ per trade after fees
 *
 * SOLUTION: Take "duration risk" by entering legs sequentially:
 *   1. Buy first leg (e.g., UP @ $0.48) when one side is cheap
 *   2. WAIT for crypto price to move (this is the "duration risk")
 *   3. When crypto moves UP → DOWN token gets cheaper
 *   4. Buy hedge (DOWN @ $0.46) at better price
 *   5. Combined: $0.94 = 6¢ profit!
 *
 * EXAMPLE TRADE FLOW:
 * ------------------
 *   T+0:00  BTC at $100,000, UP=$0.50, DOWN=$0.50
 *   T+0:05  Bot buys 10 UP @ $0.48 (edge above best bid)
 *   T+2:00  BTC rallies to $100,200
 *   T+2:00  Market now: UP=$0.55, DOWN=$0.44
 *   T+2:05  Bot buys 10 DOWN @ $0.45 to hedge
 *   T+2:05  Combined cost: $0.48 + $0.45 = $0.93
 *   T+15:00 Market resolves (either UP or DOWN wins)
 *   T+15:00 Bot receives $1.00 per pair → PROFIT: $0.07/share = $0.70 total
 *
 * STATE MACHINE
 * -------------
 * The bot operates as a finite state machine with these states:
 *
 *   [SCANNING] ──────────────────────────────────────────────────────────────
 *       │ Looking for entry opportunity
 *       │ Checks: liquidity, price levels, existing positions
 *       │ Picks side closer to 50¢ (better mean reversion odds)
 *       ▼
 *   [FIRST_LEG_BIDDING] ────────────────────────────────────────────────────
 *       │ GTC order placed for first leg
 *       │ Aggressive price bumping (every 10s)
 *       │ Timeout after 60s if unfilled
 *       ▼
 *   [WAITING_FOR_HEDGE] ────────────────────────────────────────────────────
 *       │ First leg filled, now holding directional risk
 *       │ Monitoring opposite side for favorable entry
 *       │ Will FAK (Fill And Kill) if ask price is good
 *       │ Or place patient GTC bid
 *       ▼
 *   [HEDGE_BIDDING] ────────────────────────────────────────────────────────
 *       │ GTC hedge order placed
 *       │ Patient price bumping (every 2 min)
 *       │ Timeout triggers position close
 *       ▼
 *   [CLOSING_POSITION] ─────────────────────────────────────────────────────
 *       │ Timeout or market expiring
 *       │ Selling unhedged shares to exit
 *       │ Uses FAK at best bid, then GTC at $0.01 for remainder
 *       ▼
 *   [PAUSED] ───────────────────────────────────────────────────────────────
 *       │ Market expiring within 7:30
 *       │ No new trades allowed
 *       │ Waiting for market rotation
 *
 * MARKET ROTATION
 * ---------------
 * The bot rotates through 4 crypto assets (BTC, ETH, XRP, SOL) to:
 *   - Diversify across uncorrelated price movements
 *   - Always have a market with time remaining
 *   - Avoid concentration risk in single asset
 *
 * 15-minute markets use slug format: {asset}-updown-15m-{unix_timestamp}
 * Example: btc-updown-15m-1702819200
 *
 * RISK MANAGEMENT
 * ---------------
 * 1. MAX_BID ($0.90): Never pay more than 90¢ for any token
 * 2. MIN_BID ($0.10): Ignore bids below 10¢ (no real liquidity)
 * 3. TARGET_COMBINED ($0.96): Only enter if combined < 96¢
 * 4. UNHEDGED_TIMEOUT (10 min): Force close if can't hedge
 * 5. STOP_TRADING (7:30 before expiry): No new positions near expiry
 * 6. FORCE_CLOSE (5:30 before expiry): Liquidate ALL unhedged
 *
 * ORDER TYPES USED
 * ----------------
 * - GTC (Good Till Cancelled): Resting limit orders for patient fills
 * - FAK (Fill And Kill): Aggressive orders that fill immediately or cancel
 *
 * POSITION TRACKING
 * -----------------
 * The bot maintains TWO position tracking systems:
 * 1. Internal tracking: Updated immediately on fills (fast, optimistic)
 * 2. API sync: Fetches from Polymarket API (slower, authoritative)
 *
 * Uses MAX of both to handle:
 * - WebSocket fill notifications
 * - External trades (other bots/manual)
 * - API latency
 *
 * WEBSOCKET CONNECTIONS
 * ---------------------
 * 1. User WS (ws-subscriptions-clob.polymarket.com): Real-time fill notifications
 * 2. RTDS WS (ws-live-data.polymarket.com): Real-time crypto prices (BTC, ETH, etc.)
 *
 * USAGE
 * -----
 *   npx tsx market-maker-v7.ts         # Trade all 4 assets
 *   npx tsx market-maker-v7.ts btc     # BTC only
 *   npx tsx market-maker-v7.ts eth     # ETH only
 *
 * ENVIRONMENT VARIABLES
 * ---------------------
 *   POLYMARKET_PRIVATE_KEY: Ethereum private key for signing orders
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';
import WebSocket from 'ws';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Position sizing
  BID_SIZE: 10,             // Shares per leg

  // Price bounds
  MIN_BID: 0.10,            // Won't bid below this
  MAX_BID: 0.90,            // Won't bid above this

  // Profit targets
  TARGET_COMBINED: 0.96,    // Target combined price for NEW trades (4¢ profit)
  HEDGE_IMBALANCE_MAX: 0.98, // Max combined for hedging - must be profitable (2¢+ per pair)
  MIN_EDGE_PROFIT: 0.02,    // Minimum edge to enter (2¢)

  // Unhedged timeout - close position after this long without hedge (time since first leg fill)
  UNHEDGED_TIMEOUT_MS: 10 * 60 * 1000,  // 10 minutes - give more time to find hedge

  // First leg timing (aggressive)
  FIRST_LEG_CHECK_MS: 1000,       // Check every 1s
  FIRST_LEG_BUMP_AFTER_MS: 10000, // Bump price after 10s
  FIRST_LEG_TIMEOUT_MS: 60000,    // Give up after 60s

  // Hedge leg timing (patient)
  HEDGE_CHECK_MS: 2000,           // Check every 2s
  HEDGE_BUMP_AFTER_MS: 120000,    // Bump price after 2 MINUTES (patient!)
  HEDGE_TIMEOUT_MS: 600000,       // Give up after 10 MINUTES

  // Market rotation
  STOP_TRADING_BEFORE_EXPIRY_MS: 7 * 60 * 1000 + 30 * 1000,  // Stop NEW trades 7:30 before expiry
  FORCE_CLOSE_BEFORE_EXPIRY_MS: 5 * 60 * 1000 + 30 * 1000,   // FORCE close unhedged at 5:30 before expiry
  MARKET_CHECK_MS: 30000,

  // Trading
  ENABLE_TRADING: true,
};

// ============================================================================
// API
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const GAMMA_API_HOST = 'https://gamma-api.polymarket.com';
const WS_HOST = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const RTDS_HOST = 'wss://ws-live-data.polymarket.com';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

// ============================================================================
// RTDS PRICE TRACKING
// ============================================================================

interface PricePoint {
  price: number;
  timestamp: number;
}

// Track last N prices for each asset
const PRICE_HISTORY_LENGTH = 20;  // Keep last 20 price updates
const priceHistory: Record<string, PricePoint[]> = {
  btc: [],
  eth: [],
  xrp: [],
  sol: [],
};

let rtdsWs: WebSocket | null = null;

function connectRTDS(): void {
  rtdsWs = new WebSocket(RTDS_HOST);

  rtdsWs.on('open', () => {
    log('RTDS connected - subscribing to crypto prices', 'INFO');

    // Subscribe to Binance crypto prices (no auth required)
    rtdsWs!.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices',
        type: 'update'
      }]
    }));

    // Ping every 5 seconds to keep alive
    setInterval(() => {
      if (rtdsWs?.readyState === WebSocket.OPEN) {
        rtdsWs.send(JSON.stringify({ action: 'ping' }));
      }
    }, 5000);
  });

  rtdsWs.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle price updates
      if (msg.topic === 'crypto_prices' && msg.payload) {
        const symbol = msg.payload.symbol?.toLowerCase() || '';
        const price = parseFloat(msg.payload.value || '0');
        const timestamp = msg.payload.timestamp || Date.now();

        // Map symbol to asset (btcusdt -> btc)
        let asset = '';
        if (symbol.includes('btc')) asset = 'btc';
        else if (symbol.includes('eth')) asset = 'eth';
        else if (symbol.includes('xrp')) asset = 'xrp';
        else if (symbol.includes('sol')) asset = 'sol';

        if (asset && price > 0) {
          priceHistory[asset].push({ price, timestamp });
          // Keep only last N prices
          if (priceHistory[asset].length > PRICE_HISTORY_LENGTH) {
            priceHistory[asset].shift();
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  });

  rtdsWs.on('close', () => {
    log('RTDS disconnected, reconnecting...', 'WARN');
    setTimeout(connectRTDS, 3000);
  });

  rtdsWs.on('error', (err) => {
    log(`RTDS error: ${err.message}`, 'ERROR');
  });
}

// Calculate price momentum: positive = rising, negative = falling
function getPriceMomentum(asset: string): { direction: 'up' | 'down' | 'neutral', change: number } {
  const history = priceHistory[asset.toLowerCase()];

  if (history.length < 3) {
    return { direction: 'neutral', change: 0 };
  }

  // Compare recent price to older price
  const recent = history.slice(-3);  // Last 3 prices
  const older = history.slice(0, 3); // First 3 prices

  const recentAvg = recent.reduce((sum, p) => sum + p.price, 0) / recent.length;
  const olderAvg = older.reduce((sum, p) => sum + p.price, 0) / older.length;

  const change = ((recentAvg - olderAvg) / olderAvg) * 100;  // % change

  if (change > 0.01) return { direction: 'up', change };    // Rising > 0.01%
  if (change < -0.01) return { direction: 'down', change }; // Falling > 0.01%
  return { direction: 'neutral', change };
}

// All market series available
const ALL_SERIES = [
  // 15-minute markets only
  'btc-up-or-down-15m',
  'eth-up-or-down-15m',
  'xrp-up-or-down-15m',
  'sol-up-or-down-15m',
];

// Get series from command line arg, or use all
// Usage: npx tsx market-maker-v7.ts btc
//        npx tsx market-maker-v7.ts eth
//        npx tsx market-maker-v7.ts xrp
const arg = process.argv[2]?.toLowerCase();
let MARKET_SERIES: string[] = ALL_SERIES;

if (arg) {
  const filtered = ALL_SERIES.filter(s => {
    if (arg === 'btc' || arg === 'btc-15m') return s === 'btc-up-or-down-15m';
    if (arg === 'eth' || arg === 'eth-15m') return s === 'eth-up-or-down-15m';
    if (arg === 'xrp' || arg === 'xrp-15m') return s === 'xrp-up-or-down-15m';
    if (arg === 'sol' || arg === 'sol-15m') return s === 'sol-up-or-down-15m';
    return false;
  });
  if (filtered.length > 0) {
    MARKET_SERIES = filtered;
  }
}

// Track which series we last traded to rotate
let lastTradedSeriesIndex = -1;

// ============================================================================
// ENV
// ============================================================================

const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

// ============================================================================
// CLOB CLIENT
// ============================================================================

let ClobClient: any;
let OrderType: any;
let Side: any;
let clobClient: any;
let apiCreds: { key: string; secret: string; passphrase: string } | null = null;
let ws: WebSocket | null = null;

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
    log('No private key', 'ERROR');
    process.exit(1);
  }

  const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);

  try {
    const tempClient = new ClobClient(CLOB_HOST, 137, wallet, undefined, 2, PROXY_WALLET);
    const creds = await tempClient.createOrDeriveApiKey();
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, creds, 2, PROXY_WALLET);
    apiCreds = {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };
    log('CLOB client initialized');
  } catch (error: any) {
    log(`Init failed: ${error.message}`, 'ERROR');
    process.exit(1);
  }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

let onFillCallback: ((orderId: string, fillPrice: number, fillSize: number) => void) | null = null;

function connectWebSocket(): void {
  if (!apiCreds) {
    log('No API credentials for WebSocket', 'ERROR');
    return;
  }

  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    log('WebSocket connected', 'INFO');

    const subMsg = JSON.stringify({
      auth: {
        apiKey: apiCreds!.key,
        secret: apiCreds!.secret,
        passphrase: apiCreds!.passphrase,
      },
      type: 'user',
      markets: [],
    });
    ws!.send(subMsg);

    setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, 10000);
  });

  ws.on('message', (data: Buffer) => {
    const msg = data.toString();
    if (msg === 'PONG') return;

    try {
      const parsed = JSON.parse(msg);

      if (parsed.event_type === 'trade' || parsed.type === 'trade') {
        const orderId = parsed.order_id || parsed.orderId || parsed.maker_order_id;
        const fillPrice = parseFloat(parsed.price || '0');
        const fillSize = parseFloat(parsed.size || parsed.match_size || '0');

        log(`WS FILL: Order ${orderId?.slice(0, 8)} filled ${fillSize} @ $${fillPrice.toFixed(2)}`, 'FILL');

        if (onFillCallback && orderId) {
          onFillCallback(orderId, fillPrice, fillSize);
        }
      }
    } catch {
      // Not JSON, ignore
    }
  });

  ws.on('close', () => {
    log('WebSocket disconnected, reconnecting...', 'WARN');
    setTimeout(connectWebSocket, 3000);
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`, 'ERROR');
  });
}

function setFillCallback(cb: (orderId: string, fillPrice: number, fillSize: number) => void): void {
  onFillCallback = cb;
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
  asset: string;      // BTC, ETH, XRP
  duration: string;   // 15M, 1H
}

type TradingState =
  | 'scanning'           // Looking for entry opportunity
  | 'first_leg_bidding'  // First leg bid placed
  | 'waiting_for_hedge'  // First leg filled, waiting for hedge opportunity
  | 'hedge_bidding'      // Hedge bid placed
  | 'closing_position'   // Selling unhedged leg (timeout)
  | 'paused';            // Market expiring

interface Position {
  upShares: number;
  downShares: number;
  upAvgCost: number;      // Real avg cost from API
  downAvgCost: number;    // Real avg cost from API
  completedPairs: number;

  state: TradingState;

  // Current order tracking
  currentOrderId?: string;
  currentOrderSide?: 'up' | 'down';
  currentOrderPrice: number;
  orderPlacedAt: number;
  lastPriceBump: number;

  // First leg info (for hedge calculation)
  firstLegFillPrice: number;
  firstLegFilledSize: number;  // Actual filled size (may be partial)
  firstLegSide: 'up' | 'down';
  firstLegFilledAt: number;

  // Metrics
  totalProfit: number;
  totalLoss: number;
}

// ============================================================================
// STATE
// ============================================================================

let market: Market | null = null;

// Internal position tracking - updated immediately on fills, more reliable than API
let internalUp = 0;
let internalDown = 0;

// Force close tracking - prevent repeated selling
let forceCloseStarted = false;
let forceCloseSide: 'up' | 'down' | null = null;
let forceCloseTarget = 0;  // How many shares we need to sell (calculated once)

let position: Position = {
  upShares: 0,
  downShares: 0,
  upAvgCost: 0,
  downAvgCost: 0,
  completedPairs: 0,
  state: 'scanning',
  currentOrderPrice: 0,
  orderPlacedAt: 0,
  lastPriceBump: 0,
  firstLegFillPrice: 0,
  firstLegFilledSize: 0,
  firstLegSide: 'up',
  firstLegFilledAt: 0,
  totalProfit: 0,
  totalLoss: 0,
};

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'FILL' | 'ORDER' | 'PROFIT' | 'LOSS' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    FILL: '💰',
    ORDER: '📝',
    PROFIT: '✅',
    LOSS: '🔴'
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

function parseEndTime(question: string): Date | undefined {
  const timeRangeMatch = question.match(/(\d{1,2}):?(\d{2})?(AM|PM)-(\d{1,2}):?(\d{2})?(AM|PM)\s*ET/i);

  if (timeRangeMatch) {
    const now = new Date();
    let hour = parseInt(timeRangeMatch[4]);
    const minute = timeRangeMatch[5] ? parseInt(timeRangeMatch[5]) : 0;
    const ampm = timeRangeMatch[6].toUpperCase();

    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;

    // ET is UTC-5
    const etToUtc = 5;
    const endTime = new Date(now);
    endTime.setUTCHours(hour + etToUtc, minute, 0, 0);

    if (endTime < now) {
      endTime.setDate(endTime.getDate() + 1);
    }

    return endTime;
  }

  return undefined;
}

// Calculate the current 15m market slug based on time
// Slug format: btc-updown-15m-{START_UNIX_TIMESTAMP}
function calculateCurrentMarketSlug(asset: string): { slug: string; startTime: number; endTime: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const interval = 15 * 60; // 15 minutes in seconds

  // Find the start of the current 15-min window
  const currentWindowStart = Math.floor(nowSec / interval) * interval;

  // Market slug uses lowercase asset
  const slug = `${asset.toLowerCase()}-updown-15m-${currentWindowStart}`;
  const endTime = currentWindowStart + interval;

  return { slug, startTime: currentWindowStart, endTime };
}

async function findActiveMarket(): Promise<Market | null> {
  const now = Date.now();

  // Rotate through assets - start from the next one after last traded
  const startIndex = (lastTradedSeriesIndex + 1) % MARKET_SERIES.length;

  // Try each asset in rotation order
  for (let i = 0; i < MARKET_SERIES.length; i++) {
    const seriesIndex = (startIndex + i) % MARKET_SERIES.length;
    const seriesSlug = MARKET_SERIES[seriesIndex];
    const asset = seriesSlug.split('-')[0].toUpperCase(); // BTC, ETH, etc.

    // Calculate what the current market slug should be
    const { slug: eventSlug, startTime, endTime } = calculateCurrentMarketSlug(asset);
    const endTimeMs = endTime * 1000;
    const timeToExpiry = endTimeMs - now;

    // Skip if less than 7:30 to expiry (our trading cutoff)
    if (timeToExpiry < CONFIG.STOP_TRADING_BEFORE_EXPIRY_MS) {
      log(`${asset} 15M: Only ${Math.floor(timeToExpiry / 1000)}s left - skipping`, 'INFO');
      continue;
    }

    // Fetch this specific event directly
    try {
      log(`Trying ${asset} 15M: ${eventSlug}`, 'INFO');
      const eventRes = await fetch(`${GAMMA_API_HOST}/events?slug=${eventSlug}`);

      if (!eventRes.ok) {
        log(`Event ${eventSlug} not found (${eventRes.status})`, 'WARN');
        continue;
      }

      const eventData = await eventRes.json();
      if (!eventData || eventData.length === 0) {
        log(`Event ${eventSlug} empty response`, 'WARN');
        continue;
      }

      const event = eventData[0];
      if (event.closed) {
        log(`Event ${eventSlug} is closed`, 'WARN');
        continue;
      }

      const m = event.markets?.[0];
      if (!m) {
        log('No market data in event', 'WARN');
        continue;
      }

      let upTokenId = '';
      let downTokenId = '';
      try {
        const tokenIds = JSON.parse(m.clobTokenIds || '[]');
        upTokenId = tokenIds[0] || '';
        downTokenId = tokenIds[1] || '';
      } catch {
        log('Failed to parse token IDs', 'ERROR');
        continue;
      }

      if (!upTokenId || !downTokenId) {
        log('Missing token IDs', 'ERROR');
        continue;
      }

      // Success - update rotation index and return market
      lastTradedSeriesIndex = seriesIndex;

      log(`Found: ${asset} 15M - ${event.title} (${Math.floor(timeToExpiry / 1000)}s to expiry)`, 'INFO');

      return {
        conditionId: m.conditionId,
        question: m.question,
        upTokenId,
        downTokenId,
        tickSize: m.orderPriceMinTickSize?.toString() || '0.01',
        negRisk: m.negRisk || false,
        endTime: new Date(endTimeMs),
        asset,
        duration: '15M',
      };
    } catch (error: any) {
      log(`Market fetch error for ${asset}: ${error.message}`, 'ERROR');
      continue;
    }
  }

  log('No active market found across all series', 'WARN');
  return null;
}

// ============================================================================
// POSITION FETCHING (Real avg cost from Polymarket API)
// ============================================================================

interface ApiPosition {
  size: number;
  avgPrice: number;
  outcome: string;  // "Up" or "Down"
  conditionId: string;
}

async function fetchPositionsFromApi(): Promise<{ upShares: number; downShares: number; upAvgCost: number; downAvgCost: number }> {
  if (!market) return { upShares: internalUp, downShares: internalDown, upAvgCost: 0, downAvgCost: 0 };

  try {
    const res = await fetch(`${DATA_API_HOST}/positions?user=${PROXY_WALLET}`);
    if (!res.ok) {
      log(`Position API error: ${res.status} - using internal: ${internalUp}↑/${internalDown}↓`, 'WARN');
      return { upShares: internalUp, downShares: internalDown, upAvgCost: 0, downAvgCost: 0 };
    }

    const positions: ApiPosition[] = await res.json();

    let apiUp = 0, apiDown = 0, upAvgCost = 0, downAvgCost = 0;

    // Normalize conditionId for comparison (lowercase, handle 0x prefix)
    const marketConditionId = market.conditionId.toLowerCase().replace(/^0x/, '');

    for (const pos of positions) {
      const posConditionId = pos.conditionId.toLowerCase().replace(/^0x/, '');
      if (posConditionId !== marketConditionId) continue;

      if (pos.outcome === 'Up' || pos.outcome === 'Yes') {
        apiUp = pos.size;
        upAvgCost = pos.avgPrice;
      } else if (pos.outcome === 'Down' || pos.outcome === 'No') {
        apiDown = pos.size;
        downAvgCost = pos.avgPrice;
      }
    }

    // SMART MERGE: Use max of internal and API (catches both our fills and external fills)
    // Only trust API's lower values if internal is also 0 (fresh start)
    let finalUp = apiUp;
    let finalDown = apiDown;

    if (internalUp > 0 || internalDown > 0) {
      // We have internal tracking - use max to be safe
      finalUp = Math.max(internalUp, apiUp);
      finalDown = Math.max(internalDown, apiDown);
    }

    // Update internal tracking if API shows higher (external fills)
    if (apiUp > internalUp) internalUp = apiUp;
    if (apiDown > internalDown) internalDown = apiDown;

    // Log comparison
    if (apiUp !== internalUp || apiDown !== internalDown || finalUp > 0 || finalDown > 0) {
      log(`POS: Internal ${internalUp}↑/${internalDown}↓ | API ${apiUp}↑/${apiDown}↓ | Using ${finalUp}↑/${finalDown}↓`, 'INFO');
    }

    return { upShares: finalUp, downShares: finalDown, upAvgCost, downAvgCost };
  } catch (error: any) {
    log(`Position API failed: ${error.message} - using internal: ${internalUp}↑/${internalDown}↓`, 'WARN');
    return { upShares: internalUp, downShares: internalDown, upAvgCost: 0, downAvgCost: 0 };
  }
}

// ============================================================================
// ORDER BOOK
// ============================================================================

interface OrderBook {
  bestBid: number;
  bestAsk: number;
  bidDepth: number;
  askDepth: number;
}

async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return { bestBid: 0, bestAsk: 1, bidDepth: 0, askDepth: 0 };

    const book = await res.json();
    const bids = book.bids || [];
    const asks = book.asks || [];

    // Find actual best bid (max price) and best ask (min price)
    // Filter out placeholder liquidity (bids below $0.10, asks above $0.90)
    let bestBid = 0;
    let bestAsk = 1;
    let bidDepth = 0;
    let askDepth = 0;

    for (const bid of bids) {
      const price = parseFloat(bid.price);
      const size = parseFloat(bid.size);
      // Only consider bids >= $0.10 as real liquidity
      if (price >= 0.10 && price > bestBid) bestBid = price;
      bidDepth += size;
    }

    for (const ask of asks) {
      const price = parseFloat(ask.price);
      const size = parseFloat(ask.size);
      // Only consider asks <= $0.90 as real liquidity
      if (price <= 0.90 && price < bestAsk) bestAsk = price;
      askDepth += size;
    }

    return { bestBid, bestAsk, bidDepth, askDepth };
  } catch {
    return { bestBid: 0, bestAsk: 1, bidDepth: 0, askDepth: 0 };
  }
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function cancelOrder(orderId: string | undefined): Promise<void> {
  if (!orderId || !clobClient) return;
  try {
    await clobClient.cancelOrder({ orderID: orderId });
    log(`Cancelled order ${orderId.slice(0, 8)}`, 'ORDER');
  } catch {
    // Already filled or cancelled
  }
}

async function checkOrderStatus(orderId: string): Promise<'open' | 'filled' | 'cancelled'> {
  if (!clobClient) return 'cancelled';
  try {
    const order = await clobClient.getOrder(orderId);
    if (!order) return 'cancelled';

    const sizeMatched = parseFloat(order.size_matched || '0');
    const originalSize = parseFloat(order.original_size || order.size || '0');

    if (sizeMatched >= originalSize * 0.99) return 'filled';
    if (order.status === 'CANCELED' || order.status === 'CANCELLED') return 'cancelled';
    return 'open';
  } catch {
    return 'cancelled';
  }
}

// Get actual filled size from an order (for partial fills)
async function getOrderFilledSize(orderId: string): Promise<number> {
  if (!clobClient) return 0;
  try {
    const order = await clobClient.getOrder(orderId);
    if (!order) return 0;
    return parseFloat(order.size_matched || '0');
  } catch {
    return 0;
  }
}

async function placeOrder(side: 'up' | 'down', price: number, size?: number): Promise<string | undefined> {
  if (!market || !clobClient) return undefined;

  const orderSize = size ?? CONFIG.BID_SIZE;  // Use provided size or default to config
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING) {
    log(`[DRY] BID ${side.toUpperCase()}: ${orderSize} @ $${price.toFixed(2)}`, 'ORDER');
    return 'dry-run-order';
  }

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price,
        side: Side.BUY,
        size: orderSize,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`BID ${side.toUpperCase()}: ${orderSize} @ $${price.toFixed(2)} [${orderId.slice(0, 8)}]`, 'ORDER');
    }
    return orderId;
  } catch (error: any) {
    log(`Order failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

// FAK (Fill And Kill) BUY - fills what it can immediately, returns amount filled
async function placeFAKBuy(side: 'up' | 'down', price: number, size: number): Promise<number> {
  if (!market || !clobClient) return 0;

  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING) {
    log(`[DRY] FAK BUY ${side.toUpperCase()}: ${size} @ $${price.toFixed(2)}`, 'ORDER');
    // Update internal tracking even in dry run
    if (side === 'up') internalUp += size;
    else internalDown += size;
    return size;
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
      OrderType.FAK
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      await new Promise(r => setTimeout(r, 500));
      const filledSize = await getOrderFilledSize(orderId);

      // Update internal tracking immediately
      if (filledSize > 0) {
        if (side === 'up') internalUp += filledSize;
        else internalDown += filledSize;
        log(`FAK BUY ${side.toUpperCase()}: filled ${filledSize} @ $${price.toFixed(2)} [${orderId.slice(0, 8)}] | Internal: ${internalUp}↑/${internalDown}↓`, 'ORDER');
      }
      return filledSize;
    }
    return 0;
  } catch (error: any) {
    log(`FAK buy failed: ${error.message}`, 'ERROR');
    return 0;
  }
}

// FAK (Fill And Kill) sell - fills what it can, returns amount filled
async function placeFAKSell(side: 'up' | 'down', price: number, size: number): Promise<number> {
  if (!market || !clobClient) return 0;

  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING) {
    log(`[DRY] FAK SELL ${side.toUpperCase()}: ${size} @ $${price.toFixed(2)}`, 'ORDER');
    // Update internal tracking even in dry run
    if (side === 'up') internalUp = Math.max(0, internalUp - size);
    else internalDown = Math.max(0, internalDown - size);
    return size;
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
      OrderType.FAK
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      await new Promise(r => setTimeout(r, 500));
      const filledSize = await getOrderFilledSize(orderId);

      // Update internal tracking immediately
      if (filledSize > 0) {
        if (side === 'up') internalUp = Math.max(0, internalUp - filledSize);
        else internalDown = Math.max(0, internalDown - filledSize);
        log(`FAK SELL ${side.toUpperCase()}: filled ${filledSize} @ $${price.toFixed(2)} [${orderId.slice(0, 8)}] | Internal: ${internalUp}↑/${internalDown}↓`, 'ORDER');
      }
      return filledSize;
    }
    return 0;
  } catch (error: any) {
    log(`FAK sell failed: ${error.message}`, 'ERROR');
    return 0;
  }
}

// GTC sell at extreme price - guaranteed to fill eventually
async function placeExtremeSell(side: 'up' | 'down', size: number): Promise<string | undefined> {
  if (!market || !clobClient) return undefined;

  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;
  const extremePrice = 0.01;  // 1 cent - will match any bid

  if (!CONFIG.ENABLE_TRADING) {
    log(`[DRY] EXTREME SELL ${side.toUpperCase()}: ${size} @ $${extremePrice.toFixed(2)}`, 'ORDER');
    // Update internal tracking for dry run consistency
    if (side === 'up') internalUp = Math.max(0, internalUp - size);
    else internalDown = Math.max(0, internalDown - size);
    return 'dry-run-order';
  }

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: extremePrice,
        side: Side.SELL,
        size: size,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC  // Good Till Cancelled - stays open until filled
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`🚨 EXTREME SELL ${side.toUpperCase()}: ${size} @ $${extremePrice.toFixed(2)} [${orderId.slice(0, 8)}] - GTC posted`, 'ORDER');
      return orderId;
    }
    return undefined;
  } catch (error: any) {
    log(`Extreme sell failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

// ============================================================================
// DURATION RISK STATE MACHINE
// ============================================================================

async function runStateMachine(): Promise<void> {
  const now = Date.now();

  // Check market expiry
  if (market?.endTime) {
    const timeToExpiry = market.endTime.getTime() - now;

    // ===== FORCE CLOSE AT 5:30 - HIGHEST PRIORITY =====
    // Check for ANY imbalance and aggressively close it
    if (timeToExpiry < CONFIG.FORCE_CLOSE_BEFORE_EXPIRY_MS) {
      // FIRST TIME entering force close: calculate imbalance ONCE and lock in what to sell
      if (!forceCloseStarted) {
        // Sync from API to get accurate position counts
        const apiPos = await fetchPositionsFromApi();
        position.upShares = apiPos.upShares;
        position.downShares = apiPos.downShares;
        position.upAvgCost = apiPos.upAvgCost;
        position.downAvgCost = apiPos.downAvgCost;

        const imbalance = position.upShares - position.downShares;

        if (imbalance !== 0) {
          // Lock in the side and amount to sell - NEVER recalculate
          forceCloseStarted = true;
          forceCloseSide = imbalance > 0 ? 'up' : 'down';
          forceCloseTarget = Math.abs(imbalance);
          log(`⚠️ FORCE CLOSE INITIATED: Need to sell ${forceCloseTarget} ${forceCloseSide.toUpperCase()} to balance (${position.upShares} UP / ${position.downShares} DOWN)`, 'WARN');

          // Cancel any pending orders first
          if (position.currentOrderId) {
            await cancelOrder(position.currentOrderId);
            position.currentOrderId = undefined;
          }
        } else {
          // Balanced - just pause
          log(`Market expiring in ${Math.floor(timeToExpiry / 1000)}s - position balanced, pausing`, 'INFO');
          position.state = 'paused';
          return;
        }
      }

      // If force close is active, continue selling the locked-in side
      if (forceCloseStarted && forceCloseSide) {
        // Calculate remaining based on INTERNAL tracking, not API
        const currentShares = forceCloseSide === 'up' ? internalUp : internalDown;
        const oppositeShares = forceCloseSide === 'up' ? internalDown : internalUp;
        const remainingToSell = Math.max(0, currentShares - oppositeShares);

        if (remainingToSell === 0) {
          log(`Force close complete: ${internalUp} UP / ${internalDown} DOWN - balanced!`, 'PROFIT');
          forceCloseStarted = false;
          forceCloseSide = null;
          forceCloseTarget = 0;
          position.state = 'paused';
          return;
        }

        log(`⚠️ FORCE CLOSE: ${Math.floor(timeToExpiry / 1000)}s left! Selling ${remainingToSell} ${forceCloseSide.toUpperCase()} (internal: ${internalUp}↑/${internalDown}↓)`, 'WARN');

        // Get best bid price for FAK
        const tokenId = forceCloseSide === 'up' ? market.upTokenId : market.downTokenId;
        let bestBid = 0;
        try {
          const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
          if (res.ok) {
            const book = await res.json();
            for (const bid of book.bids || []) {
              const price = parseFloat(bid.price);
              if (price > bestBid) bestBid = price;
            }
          }
        } catch {}

        if (bestBid > 0) {
          // Try FAK at best bid - will fill what it can
          log(`FAK SELL at best bid $${bestBid.toFixed(2)}...`, 'ORDER');
          await placeFAKSell(forceCloseSide, bestBid, remainingToSell);
          // placeFAKSell already updates internal tracking
        }

        // Check if we still have remaining after FAK (using internal tracking)
        const afterFAKShares = forceCloseSide === 'up' ? internalUp : internalDown;
        const afterFAKOpposite = forceCloseSide === 'up' ? internalDown : internalUp;
        const stillRemaining = Math.max(0, afterFAKShares - afterFAKOpposite);

        if (stillRemaining > 0) {
          log(`🚨 ${stillRemaining} remaining - posting GTC at $0.01 to guarantee close!`, 'WARN');
          const gtcOrderId = await placeExtremeSell(forceCloseSide, stillRemaining);
          if (gtcOrderId) {
            position.currentOrderId = gtcOrderId;
          }
        }

        position.state = 'closing_position';
        return;
      }

      // No force close needed - pause
      if (position.state !== 'paused') {
        position.state = 'paused';
      }
      return;
    }

    // ===== STOP NEW TRADES AT 7:30 =====
    if (timeToExpiry < CONFIG.STOP_TRADING_BEFORE_EXPIRY_MS) {
      // Cancel any pending orders
      if (position.currentOrderId) {
        await cancelOrder(position.currentOrderId);
        position.currentOrderId = undefined;
      }

      // If we have an unhedged position (first leg filled but no hedge), close it
      if (position.firstLegFillPrice > 0 && position.state !== 'closing_position') {
        log(`Market expiring in ${Math.floor(timeToExpiry / 1000)}s - CLOSING UNHEDGED POSITION`, 'WARN');
        position.state = 'closing_position';
        return;
      }

      // Check for imbalance even without pending first leg
      const imbalance = position.upShares - position.downShares;
      if (imbalance !== 0 && position.state !== 'closing_position') {
        log(`Market expiring in ${Math.floor(timeToExpiry / 1000)}s - CLOSING IMBALANCED POSITION (${position.upShares} UP / ${position.downShares} DOWN)`, 'WARN');
        position.state = 'closing_position';
        return;
      }

      // No unhedged position - just pause
      if (position.state !== 'paused') {
        log(`Market expiring in ${Math.floor(timeToExpiry / 1000)}s - stopping new trades`, 'WARN');
        position.state = 'paused';
      }
      return;
    }
  }

  switch (position.state) {
    // ========== SCANNING FOR ENTRY ==========
    case 'scanning': {
      if (!market) break;

      // Sync positions from API every scan cycle to stay accurate
      const apiPos = await fetchPositionsFromApi();
      position.upShares = apiPos.upShares;
      position.downShares = apiPos.downShares;
      position.upAvgCost = apiPos.upAvgCost;
      position.downAvgCost = apiPos.downAvgCost;

      const upBook = await fetchOrderBook(market.upTokenId);
      const downBook = await fetchOrderBook(market.downTokenId);

      // Calculate edge prices (1¢ above best bid)
      const upEdge = Math.min(CONFIG.MAX_BID, Math.max(CONFIG.MIN_BID, upBook.bestBid + 0.01));
      const downEdge = Math.min(CONFIG.MAX_BID, Math.max(CONFIG.MIN_BID, downBook.bestBid + 0.01));

      // Log current state
      const momentum = getPriceMomentum(market.asset);
      log(`[${market.asset} ${market.duration}] Scanning: UP $${upEdge.toFixed(2)} | DOWN $${downEdge.toFixed(2)} | Pos: ${position.upShares}↑/${position.downShares}↓ (avg: $${position.upAvgCost.toFixed(2)}/$${position.downAvgCost.toFixed(2)}) | ${market.asset} ${momentum.direction.toUpperCase()}`, 'INFO');

      // ===== CHECK FOR EXISTING IMBALANCE TO HEDGE =====
      const imbalance = position.upShares - position.downShares;
      if (imbalance !== 0) {
        // We have an imbalance - try to hedge it!
        const hedgeSide: 'up' | 'down' = imbalance < 0 ? 'up' : 'down';  // Buy opposite of excess
        const sharesToHedge = Math.abs(imbalance);
        const excessSide = imbalance > 0 ? 'up' : 'down';

        // Get the best ASK for hedge side - this is what we pay to buy immediately
        const hedgeBook = hedgeSide === 'up' ? upBook : downBook;
        const bestAsk = hedgeBook.bestAsk;  // Best price to buy immediately
        const bidEdge = hedgeSide === 'up' ? upEdge : downEdge;  // Edge for GTC bid

        // Use ACTUAL avg cost from API, but FALLBACK to firstLegFillPrice if API hasn't updated
        const apiExcessCost = excessSide === 'up' ? position.upAvgCost : position.downAvgCost;
        const excessAvgCost = apiExcessCost > 0 ? apiExcessCost : position.firstLegFillPrice;

        // SAFETY: If we don't know the cost, don't hedge (could lock in loss)
        if (excessAvgCost <= 0) {
          log(`[${market.asset} ${market.duration}] ⚠️ Unknown avg cost for ${excessSide.toUpperCase()} - waiting for API sync`, 'WARN');
          break;
        }

        const combinedIfFAK = excessAvgCost + bestAsk;  // What we'd pay to FAK now
        const combinedIfBid = excessAvgCost + bidEdge;  // What we'd pay if bid fills

        log(`[${market.asset} ${market.duration}] IMBALANCE: ${sharesToHedge} ${excessSide.toUpperCase()} @ $${excessAvgCost.toFixed(2)} | ASK: $${bestAsk.toFixed(2)} (=$${combinedIfFAK.toFixed(2)}) | BID: $${bidEdge.toFixed(2)} (=$${combinedIfBid.toFixed(2)})`, 'INFO');

        // AGGRESSIVE: FAK at best ask if profitable (combined < limit)
        if (combinedIfFAK < CONFIG.HEDGE_IMBALANCE_MAX && bestAsk <= CONFIG.MAX_BID) {
          const profit = ((1 - combinedIfFAK) * 100).toFixed(0);
          log(`[${market.asset} ${market.duration}] 🎯 FAK HEDGE: ${sharesToHedge} ${hedgeSide.toUpperCase()} @ $${bestAsk.toFixed(2)} (combined $${combinedIfFAK.toFixed(2)} = ${profit}¢ profit)`, 'ORDER');

          const filled = await placeFAKBuy(hedgeSide, bestAsk, sharesToHedge);

          if (filled > 0) {
            log(`FAK filled ${filled}/${sharesToHedge} - syncing positions`, 'FILL');
            // Sync positions from API
            const apiPos2 = await fetchPositionsFromApi();
            position.upShares = apiPos2.upShares;
            position.downShares = apiPos2.downShares;
            position.upAvgCost = apiPos2.upAvgCost;
            position.downAvgCost = apiPos2.downAvgCost;
          }

          // Check remaining imbalance
          const remainingImbalance = Math.abs(position.upShares - position.downShares);
          if (remainingImbalance > 0) {
            // Place GTC bid for remaining
            log(`${remainingImbalance} remaining - placing GTC bid @ $${bidEdge.toFixed(2)}`, 'ORDER');
            const orderId = await placeOrder(hedgeSide, bidEdge, remainingImbalance);
            if (orderId) {
              position.currentOrderId = orderId;
              position.currentOrderSide = hedgeSide;
              position.currentOrderPrice = bidEdge;
              position.orderPlacedAt = now;
              position.lastPriceBump = now;
              position.firstLegSide = excessSide;
              position.firstLegFillPrice = excessAvgCost;
              position.firstLegFilledSize = remainingImbalance;
              position.firstLegFilledAt = now;
              position.state = 'hedge_bidding';
            }
          }
          break;
        }

        // If FAK not profitable but GTC bid would be, place GTC bid
        if (combinedIfBid < CONFIG.HEDGE_IMBALANCE_MAX) {
          const profit = ((1 - combinedIfBid) * 100).toFixed(0);
          log(`[${market.asset} ${market.duration}] 📝 GTC HEDGE: BID ${sharesToHedge} ${hedgeSide.toUpperCase()} @ $${bidEdge.toFixed(2)} (combined $${combinedIfBid.toFixed(2)} = ${profit}¢ profit)`, 'ORDER');

          const orderId = await placeOrder(hedgeSide, bidEdge, sharesToHedge);
          if (orderId) {
            position.currentOrderId = orderId;
            position.currentOrderSide = hedgeSide;
            position.currentOrderPrice = bidEdge;
            position.orderPlacedAt = now;
            position.lastPriceBump = now;
            position.firstLegSide = excessSide;
            position.firstLegFillPrice = excessAvgCost;
            position.firstLegFilledSize = sharesToHedge;
            position.firstLegFilledAt = now;
            position.state = 'hedge_bidding';
          }
          break;
        }

        log(`[${market.asset} ${market.duration}] No profitable hedge: ASK $${combinedIfFAK.toFixed(2)} / BID $${combinedIfBid.toFixed(2)} >= $${CONFIG.HEDGE_IMBALANCE_MAX.toFixed(2)}`, 'INFO');
        break;
      }

      // ===== NO IMBALANCE OR NO HEDGE OPPORTUNITY - PLACE NEW ANCHOR =====
      // SAFEGUARD: Double-check we're not adding to existing imbalance
      // This catches cases where position sync failed or returned stale data
      if (position.upShares > 0 || position.downShares > 0) {
        const currentImbalance = position.upShares - position.downShares;
        if (currentImbalance !== 0) {
          log(`⛔ BLOCKED: Have ${position.upShares} UP / ${position.downShares} DOWN - not placing anchor while imbalanced!`, 'WARN');
          break;
        }
      }

      // Pick the side closer to 50¢ - betting on mean reversion / swing
      const upDistFrom50 = Math.abs(upEdge - 0.50);
      const downDistFrom50 = Math.abs(downEdge - 0.50);
      const side: 'up' | 'down' = upDistFrom50 <= downDistFrom50 ? 'up' : 'down';
      const entryPrice = side === 'up' ? upEdge : downEdge;

      // Skip if no real liquidity (bestBid was 0, so edge = MIN_BID)
      const book = side === 'up' ? upBook : downBook;
      if (book.bestBid < 0.10) {
        log(`No real liquidity for ${side.toUpperCase()} (bestBid $${book.bestBid.toFixed(2)})`, 'WARN');
        break;
      }

      // Max entry price - don't enter above 45¢ (leaves room for swings)
      if (entryPrice > 0.45) {
        log(`[${market.asset} ${market.duration}] Entry too high: $${entryPrice.toFixed(2)} > $0.45 - skipping`, 'INFO');
        break;
      }

      // Check hedge is achievable BEFORE entering
      // If we enter at entryPrice, the hedge ask must be low enough to profit
      const hedgeSideBook = side === 'up' ? downBook : upBook;
      const hedgeAsk = hedgeSideBook.bestAsk;
      const worstCaseCombined = entryPrice + hedgeAsk;
      if (worstCaseCombined > CONFIG.HEDGE_IMBALANCE_MAX) {
        log(`[${market.asset} ${market.duration}] Hedge not achievable: $${entryPrice.toFixed(2)} + $${hedgeAsk.toFixed(2)} = $${worstCaseCombined.toFixed(2)} > $${CONFIG.HEDGE_IMBALANCE_MAX}`, 'INFO');
        break;
      }

      // Note: Balanced positions (fully hedged) are OK - we can add more trades

      // Place first leg order - ANCHOR TRADE
      const orderId = await placeOrder(side, entryPrice);
      if (orderId) {
        position.currentOrderId = orderId;
        position.currentOrderSide = side;
        position.currentOrderPrice = entryPrice;
        position.orderPlacedAt = now;
        position.lastPriceBump = now;
        position.firstLegSide = side;
        position.state = 'first_leg_bidding';
        log(`[${market.asset} ${market.duration}] ANCHOR: BID ${side.toUpperCase()} @ $${entryPrice.toFixed(2)} (position: 0↑/0↓)`, 'ORDER');
      }
      break;
    }

    // ========== FIRST LEG BIDDING (AGGRESSIVE) ==========
    case 'first_leg_bidding': {
      if (!position.currentOrderId || !market) {
        position.state = 'scanning';
        break;
      }

      const status = await checkOrderStatus(position.currentOrderId);

      if (status === 'filled') {
        const fillPrice = position.currentOrderPrice;
        // Get actual filled size (may be partial fill)
        const filledSize = await getOrderFilledSize(position.currentOrderId);
        const actualSize = filledSize > 0 ? filledSize : CONFIG.BID_SIZE;  // Fallback to config if API fails

        // Update internal tracking immediately
        if (position.currentOrderSide === 'up') internalUp += actualSize;
        else internalDown += actualSize;

        // Sync positions from API to get accurate avg costs
        const apiPos = await fetchPositionsFromApi();
        position.upShares = apiPos.upShares;
        position.downShares = apiPos.downShares;
        position.upAvgCost = apiPos.upAvgCost;
        position.downAvgCost = apiPos.downAvgCost;

        position.firstLegFillPrice = fillPrice;
        position.firstLegFilledSize = actualSize;
        position.firstLegFilledAt = now;
        position.currentOrderId = undefined;

        log(`[${market.asset} ${market.duration}] ANCHOR FILLED: ${actualSize} ${position.currentOrderSide?.toUpperCase()} @ $${fillPrice.toFixed(2)} | Internal: ${internalUp}↑/${internalDown}↓`, 'FILL');

        // INSTANT FAK HEDGE - don't wait, lock it in immediately
        const hedgeSide: 'up' | 'down' = position.currentOrderSide === 'up' ? 'down' : 'up';
        const hedgeTokenId = hedgeSide === 'up' ? market.upTokenId : market.downTokenId;
        const hedgeBook = await fetchOrderBook(hedgeTokenId);
        const hedgeAsk = hedgeBook.bestAsk;
        const instantCombined = fillPrice + hedgeAsk;

        if (instantCombined <= CONFIG.HEDGE_IMBALANCE_MAX && hedgeAsk > 0) {
          log(`[${market.asset} ${market.duration}] ⚡ INSTANT FAK HEDGE: ${actualSize} ${hedgeSide.toUpperCase()} @ $${hedgeAsk.toFixed(2)} (combined $${instantCombined.toFixed(2)})`, 'ORDER');
          const hedgeFilled = await placeFAKBuy(hedgeSide, hedgeAsk, actualSize);

          if (hedgeFilled >= actualSize) {
            // Fully hedged!
            log(`✅ INSTANT HEDGE SUCCESS: ${internalUp}↑/${internalDown}↓`, 'PROFIT');
            position.firstLegFillPrice = 0;
            position.firstLegFilledSize = 0;
            position.state = 'scanning';
            break;
          } else if (hedgeFilled > 0) {
            // Partial fill - continue to waiting_for_hedge for remainder
            log(`Partial instant hedge: ${hedgeFilled}/${actualSize} - waiting for rest`, 'INFO');
          }
        } else {
          log(`[${market.asset} ${market.duration}] ⚠️ Instant hedge too expensive: $${fillPrice.toFixed(2)} + $${hedgeAsk.toFixed(2)} = $${instantCombined.toFixed(2)}`, 'WARN');
        }

        position.firstLegSide = position.currentOrderSide!;
        position.state = 'waiting_for_hedge';
        break;
      }

      if (status === 'cancelled') {
        log(`First leg order cancelled`, 'WARN');
        position.currentOrderId = undefined;
        position.state = 'scanning';
        break;
      }

      // Aggressive price bumping for first leg
      const timeSinceBump = now - position.lastPriceBump;
      if (timeSinceBump > CONFIG.FIRST_LEG_BUMP_AFTER_MS && position.currentOrderPrice < CONFIG.MAX_BID) {
        await cancelOrder(position.currentOrderId);

        const newPrice = Math.min(CONFIG.MAX_BID, position.currentOrderPrice + 0.01);
        log(`Bumping first leg: $${position.currentOrderPrice.toFixed(2)} → $${newPrice.toFixed(2)}`, 'ORDER');

        const orderId = await placeOrder(position.currentOrderSide!, newPrice);
        if (orderId) {
          position.currentOrderId = orderId;
          position.currentOrderPrice = newPrice;
          position.lastPriceBump = now;
        } else {
          position.state = 'scanning';
        }
        break;
      }

      // Timeout
      const timeSincePlaced = now - position.orderPlacedAt;
      if (timeSincePlaced > CONFIG.FIRST_LEG_TIMEOUT_MS) {
        log(`First leg timeout - cancelling`, 'WARN');
        await cancelOrder(position.currentOrderId);
        position.currentOrderId = undefined;
        position.state = 'scanning';
      }
      break;
    }

    // ========== WAITING FOR HEDGE OPPORTUNITY ==========
    case 'waiting_for_hedge': {
      if (!market) {
        position.state = 'scanning';
        break;
      }

      // Sync positions first to get accurate counts
      const apiPosWait = await fetchPositionsFromApi();
      position.upShares = apiPosWait.upShares;
      position.downShares = apiPosWait.downShares;
      position.upAvgCost = apiPosWait.upAvgCost;
      position.downAvgCost = apiPosWait.downAvgCost;

      // Use actual avg cost from API, but FALLBACK to firstLegFillPrice if API hasn't updated yet
      const apiAvgCost = position.firstLegSide === 'up' ? position.upAvgCost : position.downAvgCost;
      const actualFirstLegCost = apiAvgCost > 0 ? apiAvgCost : position.firstLegFillPrice;

      // SAFETY: If we don't know the first leg cost, don't hedge (could lock in loss)
      if (actualFirstLegCost <= 0) {
        log(`[${market.asset} ${market.duration}] ⚠️ Unknown first leg cost - waiting for API sync`, 'WARN');
        break;
      }

      // Determine hedge side and size from actual position
      const hedgeSide: 'up' | 'down' = position.firstLegSide === 'up' ? 'down' : 'up';
      const hedgeTokenId = hedgeSide === 'up' ? market.upTokenId : market.downTokenId;
      const actualImbalance = Math.abs(position.upShares - position.downShares);
      const hedgeSize = actualImbalance > 0 ? actualImbalance : (position.firstLegFilledSize || CONFIG.BID_SIZE);

      // Check current hedge market - both bid and ask
      const hedgeBook = await fetchOrderBook(hedgeTokenId);
      const bestAsk = hedgeBook.bestAsk;  // What we pay to FAK now
      const bidEdge = hedgeBook.bestBid + 0.01;  // Edge for GTC bid

      const combinedIfFAK = actualFirstLegCost + bestAsk;
      const combinedIfBid = actualFirstLegCost + bidEdge;
      const timeWaiting = now - position.firstLegFilledAt;
      const waitingMins = Math.floor(timeWaiting / 60000);
      const waitingSecs = Math.floor((timeWaiting % 60000) / 1000);

      log(`[${market.asset} ${market.duration}] WAIT ${waitingMins}m${waitingSecs}s | ${position.firstLegSide.toUpperCase()} $${actualFirstLegCost.toFixed(2)} | ASK: $${bestAsk.toFixed(2)} (=$${combinedIfFAK.toFixed(2)}) | BID: $${bidEdge.toFixed(2)} (=$${combinedIfBid.toFixed(2)}) | Need: ${hedgeSize}`, 'INFO');

      // AGGRESSIVE: FAK at best ask if profitable
      if (combinedIfFAK < CONFIG.HEDGE_IMBALANCE_MAX && bestAsk <= CONFIG.MAX_BID && hedgeSize > 0) {
        const profit = ((1 - combinedIfFAK) * 100).toFixed(0);
        log(`[${market.asset} ${market.duration}] 🎯 FAK HEDGE: ${hedgeSize} ${hedgeSide.toUpperCase()} @ $${bestAsk.toFixed(2)} (combined $${combinedIfFAK.toFixed(2)} = ${profit}¢ profit)`, 'ORDER');

        const filled = await placeFAKBuy(hedgeSide, bestAsk, hedgeSize);

        if (filled > 0) {
          log(`FAK filled ${filled}/${hedgeSize} - syncing positions`, 'FILL');
          const apiPos3 = await fetchPositionsFromApi();
          position.upShares = apiPos3.upShares;
          position.downShares = apiPos3.downShares;
          position.upAvgCost = apiPos3.upAvgCost;
          position.downAvgCost = apiPos3.downAvgCost;

          // Check if fully hedged now
          const newImbalance = Math.abs(position.upShares - position.downShares);
          if (newImbalance === 0) {
            log(`✅ FULLY HEDGED: ${position.upShares} UP / ${position.downShares} DOWN`, 'PROFIT');
            position.firstLegFillPrice = 0;
            position.firstLegFilledSize = 0;
            position.state = 'scanning';
            break;
          }
        }

        // Place GTC for any remaining
        const remainingHedge = Math.abs(position.upShares - position.downShares);
        if (remainingHedge > 0) {
          log(`${remainingHedge} remaining - placing GTC bid @ $${bidEdge.toFixed(2)}`, 'ORDER');
          const orderId = await placeOrder(hedgeSide, bidEdge, remainingHedge);
          if (orderId) {
            position.currentOrderId = orderId;
            position.currentOrderSide = hedgeSide;
            position.currentOrderPrice = bidEdge;
            position.orderPlacedAt = now;
            position.lastPriceBump = now;
            position.state = 'hedge_bidding';
          }
        }
        break;
      }

      // If FAK not profitable but GTC bid would be, place GTC bid
      if (combinedIfBid < CONFIG.TARGET_COMBINED && hedgeSize > 0) {
        const profit = ((1 - combinedIfBid) * 100).toFixed(0);
        log(`[${market.asset} ${market.duration}] 📝 GTC HEDGE: BID ${hedgeSize} ${hedgeSide.toUpperCase()} @ $${bidEdge.toFixed(2)} (combined $${combinedIfBid.toFixed(2)} = ${profit}¢ profit)`, 'ORDER');

        const orderId = await placeOrder(hedgeSide, bidEdge, hedgeSize);
        if (orderId) {
          position.currentOrderId = orderId;
          position.currentOrderSide = hedgeSide;
          position.currentOrderPrice = bidEdge;
          position.orderPlacedAt = now;
          position.lastPriceBump = now;
          position.state = 'hedge_bidding';
        }
        break;
      }

      // After 10 min unhedged, close position by selling first leg
      if (timeWaiting > CONFIG.UNHEDGED_TIMEOUT_MS) {
        log(`UNHEDGED TIMEOUT (${Math.floor(timeWaiting / 1000)}s) - closing position`, 'WARN');
        position.state = 'closing_position';
        break;
      }
      break;
    }

    // ========== HEDGE BIDDING (PATIENT) ==========
    case 'hedge_bidding': {
      if (!position.currentOrderId || !market) {
        position.state = 'waiting_for_hedge';
        break;
      }

      const status = await checkOrderStatus(position.currentOrderId);

      if (status === 'filled') {
        const hedgeFillPrice = position.currentOrderPrice;
        // Get actual filled size (may be partial fill)
        const hedgeFilledSize = await getOrderFilledSize(position.currentOrderId);
        const actualHedgeSize = hedgeFilledSize > 0 ? hedgeFilledSize : (position.firstLegFilledSize || CONFIG.BID_SIZE);

        // Update internal tracking immediately
        if (position.currentOrderSide === 'up') internalUp += actualHedgeSize;
        else internalDown += actualHedgeSize;

        const combined = position.firstLegFillPrice + hedgeFillPrice;
        const profit = (1.0 - combined) * actualHedgeSize;

        position.completedPairs += 1;
        position.totalProfit += profit;

        log(`[${market.asset} ${market.duration}] HEDGE FILLED: ${actualHedgeSize} ${position.currentOrderSide?.toUpperCase()} @ $${hedgeFillPrice.toFixed(2)} | Internal: ${internalUp}↑/${internalDown}↓ | +$${profit.toFixed(2)}`, 'PROFIT');

        // Sync positions from API to get updated avg costs
        const apiPos = await fetchPositionsFromApi();
        position.upShares = apiPos.upShares;
        position.downShares = apiPos.downShares;
        position.upAvgCost = apiPos.upAvgCost;
        position.downAvgCost = apiPos.downAvgCost;

        position.currentOrderId = undefined;
        position.currentOrderSide = undefined;
        position.firstLegFillPrice = 0;
        position.firstLegFilledSize = 0;
        position.state = 'scanning';
        break;
      }

      if (status === 'cancelled') {
        log(`Hedge order cancelled - back to waiting`, 'WARN');
        position.currentOrderId = undefined;
        position.state = 'waiting_for_hedge';
        break;
      }

      // Very patient price bumping for hedge
      const timeSinceBump = now - position.lastPriceBump;
      if (timeSinceBump > CONFIG.HEDGE_BUMP_AFTER_MS) {
        // Check if bumping is still profitable
        const newPrice = Math.min(CONFIG.MAX_BID, position.currentOrderPrice + 0.01);
        const newCombined = position.firstLegFillPrice + newPrice;

        if (newCombined < CONFIG.TARGET_COMBINED) {
          await cancelOrder(position.currentOrderId);
          const hedgeSize = position.firstLegFilledSize || CONFIG.BID_SIZE;
          log(`Bumping hedge: ${hedgeSize} shares $${position.currentOrderPrice.toFixed(2)} → $${newPrice.toFixed(2)}`, 'ORDER');

          const orderId = await placeOrder(position.currentOrderSide!, newPrice, hedgeSize);
          if (orderId) {
            position.currentOrderId = orderId;
            position.currentOrderPrice = newPrice;
            position.lastPriceBump = now;
          } else {
            position.state = 'waiting_for_hedge';
          }
        } else {
          log(`Can't bump hedge - would be unprofitable`, 'WARN');
        }
        break;
      }

      // Check timeout while hedge order is open
      const hedgeTimeWaiting = now - position.firstLegFilledAt;
      if (hedgeTimeWaiting > CONFIG.UNHEDGED_TIMEOUT_MS) {
        log(`UNHEDGED TIMEOUT while hedge bidding - closing position`, 'WARN');
        await cancelOrder(position.currentOrderId);
        position.currentOrderId = undefined;
        position.state = 'closing_position';
      }
      break;
    }

    // ========== CLOSING POSITION (TIMEOUT) ==========
    case 'closing_position': {
      if (!market) {
        position.state = 'scanning';
        break;
      }

      // Calculate actual imbalance between UP and DOWN shares
      const imbalance = position.upShares - position.downShares;

      // Determine which side has excess and how many shares to sell
      let exposedSide: 'up' | 'down';
      let sharesToSell: number;

      if (imbalance > 0) {
        // More UP than DOWN - sell UP
        exposedSide = 'up';
        sharesToSell = imbalance;
      } else if (imbalance < 0) {
        // More DOWN than UP - sell DOWN
        exposedSide = 'down';
        sharesToSell = Math.abs(imbalance);
      } else {
        // Balanced - nothing to close
        log(`[${market.asset} ${market.duration}] Position already balanced (${position.upShares} UP / ${position.downShares} DOWN)`, 'INFO');
        position.firstLegFillPrice = 0;
        position.state = 'scanning';
        break;
      }

      const exposedTokenId = exposedSide === 'up' ? market.upTokenId : market.downTokenId;

      // Fetch raw order book without filtering - we need to sell at ANY price
      let sellPrice = 0;
      try {
        const res = await fetch(`${CLOB_HOST}/book?token_id=${exposedTokenId}`);
        if (res.ok) {
          const book = await res.json();
          const bids = book.bids || [];
          // Find actual best bid (highest price, no filtering)
          for (const bid of bids) {
            const price = parseFloat(bid.price);
            if (price > sellPrice) sellPrice = price;
          }
        }
      } catch {}

      if (sellPrice <= 0) {
        log(`[${market.asset} ${market.duration}] No bids at all - position will expire`, 'LOSS');
        // Reset and move on - position will expire worthless
        const avgCost = exposedSide === 'up' ? position.upAvgCost : position.downAvgCost;
        position.totalLoss += avgCost * sharesToSell;
        position.firstLegFillPrice = 0;
        position.state = 'scanning';
        break;
      }

      // Use actual avg cost from API instead of firstLegFillPrice
      const avgEntryPrice = exposedSide === 'up' ? position.upAvgCost : position.downAvgCost;

      log(`[${market.asset} ${market.duration}] CLOSE IMBALANCE: SELL ${sharesToSell} ${exposedSide.toUpperCase()} @ $${sellPrice.toFixed(2)} (avg cost: $${avgEntryPrice.toFixed(2)}) | Before: ${position.upShares} UP / ${position.downShares} DOWN`, 'INFO');

      // Use FAK to fill what we can at best bid
      const filledAmount = await placeFAKSell(exposedSide, sellPrice, sharesToSell);

      if (filledAmount > 0) {
        const pnl = (sellPrice - avgEntryPrice) * filledAmount;

        // Record PnL
        if (pnl >= 0) {
          position.totalProfit += pnl;
        } else {
          position.totalLoss += Math.abs(pnl);
        }

        log(`FAK filled ${filledAmount}/${sharesToSell} shares, PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, 'INFO');
      }

      // Sync positions from API to get updated shares and avg costs
      // In closing_position, trust API completely (GTC sells may have filled)
      const apiPosClose = await fetchPositionsFromApi();
      position.upShares = apiPosClose.upShares;
      position.downShares = apiPosClose.downShares;
      position.upAvgCost = apiPosClose.upAvgCost;
      position.downAvgCost = apiPosClose.downAvgCost;
      // Also sync internal tracking down if API shows lower (GTC sell filled)
      if (apiPosClose.upShares < internalUp) internalUp = apiPosClose.upShares;
      if (apiPosClose.downShares < internalDown) internalDown = apiPosClose.downShares;

      const remainingImbalance = Math.abs(position.upShares - position.downShares);
      if (remainingImbalance === 0) {
        log(`[${market.asset} ${market.duration}] CLOSED: ${position.upShares} UP / ${position.downShares} DOWN`, 'PROFIT');
        position.firstLegFillPrice = 0;
        position.currentOrderId = undefined;
        position.state = 'scanning';
      } else {
        // Still have imbalance - use GTC at extreme price
        log(`Still have ${remainingImbalance} imbalance - posting GTC at $0.01`, 'WARN');
        await placeExtremeSell(exposedSide, remainingImbalance);
        // Stay in closing_position state to keep checking
      }
      break;
    }

    // ========== PAUSED ==========
    case 'paused': {
      // Wait for market rotation
      break;
    }
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function display(): void {
  console.clear();

  const stateColors: Record<TradingState, string> = {
    scanning: '\x1b[33m',
    first_leg_bidding: '\x1b[36m',
    waiting_for_hedge: '\x1b[35m',
    hedge_bidding: '\x1b[32m',
    closing_position: '\x1b[31m',
    paused: '\x1b[31m',
  };

  const wsStatus = ws?.readyState === WebSocket.OPEN ? '\x1b[32mWS:ON\x1b[0m' : '\x1b[31mWS:OFF\x1b[0m';
  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║        MARKET MAKER V7 - BTC/ETH/XRP 15M+1H                      ${wsStatus}              ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');

  if (market) {
    let ttlStr = '';
    if (market.endTime) {
      const ttl = market.endTime.getTime() - Date.now();
      if (ttl > 0) {
        const mins = Math.floor(ttl / 60000);
        const secs = Math.floor((ttl % 60000) / 1000);
        ttlStr = `${mins}m ${secs}s`;
      } else {
        ttlStr = 'EXPIRED';
      }
    }
    const marketStr = `${market.asset} ${market.duration}`;
    console.log(`║  Market: ${marketStr.padEnd(10)} │ TTL: ${ttlStr.padEnd(10)} │ ${market.question.slice(0, 40)}`.padEnd(83) + '║');
  }

  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  UP: ${position.upShares.toString().padStart(3)}  │  DOWN: ${position.downShares.toString().padStart(3)}  │  Pairs: ${position.completedPairs}  │  Size: ${CONFIG.BID_SIZE}/leg`.padEnd(83) + '║');
  console.log(`║  Profit: $${position.totalProfit.toFixed(2).padStart(7)}  │  Loss: $${position.totalLoss.toFixed(2).padStart(7)}  │  Net: $${(position.totalProfit - position.totalLoss).toFixed(2)}`.padEnd(83) + '║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');

  const color = stateColors[position.state];
  const reset = '\x1b[0m';

  let stateMsg = '';
  switch (position.state) {
    case 'scanning':
      stateMsg = 'SCANNING - Looking for entry...';
      break;
    case 'first_leg_bidding':
      stateMsg = `FIRST LEG: ${position.currentOrderSide?.toUpperCase()} @ $${position.currentOrderPrice.toFixed(2)} [${position.currentOrderId?.slice(0, 8) || '?'}]`;
      break;
    case 'waiting_for_hedge':
      const targetHedge = CONFIG.TARGET_COMBINED - position.firstLegFillPrice;
      stateMsg = `WAITING FOR HEDGE: ${position.firstLegSide === 'up' ? 'DOWN' : 'UP'} target $${targetHedge.toFixed(2)}`;
      break;
    case 'hedge_bidding':
      stateMsg = `HEDGE: ${position.currentOrderSide?.toUpperCase()} @ $${position.currentOrderPrice.toFixed(2)} [${position.currentOrderId?.slice(0, 8) || '?'}]`;
      break;
    case 'closing_position':
      stateMsg = 'CLOSING - Selling unhedged leg (7:30 timeout)...';
      break;
    case 'paused':
      stateMsg = 'PAUSED - Market expiring';
      break;
  }

  console.log(`║  ${color}${stateMsg}${reset}`.padEnd(91) + '║');

  if (position.state === 'waiting_for_hedge' || position.state === 'hedge_bidding' || position.state === 'closing_position') {
    const timeWaiting = Date.now() - position.firstLegFilledAt;
    const timeLeft = Math.max(0, CONFIG.UNHEDGED_TIMEOUT_MS - timeWaiting);
    const minsLeft = Math.floor(timeLeft / 60000);
    const secsLeft = Math.floor((timeLeft % 60000) / 1000);
    console.log(`║  First leg: ${position.firstLegSide.toUpperCase()} @ $${position.firstLegFillPrice.toFixed(2)}  │  Close timeout in ${minsLeft}m ${secsLeft}s`.padEnd(83) + '║');
  }

  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
}

// ============================================================================
// MARKET ROTATION
// ============================================================================

async function resetPosition(): Promise<void> {
  // Reset internal counters for new market - will be populated from API
  internalUp = 0;
  internalDown = 0;

  // Reset force close tracking
  forceCloseStarted = false;
  forceCloseSide = null;
  forceCloseTarget = 0;

  // Fetch actual positions from API for the new market
  const apiPos = await fetchPositionsFromApi();

  // Initialize internal tracking from API
  internalUp = apiPos.upShares;
  internalDown = apiPos.downShares;

  position.upShares = apiPos.upShares;
  position.downShares = apiPos.downShares;
  position.upAvgCost = apiPos.upAvgCost;
  position.downAvgCost = apiPos.downAvgCost;

  position.state = 'scanning';
  position.currentOrderId = undefined;
  position.currentOrderSide = undefined;
  position.currentOrderPrice = 0;
  position.orderPlacedAt = 0;
  position.lastPriceBump = 0;
  position.firstLegFillPrice = 0;
  position.firstLegFilledSize = 0;
  position.firstLegFilledAt = 0;

  log(`Market reset - Internal: ${internalUp}↑/${internalDown}↓ | API: ${apiPos.upShares}↑/${apiPos.downShares}↓`, 'INFO');
}

async function checkMarketRotation(): Promise<void> {
  if (!market?.endTime) return;

  const now = Date.now();
  const timeToExpiry = market.endTime.getTime() - now;

  if (timeToExpiry < 0) {
    log(`Market expired, finding next one...`, 'WARN');

    if (position.currentOrderId) {
      await cancelOrder(position.currentOrderId);
    }

    const newMarket = await findActiveMarket();
    if (newMarket && newMarket.conditionId !== market.conditionId) {
      market = newMarket;
      await resetPosition();
      log(`Switched to: ${market.question}`, 'INFO');

      if (market.endTime) {
        const ttl = Math.floor((market.endTime.getTime() - now) / 60000);
        log(`Expires in ${ttl} minutes`, 'INFO');
      }
    } else {
      log(`No new market found, waiting...`, 'WARN');
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           MARKET MAKER V7 - MULTI-ASSET DURATION RISK                            ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                                  ║');
  const marketList = MARKET_SERIES.map(s => s.replace('-up-or-down-', ' ').toUpperCase()).join(', ');
  console.log(`║  MARKETS: ${marketList.slice(0, 68).padEnd(68)} ║`);
  console.log('║                                                                                  ║');
  console.log('║  STRATEGY:                                                                       ║');
  console.log('║  1. Find soonest expiring market across all assets                               ║');
  console.log('║  2. Enter anchor trade (side closer to 50¢)                                      ║');
  console.log('║  3. Wait for price movement, then hedge opposite side                            ║');
  console.log('║  4. Close unhedged after 7:30 timeout                                            ║');
  console.log('║                                                                                  ║');
  console.log(`║  Target: Combined < $${CONFIG.TARGET_COMBINED} (${((1 - CONFIG.TARGET_COMBINED) * 100).toFixed(0)}¢ profit)                                              ║`);
  console.log('║                                                                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await loadClobClient();
  await initClobClient();

  connectWebSocket();
  connectRTDS();  // Real-time crypto price feed for logging (not trading decisions)

  setFillCallback((orderId, fillPrice, _fillSize) => {
    if (position.currentOrderId && orderId === position.currentOrderId) {
      log(`Real-time fill detected!`, 'FILL');
      position.currentOrderPrice = fillPrice;
    }
  });

  log('Finding active BTC 15-min market...');
  market = await findActiveMarket();

  if (!market) {
    log('No active market found - waiting...', 'WARN');
  } else {
    log(`Trading: ${market.question}`);
    if (market.endTime) {
      const ttl = Math.floor((market.endTime.getTime() - Date.now()) / 60000);
      log(`Expires in ${ttl} minutes`);
    }
  }

  // Main loop - variable interval based on state
  const runLoop = async () => {
    await checkMarketRotation();

    if (!market) {
      market = await findActiveMarket();
      if (market) {
        await resetPosition();
        log(`Found market: ${market.question}`, 'INFO');
      }
    }

    if (market) {
      await runStateMachine();
      display();
    }

    // Variable interval based on state - faster during force close
    let interval = CONFIG.HEDGE_CHECK_MS;
    if (position.state === 'first_leg_bidding') {
      interval = CONFIG.FIRST_LEG_CHECK_MS;
    } else if (position.state === 'closing_position') {
      interval = 1000;  // 1 second during force close - be aggressive!
    }

    setTimeout(runLoop, interval);
  };

  runLoop();

  setInterval(checkMarketRotation, CONFIG.MARKET_CHECK_MS);

  if (market) display();
  log('Running. Press Ctrl+C to stop.');
}

main().catch(console.error);
