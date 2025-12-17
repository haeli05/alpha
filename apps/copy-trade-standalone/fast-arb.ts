/**
 * FAST SPREAD ARB
 *
 * Uses WebSocket for real-time order book updates + parallel execution.
 * Goal: Capture spreads where Yes + No < $1 before others.
 *
 * SPEED OPTIMIZATIONS:
 * 1. WebSocket subscription to order books (no polling delay)
 * 2. Pre-loaded market data and CLOB client
 * 3. Parallel order execution (both legs at once)
 * 4. FAK orders at $0.99 for instant fill
 *
 * USAGE: npx tsx fast-arb.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MIN_SPREAD_PROFIT = 0.02; // 2 cents minimum profit
const MAX_COMBINED_PRICE = 1 - MIN_SPREAD_PROFIT; // $0.98
const SHARES_PER_TRADE = 20; // Conservative size
const ENABLE_TRADING = false; // Set true to enable live trading
const COOLDOWN_MS = 5000; // Wait between arb attempts on same market

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

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
  const signatureType = 2;
  const funder = PROXY_WALLET;

  try {
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
      key: POLYMARKET_API_KEY,
      secret: POLYMARKET_SECRET,
      passphrase: POLYMARKET_PASSPHRASE,
    }, signatureType, funder);
    log('CLOB client initialized');
  } catch (error: any) {
    log(`Failed to init CLOB client: ${error.message}`, 'ERROR');
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
  endDate: string;
}

interface OrderBook {
  upAsk: number;
  upAskSize: number;
  upBid: number;
  downAsk: number;
  downAskSize: number;
  downBid: number;
  combined: number;
  spread: number;
  timestamp: number;
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const orderBooks: Map<string, OrderBook> = new Map();
const lastArbTime: Map<string, number> = new Map();
const wsConnections: Map<string, WebSocket> = new Map();

let tradesExecuted = 0;
let totalProfit = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'ARB' | 'TRADE' | 'WS' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    ARB: '🎯',
    TRADE: '💰',
    WS: '🔌'
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

async function findActiveMarkets(): Promise<Market[]> {
  const result: Market[] = [];
  const seenConditions = new Set<string>();

  // Get markets from target wallet's recent trades
  try {
    const res = await fetch(`${DATA_API_HOST}/trades?user=${TARGET_WALLET}&limit=50`);
    if (!res.ok) return result;

    const trades = await res.json();
    for (const trade of trades) {
      const conditionId = trade.conditionId;
      if (!conditionId || seenConditions.has(conditionId)) continue;
      seenConditions.add(conditionId);

      // Get market details
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
        endDate: data.end_date_iso,
      });

      await new Promise(r => setTimeout(r, 50));
    }
  } catch (error: any) {
    log(`Error finding markets: ${error.message}`, 'ERROR');
  }

  return result;
}

// ============================================================================
// WEBSOCKET ORDER BOOK SUBSCRIPTION
// ============================================================================

function subscribeToOrderBook(market: Market): void {
  const wsKey = market.conditionId;

  // Close existing connection if any
  if (wsConnections.has(wsKey)) {
    wsConnections.get(wsKey)?.close();
  }

  const ws = new WebSocket(WS_URL);
  wsConnections.set(wsKey, ws);

  ws.on('open', () => {
    log(`Connected to ${market.question.slice(0, 40)}...`, 'WS');

    // Subscribe to both token order books
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: [market.upTokenId, market.downTokenId],
    }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleOrderBookUpdate(market, msg);
    } catch {
      // Ignore parse errors
    }
  });

  ws.on('error', (err) => {
    log(`WS error for ${market.question.slice(0, 30)}: ${err.message}`, 'ERROR');
  });

  ws.on('close', () => {
    log(`WS closed for ${market.question.slice(0, 30)}, reconnecting...`, 'WS');
    setTimeout(() => subscribeToOrderBook(market), 3000);
  });
}

function handleOrderBookUpdate(market: Market, msg: any): void {
  // Get or create order book state
  let book = orderBooks.get(market.conditionId);
  if (!book) {
    book = {
      upAsk: 1, upAskSize: 0, upBid: 0,
      downAsk: 1, downAskSize: 0, downBid: 0,
      combined: 2, spread: -1, timestamp: 0,
    };
    orderBooks.set(market.conditionId, book);
  }

  // Update based on message type
  if (msg.event_type === 'book' || msg.event_type === 'price_change') {
    const assetId = msg.asset_id;
    const isUp = assetId === market.upTokenId;

    // Parse book data
    if (msg.market) {
      const asks = msg.market.asks || [];
      const bids = msg.market.bids || [];

      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
      const askSize = asks.length > 0 ? parseFloat(asks[0].size) : 0;
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;

      if (isUp) {
        book.upAsk = bestAsk;
        book.upAskSize = askSize;
        book.upBid = bestBid;
      } else {
        book.downAsk = bestAsk;
        book.downAskSize = askSize;
        book.downBid = bestBid;
      }
    }
  }

  // Recalculate combined price
  book.combined = book.upAsk + book.downAsk;
  book.spread = 1 - book.combined;
  book.timestamp = Date.now();

  // Check for arb opportunity
  checkAndExecuteArb(market, book);
}

// ============================================================================
// ARB DETECTION AND EXECUTION
// ============================================================================

async function checkAndExecuteArb(market: Market, book: OrderBook): Promise<void> {
  // Check if combined price is below threshold
  if (book.combined >= MAX_COMBINED_PRICE) return;

  // Check cooldown
  const lastArb = lastArbTime.get(market.conditionId) || 0;
  if (Date.now() - lastArb < COOLDOWN_MS) return;

  // Check liquidity
  const minSize = Math.min(book.upAskSize, book.downAskSize);
  if (minSize < SHARES_PER_TRADE) {
    log(`ARB DETECTED but insufficient liquidity (${minSize.toFixed(0)} < ${SHARES_PER_TRADE})`, 'ARB');
    return;
  }

  // ARB OPPORTUNITY!
  const profitPerShare = book.spread;
  const expectedProfit = SHARES_PER_TRADE * profitPerShare;

  log(``, 'ARB');
  log(`═══════════════════════════════════════════════════════`, 'ARB');
  log(`ARB OPPORTUNITY DETECTED!`, 'ARB');
  log(`Market: ${market.question}`, 'ARB');
  log(`Up Ask: $${book.upAsk.toFixed(4)} | Down Ask: $${book.downAsk.toFixed(4)}`, 'ARB');
  log(`Combined: $${book.combined.toFixed(4)} | Spread: ${(book.spread * 100).toFixed(2)}%`, 'ARB');
  log(`Expected Profit: $${expectedProfit.toFixed(2)} on ${SHARES_PER_TRADE} shares`, 'ARB');
  log(`═══════════════════════════════════════════════════════`, 'ARB');

  // Execute if trading enabled
  if (ENABLE_TRADING && clobClient) {
    lastArbTime.set(market.conditionId, Date.now());
    await executeArb(market, book);
  } else {
    log(`[DRY RUN] Would execute arb - trading disabled`, 'ARB');
  }
}

async function executeArb(market: Market, book: OrderBook): Promise<void> {
  const startTime = Date.now();
  log(`Executing arb...`, 'TRADE');

  try {
    // Create both orders in parallel
    const buyUpPromise = clobClient.createAndPostOrder(
      {
        tokenID: market.upTokenId,
        price: 0.99, // FAK at max price for instant fill
        side: Side.BUY,
        size: SHARES_PER_TRADE,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.FAK
    );

    const buyDownPromise = clobClient.createAndPostOrder(
      {
        tokenID: market.downTokenId,
        price: 0.99,
        side: Side.BUY,
        size: SHARES_PER_TRADE,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.FAK
    );

    // Execute both simultaneously
    const [upResult, downResult] = await Promise.all([buyUpPromise, buyDownPromise]);

    const execTime = Date.now() - startTime;

    const upOrderId = upResult?.order_id || upResult?.orderID;
    const downOrderId = downResult?.order_id || downResult?.orderID;

    log(`Execution completed in ${execTime}ms`, 'TRADE');
    log(`Up order: ${upOrderId?.slice(0, 20) || 'FAILED'}...`, 'TRADE');
    log(`Down order: ${downOrderId?.slice(0, 20) || 'FAILED'}...`, 'TRADE');

    if (upOrderId && downOrderId) {
      const profit = SHARES_PER_TRADE * book.spread;
      totalProfit += profit;
      tradesExecuted++;
      log(`Expected profit: +$${profit.toFixed(2)}`, 'TRADE');
    }

  } catch (error: any) {
    log(`Execution error: ${error.message}`, 'ERROR');
  }
}

// ============================================================================
// POLLING FALLBACK (for when WS doesn't update)
// ============================================================================

async function pollOrderBooks(): Promise<void> {
  for (const [conditionId, market] of markets) {
    try {
      const [upRes, downRes] = await Promise.all([
        fetch(`${CLOB_HOST}/book?token_id=${market.upTokenId}`),
        fetch(`${CLOB_HOST}/book?token_id=${market.downTokenId}`),
      ]);

      const upBook = await upRes.json();
      const downBook = await downRes.json();

      const book: OrderBook = {
        upAsk: upBook.asks?.[0]?.price ? parseFloat(upBook.asks[0].price) : 1,
        upAskSize: upBook.asks?.[0]?.size ? parseFloat(upBook.asks[0].size) : 0,
        upBid: upBook.bids?.[0]?.price ? parseFloat(upBook.bids[0].price) : 0,
        downAsk: downBook.asks?.[0]?.price ? parseFloat(downBook.asks[0].price) : 1,
        downAskSize: downBook.asks?.[0]?.size ? parseFloat(downBook.asks[0].size) : 0,
        downBid: downBook.bids?.[0]?.price ? parseFloat(downBook.bids[0].price) : 0,
        combined: 0,
        spread: 0,
        timestamp: Date.now(),
      };

      book.combined = book.upAsk + book.downAsk;
      book.spread = 1 - book.combined;
      orderBooks.set(conditionId, book);

      // Check for arb
      checkAndExecuteArb(market, book);

    } catch {
      // Ignore fetch errors
    }
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.log('');
  console.log('─'.repeat(90));
  console.log(`FAST ARB MONITOR | Markets: ${markets.size} | Trades: ${tradesExecuted} | Profit: $${totalProfit.toFixed(2)} | Mode: ${ENABLE_TRADING ? 'LIVE' : 'DRY RUN'}`);
  console.log('─'.repeat(90));

  const sorted = Array.from(orderBooks.entries())
    .sort((a, b) => a[1].combined - b[1].combined);

  for (const [conditionId, book] of sorted) {
    const market = markets.get(conditionId);
    if (!market) continue;

    const spreadPct = (book.spread * 100).toFixed(2);
    const icon = book.combined < MAX_COMBINED_PRICE ? '🎯' : '  ';
    const question = market.question.slice(0, 40).padEnd(40);
    const minSize = Math.min(book.upAskSize, book.downAskSize).toFixed(0);
    const age = ((Date.now() - book.timestamp) / 1000).toFixed(0);

    console.log(`${icon} ${question} | Up: $${book.upAsk.toFixed(2)} + Down: $${book.downAsk.toFixed(2)} = $${book.combined.toFixed(4)} (${spreadPct}%) | Liq: ${minSize} | ${age}s ago`);
  }

  console.log('─'.repeat(90));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              FAST SPREAD ARB BOT                           ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Min Spread:    ${(MIN_SPREAD_PROFIT * 100).toFixed(1)} cents                                  ║`);
  console.log(`║  Max Combined:  $${MAX_COMBINED_PRICE.toFixed(2)}                                    ║`);
  console.log(`║  Shares/Trade:  ${SHARES_PER_TRADE}                                        ║`);
  console.log(`║  Trading:       ${ENABLE_TRADING ? 'ENABLED' : 'DISABLED (monitor only)'}                       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load CLOB client
  log('Loading CLOB client...');
  const loaded = await loadClobClient();
  if (!loaded) {
    log('Failed to load CLOB client', 'ERROR');
    process.exit(1);
  }

  // Initialize client for trading
  if (ENABLE_TRADING) {
    await initClobClient();
  }

  // Find active markets
  log('Finding active BTC/ETH markets...');
  const activeMarkets = await findActiveMarkets();
  log(`Found ${activeMarkets.length} active markets`);

  for (const market of activeMarkets) {
    markets.set(market.conditionId, market);
    log(`  - ${market.question}`);
  }

  if (markets.size === 0) {
    log('No active markets found', 'ERROR');
    process.exit(1);
  }

  // Subscribe to order books via WebSocket
  log('Subscribing to order books via WebSocket...');
  for (const market of markets.values()) {
    subscribeToOrderBook(market);
  }

  // Also poll as fallback (every 2s)
  setInterval(pollOrderBooks, 2000);

  // Display status
  setInterval(displayStatus, 5000);

  // Refresh markets periodically
  setInterval(async () => {
    log('Refreshing market list...');
    const newMarkets = await findActiveMarkets();

    for (const market of newMarkets) {
      if (!markets.has(market.conditionId)) {
        markets.set(market.conditionId, market);
        subscribeToOrderBook(market);
        log(`Added new market: ${market.question.slice(0, 40)}...`);
      }
    }

    // Remove expired markets
    for (const [conditionId, market] of markets) {
      if (new Date(market.endDate) < new Date()) {
        markets.delete(conditionId);
        orderBooks.delete(conditionId);
        wsConnections.get(conditionId)?.close();
        wsConnections.delete(conditionId);
        log(`Removed expired market: ${market.question.slice(0, 40)}...`);
      }
    }
  }, 30000);

  log('Bot started - monitoring for arb opportunities...');
  log('Press Ctrl+C to stop');
}

main().catch(console.error);
