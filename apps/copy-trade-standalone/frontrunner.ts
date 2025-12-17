/**
 * FRONTRUNNER V2 - Market Open Sniper
 *
 * KEY INSIGHT from target wallet analysis:
 * - Spreads are BEST right when markets open (first 30-60 seconds)
 * - Target enters at +19s with combined ~$0.89-0.97
 * - By 8+ minutes, spreads tighten to $0.99-1.00
 *
 * STRATEGY:
 * 1. Calculate when next 15m market opens
 * 2. Wait until exactly market open
 * 3. Immediately buy BOTH Up AND Down
 * 4. Accumulate in small lots (20 shares) for better fills
 * 5. Hold to resolution - winner pays $1.00
 *
 * USAGE:
 *   npx tsx frontrunner.ts              # Account 1
 *   npx tsx frontrunner.ts --account=2  # Account 2
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
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Position sizing
  LOT_SIZE: 5,                // 5 shares per order

  // Target - CRITICAL: Must be < 1.0 for profit
  TARGET_COMBINED: 0.98,      // Max combined price (2¢ profit per share)

  // Price bounds
  MIN_BID: 0.10,
  MAX_BID: 0.90,

  // === RISK CONTROLS ===
  MAX_IMBALANCE: 10,          // Max shares difference between sides
  STOP_LOSS_PCT: 0.15,        // Cut losses if side drops 15% from avg entry
  MAX_UNREALIZED_LOSS: 20,    // Max $ unrealized loss before stopping

  // Timing
  ENTRY_WINDOW_MS: 5 * 60 * 1000,  // New exposure in first 5 minutes
  NO_NEW_EXPOSURE_MS: 7 * 60 * 1000, // No new exposure in last 7 minutes (but hedging OK)
  POLL_INTERVAL_MS: 1000,          // Check every 1s
  IDLE_INTERVAL_MS: 5000,          // Check every 5s when waiting

  // Assets to trade
  ASSETS: ['btc', 'eth', 'sol', 'xrp'],

  // Trading
  ENABLE_TRADING: true,  // LIVE TRADING
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

function log(msg: string, type: 'INFO' | 'ORDER' | 'FILL' | 'PROFIT' | 'WARN' | 'SNIPE' | 'HEDGE' = 'INFO'): void {
  const colors: Record<string, string> = {
    INFO: '\x1b[37m',
    ORDER: '\x1b[36m',
    FILL: '\x1b[32m',
    PROFIT: '\x1b[32m',
    WARN: '\x1b[33m',
    SNIPE: '\x1b[35m',
    HEDGE: '\x1b[34m',  // Blue for hedge orders
  };
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${colors[type]}[${time}] [${type}] ${msg}\x1b[0m`);
}

// ============================================================================
// MARKET TIMING
// ============================================================================

interface MarketWindow {
  asset: string;
  startTime: number;  // Unix timestamp in seconds
  endTime: number;
  slug: string;
}

function getCurrentAndNextWindows(): { current: MarketWindow[], next: MarketWindow[], nextStartMs: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const interval = 15 * 60; // 15 minutes

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

  const nextStartMs = nextWindowStart * 1000;

  return { current, next, nextStartMs };
}

// ============================================================================
// MARKET DATA
// ============================================================================

interface MarketTokens {
  upTokenId: string;
  downTokenId: string;
  tickSize: string;
  negRisk: boolean;
}

async function getMarketTokens(slug: string): Promise<MarketTokens | null> {
  try {
    const res = await fetch(`${GAMMA_HOST}/events?slug=${slug}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.[0]?.markets?.[0]) return null;

    const m = data[0].markets[0];
    const tokens = JSON.parse(m.clobTokenIds || '[]');

    if (tokens.length < 2) return null;

    return {
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      tickSize: m.orderPriceMinTickSize?.toString() || '0.01',
      negRisk: m.negRisk || false,
    };
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

async function placeOrder(
  tokenId: string,
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean
): Promise<string | null> {
  if (!CONFIG.ENABLE_TRADING) {
    // Paper trading - assume instant fill at our price
    return `paper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

    return result?.order_id || result?.orderID || null;
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
  lots: number;
  stopped: boolean;      // Hit stop loss - stop trading this market
  stopReason?: string;
}

const positions: Map<string, Position> = new Map();

// Stats
let marketsTraded = 0;
let cumulativePnL = 0;
let totalWins = 0;
let totalLosses = 0;

interface ResolvedMarket {
  asset: string;
  upShares: number;
  downShares: number;
  upAvgCost: number;
  downAvgCost: number;
  winner: 'up' | 'down';
  pnl: number;
  timestamp: number;
}

// ============================================================================
// SNIPE EXECUTION
// ============================================================================

async function snipeMarket(window: MarketWindow, hedgeOnly: boolean): Promise<void> {
  const { asset, slug } = window;

  // Get market tokens
  const tokens = await getMarketTokens(slug);
  if (!tokens) {
    return;
  }

  // Initialize position
  if (!positions.has(slug)) {
    positions.set(slug, {
      asset,
      slug,
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
      lots: 0,
      stopped: false,
    });
  }

  const pos = positions.get(slug)!;

  // Check if stopped
  if (pos.stopped) {
    return;
  }

  // If hedgeOnly and no position, skip
  if (hedgeOnly && pos.upShares === 0 && pos.downShares === 0) {
    return;
  }


  // Get current best bids
  const [upBid, downBid] = await Promise.all([
    fetchBestBid(tokens.upTokenId),
    fetchBestBid(tokens.downTokenId),
  ]);

  if (upBid === 0 || downBid === 0) {
    return;
  }

  // Calculate entry prices (1¢ above best bid)
  const upPrice = Math.min(CONFIG.MAX_BID, upBid + 0.01);
  const downPrice = Math.min(CONFIG.MAX_BID, downBid + 0.01);

  // === RISK CONTROL: Check unrealized P&L ===
  if (pos.upShares > 0 || pos.downShares > 0) {
    const upAvg = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const downAvg = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;

    // Unrealized P&L: current bid vs avg cost
    const upUnrealized = pos.upShares * (upBid - upAvg);
    const downUnrealized = pos.downShares * (downBid - downAvg);
    const totalUnrealized = upUnrealized + downUnrealized;

    if (totalUnrealized < -CONFIG.MAX_UNREALIZED_LOSS) {
      pos.stopped = true;
      pos.stopReason = `Unrealized loss $${Math.abs(totalUnrealized).toFixed(2)}`;
      log(`${asset}: STOP LOSS - ${pos.stopReason}`, 'WARN');
      return;
    }

    // Check individual side stop loss (15% drop from avg)
    if (upAvg > 0 && upBid < upAvg * (1 - CONFIG.STOP_LOSS_PCT)) {
      pos.stopped = true;
      pos.stopReason = `UP dropped ${((1 - upBid/upAvg) * 100).toFixed(0)}% from avg`;
      log(`${asset}: STOP LOSS - ${pos.stopReason}`, 'WARN');
      return;
    }
    if (downAvg > 0 && downBid < downAvg * (1 - CONFIG.STOP_LOSS_PCT)) {
      pos.stopped = true;
      pos.stopReason = `DOWN dropped ${((1 - downBid/downAvg) * 100).toFixed(0)}% from avg`;
      log(`${asset}: STOP LOSS - ${pos.stopReason}`, 'WARN');
      return;
    }
  }

  // === POSITION LOGIC ===
  const imbalance = pos.upShares - pos.downShares;

  // Determine which side(s) to buy
  let buyUp = false;
  let buyDown = false;

  if (hedgeOnly) {
    // HEDGE ONLY MODE: Only buy the side with fewer shares to reduce imbalance
    if (imbalance > 10) {
      // Too many UP shares - buy DOWN to hedge
      buyDown = true;
      log(`${asset}: [HEDGE] Imbalance +${imbalance} - buying DOWN`, 'INFO');
    } else if (imbalance < -10) {
      // Too many DOWN shares - buy UP to hedge
      buyUp = true;
      log(`${asset}: [HEDGE] Imbalance ${imbalance} - buying UP`, 'INFO');
    } else {
      // Position is balanced enough, no hedge needed
      return;
    }
  } else {
    // NORMAL MODE: Can take new exposure
    if (Math.abs(imbalance) < CONFIG.MAX_IMBALANCE) {
      // Within imbalance limit - can buy either side
      // Buy the CHEAPER side (mean reversion)
      if (upPrice < downPrice) {
        buyUp = true;
      } else {
        buyDown = true;
      }
      // If roughly balanced and combined is good, buy both
      if (Math.abs(imbalance) < 20 && upPrice + downPrice < CONFIG.TARGET_COMBINED) {
        buyUp = true;
        buyDown = true;
      }
    } else if (imbalance > 0) {
      // Too many UP shares - only buy DOWN to balance
      buyDown = true;
      log(`${asset}: Imbalance +${imbalance} UP - only buying DOWN`, 'INFO');
    } else {
      // Too many DOWN shares - only buy UP to balance
      buyUp = true;
      log(`${asset}: Imbalance ${imbalance} DOWN - only buying UP`, 'INFO');
    }
  }

  // Place orders
  let upOrderId: string | null = null;
  let downOrderId: string | null = null;

  if (buyUp && buyDown) {
    // Buy both simultaneously
    [upOrderId, downOrderId] = await Promise.all([
      placeOrder(tokens.upTokenId, upPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk),
      placeOrder(tokens.downTokenId, downPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk),
    ]);
  } else if (buyUp) {
    upOrderId = await placeOrder(tokens.upTokenId, upPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk);
  } else if (buyDown) {
    downOrderId = await placeOrder(tokens.downTokenId, downPrice, CONFIG.LOT_SIZE, tokens.tickSize, tokens.negRisk);
  }

  // Update position
  const orderType = hedgeOnly ? 'HEDGE' : 'ORDER';
  if (upOrderId) {
    pos.upShares += CONFIG.LOT_SIZE;
    pos.upCost += upPrice * CONFIG.LOT_SIZE;
    pos.lots += 1;
    log(`${asset}: UP ${pos.lots} @ $${upPrice.toFixed(2)} [${upOrderId.slice(0, 8)}]`, orderType as any);
  }
  if (downOrderId) {
    pos.downShares += CONFIG.LOT_SIZE;
    pos.downCost += downPrice * CONFIG.LOT_SIZE;
    if (!upOrderId) pos.lots += 1;  // Only increment if not already counted
    log(`${asset}: DOWN ${pos.lots} @ $${downPrice.toFixed(2)} [${downOrderId.slice(0, 8)}]`, orderType as any);
  }

  // Log current state
  if (upOrderId || downOrderId) {
    const avgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const avgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const combined = avgUp + avgDown;
    const newImbalance = pos.upShares - pos.downShares;
    log(`${asset}: ${pos.upShares}↑/$${avgUp.toFixed(2)} | ${pos.downShares}↓/$${avgDown.toFixed(2)} | Comb: $${combined.toFixed(3)} | Imbal: ${newImbalance}`, 'INFO');
  }
}

// ============================================================================
// RESOLUTION & P&L
// ============================================================================

async function checkResolutionAndCalculatePnL(windows: MarketWindow[]): Promise<void> {
  // Wait until market resolves (end of 15-min window + buffer)
  const endTimeMs = windows[0].endTime * 1000;
  const waitMs = endTimeMs - Date.now() + 5000;  // +5s buffer for resolution

  if (waitMs > 0) {
    log(`Waiting ${Math.ceil(waitMs / 1000)}s for market resolution...`, 'INFO');
    await new Promise(r => setTimeout(r, waitMs));
  }

  // Check each position's result
  for (const window of windows) {
    const pos = positions.get(window.slug);
    if (!pos || (pos.upShares === 0 && pos.downShares === 0)) continue;

    // Fetch current prices to determine winner
    const tokens = await getMarketTokens(window.slug);
    if (!tokens) continue;

    const [upBid, downBid] = await Promise.all([
      fetchBestBid(tokens.upTokenId),
      fetchBestBid(tokens.downTokenId),
    ]);

    // Determine winner: the side with price near $1.00 won
    // After resolution, winning side = ~$1.00, losing side = ~$0.00
    let winner: 'up' | 'down';
    if (upBid > 0.8) {
      winner = 'up';
    } else if (downBid > 0.8) {
      winner = 'down';
    } else {
      // Market not resolved yet or no clear winner - check again
      log(`${pos.asset}: Market not resolved yet (Up $${upBid.toFixed(2)}, Down $${downBid.toFixed(2)})`, 'WARN');
      continue;
    }

    // Calculate P&L
    const upAvg = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const downAvg = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const totalCost = pos.upCost + pos.downCost;

    // Winning side pays $1.00 per share
    const payout = winner === 'up' ? pos.upShares * 1.0 : pos.downShares * 1.0;
    const pnl = payout - totalCost;

    cumulativePnL += pnl;
    if (pnl >= 0) totalWins++;
    else totalLosses++;

    const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(2)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(2)}\x1b[0m`;
    log(`${pos.asset}: ${winner.toUpperCase()} won | ${pos.upShares}↑ @ $${upAvg.toFixed(2)} | ${pos.downShares}↓ @ $${downAvg.toFixed(2)} | ${pnlStr}`, 'PROFIT');

    // Clear position for next cycle
    positions.delete(window.slug);
  }

  // Show cumulative stats
  const cumStr = cumulativePnL >= 0 ? `\x1b[32m+$${cumulativePnL.toFixed(2)}\x1b[0m` : `\x1b[31m-$${Math.abs(cumulativePnL).toFixed(2)}\x1b[0m`;
  log(`═══ CUMULATIVE: ${cumStr} | Wins: ${totalWins} | Losses: ${totalLosses} ═══`, 'PROFIT');
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketCycle(windows: MarketWindow[]): Promise<void> {
  const marketEndMs = windows[0].endTime * 1000;
  const marketStartMs = windows[0].startTime * 1000;
  const entryEndMs = marketStartMs + CONFIG.ENTRY_WINDOW_MS;
  const hedgeOnlyStartMs = marketEndMs - CONFIG.NO_NEW_EXPOSURE_MS;

  log(`=== ENTRY WINDOW OPEN (${CONFIG.ENTRY_WINDOW_MS / 1000}s) ===`, 'SNIPE');

  // PHASE 1: Entry window - free trading
  while (Date.now() < entryEndMs && Date.now() < marketEndMs - 30000) {
    await Promise.all(windows.map(w => snipeMarket(w, false)));

    const allStopped = windows.every(w => {
      const pos = positions.get(w.slug);
      return pos && pos.stopped;
    });

    if (allStopped) {
      log('All assets stopped - entry complete', 'WARN');
      break;
    }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }

  log(`=== ENTRY WINDOW CLOSED ===`, 'INFO');
  displayPositions();

  // PHASE 2: Post-entry - hedge only when needed
  // Timeline: Entry ends -> Hedge-only zone (last 7 min) -> Resolution
  log(`=== HEDGE PHASE (until resolution) ===`, 'HEDGE');

  while (Date.now() < marketEndMs - 30000) {  // Stop 30s before resolution
    const now = Date.now();
    const timeRemaining = marketEndMs - now;
    const hedgeOnly = now >= hedgeOnlyStartMs;

    if (hedgeOnly) {
      // Last 7 minutes - hedge only
      await Promise.all(windows.map(w => snipeMarket(w, true)));
    } else {
      // Between entry end and hedge-only zone - can still take new positions
      // But prioritize hedging if imbalanced
      await Promise.all(windows.map(w => snipeMarket(w, false)));
    }

    // Display status periodically (every 30s)
    const secsRemaining = Math.floor(timeRemaining / 1000);
    if (secsRemaining % 30 === 0) {
      const mode = hedgeOnly ? 'HEDGE ONLY' : 'TRADING';
      log(`${secsRemaining}s remaining - ${mode}`, 'INFO');
    }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
  }

  log(`=== MARKET CLOSING - AWAITING RESOLUTION ===`, 'INFO');
  displayPositions();

  // PHASE 3: Wait for resolution and calculate P&L
  await checkResolutionAndCalculatePnL(windows);
}

function displayPositions(): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                      CURRENT POSITIONS                                         ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');

  let totalProfit = 0;

  for (const [slug, pos] of positions) {
    if (pos.lots === 0 && !pos.stopped) continue;

    const avgUp = pos.upShares > 0 ? pos.upCost / pos.upShares : 0;
    const avgDown = pos.downShares > 0 ? pos.downCost / pos.downShares : 0;
    const combined = avgUp + avgDown;
    const minShares = Math.min(pos.upShares, pos.downShares);
    const profit = (1 - combined) * minShares;
    const imbalance = pos.upShares - pos.downShares;

    totalProfit += profit;

    let status = '';
    if (pos.stopped) {
      status = `\x1b[31mSTOPPED: ${pos.stopReason}\x1b[0m`;
    } else if (Math.abs(imbalance) > 50) {
      status = `\x1b[33mImbal: ${imbalance > 0 ? '+' : ''}${imbalance}\x1b[0m`;
    } else {
      status = `\x1b[32m+$${profit.toFixed(2)}\x1b[0m`;
    }

    console.log(`║  ${pos.asset}: ${pos.upShares}↑/$${avgUp.toFixed(2)} | ${pos.downShares}↓/$${avgDown.toFixed(2)} | $${combined.toFixed(3)} | ${status}`.padEnd(91) + '║');
  }

  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  const profitColor = totalProfit >= 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`║  Expected profit at resolution: ${profitColor}$${totalProfit.toFixed(2)}\x1b[0m`.padEnd(91) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

async function main(): Promise<void> {
  const modeStr = CONFIG.ENABLE_TRADING ? 'LIVE TRADING' : '📝 PAPER TRADING';
  const modeColor = CONFIG.ENABLE_TRADING ? '\x1b[31m' : '\x1b[33m';

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║           FRONTRUNNER V2 - MEAN REVERSION ARB    ${modeColor}${modeStr}\x1b[0m`.padEnd(91) + '║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Account: ${accountNum}                                                                      ║`);
  console.log(`║  Wallet: ${wallet.address.slice(0, 20)}...                                        ║`);
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  STRATEGY:                                                                     ║');
  console.log('║  - Buy the CHEAPER side as underlying oscillates                               ║');
  console.log('║  - Accumulate both sides over 5-min window                                     ║');
  console.log('║  - Target avg combined < $0.98                                                 ║');
  console.log('║  - Hold to resolution - winner pays $1.00                                      ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  RISK CONTROLS:                                                                ║');
  console.log(`║  - Max unhedged: ${CONFIG.MAX_IMBALANCE} shares (2 lots) | Stop loss: ${(CONFIG.STOP_LOSS_PCT * 100).toFixed(0)}% | Max loss: $${CONFIG.MAX_UNREALIZED_LOSS}       ║`);
  console.log(`║  - Lot size: ${CONFIG.LOT_SIZE} | Entry window: ${CONFIG.ENTRY_WINDOW_MS / 1000}s | Hedge-only: last ${CONFIG.NO_NEW_EXPOSURE_MS / 60000}min        ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await initClobClient();

  // Main loop - run continuous market cycles
  while (true) {
    const { current, next, nextStartMs } = getCurrentAndNextWindows();
    const now = Date.now();
    const currentWindowStart = current[0].startTime * 1000;
    const timeIntoWindow = now - currentWindowStart;
    const marketDuration = 15 * 60 * 1000;  // 15 minutes

    // If we're still within the market window (not too late to join), run cycle
    if (timeIntoWindow < marketDuration - 30000) {  // At least 30s before resolution
      if (timeIntoWindow < CONFIG.ENTRY_WINDOW_MS) {
        log(`Current window started ${(timeIntoWindow / 1000).toFixed(0)}s ago - entering NOW`, 'SNIPE');
      } else {
        log(`Current window started ${(timeIntoWindow / 1000).toFixed(0)}s ago - joining for hedge phase`, 'INFO');
      }
      marketsTraded++;
      await runMarketCycle(current);
    }

    // Calculate wait time until next window
    const waitMs = nextStartMs - Date.now();

    if (waitMs > 0) {
      const waitMins = Math.floor(waitMs / 60000);
      const waitSecs = Math.floor((waitMs % 60000) / 1000);

      log(`Next window: ${next[0].slug.split('-').slice(0, 3).join('-')} in ${waitMins}m ${waitSecs}s`, 'INFO');
      log(`Cumulative P&L: ${cumulativePnL >= 0 ? '+' : ''}$${cumulativePnL.toFixed(2)} | W: ${totalWins} L: ${totalLosses}`, 'PROFIT');

      // Wait with countdown
      const sleepUntil = Date.now() + waitMs;
      while (Date.now() < sleepUntil) {
        const remaining = sleepUntil - Date.now();
        if (remaining > 10000) {
          // Log every minute
          if (Math.floor(remaining / 1000) % 60 === 0) {
            log(`Waiting... ${Math.floor(remaining / 60000)}m ${Math.floor((remaining % 60000) / 1000)}s`, 'INFO');
          }
          await new Promise(r => setTimeout(r, 10000));
        } else {
          // Final countdown
          log(`Starting in ${Math.ceil(remaining / 1000)}s...`, 'SNIPE');
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    // Short pause before next cycle
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
