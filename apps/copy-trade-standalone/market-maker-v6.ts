/**
 * POLYMARKET MARKET MAKER V6 - TRULY SEQUENTIAL
 *
 * KEY CHANGE: Only ONE bid active at a time
 * - Place UP bid, wait for fill
 * - Then place DOWN bid, wait for fill
 * - Repeat
 *
 * This PREVENTS unhedged exposure accumulation
 *
 * USAGE: npx tsx market-maker-v6.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';
import WebSocket from 'ws';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Bid prices
  BID_SIZE: 5,              // 5 shares per leg

  // Price bounds
  MIN_BID: 0.40,
  MAX_BID: 0.48,
  MAX_COMBINED: 0.96,       // Max combined price for 4c profit per share

  // Timing
  ORDER_CHECK_MS: 2000,      // Check order status every 2s
  ORDER_TIMEOUT_MS: 30000,   // Cancel unfilled order after 30s
  PRICE_BUMP_AFTER_MS: 15000, // Increase price after 15s no fill

  // Market rotation
  STOP_TRADING_BEFORE_EXPIRY_MS: 60000,  // Stop new pairs 1 min before expiry
  MARKET_CHECK_MS: 30000,    // Check for new markets every 30s

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
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

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
    // Store creds for WebSocket auth
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

    // Subscribe to user channel
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

    // Ping every 10s to keep alive
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

      // Handle trade/fill messages
      if (parsed.event_type === 'trade' || parsed.type === 'trade') {
        const orderId = parsed.order_id || parsed.orderId || parsed.maker_order_id;
        const fillPrice = parseFloat(parsed.price || '0');
        const fillSize = parseFloat(parsed.size || parsed.match_size || '0');

        log(`WS FILL: Order ${orderId?.slice(0, 8)} filled ${fillSize} @ $${fillPrice.toFixed(2)}`, 'FILL');

        if (onFillCallback && orderId) {
          onFillCallback(orderId, fillPrice, fillSize);
        }
      }

      // Handle order status updates
      if (parsed.event_type === 'order' || parsed.type === 'order') {
        const orderId = parsed.order_id || parsed.id;
        const status = parsed.status || parsed.order_status;
        log(`WS ORDER: ${orderId?.slice(0, 8)} status=${status}`, 'ORDER');
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
}

type TradingState =
  | 'idle'           // No active orders
  | 'bidding_up'     // UP bid placed, waiting for fill
  | 'bidding_down'   // DOWN bid placed, waiting for fill
  | 'paused';        // Hit limits, waiting

interface Position {
  upShares: number;
  downShares: number;
  pairs: number;           // Hedged pairs (min of up, down)

  state: TradingState;
  currentOrderId?: string;
  currentOrderSide?: 'up' | 'down';
  currentOrderPrice: number;
  orderPlacedAt: number;
  lastPriceBump: number;

  // Track first leg fill for hedge calculation
  firstLegFillPrice?: number;
  firstLegSide?: 'up' | 'down';
}

// ============================================================================
// STATE
// ============================================================================

let market: Market | null = null;
let position: Position = {
  upShares: 0,
  downShares: 0,
  pairs: 0,
  state: 'idle',
  currentOrderPrice: CONFIG.INITIAL_BID,
  orderPlacedAt: 0,
  lastPriceBump: 0,
};

let totalExposure = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'FILL' | 'ORDER' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    FILL: '💰',
    ORDER: '📝'
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

function parseEndTime(question: string): Date | undefined {
  // Parse end time from question like "Bitcoin Up or Down - December 15, 10:15AM-10:30AM ET"
  // We want the END time (10:30AM in this example)
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

    // If time has passed today, it's tomorrow
    if (endTime < now) {
      endTime.setDate(endTime.getDate() + 1);
    }

    return endTime;
  }

  return undefined;
}

async function findActiveMarket(): Promise<Market | null> {
  try {
    // Get BTC 15-min series and find current active event
    const res = await fetch(`${GAMMA_API_HOST}/series?slug=btc-up-or-down-15m`);
    if (!res.ok) {
      log(`Series API error: ${res.status}`, 'ERROR');
      return null;
    }

    const series = await res.json();
    if (!series || series.length === 0) {
      log('BTC 15-min series not found', 'WARN');
      return null;
    }

    const events = series[0].events || [];
    const now = new Date();

    // Find the one expiring soonest that hasn't ended yet (by parsing end time from title)
    let bestEvent = null;
    let bestEndTime: Date | null = null;

    for (const event of events) {
      const endTime = parseEndTime(event.title);
      if (!endTime) continue;

      // Skip if already expired
      if (endTime <= now) continue;

      // Pick the one ending soonest
      if (!bestEndTime || endTime < bestEndTime) {
        bestEndTime = endTime;
        bestEvent = event;
      }
    }

    if (!bestEvent || !bestEndTime) {
      log('No active BTC 15-min market found', 'WARN');
      return null;
    }

    // Fetch full market data for this event
    const eventRes = await fetch(`${GAMMA_API_HOST}/events?slug=${bestEvent.slug}`);
    if (!eventRes.ok) {
      log(`Event fetch error: ${eventRes.status}`, 'ERROR');
      return null;
    }

    const eventData = await eventRes.json();
    const m = eventData[0]?.markets?.[0];
    if (!m) {
      log('No market data in event', 'WARN');
      return null;
    }

    let upTokenId = '';
    let downTokenId = '';
    try {
      const tokenIds = JSON.parse(m.clobTokenIds || '[]');
      upTokenId = tokenIds[0] || '';
      downTokenId = tokenIds[1] || '';
    } catch {
      log('Failed to parse token IDs', 'ERROR');
      return null;
    }

    if (!upTokenId || !downTokenId) {
      log('Missing token IDs', 'ERROR');
      return null;
    }

    return {
      conditionId: m.conditionId,
      question: m.question,
      upTokenId,
      downTokenId,
      tickSize: m.orderPriceMinTickSize?.toString() || '0.01',
      negRisk: m.negRisk || false,
      endTime: bestEndTime,
    };
  } catch (error: any) {
    log(`Market search error: ${error.message}`, 'ERROR');
  }

  return null;
}

// ============================================================================
// POSITION TRACKING
// ============================================================================

async function fetchPosition(): Promise<void> {
  if (!market) return;

  try {
    const res = await fetch(`${DATA_API_HOST}/trades?user=${PROXY_WALLET}&limit=100`);
    if (!res.ok) return;

    const trades = await res.json();

    let up = 0, down = 0, upCost = 0, downCost = 0;

    for (const trade of trades) {
      if (trade.conditionId !== market.conditionId) continue;

      const size = parseFloat(trade.size) || 0;
      const price = parseFloat(trade.price) || 0;
      const isUp = trade.asset_id === market.upTokenId || trade.outcome === 'Up';
      const isBuy = trade.side === 'BUY' || trade.side === 'buy';

      if (isUp) {
        if (isBuy) { up += size; upCost += size * price; }
        else { up -= size; }
      } else {
        if (isBuy) { down += size; downCost += size * price; }
        else { down -= size; }
      }
    }

    const prevUp = position.upShares;
    const prevDown = position.downShares;

    position.upShares = Math.max(0, up);
    position.downShares = Math.max(0, down);
    position.pairs = Math.min(position.upShares, position.downShares);

    totalExposure = upCost + downCost;

    // Detect fills
    if (position.upShares > prevUp) {
      const filled = position.upShares - prevUp;
      log(`FILLED: +${filled} UP @ ~$${(upCost/up).toFixed(2)}`, 'FILL');
    }
    if (position.downShares > prevDown) {
      const filled = position.downShares - prevDown;
      log(`FILLED: +${filled} DOWN @ ~$${(downCost/down).toFixed(2)}`, 'FILL');
    }

  } catch (error: any) {
    // Silent fail
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

async function placeOrder(side: 'up' | 'down', price: number): Promise<string | undefined> {
  if (!market || !clobClient) return undefined;

  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;

  if (!CONFIG.ENABLE_TRADING) {
    log(`[DRY] BID ${side.toUpperCase()}: ${CONFIG.BID_SIZE} @ $${price.toFixed(2)}`, 'ORDER');
    return 'dry-run-order';
  }

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price,
        side: Side.BUY,
        size: CONFIG.BID_SIZE,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`BID ${side.toUpperCase()}: ${CONFIG.BID_SIZE} @ $${price.toFixed(2)} [${orderId.slice(0, 8)}]`, 'ORDER');
    }
    return orderId;
  } catch (error: any) {
    log(`Order failed: ${error.message}`, 'ERROR');
    return undefined;
  }
}

// ============================================================================
// ORDER BOOK
// ============================================================================

interface OrderBook {
  bestBid: number;
  bestAsk: number;
}

async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return { bestBid: 0, bestAsk: 1 };

    const book = await res.json();
    const bids = book.bids || [];
    const asks = book.asks || [];

    return {
      bestBid: bids.length > 0 ? parseFloat(bids[0].price) : 0,
      bestAsk: asks.length > 0 ? parseFloat(asks[0].price) : 1,
    };
  } catch {
    return { bestBid: 0, bestAsk: 1 };
  }
}

// Calculate optimal bid price at edge of spread
function calcEdgeBid(book: OrderBook): number {
  // Bid 1 cent above best bid (to be at front of queue)
  const edgeBid = book.bestBid + 0.01;
  // But don't exceed MAX_BID or cross the spread
  return Math.min(CONFIG.MAX_BID, book.bestAsk - 0.01, edgeBid);
}

// ============================================================================
// STATE MACHINE
// ============================================================================

async function runStateMachine(): Promise<void> {
  const now = Date.now();

  // NO LIMITS - just enforce sequential hedging

  // Check if market is about to expire
  if (market?.endTime) {
    const timeToExpiry = market.endTime.getTime() - now;
    if (timeToExpiry < CONFIG.STOP_TRADING_BEFORE_EXPIRY_MS) {
      // Cancel any open orders
      if (position.currentOrderId) {
        await cancelOrder(position.currentOrderId);
        position.currentOrderId = undefined;
      }
      log(`Market expiring in ${Math.floor(timeToExpiry / 1000)}s - stopping trading`, 'WARN');
      position.state = 'paused';
      return;
    }
  }

  switch (position.state) {
    case 'idle':
    case 'paused': {
      // Scan order book to find edge bid price
      if (!market) break;
      const upBook = await fetchOrderBook(market.upTokenId);
      const downBook = await fetchOrderBook(market.downTokenId);

      // Calculate edge bids for both sides
      const upEdge = calcEdgeBid(upBook);
      const downEdge = calcEdgeBid(downBook);

      // Only enter if combined edge < MAX_COMBINED (profitable)
      if (upEdge + downEdge >= CONFIG.MAX_COMBINED) {
        log(`Spread too tight: UP $${upEdge.toFixed(2)} + DOWN $${downEdge.toFixed(2)} = $${(upEdge + downEdge).toFixed(2)} >= $${CONFIG.MAX_COMBINED}`, 'WARN');
        break;
      }

      log(`Spread OK: UP $${upEdge.toFixed(2)} + DOWN $${downEdge.toFixed(2)} = $${(upEdge + downEdge).toFixed(2)}`, 'INFO');

      // Start by bidding UP at edge
      position.currentOrderPrice = upEdge;
      position.firstLegFillPrice = undefined;
      position.firstLegSide = 'up';
      const orderId = await placeOrder('up', upEdge);
      if (orderId) {
        position.currentOrderId = orderId;
        position.currentOrderSide = 'up';
        position.orderPlacedAt = now;
        position.lastPriceBump = now;
        position.state = 'bidding_up';
      }
      break;
    }

    case 'bidding_up':
    case 'bidding_down': {
      if (!position.currentOrderId) {
        position.state = 'idle';
        break;
      }

      // Check if order filled
      const status = await checkOrderStatus(position.currentOrderId);

      if (status === 'filled') {
        const fillPrice = position.currentOrderPrice;
        log(`Order filled @ $${fillPrice.toFixed(2)}!`, 'FILL');

        // Switch to other side
        if (position.currentOrderSide === 'up') {
          // UP filled, now bid DOWN
          // CALCULATE HEDGE PRICE: MAX_COMBINED - first leg fill price
          position.firstLegFillPrice = fillPrice;
          const hedgePrice = Math.min(CONFIG.MAX_BID, CONFIG.MAX_COMBINED - fillPrice);
          position.currentOrderPrice = hedgePrice;

          log(`Hedge calc: $${CONFIG.MAX_COMBINED} - $${fillPrice.toFixed(2)} = $${hedgePrice.toFixed(2)} max DOWN`, 'ORDER');

          const orderId = await placeOrder('down', hedgePrice);
          if (orderId) {
            position.currentOrderId = orderId;
            position.currentOrderSide = 'down';
            position.orderPlacedAt = now;
            position.lastPriceBump = now;
            position.state = 'bidding_down';
          } else {
            position.state = 'idle';
          }
        } else {
          // DOWN filled, pair complete! Back to idle for next pair
          const upCost = position.firstLegFillPrice || CONFIG.INITIAL_BID;
          const downCost = fillPrice;
          const profit = (1.0 - upCost - downCost) * CONFIG.BID_SIZE;
          log(`✅ PAIR COMPLETE: UP $${upCost.toFixed(2)} + DOWN $${downCost.toFixed(2)} = $${(upCost + downCost).toFixed(2)} combined | Profit: $${profit.toFixed(2)}`, 'FILL');
          position.currentOrderId = undefined;
          position.currentOrderSide = undefined;
          position.firstLegFillPrice = undefined;
          position.state = 'idle';
        }
        break;
      }

      if (status === 'cancelled') {
        log(`Order was cancelled externally`, 'WARN');
        position.currentOrderId = undefined;
        position.state = 'idle';
        break;
      }

      // Order still open - check if we should bump price
      const timeSincePlaced = now - position.orderPlacedAt;
      const timeSinceBump = now - position.lastPriceBump;

      if (timeSinceBump > CONFIG.PRICE_BUMP_AFTER_MS && position.currentOrderPrice < CONFIG.MAX_BID) {
        // Cancel and replace at higher price
        await cancelOrder(position.currentOrderId);

        const newPrice = Math.min(CONFIG.MAX_BID, position.currentOrderPrice + 0.01);
        log(`Bumping price: $${position.currentOrderPrice.toFixed(2)} → $${newPrice.toFixed(2)}`, 'ORDER');

        const orderId = await placeOrder(position.currentOrderSide!, newPrice);
        if (orderId) {
          position.currentOrderId = orderId;
          position.currentOrderPrice = newPrice;
          position.lastPriceBump = now;
        } else {
          position.state = 'idle';
        }
        break;
      }

      // Check timeout
      if (timeSincePlaced > CONFIG.ORDER_TIMEOUT_MS) {
        log(`Order timeout - cancelling`, 'WARN');
        await cancelOrder(position.currentOrderId);
        position.currentOrderId = undefined;
        position.state = 'idle';
      }
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
    idle: '\x1b[33m',
    bidding_up: '\x1b[36m',
    bidding_down: '\x1b[35m',
    paused: '\x1b[31m',
  };

  const wsStatus = ws?.readyState === WebSocket.OPEN ? '\x1b[32mWS:ON\x1b[0m' : '\x1b[31mWS:OFF\x1b[0m';
  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║              MARKET MAKER V6 - BTC 15-MIN                      ${wsStatus}              ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');

  if (market) {
    const name = market.question.slice(0, 50);
    let ttlStr = '';
    if (market.endTime) {
      const ttl = market.endTime.getTime() - Date.now();
      if (ttl > 0) {
        const mins = Math.floor(ttl / 60000);
        const secs = Math.floor((ttl % 60000) / 1000);
        ttlStr = `TTL: ${mins}m ${secs}s`;
      } else {
        ttlStr = 'EXPIRED';
      }
    }
    console.log(`║  ${name.padEnd(50)} │ ${ttlStr.padEnd(25)} ║`);
  }

  const imbalance = position.upShares - position.downShares;
  const imbalStr = imbalance >= 0 ? `+${imbalance}` : `${imbalance}`;

  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  UP: ${position.upShares.toString().padStart(3)}  │  DOWN: ${position.downShares.toString().padStart(3)}  │  Pairs: ${position.pairs}  │  Imbalance: ${imbalStr.padStart(4)}`.padEnd(83) + '║');
  console.log(`║  Exposure: $${totalExposure.toFixed(0)}  │  Size: ${CONFIG.BID_SIZE} per leg`.padEnd(83) + '║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');

  const color = stateColors[position.state];
  const reset = '\x1b[0m';

  let stateMsg = '';
  switch (position.state) {
    case 'idle':
      stateMsg = 'IDLE - Starting next bid...';
      break;
    case 'bidding_up':
      stateMsg = `BIDDING UP @ $${position.currentOrderPrice.toFixed(2)} [${position.currentOrderId?.slice(0, 8) || '?'}]`;
      break;
    case 'bidding_down':
      stateMsg = `BIDDING DOWN @ $${position.currentOrderPrice.toFixed(2)} [${position.currentOrderId?.slice(0, 8) || '?'}]`;
      break;
    case 'paused':
      stateMsg = 'PAUSED - Hit limits';
      break;
  }

  console.log(`║  ${color}${stateMsg}${reset}`.padEnd(91) + '║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
}

// ============================================================================
// MARKET ROTATION
// ============================================================================

function resetPosition(): void {
  position = {
    upShares: 0,
    downShares: 0,
    pairs: 0,
    state: 'idle',
    currentOrderPrice: CONFIG.MIN_BID,
    orderPlacedAt: 0,
    lastPriceBump: 0,
  };
  totalExposure = 0;
}

async function checkMarketRotation(): Promise<void> {
  if (!market?.endTime) return;

  const now = Date.now();
  const timeToExpiry = market.endTime.getTime() - now;

  // If market expired, find next one
  if (timeToExpiry < 0) {
    log(`Market expired, finding next one...`, 'WARN');

    // Cancel any open orders
    if (position.currentOrderId) {
      await cancelOrder(position.currentOrderId);
    }

    // Find next market
    const newMarket = await findActiveMarket();
    if (newMarket && newMarket.conditionId !== market.conditionId) {
      market = newMarket;
      resetPosition();
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
  console.log('║              MARKET MAKER V6 - BTC 15-MIN + WEBSOCKET                            ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                                  ║');
  console.log('║  FEATURES:                                                                       ║');
  console.log('║  • WebSocket for real-time fill detection                                        ║');
  console.log('║  • Edge bidding (bestBid + 1c)                                                   ║');
  console.log('║  • Sequential hedging (UP → DOWN → pair complete)                                ║');
  console.log('║  • 4 cent spread target (combined < $0.96)                                       ║');
  console.log('║  • Auto-rotate to next 15-min BTC market                                         ║');
  console.log('║                                                                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await loadClobClient();
  await initClobClient();

  // Connect WebSocket for real-time fills
  connectWebSocket();

  // Set up fill callback to handle real-time order fills
  setFillCallback((orderId, fillPrice, fillSize) => {
    // Check if this is our current order
    if (position.currentOrderId && orderId === position.currentOrderId) {
      log(`Real-time fill detected for our order!`, 'FILL');
      position.currentOrderPrice = fillPrice; // Update with actual fill price
    }
  });

  log('Finding active BTC 15-min market...');
  market = await findActiveMarket();

  if (!market) {
    log('No active market found - waiting for next one...', 'WARN');
  } else {
    log(`Trading: ${market.question}`);
    if (market.endTime) {
      const ttl = Math.floor((market.endTime.getTime() - Date.now()) / 60000);
      log(`Expires in ${ttl} minutes`);
    }
  }

  // Main loop
  setInterval(async () => {
    // Check if we need to rotate markets
    await checkMarketRotation();

    if (!market) {
      // Try to find a market
      market = await findActiveMarket();
      if (market) {
        resetPosition();
        log(`Found market: ${market.question}`, 'INFO');
      }
      return;
    }

    await fetchPosition();
    await runStateMachine();
    display();
  }, CONFIG.ORDER_CHECK_MS);

  // Also check for new markets periodically
  setInterval(checkMarketRotation, CONFIG.MARKET_CHECK_MS);

  if (market) display();
  log('Running. Press Ctrl+C to stop.');
}

main().catch(console.error);
