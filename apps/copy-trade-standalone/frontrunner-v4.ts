/**
 * ══════════════════════════════════════════════════════════════════════════════
 * FRONTRUNNER V4 - TARGET WALLET STRATEGY
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * OVERVIEW
 * --------
 * This bot "frontrunns" market opens on Polymarket's 15-minute crypto markets.
 * It's designed to capture the price inefficiencies that exist in the first
 * few minutes after a new market opens, when liquidity is thin and prices
 * are often mispriced.
 *
 * The strategy is reverse-engineered from analyzing a profitable whale wallet
 * (0x6031b...) that consistently achieves 10-17% profit margins.
 *
 * WHAT IS "FRONTRUNNING" IN THIS CONTEXT?
 * ---------------------------------------
 * NOT illegal frontrunning (seeing pending txs). Instead:
 * - Markets open every 15 minutes (e.g., 12:00, 12:15, 12:30)
 * - First ~30 seconds have thin liquidity and wild prices
 * - Bot "snipes" cheap tokens before market stabilizes
 * - Then hedges when prices normalize
 *
 * TARGET WALLET ANALYSIS (0x6031b...)
 * -----------------------------------
 * By analyzing the whale's trading patterns, we discovered:
 *
 * 1. TIMING: Enters within +19 seconds of market open
 *    - Liquidity providers haven't fully set up
 *    - Prices often temporarily dislocated
 *
 * 2. PRICE DISCIPLINE: Only buys when tokens are CHEAP
 *    - Entry range: 27¢ - 40¢ (never above 48¢)
 *    - At 27¢: Risk $0.27 to win $0.73 = 2.7:1 reward/risk
 *    - Even unhedged, this is +EV if win rate > 27%
 *
 * 3. AGGRESSIVE EARLY, PASSIVE LATE:
 *    - First 2 minutes: Rapid-fire orders (300ms polling)
 *    - Minutes 2-5: Slower, selective entries
 *    - After 5 min: No new positions, only hedges
 *    - Last 5 min: Complete freeze (accept directional risk)
 *
 * 4. ACCEPTS DIRECTIONAL RISK:
 *    - Doesn't force hedges at bad prices
 *    - If hedge would cost >98¢ combined, skips it
 *    - Willing to let position expire unhedged if entry was cheap
 *
 * STRATEGY BREAKDOWN
 * ------------------
 *
 * PHASE 1: AGGRESSIVE SNIPE (0-2 minutes)
 * ├── Poll every 300ms (fast!)
 * ├── Buy ANY token ≤ 48¢
 * ├── Place orders at best_bid + 1¢ (edge)
 * ├── Size: 5 shares per order (small lots, many bets)
 * └── Max imbalance: 10 shares (risk limit)
 *
 * PHASE 2: ENTRY PHASE (2-5 minutes)
 * ├── Slower polling (600ms)
 * ├── Same price criteria (≤48¢)
 * ├── Continue building positions
 * └── Start looking for hedges
 *
 * PHASE 3: HEDGE ONLY (5-10 minutes)
 * ├── No new positions
 * ├── Only place orders that REDUCE imbalance
 * ├── Hedge if combined ≤ 98¢
 * └── Patient - don't force bad hedges
 *
 * PHASE 4: FREEZE (last 5 minutes)
 * ├── Accept whatever position we have
 * ├── Still try to hedge if opportunity appears
 * └── No panic selling
 *
 * RESOLUTION & P&L
 * ├── Wait for market to resolve
 * ├── Check which side won (UP or DOWN)
 * ├── Calculate P&L based on cost basis
 * └── Log cumulative stats
 *
 * WHY THIS WORKS (EDGE EXPLAINED)
 * -------------------------------
 *
 * 1. INFORMATION ASYMMETRY AT OPEN
 *    - Market makers need time to assess fair value
 *    - Early liquidity is often mispriced
 *    - Fast bots capture these mispricings
 *
 * 2. FAVORABLE RISK/REWARD ON CHEAP ENTRIES
 *    Example at 30¢ entry:
 *    - If hedged at 65¢: Combined 95¢ = 5¢ profit (guaranteed)
 *    - If unhedged and WINS: Profit = $1.00 - $0.30 = 70¢
 *    - If unhedged and LOSES: Loss = $0.30
 *    - Break-even win rate: 30% (coin flip is 50%)
 *
 * 3. MULTI-ASSET DIVERSIFICATION
 *    - Trades BTC, ETH, SOL, XRP simultaneously
 *    - Uncorrelated short-term movements
 *    - Law of large numbers smooths variance
 *
 * POSITION TRACKING
 * -----------------
 * The bot tracks positions TWO ways:
 *
 * 1. LOCAL TRACKING (immediate)
 *    - Updated on every fill
 *    - May miss external trades
 *    - Fast for decision making
 *
 * 2. API SYNC (authoritative)
 *    - Fetches from Polymarket API
 *    - Catches external fills
 *    - Defensive: uses MAX of local and API
 *
 * ORDER MANAGEMENT
 * ----------------
 * - Uses GTC (Good Till Cancelled) orders
 * - Checks fill status after 500ms
 * - Cancels unfilled orders immediately (no stale orders)
 * - Tracks orders per side to prevent "snowball" effect
 *
 * RISK CONTROLS
 * -------------
 * 1. MAX_ENTRY_PRICE (48¢): Never buy expensive tokens
 * 2. MAX_IMBALANCE (10): Max 10 unhedged shares
 * 3. MAX_SINGLE_SIDE (15): Max 15 shares on one side (new)
 * 4. MAX_TOTAL_PER_SIDE (250): Large hedged positions OK
 * 5. MAX_ORDERS_PER_SIDE (10): Prevent order spam
 * 6. TARGET_COMBINED (98¢): Only hedge if profitable
 *
 * MULTI-ACCOUNT SUPPORT
 * ---------------------
 * Run multiple instances with different accounts:
 *   npx tsx frontrunner-v4.ts              # Uses POLYMARKET_PRIVATE_KEY
 *   npx tsx frontrunner-v4.ts --account=2  # Uses POLYMARKET2_PRIVATE_KEY
 *
 * This allows:
 * - Scaling capital across multiple wallets
 * - Different risk parameters per account
 * - Redundancy if one account has issues
 *
 * MARKET TIMING
 * -------------
 * 15-minute markets use this slug format:
 *   {asset}-updown-15m-{unix_timestamp_of_start}
 *
 * Example: btc-updown-15m-1702819200
 * - Asset: BTC
 * - Duration: 15 minutes
 * - Start: Unix timestamp 1702819200
 * - End: 1702819200 + 900 = 1702820100
 *
 * Bot calculates current/next windows based on system time.
 *
 * USAGE
 * -----
 *   npx tsx frontrunner-v4.ts              # Account 1, all assets
 *   npx tsx frontrunner-v4.ts --account=2  # Account 2, all assets
 *
 * ENVIRONMENT VARIABLES
 * ---------------------
 *   POLYMARKET_PRIVATE_KEY: Account 1 private key
 *   POLYMARKET_FUNDER_ADDRESS: Account 1 proxy wallet (optional)
 *   POLYMARKET2_PRIVATE_KEY: Account 2 private key
 *   POLYMARKET2_FUNDER_ADDRESS: Account 2 proxy wallet (optional)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// MULTI-ACCOUNT SUPPORT
// ============================================================================

const accountArg = process.argv.find(a => a.startsWith('--account='));
const accountNum = accountArg ? accountArg.split('=')[1] : '1';
const envPrefix = accountNum === '1' ? 'POLYMARKET' : `POLYMARKET${accountNum}`;

// ============================================================================
// CONFIGURATION - TARGET WALLET STYLE
// ============================================================================

const CONFIG = {
  // Fixed lot size
  LOT_SIZE: 5,                // 5 shares per order (as requested)

  // CRITICAL: Only buy when price is CHEAP
  MAX_ENTRY_PRICE: 0.48,      // Only buy when side is ≤48¢

  // Combined price target for hedging
  TARGET_COMBINED: 0.98,      // 2¢ profit when hedged

  // Price bounds
  MIN_BID: 0.10,
  MAX_BID: 0.90,

  // Timing - AGGRESSIVE EARLY, FREEZE LATE
  AGGRESSIVE_WINDOW_MS: 2 * 60 * 1000,   // First 2 minutes: trade hard
  ENTRY_WINDOW_MS: 5 * 60 * 1000,        // Allow entries up to 5 minutes
  FREEZE_BEFORE_END_MS: 5 * 60 * 1000,   // Stop ALL trading 5 min before end
  POLL_INTERVAL_MS: 300,                  // Check every 300ms (fast during snipe)

  // Risk - LIMITED EXPOSURE
  MAX_IMBALANCE: 10,          // CRITICAL: Max 10 unhedged shares
  MAX_SINGLE_SIDE: 15,        // Max 15 shares on one side (new positions only)
  MAX_TOTAL_PER_SIDE: 250,    // Large hedged positions OK
  MAX_ORDERS_PER_SIDE: 10,    // Max GTC orders per side per market (prevents snowball)

  // Assets to trade
  ASSETS: ['btc', 'eth', 'sol', 'xrp'],

  // Trading
  ENABLE_TRADING: true,
};

// ============================================================================
// CREDENTIALS
// ============================================================================

const POLYMARKET_PRIVATE_KEY = process.env[`${envPrefix}_PRIVATE_KEY`]!;
const FUNDER_ADDRESS = process.env[`${envPrefix}_FUNDER_ADDRESS`] || '0x2163f00898fb58f47573e89940ff728a5e07ac09';

if (!POLYMARKET_PRIVATE_KEY) {
  console.error(`Missing ${envPrefix}_PRIVATE_KEY in .env`);
  process.exit(1);
}

// ============================================================================
// API SETUP
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';

const wallet = new Wallet(
  POLYMARKET_PRIVATE_KEY.startsWith('0x') ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`
);

let clobClient: any = null;
let Side: any = null;
let OrderType: any = null;

async function initClobClient(): Promise<void> {
  const module = await import('@polymarket/clob-client');
  Side = module.Side;
  OrderType = module.OrderType;

  const tempClient = new module.ClobClient(CLOB_HOST, 137, wallet, undefined, 2, FUNDER_ADDRESS);
  const creds = await tempClient.createOrDeriveApiKey();
  clobClient = new module.ClobClient(CLOB_HOST, 137, wallet, creds, 2, FUNDER_ADDRESS);

  log('CLOB client initialized', 'INFO');
}

// ============================================================================
// LOGGING
// ============================================================================

function log(msg: string, type: 'INFO' | 'ORDER' | 'FILL' | 'PROFIT' | 'WARN' | 'SNIPE' | 'CHEAP' = 'INFO'): void {
  const colors: Record<string, string> = {
    INFO: '\x1b[37m',
    ORDER: '\x1b[36m',
    FILL: '\x1b[32m',
    PROFIT: '\x1b[32m',
    WARN: '\x1b[33m',
    SNIPE: '\x1b[35m',
    CHEAP: '\x1b[32m',  // Green for cheap entries
  };
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${colors[type]}[${time}] [${type}] ${msg}\x1b[0m`);
}

// ============================================================================
// MARKET TIMING
// ============================================================================

interface MarketWindow {
  asset: string;
  startTime: number;
  endTime: number;
  slug: string;
}

function getCurrentAndNextWindows(): { current: MarketWindow[], next: MarketWindow[], nextStartMs: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const interval = 15 * 60;

  const currentWindowStart = Math.floor(nowSec / interval) * interval;
  const nextWindowStart = currentWindowStart + interval;

  const current: MarketWindow[] = [];
  const next: MarketWindow[] = [];

  for (const asset of CONFIG.ASSETS) {
    current.push({
      asset: asset.toUpperCase(),
      startTime: currentWindowStart,
      endTime: currentWindowStart + interval,
      slug: `${asset}-updown-15m-${currentWindowStart}`,
    });
    next.push({
      asset: asset.toUpperCase(),
      startTime: nextWindowStart,
      endTime: nextWindowStart + interval,
      slug: `${asset}-updown-15m-${nextWindowStart}`,
    });
  }

  return { current, next, nextStartMs: nextWindowStart * 1000 };
}

// ============================================================================
// MARKET DATA
// ============================================================================

interface MarketTokens {
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  tickSize: string;
  negRisk: boolean;
}

const marketTokensCache = new Map<string, MarketTokens>();

async function getMarketTokens(slug: string): Promise<MarketTokens | null> {
  if (marketTokensCache.has(slug)) {
    return marketTokensCache.get(slug)!;
  }

  try {
    const res = await fetch(`${GAMMA_HOST}/events?slug=${slug}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.[0]?.markets?.[0]) return null;

    const m = data[0].markets[0];
    const tokens = JSON.parse(m.clobTokenIds || '[]');

    if (tokens.length < 2) return null;

    const result: MarketTokens = {
      conditionId: m.conditionId || '',
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      tickSize: m.orderPriceMinTickSize?.toString() || '0.01',
      negRisk: m.negRisk || false,
    };

    marketTokensCache.set(slug, result);
    return result;
  } catch {
    return null;
  }
}

async function fetchBestBid(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return 0;

    const book = await res.json();
    let best = 0;
    for (const b of book.bids || []) {
      const p = parseFloat(b.price);
      if (p > best && p >= CONFIG.MIN_BID) best = p;
    }
    return best;
  } catch {
    return 0;
  }
}

// ============================================================================
// ORDER PLACEMENT
// ============================================================================

interface OrderResult {
  orderId: string;
  filledSize: number;
}

async function placeOrder(
  tokenId: string,
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean
): Promise<OrderResult | null> {
  if (!CONFIG.ENABLE_TRADING) {
    return { orderId: `paper-${Date.now()}`, filledSize: size };
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
      { tickSize, negRisk },
      OrderType.GTC
    );

    const orderId = result?.order_id || result?.orderID;
    if (!orderId) {
      log(`No order ID returned`, 'WARN');
      return null;
    }

    // Check if order actually filled by querying order status
    await new Promise(r => setTimeout(r, 500)); // Wait for fill to propagate

    try {
      const orderStatus = await clobClient.getOrder(orderId);
      const filledSize = parseFloat(orderStatus?.size_matched || '0');

      if (filledSize === 0) {
        // Nothing filled - cancel and return null
        log(`Order ${orderId.slice(0, 8)} unfilled - cancelling`, 'WARN');
        await clobClient.cancelOrder(orderId);
        return null;
      }

      // Cancel any remaining unfilled portion
      if (filledSize < size) {
        await clobClient.cancelOrder(orderId);
      }

      log(`Order ${orderId.slice(0, 8)} filled ${filledSize}/${size}`, 'INFO');
      return { orderId, filledSize };
    } catch (statusErr: any) {
      // Can't check status, assume it worked
      return { orderId, filledSize: size };
    }
  } catch (e: any) {
    log(`Order error: ${e.message}`, 'WARN');
    return null;
  }
}

// ============================================================================
// POSITION TRACKING
// ============================================================================

interface Position {
  asset: string;
  slug: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  orders: number;
  upOrdersPlaced: number;   // Track GTC orders placed per side
  downOrdersPlaced: number; // to prevent snowball
}

const positions: Map<string, Position> = new Map();

// Stats
let marketsTraded = 0;
let cumulativePnL = 0;
let totalWins = 0;
let totalLosses = 0;

// ============================================================================
// POSITION SYNC FROM API
// ============================================================================

interface ApiPosition {
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
}

async function syncPositionsFromApi(windows: MarketWindow[]): Promise<boolean> {
  try {
    const res = await fetch(`${DATA_API_HOST}/positions?user=${FUNDER_ADDRESS}`);
    if (!res.ok) {
      log(`Position sync HTTP error: ${res.status}`, 'WARN');
      return false;
    }

    const apiPositions: ApiPosition[] = await res.json();

    for (const window of windows) {
      const pos = positions.get(window.slug);
      if (!pos) continue;

      const tokens = marketTokensCache.get(window.slug);
      if (!tokens?.conditionId) continue;

      const marketConditionId = tokens.conditionId.toLowerCase().replace(/^0x/, '');

      let apiUp = 0, apiDown = 0, apiUpCost = 0, apiDownCost = 0;

      for (const apiPos of apiPositions) {
        const posConditionId = (apiPos.conditionId || '').toLowerCase().replace(/^0x/, '');

        if (posConditionId === marketConditionId) {
          if (apiPos.outcome === 'Up' || apiPos.outcome === 'Yes') {
            apiUp = apiPos.size;
            apiUpCost = apiPos.size * apiPos.avgPrice;
          } else if (apiPos.outcome === 'Down' || apiPos.outcome === 'No') {
            apiDown = apiPos.size;
            apiDownCost = apiPos.size * apiPos.avgPrice;
          }
        }
      }

      // DEFENSIVE SYNC: Never decrease positions (API might be stale)
      // Only increase if API shows more than we tracked
      const newUp = Math.max(pos.upShares, apiUp);
      const newDown = Math.max(pos.downShares, apiDown);

      if (newUp !== pos.upShares || newDown !== pos.downShares) {
        log(`${pos.asset}: API sync ${pos.upShares}↑/${pos.downShares}↓ → ${newUp}↑/${newDown}↓`, 'INFO');
      }

      pos.upShares = newUp;
      pos.downShares = newDown;
      // Only update costs if API shows more
      if (apiUp > 0) pos.upCost = Math.max(pos.upCost, apiUpCost);
      if (apiDown > 0) pos.downCost = Math.max(pos.downCost, apiDownCost);
    }
    return true;
  } catch (error: any) {
    log(`Position sync failed: ${error.message}`, 'WARN');
    return false;
  }
}

// ============================================================================
// SNIPE EXECUTION - TARGET WALLET STYLE
// ============================================================================

async function snipeMarket(window: MarketWindow, isAggressivePhase: boolean, hedgeOnly: boolean = false): Promise<void> {
  const { asset, slug } = window;

  const tokens = await getMarketTokens(slug);
  if (!tokens) return;

  // Initialize position
  if (!positions.has(slug)) {
    positions.set(slug, {
      asset,
      slug,
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
      orders: 0,
      upOrdersPlaced: 0,
      downOrdersPlaced: 0,
    });
  }

  const pos = positions.get(slug)!;

  // LOG CURRENT POSITION STATE
  if (pos.upShares > 0 || pos.downShares > 0) {
    const currentImbal = pos.upShares - pos.downShares;
    log(`${asset}: POSITION STATE: ${pos.upShares}↑ / ${pos.downShares}↓ (imbal: ${currentImbal})`, 'INFO');
  }

  // Get current best bids
  const [upBid, downBid] = await Promise.all([
    fetchBestBid(tokens.upTokenId),
    fetchBestBid(tokens.downTokenId),
  ]);

  if (upBid === 0 && downBid === 0) {
    return; // No liquidity
  }

  // Calculate entry prices (bid + 1 tick)
  const upPrice = Math.min(CONFIG.MAX_BID, upBid + 0.01);
  const downPrice = Math.min(CONFIG.MAX_BID, downBid + 0.01);

  // Current position state
  const imbalance = pos.upShares - pos.downShares;
  const avgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
  const avgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;

  // =========================================================================
  // TARGET WALLET STRATEGY: Only buy when price is CHEAP
  // =========================================================================

  let buyUp = false;
  let buyDown = false;

  // POSITION LIMITS (no imbalance check here - that's handled per-mode below)
  const canBuyMoreUp = pos.upShares + CONFIG.LOT_SIZE <= CONFIG.MAX_TOTAL_PER_SIDE
    && pos.upOrdersPlaced < CONFIG.MAX_ORDERS_PER_SIDE;

  const canBuyMoreDown = pos.downShares + CONFIG.LOT_SIZE <= CONFIG.MAX_TOTAL_PER_SIDE
    && pos.downOrdersPlaced < CONFIG.MAX_ORDERS_PER_SIDE;

  // Imbalance checks - ONLY for new positions, NOT for hedging
  const projectedUpImbalance = imbalance + CONFIG.LOT_SIZE;
  const projectedDownImbalance = imbalance - CONFIG.LOT_SIZE;
  const upWouldExceedImbalance = projectedUpImbalance > CONFIG.MAX_IMBALANCE;
  const downWouldExceedImbalance = projectedDownImbalance < -CONFIG.MAX_IMBALANCE;

  // Is buying UP a hedge? (reduces negative imbalance)
  const buyingUpIsHedge = pos.downShares > 0 && pos.upShares < pos.downShares;
  // Is buying DOWN a hedge? (reduces positive imbalance)
  const buyingDownIsHedge = pos.upShares > 0 && pos.downShares < pos.upShares;

  // =========================================================================
  // PRIORITY 1: HEDGE UNHEDGED POSITIONS (NO LIMITS - JUST DO IT)
  // =========================================================================

  // DEBUG: Always log position state when imbalanced
  if (Math.abs(imbalance) > 0) {
    log(`${asset}: IMBALANCE ${imbalance} | UP:${pos.upShares}@${(avgUp*100).toFixed(0)}¢ DOWN:${pos.downShares}@${(avgDown*100).toFixed(0)}¢ | upBid:${(upBid*100).toFixed(0)}¢ downBid:${(downBid*100).toFixed(0)}¢`, 'INFO');
  }

  if (buyingUpIsHedge) {
    if (upBid === 0) {
      log(`${asset}: HEDGE UP BLOCKED - no upBid liquidity!`, 'WARN');
    } else {
      const projectedCombined = upPrice + avgDown;
      if (projectedCombined <= CONFIG.TARGET_COMBINED) {
        buyUp = true;
        log(`${asset}: HEDGE UP @ ${(upPrice * 100).toFixed(0)}¢ (comb ${(projectedCombined * 100).toFixed(0)}¢) [${pos.upShares}↑ vs ${pos.downShares}↓]`, 'CHEAP');
      } else {
        log(`${asset}: HEDGE UP BLOCKED - combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(CONFIG.TARGET_COMBINED * 100).toFixed(0)}¢ (upPrice:${(upPrice*100).toFixed(0)}¢ + avgDown:${(avgDown*100).toFixed(0)}¢)`, 'WARN');
      }
    }
  }

  if (buyingDownIsHedge) {
    if (downBid === 0) {
      log(`${asset}: HEDGE DOWN BLOCKED - no downBid liquidity!`, 'WARN');
    } else {
      const projectedCombined = avgUp + downPrice;
      if (projectedCombined <= CONFIG.TARGET_COMBINED) {
        buyDown = true;
        log(`${asset}: HEDGE DOWN @ ${(downPrice * 100).toFixed(0)}¢ (comb ${(projectedCombined * 100).toFixed(0)}¢) [${pos.upShares}↑ vs ${pos.downShares}↓]`, 'CHEAP');
      } else {
        log(`${asset}: HEDGE DOWN BLOCKED - combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(CONFIG.TARGET_COMBINED * 100).toFixed(0)}¢ (avgUp:${(avgUp*100).toFixed(0)}¢ + downPrice:${(downPrice*100).toFixed(0)}¢)`, 'WARN');
      }
    }
  }

  // =========================================================================
  // PRIORITY 2: NEW POSITIONS (only if balanced, within limits, and not hedge-only mode)
  // =========================================================================

  // ABSOLUTE HARD BLOCK: If imbalance is already over limit, NO NEW POSITIONS AT ALL
  if (Math.abs(imbalance) > CONFIG.MAX_IMBALANCE) {
    log(`${asset}: IMBALANCE ${imbalance} OVER LIMIT - NO NEW POSITIONS ALLOWED`, 'WARN');
  } else if (!buyUp && !buyDown && !hedgeOnly) {
    // ONLY PLACE ONE SIDE PER CYCLE - prevents divergent fills causing imbalance
    const upOk = upBid > 0 && canBuyMoreUp && !upWouldExceedImbalance
      && upPrice <= CONFIG.MAX_ENTRY_PRICE
      && pos.upShares + CONFIG.LOT_SIZE <= CONFIG.MAX_SINGLE_SIDE;
    const downOk = downBid > 0 && canBuyMoreDown && !downWouldExceedImbalance
      && downPrice <= CONFIG.MAX_ENTRY_PRICE
      && pos.downShares + CONFIG.LOT_SIZE <= CONFIG.MAX_SINGLE_SIDE;

    if (upOk && downOk) {
      // Both available - pick the CHEAPER one only
      if (upPrice <= downPrice) {
        buyUp = true;
        log(`${asset}: NEW UP @ ${(upPrice * 100).toFixed(0)}¢ (cheaper than DOWN ${(downPrice * 100).toFixed(0)}¢)`, 'CHEAP');
      } else {
        buyDown = true;
        log(`${asset}: NEW DOWN @ ${(downPrice * 100).toFixed(0)}¢ (cheaper than UP ${(upPrice * 100).toFixed(0)}¢)`, 'CHEAP');
      }
    } else if (upOk) {
      buyUp = true;
      log(`${asset}: NEW UP @ ${(upPrice * 100).toFixed(0)}¢`, 'CHEAP');
    } else if (downOk) {
      buyDown = true;
      log(`${asset}: NEW DOWN @ ${(downPrice * 100).toFixed(0)}¢`, 'CHEAP');
    }
  }

  // During aggressive phase, also log when we're SKIPPING due to high price
  if (isAggressivePhase && !buyUp && !buyDown) {
    if (upPrice > CONFIG.MAX_ENTRY_PRICE && downPrice > CONFIG.MAX_ENTRY_PRICE) {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.1) {
        log(`${asset}: Waiting... UP ${(upPrice * 100).toFixed(0)}¢ / DOWN ${(downPrice * 100).toFixed(0)}¢ (need ≤${(CONFIG.MAX_ENTRY_PRICE * 100).toFixed(0)}¢)`, 'INFO');
      }
    }
  }

  // HARD STOP: Only for NEW positions, NOT for hedges
  // Hedges REDUCE imbalance so they should always be allowed
  if (buyUp && !buyingUpIsHedge) {
    const projectedImbal = imbalance + CONFIG.LOT_SIZE;
    if (projectedImbal > CONFIG.MAX_IMBALANCE) {
      log(`${asset}: NEW UP BLOCKED - would create imbalance ${projectedImbal} > ${CONFIG.MAX_IMBALANCE}`, 'WARN');
      buyUp = false;
    }
  }

  if (buyDown && !buyingDownIsHedge) {
    const projectedImbal = imbalance - CONFIG.LOT_SIZE;
    if (projectedImbal < -CONFIG.MAX_IMBALANCE) {
      log(`${asset}: NEW DOWN BLOCKED - would create imbalance ${projectedImbal} < -${CONFIG.MAX_IMBALANCE}`, 'WARN');
      buyDown = false;
    }
  }

  // Place orders - track ACTUAL fills only
  if (buyUp) {
    pos.upOrdersPlaced++;
    const result = await placeOrder(tokens.upTokenId, upPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk);
    if (result && result.filledSize > 0) {
      pos.upShares += result.filledSize;
      pos.upCost += upPrice * result.filledSize;
      pos.orders++;
      log(`${asset}: UP +${result.filledSize} @ ${(upPrice * 100).toFixed(0)}¢ [ord#${pos.upOrdersPlaced}]`, 'ORDER');
    }
  }

  if (buyDown) {
    pos.downOrdersPlaced++;
    const result = await placeOrder(tokens.downTokenId, downPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk);
    if (result && result.filledSize > 0) {
      pos.downShares += result.filledSize;
      pos.downCost += downPrice * result.filledSize;
      pos.orders++;
      log(`${asset}: DOWN +${result.filledSize} @ ${(downPrice * 100).toFixed(0)}¢ [ord#${pos.downOrdersPlaced}]`, 'ORDER');
    }
  }

  // Log position state after trades
  if (buyUp || buyDown) {
    const newAvgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const newAvgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const combined = newAvgUp + newAvgDown;
    const newImbalance = pos.upShares - pos.downShares;
    const hedged = Math.min(pos.upShares, pos.downShares);
    const profit = hedged * (1 - combined);

    log(`${asset}: ${pos.upShares}↑/${(newAvgUp * 100).toFixed(0)}¢ | ${pos.downShares}↓/${(newAvgDown * 100).toFixed(0)}¢ | Comb: ${(combined * 100).toFixed(0)}¢ | Imbal: ${newImbalance} | Profit: $${profit.toFixed(2)}`, 'INFO');
  }
}

// ============================================================================
// RESOLUTION & P&L
// ============================================================================

async function checkResolutionAndCalculatePnL(windows: MarketWindow[]): Promise<void> {
  const endTimeMs = windows[0].endTime * 1000;
  const waitMs = endTimeMs - Date.now() + 5000;

  if (waitMs > 0) {
    log(`Waiting ${Math.ceil(waitMs / 1000)}s for market resolution...`, 'INFO');
    await new Promise(r => setTimeout(r, waitMs));
  }

  for (const window of windows) {
    const pos = positions.get(window.slug);
    if (!pos || (pos.upShares === 0 && pos.downShares === 0)) continue;

    const tokens = await getMarketTokens(window.slug);
    if (!tokens) continue;

    const [upBid, downBid] = await Promise.all([
      fetchBestBid(tokens.upTokenId),
      fetchBestBid(tokens.downTokenId),
    ]);

    let winner: 'up' | 'down';
    if (upBid > 0.8) {
      winner = 'up';
    } else if (downBid > 0.8) {
      winner = 'down';
    } else {
      log(`${pos.asset}: Market not resolved yet`, 'WARN');
      continue;
    }

    const upAvg = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const downAvg = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const totalCost = pos.upCost + pos.downCost;

    // Winning side pays $1.00
    const payout = winner === 'up' ? pos.upShares * 1.0 : pos.downShares * 1.0;
    const pnl = payout - totalCost;

    cumulativePnL += pnl;
    if (pnl >= 0) totalWins++;
    else totalLosses++;

    const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(2)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(2)}\x1b[0m`;
    const imbalance = pos.upShares - pos.downShares;
    const imbalStr = imbalance !== 0 ? ` (imbal: ${imbalance > 0 ? '+' : ''}${imbalance})` : '';

    log(`${pos.asset}: ${winner.toUpperCase()} won | ${pos.upShares}↑/${(upAvg * 100).toFixed(0)}¢ | ${pos.downShares}↓/${(downAvg * 100).toFixed(0)}¢ | ${pnlStr}${imbalStr}`, 'PROFIT');

    positions.delete(window.slug);
  }

  const cumStr = cumulativePnL >= 0 ? `\x1b[32m+$${cumulativePnL.toFixed(2)}\x1b[0m` : `\x1b[31m-$${Math.abs(cumulativePnL).toFixed(2)}\x1b[0m`;
  log(`═══ CUMULATIVE: ${cumStr} | Wins: ${totalWins} | Losses: ${totalLosses} ═══`, 'PROFIT');
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketCycle(windows: MarketWindow[]): Promise<void> {
  const marketEndMs = windows[0].endTime * 1000;
  const marketStartMs = windows[0].startTime * 1000;
  const aggressiveEndMs = marketStartMs + CONFIG.AGGRESSIVE_WINDOW_MS;
  const entryEndMs = marketStartMs + CONFIG.ENTRY_WINDOW_MS;
  const freezeStartMs = marketEndMs - CONFIG.FREEZE_BEFORE_END_MS;

  // CRITICAL: Initialize positions FIRST, then sync from API
  for (const window of windows) {
    if (!positions.has(window.slug)) {
      positions.set(window.slug, {
        asset: window.asset,
        slug: window.slug,
        upShares: 0,
        downShares: 0,
        upCost: 0,
        downCost: 0,
        orders: 0,
        upOrdersPlaced: 0,
        downOrdersPlaced: 0,
      });
    }
    // Pre-fetch tokens so sync can match conditionId
    await getMarketTokens(window.slug);
  }

  // Sync from API BEFORE trading to get existing positions
  log('Syncing existing positions from API...', 'INFO');
  await syncPositionsFromApi(windows);
  displayPositions();

  log(`=== AGGRESSIVE SNIPE PHASE (${CONFIG.AGGRESSIVE_WINDOW_MS / 1000}s) ===`, 'SNIPE');

  // PHASE 1: Aggressive phase - first 2 minutes, fast polling
  while (Date.now() < aggressiveEndMs) {
    const syncOk = await syncPositionsFromApi(windows);
    if (syncOk) {
      await Promise.all(windows.map(w => snipeMarket(w, true)));
    } else {
      log('Skipping trade cycle - sync failed', 'WARN');
    }
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }

  log(`=== ENTRY PHASE (${(CONFIG.ENTRY_WINDOW_MS - CONFIG.AGGRESSIVE_WINDOW_MS) / 1000}s more) ===`, 'INFO');

  // PHASE 2: Entry phase - up to 3 minutes, slightly slower
  while (Date.now() < entryEndMs) {
    const syncOk = await syncPositionsFromApi(windows);
    if (syncOk) {
      await Promise.all(windows.map(w => snipeMarket(w, false)));
    } else {
      log('Skipping trade cycle - sync failed', 'WARN');
    }
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
  }

  log(`=== ENTRY CLOSED - HEDGE ONLY MODE UNTIL FREEZE ===`, 'INFO');
  displayPositions();

  // PHASE 3: Hold phase - KEEP HEDGING, no new positions
  while (Date.now() < freezeStartMs) {
    const syncOk = await syncPositionsFromApi(windows);
    if (syncOk) {
      // HEDGE ONLY - no new positions
      await Promise.all(windows.map(w => snipeMarket(w, false, true)));
    }
    await new Promise(r => setTimeout(r, 1000)); // Check every second for hedge opportunities
  }

  log(`=== FREEZE PHASE - HEDGE ONLY (${CONFIG.FREEZE_BEFORE_END_MS / 60000}min before end) ===`, 'WARN');
  displayPositions();

  // PHASE 4: Freeze - STILL HEDGE, never stop trying to reduce exposure
  while (Date.now() < marketEndMs - 30000) { // Stop 30 seconds before end
    const syncOk = await syncPositionsFromApi(windows);
    if (syncOk) {
      await Promise.all(windows.map(w => snipeMarket(w, false, true)));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  log(`=== FINAL 30s - WAITING FOR RESOLUTION ===`, 'WARN');
  await checkResolutionAndCalculatePnL(windows);
}

function displayPositions(): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                      CURRENT POSITIONS                                         ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');

  let totalProfit = 0;
  let totalDirectional = 0;

  for (const [slug, pos] of positions) {
    if (pos.upShares === 0 && pos.downShares === 0) continue;

    const avgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const avgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const combined = avgUp + avgDown;
    const hedged = Math.min(pos.upShares, pos.downShares);
    const profit = hedged * (1 - combined);
    const imbalance = pos.upShares - pos.downShares;

    totalProfit += profit;
    totalDirectional += Math.abs(imbalance);

    const profitStr = profit > 0 ? `\x1b[32m+$${profit.toFixed(2)}\x1b[0m` : `$${profit.toFixed(2)}`;
    const imbalStr = imbalance !== 0 ? `\x1b[33m${imbalance > 0 ? '+' : ''}${imbalance}\x1b[0m` : '0';

    console.log(`║  ${pos.asset}: ${pos.upShares}↑/${(avgUp * 100).toFixed(0)}¢ | ${pos.downShares}↓/${(avgDown * 100).toFixed(0)}¢ | Comb: ${(combined * 100).toFixed(0)}¢ | Imbal: ${imbalStr} | ${profitStr}`.padEnd(91) + '║');
  }

  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  const profitColor = totalProfit >= 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`║  Hedged profit: ${profitColor}$${totalProfit.toFixed(2)}\x1b[0m | Directional exposure: ${totalDirectional} shares`.padEnd(91) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

async function main(): Promise<void> {
  const modeStr = CONFIG.ENABLE_TRADING ? 'LIVE TRADING' : 'PAPER TRADING';
  const modeColor = CONFIG.ENABLE_TRADING ? '\x1b[31m' : '\x1b[33m';

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║       FRONTRUNNER V4 - TARGET WALLET STYLE    ${modeColor}${modeStr}\x1b[0m`.padEnd(91) + '║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Account: ${accountNum}                                                                      ║`);
  console.log(`║  Wallet: ${wallet.address.slice(0, 20)}...                                        ║`);
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  STRATEGY (based on profitable target wallet):                                 ║');
  console.log(`║  - Only buy when price ≤ ${(CONFIG.MAX_ENTRY_PRICE * 100).toFixed(0)}¢ (target buys at 27-38¢)                          ║`);
  console.log(`║  - Lot size: ${CONFIG.LOT_SIZE} shares per order                                                ║`);
  console.log(`║  - Accept directional risk (max imbalance: ${CONFIG.MAX_IMBALANCE} shares)                        ║`);
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  TIMING:                                                                       ║');
  console.log(`║  - Aggressive: first ${CONFIG.AGGRESSIVE_WINDOW_MS / 1000}s (fast polling)                                       ║`);
  console.log(`║  - Entry window: ${CONFIG.ENTRY_WINDOW_MS / 1000}s total                                                    ║`);
  console.log(`║  - Freeze: ${CONFIG.FREEZE_BEFORE_END_MS / 60000} min before resolution (no more trading)                         ║`);
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  RISK: Accepts unhedged positions - betting on favorable risk/reward          ║');
  console.log('║  E.g., 27¢ entry = 73¢ upside vs 27¢ downside if unhedged                     ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await initClobClient();

  while (true) {
    const { current, next, nextStartMs } = getCurrentAndNextWindows();
    const now = Date.now();
    const currentWindowStart = current[0].startTime * 1000;
    const timeIntoWindow = now - currentWindowStart;
    const marketDuration = 15 * 60 * 1000;

    // Only join if we're not past the freeze point
    const freezePoint = marketDuration - CONFIG.FREEZE_BEFORE_END_MS;
    if (timeIntoWindow < freezePoint) {
      if (timeIntoWindow < CONFIG.AGGRESSIVE_WINDOW_MS) {
        log(`Market started ${(timeIntoWindow / 1000).toFixed(0)}s ago - SNIPING NOW`, 'SNIPE');
      } else if (timeIntoWindow < CONFIG.ENTRY_WINDOW_MS) {
        log(`Market started ${(timeIntoWindow / 1000).toFixed(0)}s ago - joining entry phase`, 'INFO');
      } else {
        log(`Market started ${(timeIntoWindow / 1000).toFixed(0)}s ago - late join, holding only`, 'WARN');
      }
      marketsTraded++;
      await runMarketCycle(current);
    }

    const waitMs = nextStartMs - Date.now();

    if (waitMs > 0) {
      const waitMins = Math.floor(waitMs / 60000);
      const waitSecs = Math.floor((waitMs % 60000) / 1000);

      log(`Next window in ${waitMins}m ${waitSecs}s`, 'INFO');
      log(`Cumulative P&L: ${cumulativePnL >= 0 ? '+' : ''}$${cumulativePnL.toFixed(2)} | W: ${totalWins} L: ${totalLosses}`, 'PROFIT');

      const sleepUntil = Date.now() + waitMs;
      while (Date.now() < sleepUntil) {
        const remaining = sleepUntil - Date.now();
        if (remaining > 10000) {
          await new Promise(r => setTimeout(r, 10000));
        } else {
          log(`Starting in ${Math.ceil(remaining / 1000)}s...`, 'SNIPE');
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

process.on('SIGINT', () => {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                           FINAL SESSION STATS                                  ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Markets traded: ${marketsTraded}`.padEnd(83) + '║');
  const cumStr = cumulativePnL >= 0 ? `+$${cumulativePnL.toFixed(2)}` : `-$${Math.abs(cumulativePnL).toFixed(2)}`;
  const cumColor = cumulativePnL >= 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`║  Cumulative P&L: ${cumColor}${cumStr}\x1b[0m`.padEnd(92) + '║');
  console.log(`║  Wins: ${totalWins} | Losses: ${totalLosses}`.padEnd(83) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  displayPositions();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
