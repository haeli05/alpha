/**
 * POLYMARKET MARKET MAKER V2 - LADDERED BIDS
 *
 * Places bids at MULTIPLE price levels to maximize fill probability
 * and capture wider spreads.
 *
 * STRATEGY:
 * - Place 5 bid levels on each side (Up and Down)
 * - Each level has different size (more size at better prices)
 * - Ensure any Up+Down combo stays < $0.98 combined
 * - Adjust ladder based on inventory imbalance
 *
 * EXAMPLE LADDER:
 *   Up bids: $0.30 (10), $0.35 (15), $0.40 (20), $0.45 (25), $0.50 (30)
 *   Down bids: $0.30 (10), $0.35 (15), $0.40 (20), $0.45 (25), $0.50 (30)
 *   If filled at Up $0.35 + Down $0.45 = $0.80 combined = 20% profit!
 *
 * USAGE: npx tsx market-maker-v2.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Ladder settings
  NUM_LEVELS: 5,               // Number of price levels per side
  LEVEL_SPACING: 0.05,         // 5 cents between levels
  BASE_SIZE: 10,               // Base shares at worst price
  SIZE_INCREMENT: 5,           // Additional shares per better level

  // Price bounds
  MIN_BID: 0.25,               // Don't bid below this
  MAX_BID: 0.55,               // Don't bid above this
  MAX_COMBINED: 0.98,          // Max combined price for profit

  // Position limits
  MAX_POSITION: 500,           // Max shares per side per market
  MAX_IMBALANCE: 100,          // Trigger rebalancing

  // Timing
  REFRESH_INTERVAL_MS: 20000,  // Refresh every 20s

  // Trading
  ENABLE_TRADING: false,
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
    log('No private key - monitor only mode', 'WARN');
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

interface BidLevel {
  price: number;
  size: number;
  orderId?: string;
}

interface Position {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upLadder: BidLevel[];
  downLadder: BidLevel[];
}

// ============================================================================
// STATE
// ============================================================================

const markets: Map<string, Market> = new Map();
const positions: Map<string, Position> = new Map();

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'ORDER' | 'LADDER' = 'INFO') {
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    ORDER: '📝',
    LADDER: '📊'
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
// LADDER CALCULATION
// ============================================================================

function calculateLadder(
  position: Position,
  side: 'up' | 'down'
): BidLevel[] {
  const ladder: BidLevel[] = [];
  const imbalance = position.upShares - position.downShares;

  // Adjust base price based on imbalance
  let basePrice = (CONFIG.MIN_BID + CONFIG.MAX_BID) / 2; // Start at midpoint

  if (side === 'up' && imbalance > CONFIG.MAX_IMBALANCE / 2) {
    // Too much Up, bid lower to slow down Up acquisition
    basePrice -= 0.05;
  } else if (side === 'down' && imbalance < -CONFIG.MAX_IMBALANCE / 2) {
    // Too much Down, bid lower to slow down Down acquisition
    basePrice -= 0.05;
  } else if (side === 'up' && imbalance < -CONFIG.MAX_IMBALANCE / 2) {
    // Need more Up, bid higher
    basePrice += 0.05;
  } else if (side === 'down' && imbalance > CONFIG.MAX_IMBALANCE / 2) {
    // Need more Down, bid higher
    basePrice += 0.05;
  }

  // Generate ladder from worst (lowest) to best (highest) price
  for (let i = 0; i < CONFIG.NUM_LEVELS; i++) {
    const price = Math.min(CONFIG.MAX_BID, Math.max(CONFIG.MIN_BID,
      basePrice - (CONFIG.NUM_LEVELS - 1 - i) * CONFIG.LEVEL_SPACING
    ));

    // More size at better prices (higher bids)
    const size = CONFIG.BASE_SIZE + i * CONFIG.SIZE_INCREMENT;

    // Round price to cents
    const roundedPrice = Math.round(price * 100) / 100;

    ladder.push({ price: roundedPrice, size });
  }

  return ladder;
}

function validateLadder(upLadder: BidLevel[], downLadder: BidLevel[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check that any combination is profitable
  for (const up of upLadder) {
    for (const down of downLadder) {
      if (up.price + down.price > CONFIG.MAX_COMBINED) {
        issues.push(`Up $${up.price} + Down $${down.price} = $${(up.price + down.price).toFixed(2)} exceeds max`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function cancelAllOrders(position: Position): Promise<void> {
  if (!clobClient) return;

  const allOrders = [
    ...position.upLadder.filter(l => l.orderId).map(l => l.orderId!),
    ...position.downLadder.filter(l => l.orderId).map(l => l.orderId!),
  ];

  for (const orderId of allOrders) {
    try {
      await clobClient.cancelOrder({ orderID: orderId });
    } catch {
      // Already cancelled or filled
    }
  }

  // Clear order IDs
  position.upLadder.forEach(l => l.orderId = undefined);
  position.downLadder.forEach(l => l.orderId = undefined);
}

async function placeLadder(
  market: Market,
  position: Position,
  ladder: BidLevel[],
  side: 'up' | 'down'
): Promise<void> {
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;
  const currentShares = side === 'up' ? position.upShares : position.downShares;

  if (currentShares >= CONFIG.MAX_POSITION) {
    log(`Max ${side} position reached, skipping ladder`, 'WARN');
    return;
  }

  for (const level of ladder) {
    if (!CONFIG.ENABLE_TRADING || !clobClient) {
      log(`[DRY] ${side.toUpperCase()} bid: ${level.size} @ $${level.price.toFixed(2)}`, 'ORDER');
      continue;
    }

    try {
      const result = await clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: level.price,
          side: Side.BUY,
          size: level.size,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC
      );

      level.orderId = result?.order_id || result?.orderID;
      if (level.orderId) {
        log(`${side.toUpperCase()} bid placed: ${level.size} @ $${level.price.toFixed(2)}`, 'ORDER');
      }
    } catch (error: any) {
      log(`Failed to place ${side} bid: ${error.message}`, 'ERROR');
    }

    // Small delay between orders
    await new Promise(r => setTimeout(r, 100));
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function displayLadder(position: Position, market: Market): void {
  console.log(`\n┌─────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${market.question.slice(0, 69).padEnd(69)} │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────┤`);

  // Show position
  const hedged = Math.min(position.upShares, position.downShares);
  const imbalance = position.upShares - position.downShares;
  console.log(`│ Position: Up ${position.upShares} | Down ${position.downShares} | Hedged: ${hedged} | Imbalance: ${imbalance >= 0 ? '+' : ''}${imbalance}`.padEnd(74) + '│');
  console.log(`├─────────────────────────────────────────────────────────────────────────┤`);

  // Show ladders side by side
  console.log(`│         UP BIDS                    │         DOWN BIDS                  │`);
  console.log(`│  Price      Size    Status         │  Price      Size    Status         │`);
  console.log(`│  ──────────────────────────────    │  ──────────────────────────────    │`);

  for (let i = 0; i < CONFIG.NUM_LEVELS; i++) {
    const up = position.upLadder[i];
    const down = position.downLadder[i];

    const upStatus = up?.orderId ? 'ACTIVE' : 'PENDING';
    const downStatus = down?.orderId ? 'ACTIVE' : 'PENDING';

    const upStr = up ? `  $${up.price.toFixed(2)}      ${up.size.toString().padStart(3)}     ${upStatus.padEnd(10)}` : '  -'.padEnd(35);
    const downStr = down ? `  $${down.price.toFixed(2)}      ${down.size.toString().padStart(3)}     ${downStatus.padEnd(10)}` : '  -'.padEnd(35);

    console.log(`│${upStr}   │${downStr}   │`);
  }

  // Show combined prices
  console.log(`├─────────────────────────────────────────────────────────────────────────┤`);

  if (position.upLadder.length > 0 && position.downLadder.length > 0) {
    const worstUp = Math.max(...position.upLadder.map(l => l.price));
    const worstDown = Math.max(...position.downLadder.map(l => l.price));
    const bestUp = Math.min(...position.upLadder.map(l => l.price));
    const bestDown = Math.min(...position.downLadder.map(l => l.price));

    const worstCombined = worstUp + worstDown;
    const bestCombined = bestUp + bestDown;
    const worstProfit = ((1 - worstCombined) * 100).toFixed(1);
    const bestProfit = ((1 - bestCombined) * 100).toFixed(1);

    console.log(`│ Combined range: $${bestCombined.toFixed(2)} (${bestProfit}% profit) to $${worstCombined.toFixed(2)} (${worstProfit}% profit)`.padEnd(74) + '│');
  }

  console.log(`└─────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function runMarketMaker(): Promise<void> {
  for (const [conditionId, market] of markets) {
    // Get or create position
    let position = positions.get(conditionId);
    if (!position) {
      position = {
        upShares: 0,
        downShares: 0,
        upCost: 0,
        downCost: 0,
        upLadder: [],
        downLadder: [],
      };
      positions.set(conditionId, position);
    }

    // Cancel existing orders
    await cancelAllOrders(position);

    // Calculate new ladders
    const upLadder = calculateLadder(position, 'up');
    const downLadder = calculateLadder(position, 'down');

    // Validate
    const { valid, issues } = validateLadder(upLadder, downLadder);
    if (!valid) {
      log(`Ladder validation failed: ${issues[0]}`, 'WARN');
      // Adjust ladders to be safe
      // For now, just reduce the max bids
    }

    // Store ladders
    position.upLadder = upLadder;
    position.downLadder = downLadder;

    // Place orders
    await placeLadder(market, position, upLadder, 'up');
    await placeLadder(market, position, downLadder, 'down');

    // Display
    displayLadder(position, market);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    POLYMARKET MARKET MAKER V2 - LADDERED BIDS                  ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Levels:       ${CONFIG.NUM_LEVELS} per side                                                      ║`);
  console.log(`║  Price Range:  $${CONFIG.MIN_BID.toFixed(2)} - $${CONFIG.MAX_BID.toFixed(2)}                                                  ║`);
  console.log(`║  Spacing:      $${CONFIG.LEVEL_SPACING.toFixed(2)} between levels                                           ║`);
  console.log(`║  Max Combined: $${CONFIG.MAX_COMBINED.toFixed(2)}                                                          ║`);
  console.log(`║  Trading:      ${CONFIG.ENABLE_TRADING ? 'ENABLED' : 'DISABLED (monitor only)'}                                             ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load CLOB client
  log('Loading CLOB client...');
  await loadClobClient();

  if (CONFIG.ENABLE_TRADING) {
    await initClobClient();
  }

  // Find markets
  log('Finding active markets...');
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

  // Initial run
  await runMarketMaker();

  // Main loop
  setInterval(runMarketMaker, CONFIG.REFRESH_INTERVAL_MS);

  // Refresh markets
  setInterval(async () => {
    const newMarkets = await findActiveMarkets();
    for (const market of newMarkets) {
      if (!markets.has(market.conditionId)) {
        markets.set(market.conditionId, market);
        log(`Added: ${market.question}`);
      }
    }
  }, 60000);

  log('Market maker running. Press Ctrl+C to stop.');
}

main().catch(console.error);
