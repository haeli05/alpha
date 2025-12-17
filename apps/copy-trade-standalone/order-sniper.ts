/**
 * ORDER SNIPER
 *
 * Watches for NEW limit orders appearing at attractive prices and instantly takes them.
 * The arb wallet doesn't find arb in resting books - they snipe new orders as they appear.
 *
 * STRATEGY:
 * 1. Subscribe to order book WebSocket for real-time updates
 * 2. Track when new asks appear at prices better than resting book
 * 3. When we see good price AND would create arb with other side, instantly buy
 * 4. Build position over time like the target wallet does
 *
 * USAGE: npx tsx order-sniper.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_UP_PRICE = 0.75; // Max price to pay for Up
const MAX_DOWN_PRICE = 0.75; // Max price to pay for Down
const MAX_COMBINED = 0.98; // Only buy if combined would be < $0.98
const SHARES_PER_SNIPE = 20; // Shares to buy when sniping
const ENABLE_TRADING = false;
const MIN_PRICE_IMPROVEMENT = 0.05; // Only snipe if price is 5 cents better than $0.99

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

interface Position {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
}

interface BookState {
  upBestAsk: number;
  upBestAskSize: number;
  downBestAsk: number;
  downBestAskSize: number;
  lastUpAsk: number;
  lastDownAsk: number;
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();
const bookStates: Map<string, BookState> = new Map();

let snipesAttempted = 0;
let snipesSuccessful = 0;

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'SNIPE' | 'TRADE' | 'WS' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    SNIPE: '🎯',
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
    log(`Error finding markets: ${error.message}`, 'ERROR');
  }

  return result;
}

// ============================================================================
// WEBSOCKET ORDER BOOK SUBSCRIPTION
// ============================================================================

function subscribeToMarket(market: Market): void {
  const ws = new WebSocket(WS_URL);

  // Initialize book state
  bookStates.set(market.conditionId, {
    upBestAsk: 0.99,
    upBestAskSize: 0,
    downBestAsk: 0.99,
    downBestAskSize: 0,
    lastUpAsk: 0.99,
    lastDownAsk: 0.99,
  });

  ws.on('open', () => {
    log(`Connected to ${market.question.slice(0, 45)}`, 'WS');
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: [market.upTokenId, market.downTokenId],
    }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleBookUpdate(market, msg);
    } catch {
      // Ignore
    }
  });

  ws.on('error', (err) => {
    log(`WS error: ${err.message}`, 'ERROR');
  });

  ws.on('close', () => {
    log(`WS closed for ${market.question.slice(0, 30)}, reconnecting...`, 'WS');
    setTimeout(() => subscribeToMarket(market), 2000);
  });
}

function handleBookUpdate(market: Market, msg: any): void {
  const state = bookStates.get(market.conditionId);
  if (!state) return;

  // Check if this is a book update
  if (msg.event_type !== 'book' && msg.event_type !== 'price_change') return;

  const assetId = msg.asset_id;
  const isUp = assetId === market.upTokenId;

  // Get new best ask
  const asks = msg.market?.asks || [];
  if (asks.length === 0) return;

  const newBestAsk = parseFloat(asks[0].price);
  const newBestAskSize = parseFloat(asks[0].size);

  // Store previous values
  const prevAsk = isUp ? state.upBestAsk : state.downBestAsk;

  // Update state
  if (isUp) {
    state.lastUpAsk = state.upBestAsk;
    state.upBestAsk = newBestAsk;
    state.upBestAskSize = newBestAskSize;
  } else {
    state.lastDownAsk = state.downBestAsk;
    state.downBestAsk = newBestAsk;
    state.downBestAskSize = newBestAskSize;
  }

  // Check if this is a NEW better price (potential snipe opportunity)
  if (newBestAsk < prevAsk && newBestAsk < (0.99 - MIN_PRICE_IMPROVEMENT)) {
    checkSnipeOpportunity(market, state, isUp, newBestAsk, newBestAskSize);
  }
}

async function checkSnipeOpportunity(
  market: Market,
  state: BookState,
  isUpSide: boolean,
  newPrice: number,
  size: number
): Promise<void> {
  const side = isUpSide ? 'UP' : 'DOWN';
  const otherSideAsk = isUpSide ? state.downBestAsk : state.upBestAsk;
  const combinedPrice = newPrice + otherSideAsk;

  log(`NEW ${side} ASK: $${newPrice.toFixed(4)} (size: ${size.toFixed(0)}) | Combined would be: $${combinedPrice.toFixed(4)}`, 'SNIPE');

  // Check if price is attractive
  const maxPrice = isUpSide ? MAX_UP_PRICE : MAX_DOWN_PRICE;
  if (newPrice > maxPrice) {
    log(`  Skip: Price $${newPrice.toFixed(2)} > max $${maxPrice.toFixed(2)}`, 'INFO');
    return;
  }

  // Check combined price
  if (combinedPrice > MAX_COMBINED) {
    log(`  Skip: Combined $${combinedPrice.toFixed(4)} > max $${MAX_COMBINED.toFixed(2)}`, 'INFO');
    return;
  }

  // Check size
  if (size < SHARES_PER_SNIPE) {
    log(`  Skip: Size ${size.toFixed(0)} < min ${SHARES_PER_SNIPE}`, 'INFO');
    return;
  }

  // SNIPE OPPORTUNITY!
  log(``, 'SNIPE');
  log(`🎯🎯🎯 SNIPE OPPORTUNITY! 🎯🎯🎯`, 'SNIPE');
  log(`  Market: ${market.question}`, 'SNIPE');
  log(`  Side: ${side} @ $${newPrice.toFixed(4)}`, 'SNIPE');
  log(`  Combined: $${combinedPrice.toFixed(4)} (${((1 - combinedPrice) * 100).toFixed(2)}% profit)`, 'SNIPE');
  log(`  Available: ${size.toFixed(0)} shares`, 'SNIPE');

  snipesAttempted++;

  if (ENABLE_TRADING && clobClient) {
    await executeSnipe(market, isUpSide, newPrice, Math.min(size, SHARES_PER_SNIPE));
  } else {
    log(`  [DRY RUN] Would snipe ${SHARES_PER_SNIPE} shares`, 'SNIPE');
  }
}

async function executeSnipe(market: Market, isUpSide: boolean, price: number, shares: number): Promise<void> {
  const tokenId = isUpSide ? market.upTokenId : market.downTokenId;
  const side = isUpSide ? 'UP' : 'DOWN';

  log(`Executing snipe: BUY ${shares} ${side} @ $${price.toFixed(4)}`, 'TRADE');

  try {
    const result = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price + 0.01, // Slightly above to ensure fill
        side: Side.BUY,
        size: shares,
        feeRateBps: 0,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.FAK
    );

    const orderId = result?.order_id || result?.orderID;
    if (orderId) {
      log(`Snipe successful: ${orderId.slice(0, 20)}...`, 'TRADE');
      snipesSuccessful++;

      // Update position
      let pos = positions.get(market.conditionId);
      if (!pos) {
        pos = { upShares: 0, downShares: 0, upCost: 0, downCost: 0 };
        positions.set(market.conditionId, pos);
      }

      if (isUpSide) {
        pos.upShares += shares;
        pos.upCost += shares * price;
      } else {
        pos.downShares += shares;
        pos.downCost += shares * price;
      }
    } else {
      log(`Snipe may have failed - no order ID`, 'WARN');
    }

  } catch (error: any) {
    log(`Snipe error: ${error.message}`, 'ERROR');
  }
}

// ============================================================================
// POLLING (backup for when WebSocket doesn't catch updates)
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

      const state = bookStates.get(conditionId);
      if (!state) continue;

      const newUpAsk = upBook.asks?.[0]?.price ? parseFloat(upBook.asks[0].price) : 0.99;
      const newUpSize = upBook.asks?.[0]?.size ? parseFloat(upBook.asks[0].size) : 0;
      const newDownAsk = downBook.asks?.[0]?.price ? parseFloat(downBook.asks[0].price) : 0.99;
      const newDownSize = downBook.asks?.[0]?.size ? parseFloat(downBook.asks[0].size) : 0;

      // Check for new opportunities
      if (newUpAsk < state.upBestAsk && newUpAsk < (0.99 - MIN_PRICE_IMPROVEMENT)) {
        state.lastUpAsk = state.upBestAsk;
        state.upBestAsk = newUpAsk;
        state.upBestAskSize = newUpSize;
        checkSnipeOpportunity(market, state, true, newUpAsk, newUpSize);
      }

      if (newDownAsk < state.downBestAsk && newDownAsk < (0.99 - MIN_PRICE_IMPROVEMENT)) {
        state.lastDownAsk = state.downBestAsk;
        state.downBestAsk = newDownAsk;
        state.downBestAskSize = newDownSize;
        checkSnipeOpportunity(market, state, false, newDownAsk, newDownSize);
      }

      // Update state
      state.upBestAsk = newUpAsk;
      state.downBestAsk = newDownAsk;

    } catch {
      // Ignore
    }
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayStatus(): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(`ORDER SNIPER | Markets: ${markets.size} | Snipes: ${snipesSuccessful}/${snipesAttempted} | Mode: ${ENABLE_TRADING ? 'LIVE' : 'MONITOR'}`);
  console.log('═'.repeat(100));

  for (const [conditionId, market] of markets) {
    const state = bookStates.get(conditionId);
    const pos = positions.get(conditionId);
    if (!state) continue;

    const combined = state.upBestAsk + state.downBestAsk;
    const question = market.question.slice(0, 50).padEnd(50);

    console.log(`${question} | Up: $${state.upBestAsk.toFixed(2)} + Down: $${state.downBestAsk.toFixed(2)} = $${combined.toFixed(4)}`);

    if (pos && (pos.upShares > 0 || pos.downShares > 0)) {
      const avgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
      const avgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
      const combinedCost = avgUp + avgDown;
      const hedged = Math.min(pos.upShares, pos.downShares);
      const profit = hedged * (1 - combinedCost);

      console.log(`  Position: Up ${pos.upShares.toFixed(0)} @ $${avgUp.toFixed(2)} | Down ${pos.downShares.toFixed(0)} @ $${avgDown.toFixed(2)} | Profit: $${profit.toFixed(2)}`);
    }
  }

  console.log('═'.repeat(100));
  console.log('Watching for new limit orders at attractive prices...');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              ORDER SNIPER                                  ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Max Up Price:    $${MAX_UP_PRICE.toFixed(2)}                                  ║`);
  console.log(`║  Max Down Price:  $${MAX_DOWN_PRICE.toFixed(2)}                                  ║`);
  console.log(`║  Max Combined:    $${MAX_COMBINED.toFixed(2)}                                  ║`);
  console.log(`║  Shares/Snipe:    ${SHARES_PER_SNIPE}                                        ║`);
  console.log(`║  Trading:         ${ENABLE_TRADING ? 'ENABLED' : 'DISABLED'}                                 ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load CLOB client
  log('Loading CLOB client...');
  await loadClobClient();

  if (ENABLE_TRADING) {
    await initClobClient();
  }

  // Find active markets
  log('Finding active markets from target wallet activity...');
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

  // Subscribe to order books
  log('Subscribing to order book streams...');
  for (const market of markets.values()) {
    subscribeToMarket(market);
  }

  // Poll as backup
  setInterval(pollOrderBooks, 1000);

  // Display status
  setInterval(displayStatus, 10000);

  // Refresh markets
  setInterval(async () => {
    const newMarkets = await findActiveMarkets();
    for (const market of newMarkets) {
      if (!markets.has(market.conditionId)) {
        markets.set(market.conditionId, market);
        subscribeToMarket(market);
        log(`Added market: ${market.question}`);
      }
    }
  }, 30000);

  log('Sniper active - watching for opportunities...');
}

main().catch(console.error);
