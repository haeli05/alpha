/**
 * POLYMARKET SPREAD ARB BOT
 *
 * Captures spreads where Yes + No < $1 on BTC/ETH 15min and hourly markets.
 *
 * STRATEGY:
 * 1. Monitor order books for Yes and No tokens
 * 2. When bestAsk(Yes) + bestAsk(No) < threshold, execute arb
 * 3. Buy both legs via FAK @ $0.99 (market order)
 * 4. Hold until resolution, collect guaranteed profit
 *
 * USAGE: npx tsx spread-arb.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MIN_SPREAD_PROFIT = 0.02; // Minimum 2 cents profit per share
const MAX_COMBINED_PRICE = 1 - MIN_SPREAD_PROFIT; // $0.98
const SHARES_PER_TRADE = 50; // Start small
const ENABLE_TRADING = false; // Set true to enable live trading
const POLL_INTERVAL_MS = 5000; // Check markets every 5s

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

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
    const tempClient = new ClobClient(CLOB_HOST, 137, wallet, undefined, signatureType, funder);
    const creds = await tempClient.createOrDeriveApiKey();
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, creds, signatureType, funder);
    log('CLOB client initialized');
  } catch (error) {
    log(`Using provided API credentials`, 'WARN');
    clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
      key: POLYMARKET_API_KEY,
      secret: POLYMARKET_SECRET,
      passphrase: POLYMARKET_PASSPHRASE,
    }, signatureType, funder);
  }
}

// ============================================================================
// TYPES
// ============================================================================

interface Market {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  active: boolean;
}

interface OrderBookState {
  yesAsk: number;
  yesBid: number;
  yesAskSize: number;
  noAsk: number;
  noBid: number;
  noAskSize: number;
  combined: number;
  spread: number;
  lastUpdate: number;
}

interface Position {
  market: Market;
  yesShares: number;
  noShares: number;
  avgYesPrice: number;
  avgNoPrice: number;
  combinedCost: number;
  timestamp: number;
}

// ============================================================================
// STATE
// ============================================================================

const activeMarkets: Map<string, Market> = new Map();
const orderBooks: Map<string, OrderBookState> = new Map();
const positions: Map<string, Position> = new Map();
const wsConnections: Map<string, WebSocket> = new Map();

let totalPnL = 0;
let tradesExecuted = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'ARB' | 'TRADE' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    ARB: '🎯',
    TRADE: '💰'
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

async function findActiveMarkets(): Promise<Market[]> {
  const markets: Market[] = [];
  const seenConditions = new Set<string>();

  try {
    // Method 1: Get markets from target wallet's recent trades
    const tradesRes = await fetch(`https://data-api.polymarket.com/trades?user=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d&limit=100`);
    if (tradesRes.ok) {
      const trades = await tradesRes.json();
      for (const trade of trades) {
        const conditionId = trade.conditionId;
        if (!conditionId || seenConditions.has(conditionId)) continue;
        seenConditions.add(conditionId);

        // Get market details from CLOB
        const clobRes = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
        if (!clobRes.ok) continue;

        const clobData = await clobRes.json();
        if (!clobData.question?.includes('Up or Down')) continue;
        if (clobData.closed) continue;

        const tokens = clobData.tokens || [];
        const yesToken = tokens.find((t: any) =>
          t.outcome?.toLowerCase() === 'yes' || t.outcome?.toLowerCase() === 'up'
        );
        const noToken = tokens.find((t: any) =>
          t.outcome?.toLowerCase() === 'no' || t.outcome?.toLowerCase() === 'down'
        );

        if (!yesToken || !noToken) continue;

        markets.push({
          conditionId,
          question: clobData.question,
          yesTokenId: yesToken.token_id,
          noTokenId: noToken.token_id,
          endDate: clobData.end_date_iso,
          active: true,
        });

        // Rate limit
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Method 2: Generate slugs for current/upcoming hours (BTC and ETH)
    const now = new Date();
    const etOffset = -5; // EST offset
    const etHour = (now.getUTCHours() + etOffset + 24) % 24;
    const etDate = now.getUTCDate();
    const etMonth = now.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' }).toLowerCase();

    // Try hourly and 15-min patterns
    const patterns = [
      `bitcoin-up-or-down-december-${etDate}-${etHour}am-et`,
      `bitcoin-up-or-down-december-${etDate}-${etHour + 1}am-et`,
      `ethereum-up-or-down-december-${etDate}-${etHour}am-et`,
    ];

    for (const slug of patterns) {
      if (seenConditions.has(slug)) continue;

      const slugRes = await fetch(`${GAMMA_HOST}/markets/slug/${slug}`);
      if (!slugRes.ok) continue;

      const data = await slugRes.json();
      if (!data.conditionId || seenConditions.has(data.conditionId)) continue;
      seenConditions.add(data.conditionId);

      const clobRes = await fetch(`${CLOB_HOST}/markets/${data.conditionId}`);
      if (!clobRes.ok) continue;

      const clobData = await clobRes.json();
      if (clobData.closed) continue;

      const tokens = clobData.tokens || [];
      const yesToken = tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'yes' || t.outcome?.toLowerCase() === 'up'
      );
      const noToken = tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'no' || t.outcome?.toLowerCase() === 'down'
      );

      if (yesToken && noToken) {
        markets.push({
          conditionId: data.conditionId,
          question: clobData.question,
          yesTokenId: yesToken.token_id,
          noTokenId: noToken.token_id,
          endDate: clobData.end_date_iso,
          active: true,
        });
      }
    }
  } catch (error) {
    log(`Error finding markets: ${error}`, 'ERROR');
  }

  return markets;
}

// ============================================================================
// ORDER BOOK MONITORING
// ============================================================================

async function fetchOrderBook(tokenId: string): Promise<{ ask: number; bid: number; askSize: number } | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return null;

    const data = await res.json();

    // Best ask (lowest sell price)
    const asks = data.asks || [];
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
    const askSize = asks.length > 0 ? parseFloat(asks[0].size) : 0;

    // Best bid (highest buy price)
    const bids = data.bids || [];
    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;

    return { ask: bestAsk, bid: bestBid, askSize };
  } catch {
    return null;
  }
}

async function updateOrderBooks(): Promise<void> {
  for (const [conditionId, market] of activeMarkets) {
    const yesBook = await fetchOrderBook(market.yesTokenId);
    const noBook = await fetchOrderBook(market.noTokenId);

    if (!yesBook || !noBook) continue;

    const combined = yesBook.ask + noBook.ask;
    const spread = 1 - combined;

    orderBooks.set(conditionId, {
      yesAsk: yesBook.ask,
      yesBid: yesBook.bid,
      yesAskSize: yesBook.askSize,
      noAsk: noBook.ask,
      noBid: noBook.bid,
      noAskSize: noBook.askSize,
      combined,
      spread,
      lastUpdate: Date.now(),
    });
  }
}

// ============================================================================
// ARB DETECTION
// ============================================================================

function checkForArb(): { market: Market; book: OrderBookState } | null {
  for (const [conditionId, book] of orderBooks) {
    const market = activeMarkets.get(conditionId);
    if (!market) continue;

    // Check if combined price is below threshold
    if (book.combined < MAX_COMBINED_PRICE) {
      // Check liquidity
      const minSize = Math.min(book.yesAskSize, book.noAskSize);
      if (minSize >= SHARES_PER_TRADE) {
        return { market, book };
      }
    }
  }

  return null;
}

// ============================================================================
// EXECUTION
// ============================================================================

async function executeArb(market: Market, book: OrderBookState): Promise<boolean> {
  if (!ENABLE_TRADING || !clobClient) {
    log(`[DRY RUN] Would buy ${SHARES_PER_TRADE} Yes @ $${book.yesAsk.toFixed(4)} + No @ $${book.noAsk.toFixed(4)} = $${book.combined.toFixed(4)}`, 'ARB');
    return false;
  }

  log(`EXECUTING ARB: ${market.question.slice(0, 40)}...`, 'TRADE');
  log(`  Combined: $${book.combined.toFixed(4)} | Spread: ${(book.spread * 100).toFixed(2)}%`, 'TRADE');

  try {
    // Get market info for tick size
    const marketInfo = await fetch(`${CLOB_HOST}/markets/${market.conditionId}`).then(r => r.json());
    const tickSize = marketInfo.tick_size || '0.01';
    const negRisk = marketInfo.neg_risk || false;

    // Execute both legs as FAK @ $0.99 (market order)
    const buyYes = clobClient.createAndPostOrder(
      {
        tokenID: market.yesTokenId,
        price: 0.99,
        side: Side.BUY,
        size: SHARES_PER_TRADE,
        feeRateBps: 0,
      },
      { tickSize, negRisk },
      OrderType.FAK
    );

    const buyNo = clobClient.createAndPostOrder(
      {
        tokenID: market.noTokenId,
        price: 0.99,
        side: Side.BUY,
        size: SHARES_PER_TRADE,
        feeRateBps: 0,
      },
      { tickSize, negRisk },
      OrderType.FAK
    );

    // Execute both simultaneously
    const [yesResult, noResult] = await Promise.all([buyYes, buyNo]);

    const yesOrderId = yesResult?.order_id || yesResult?.orderID;
    const noOrderId = noResult?.order_id || noResult?.orderID;

    log(`  Yes order: ${yesOrderId?.slice(0, 20) || 'FAILED'}...`, 'TRADE');
    log(`  No order: ${noOrderId?.slice(0, 20) || 'FAILED'}...`, 'TRADE');

    // Track position
    positions.set(market.conditionId, {
      market,
      yesShares: SHARES_PER_TRADE,
      noShares: SHARES_PER_TRADE,
      avgYesPrice: book.yesAsk,
      avgNoPrice: book.noAsk,
      combinedCost: book.combined,
      timestamp: Date.now(),
    });

    const expectedProfit = SHARES_PER_TRADE * book.spread;
    log(`  Expected profit: $${expectedProfit.toFixed(2)}`, 'TRADE');

    tradesExecuted++;
    return true;

  } catch (error: any) {
    log(`Execution error: ${error.message}`, 'ERROR');
    return false;
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.log('\n' + '─'.repeat(80));
  console.log(`SPREAD MONITOR | Markets: ${activeMarkets.size} | Trades: ${tradesExecuted} | Mode: ${ENABLE_TRADING ? 'LIVE' : 'DRY RUN'}`);
  console.log('─'.repeat(80));

  const sorted = Array.from(orderBooks.entries())
    .sort((a, b) => a[1].combined - b[1].combined);

  for (const [conditionId, book] of sorted) {
    const market = activeMarkets.get(conditionId);
    if (!market) continue;

    const spreadPct = (book.spread * 100).toFixed(2);
    const icon = book.combined < MAX_COMBINED_PRICE ? '🎯' : '  ';
    const question = market.question.slice(0, 45).padEnd(45);
    const minSize = Math.min(book.yesAskSize, book.noAskSize).toFixed(0);

    console.log(`${icon} ${question} | Yes: $${book.yesAsk.toFixed(2)} + No: $${book.noAsk.toFixed(2)} = $${book.combined.toFixed(4)} (${spreadPct}%) | Depth: ${minSize}`);
  }

  console.log('─'.repeat(80));
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           POLYMARKET SPREAD ARB BOT                        ║');
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
  const markets = await findActiveMarkets();
  log(`Found ${markets.length} active markets`);

  for (const market of markets) {
    activeMarkets.set(market.conditionId, market);
    log(`  - ${market.question.slice(0, 60)}`);
  }

  if (activeMarkets.size === 0) {
    log('No active markets found', 'ERROR');
    process.exit(1);
  }

  // Initial order book fetch
  log('Fetching order books...');
  await updateOrderBooks();

  // Display initial status
  displayStatus();

  // Main loop
  log('Starting spread monitor...');

  setInterval(async () => {
    // Update order books
    await updateOrderBooks();

    // Check for arb opportunities
    const arb = checkForArb();
    if (arb) {
      log(`ARB DETECTED: ${arb.market.question.slice(0, 40)}...`, 'ARB');
      log(`  Combined: $${arb.book.combined.toFixed(4)} | Spread: ${(arb.book.spread * 100).toFixed(2)}%`, 'ARB');

      if (ENABLE_TRADING) {
        await executeArb(arb.market, arb.book);
      }
    }

    // Display status
    displayStatus();

  }, POLL_INTERVAL_MS);

  // Refresh markets periodically
  setInterval(async () => {
    log('Refreshing market list...');
    const newMarkets = await findActiveMarkets();

    // Add new markets
    for (const market of newMarkets) {
      if (!activeMarkets.has(market.conditionId)) {
        activeMarkets.set(market.conditionId, market);
        log(`Added new market: ${market.question.slice(0, 50)}...`);
      }
    }

    // Remove expired markets
    for (const [conditionId, market] of activeMarkets) {
      if (new Date(market.endDate) < new Date()) {
        activeMarkets.delete(conditionId);
        orderBooks.delete(conditionId);
        log(`Removed expired market: ${market.question.slice(0, 50)}...`);
      }
    }
  }, 60000); // Every minute
}

main().catch(console.error);
