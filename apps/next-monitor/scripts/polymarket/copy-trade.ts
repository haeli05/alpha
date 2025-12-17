/**
 * ============================================================================
 * POLYMARKET COPY TRADING SCRIPT
 * ============================================================================
 *
 * STRATEGY OVERVIEW:
 * -----------------
 * 1. Monitor a target account's positions on Polymarket
 * 2. When the target makes a trade, copy it on our account
 * 3. Supports proportional sizing or fixed sizing
 *
 * USAGE:
 * ------
 * npx tsx scripts/polymarket/copy-trade.ts
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

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * TARGET_ACCOUNT: The account to copy trades from
 */
const TARGET_ACCOUNT = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

/**
 * STOP_LOSS_PERCENT: Exit script if we lose this % of starting capital
 */
const STOP_LOSS_PERCENT = 12; // 12% max loss

/**
 * POLL_INTERVAL_MS: How often to check for new trades (milliseconds)
 */
const POLL_INTERVAL_MS = 5000; // 5 seconds

/**
 * ENABLE_TRADING: Set to true to enable actual trading
 */
const ENABLE_TRADING = true;

// ============================================================================
// CAPITAL TRACKING - Based on actual portfolio value, not cash flow
// ============================================================================

let initialPortfolioValue = 0; // Set at startup (USDC + position values)
let tradesExecuted = 0;

// Track our positions: tokenId -> { size, costBasis }
const ourPositions: Map<string, { size: number; costBasis: number }> = new Map();

/**
 * Fetch current value of all our positions from Polymarket
 */
async function getPositionValues(): Promise<number> {
  try {
    // Fetch our positions
    const res = await fetch(`${DATA_API_HOST}/positions?user=${PROXY_WALLET.toLowerCase()}`);
    if (!res.ok) return 0;

    const positions = await res.json();
    if (!Array.isArray(positions)) return 0;

    let totalValue = 0;
    for (const pos of positions) {
      const size = parseFloat(pos.size || pos.amount || '0');
      const price = parseFloat(pos.price || pos.avgPrice || '0');
      totalValue += size * price;
    }
    return totalValue;
  } catch (error) {
    log(`Error fetching position values: ${error}`, 'WARN');
    return 0;
  }
}

/**
 * Get total portfolio value (USDC balance + position values)
 */
async function getPortfolioValue(): Promise<number> {
  const usdcBalance = await getWalletBalance();
  const positionValue = await getPositionValues();
  return usdcBalance + positionValue;
}

/**
 * Calculate current PnL based on portfolio value change
 */
async function getCurrentPnL(): Promise<number> {
  const currentValue = await getPortfolioValue();
  return currentValue - initialPortfolioValue;
}

/**
 * Get PnL as percentage of initial portfolio
 */
async function getPnLPercent(): Promise<number> {
  if (initialPortfolioValue <= 0) return 0;
  const pnl = await getCurrentPnL();
  return (pnl / initialPortfolioValue) * 100;
}

/**
 * Check if stop loss should trigger
 */
async function checkStopLoss(): Promise<boolean> {
  const pnlPercent = await getPnLPercent();
  return pnlPercent <= -STOP_LOSS_PERCENT;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';

// Polygon USDC contract
const POLYGON_RPC = 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

/**
 * Fetch USDC balance from proxy wallet
 */
async function getWalletBalance(): Promise<number> {
  try {
    const { providers, Contract } = await import('ethers');
    const provider = new providers.JsonRpcProvider(POLYGON_RPC);
    const usdc = new Contract(USDC_ADDRESS, [
      'function balanceOf(address) view returns (uint256)',
    ], provider);
    const balance = await usdc.balanceOf(PROXY_WALLET);
    // USDC has 6 decimals
    return Number(balance) / 1e6;
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return 0;
  }
}

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

// ============================================================================
// DYNAMIC IMPORTS
// ============================================================================

let ClobClient: any;
let OrderType: any;
let Side: any;

async function loadClobClient(): Promise<boolean> {
  try {
    const clobModule = await import('@polymarket/clob-client');
    ClobClient = clobModule.ClobClient;
    OrderType = clobModule.OrderType;
    Side = clobModule.Side;

    if (!ClobClient || typeof ClobClient !== 'function') {
      throw new Error(`ClobClient is not a constructor`);
    }

    return true;
  } catch (error) {
    console.error(`Failed to load @polymarket/clob-client: ${error}`);
    return false;
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface Position {
  asset: string; // Token ID
  market: string; // Market condition ID
  outcome: string; // 'Yes' or 'No'
  price: number;
  size: number;
  value: number;
}

interface TargetTrade {
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  timestamp: number;
}

interface CopiedTrade {
  originalTradeHash: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  ourOrderId?: string;
  status: 'pending' | 'executed' | 'failed';
  timestamp: number;
}

// ============================================================================
// STATE
// ============================================================================

// Store previous positions to detect changes
let previousPositions: Map<string, Position> = new Map();

// Store copied trades to avoid duplicates
const copiedTrades: Map<string, CopiedTrade> = new Map();

// Store seen trade IDs (by transactionHash) to avoid duplicates
const seenTradeIds: Set<string> = new Set();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// POLYMARKET API FUNCTIONS
// ============================================================================

/**
 * Get recent trades for an account using the Data API
 */
async function getAccountTrades(address: string, limit: number = 100): Promise<any[]> {
  try {
    // Use the Data API which supports user filtering
    const url = `${DATA_API_HOST}/trades?user=${address.toLowerCase()}&limit=${limit}`;
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch trades: ${res.status} - ${text}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (error) {
    log(`Error fetching trades for ${address}: ${error}`, 'ERROR');
    return [];
  }
}

/**
 * Get positions by aggregating trades (since direct position endpoint is not available)
 * We track positions by looking at the most recent trades
 */
async function getAccountPositions(address: string): Promise<Position[]> {
  try {
    const trades = await getAccountTrades(address, 200);

    if (trades.length === 0) {
      return [];
    }

    // Aggregate positions from trades
    const positionMap = new Map<string, Position>();

    for (const trade of trades) {
      const tokenId = trade.asset;
      const side = trade.side; // BUY or SELL
      const size = parseFloat(trade.size || '0');
      const price = parseFloat(trade.price || '0');
      const conditionId = trade.conditionId;
      const outcome = trade.outcome || 'Unknown';

      if (!tokenId) continue;

      let pos = positionMap.get(tokenId);
      if (!pos) {
        pos = {
          asset: tokenId,
          market: conditionId,
          outcome: outcome,
          price: price,
          size: 0,
          value: 0,
        };
        positionMap.set(tokenId, pos);
      }

      // Adjust position size based on trade side
      if (side === 'BUY') {
        pos.size += size;
      } else if (side === 'SELL') {
        pos.size -= size;
      }

      // Update average price (simplified)
      pos.price = price;
      pos.value = pos.size * pos.price;
    }

    // Filter out zero or negative positions
    return Array.from(positionMap.values()).filter(p => p.size > 0.01);
  } catch (error) {
    log(`Error fetching positions for ${address}: ${error}`, 'ERROR');
    return [];
  }
}

/**
 * Get market info by condition ID
 */
async function getMarketInfo(conditionId: string): Promise<any> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (error) {
    return null;
  }
}

/**
 * Get best prices for a token
 */
async function getBestPrices(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) {
      return { bestBid: 0, bestAsk: 1 };
    }

    const book = await res.json();

    const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : 0;
    const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : 1;

    return { bestBid, bestAsk };
  } catch (error) {
    return { bestBid: 0, bestAsk: 1 };
  }
}

// ============================================================================
// TRADING FUNCTIONS
// ============================================================================

/**
 * Execute a copy trade using createAndPostOrder (same as pair-arb script)
 * Uses market order logic: cross the spread for immediate execution
 */
async function executeCopyTrade(
  clobClient: any,
  tokenId: string,
  side: 'BUY' | 'SELL',
  size: number,
  targetPrice: number,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<{ success: boolean; orderId?: string; price?: number }> {
  try {
    const tick = parseFloat(marketInfo.tickSize || '0.01');

    // For MARKET ORDER behavior: cross the spread
    // BUY: pay more (use higher price to guarantee fill)
    // SELL: accept less (use lower price to guarantee fill)
    const SPREAD_CROSS_CENTS = 0.02; // 2 cents to cross spread

    let price: number;
    if (side === 'BUY') {
      // Buy at target price + spread to ensure we cross the ask
      price = targetPrice + SPREAD_CROSS_CENTS;
    } else {
      // Sell at target price - spread to ensure we cross the bid
      price = targetPrice - SPREAD_CROSS_CENTS;
    }

    // Apply tick size and ensure 2 decimal places
    price = Math.round(price / tick) * tick;
    price = Math.round(price * 100) / 100; // Ensure 2 decimal places
    price = Math.max(0.01, Math.min(price, 0.99));

    // Ensure minimum order value of $1.05
    const MIN_ORDER_VALUE = 1.05;
    const minSharesForValue = Math.ceil(MIN_ORDER_VALUE / price);
    const actualSize = Math.max(size, minSharesForValue);

    log(`Executing ${side} MARKET order: ${actualSize} shares @ $${price.toFixed(2)} (target: $${targetPrice.toFixed(2)})`, 'TRADE');

    // Use createAndPostOrder which handles signing internally (like pair-arb script)
    const response = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: price,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        size: actualSize,
        feeRateBps: 0,
      },
      {
        tickSize: marketInfo.tickSize,
        negRisk: marketInfo.negRisk,
      },
      OrderType.GTC // Good Till Cancelled - stays on book until filled
    );

    if (!response) {
      throw new Error('Order returned no response');
    }

    // Check for error responses
    if (response.error || response.status === 403 || response.status === 401) {
      const errorMsg = response.error || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`Order rejected: ${errorMsg}`);
    }

    const orderId = response?.order_id || response?.orderID || response?.id || null;

    if (orderId) {
      log(`Order placed: ${orderId}`, 'TRADE');

      // Verify order was filled
      try {
        await sleep(500);
        const orderInfo = await clobClient.getOrder(orderId);
        if (orderInfo) {
          const orderStatus = (orderInfo.status || '').toUpperCase();
          if (orderStatus === 'MATCHED' || orderStatus === 'FILLED') {
            log(`✅ Order FILLED!`, 'TRADE');
          } else {
            log(`Order status: ${orderStatus}`, 'INFO');
          }
        }
      } catch (e) {
        // Ignore verification errors
      }

      return { success: true, orderId, price };
    } else {
      log(`Order may have failed: ${JSON.stringify(response).slice(0, 200)}`, 'WARN');
      return { success: false };
    }
  } catch (error) {
    log(`Error executing copy trade: ${error}`, 'ERROR');
    return { success: false };
  }
}

// ============================================================================
// POSITION MONITORING
// ============================================================================

/**
 * Detect new trades from the target account using the trades API
 * Uses transactionHash as unique ID - each trade has a unique hash
 */
async function detectNewTrades(address: string): Promise<TargetTrade[]> {
  const trades = await getAccountTrades(address, 50);
  const newTrades: TargetTrade[] = [];

  for (const trade of trades) {
    // Use transactionHash as unique ID (most reliable)
    const tradeId = trade.transactionHash || trade.id || `${trade.asset}-${trade.size}-${trade.timestamp}`;

    // Skip if we've already seen this trade
    if (seenTradeIds.has(tradeId)) {
      continue;
    }

    // Mark as seen immediately
    seenTradeIds.add(tradeId);

    // Parse timestamp
    let timestamp = Date.now();
    if (trade.timestamp) {
      const ts = typeof trade.timestamp === 'number' ? trade.timestamp : parseInt(trade.timestamp);
      timestamp = ts < 4102444800 ? ts * 1000 : ts;
    }

    // Create trade object
    newTrades.push({
      tokenId: trade.asset,
      conditionId: trade.conditionId,
      side: trade.side as 'BUY' | 'SELL',
      size: parseFloat(trade.size || '0'),
      price: parseFloat(trade.price || '0'),
      timestamp: timestamp,
    });

    log(`New trade detected: ${trade.side} ${trade.size} shares @ $${trade.price}`, 'TRADE');
  }

  return newTrades;
}

/**
 * Detect position changes and generate trades to copy
 */
function detectPositionChanges(
  currentPositions: Position[],
  previousPositions: Map<string, Position>
): TargetTrade[] {
  const trades: TargetTrade[] = [];
  const currentMap = new Map<string, Position>();

  // Build current position map
  for (const pos of currentPositions) {
    currentMap.set(pos.asset, pos);
  }

  // Check for new or increased positions (BUY signals)
  for (const [tokenId, pos] of currentMap) {
    const prevPos = previousPositions.get(tokenId);

    if (!prevPos) {
      // New position - target bought
      if (pos.size > 0) {
        trades.push({
          tokenId,
          conditionId: pos.market,
          side: 'BUY',
          size: pos.size,
          price: pos.price,
          timestamp: Date.now(),
        });
        log(`Detected NEW position: ${pos.size} shares of token ${tokenId.slice(0, 20)}...`, 'INFO');
      }
    } else if (pos.size > prevPos.size) {
      // Increased position - target bought more
      const sizeDiff = pos.size - prevPos.size;
      trades.push({
        tokenId,
        conditionId: pos.market,
        side: 'BUY',
        size: sizeDiff,
        price: pos.price,
        timestamp: Date.now(),
      });
      log(`Detected INCREASED position: +${sizeDiff} shares of token ${tokenId.slice(0, 20)}...`, 'INFO');
    } else if (pos.size < prevPos.size) {
      // Decreased position - target sold
      const sizeDiff = prevPos.size - pos.size;
      trades.push({
        tokenId,
        conditionId: pos.market,
        side: 'SELL',
        size: sizeDiff,
        price: pos.price,
        timestamp: Date.now(),
      });
      log(`Detected DECREASED position: -${sizeDiff} shares of token ${tokenId.slice(0, 20)}...`, 'INFO');
    }
  }

  // Check for closed positions (SELL signals)
  for (const [tokenId, prevPos] of previousPositions) {
    if (!currentMap.has(tokenId) && prevPos.size > 0) {
      // Position closed - target sold all
      trades.push({
        tokenId,
        conditionId: prevPos.market,
        side: 'SELL',
        size: prevPos.size,
        price: prevPos.price,
        timestamp: Date.now(),
      });
      log(`Detected CLOSED position: ${prevPos.size} shares of token ${tokenId.slice(0, 20)}...`, 'INFO');
    }
  }

  return trades;
}

/**
 * Calculate copy trade size - mirrors target's exact size
 */
function calculateCopySize(targetSize: number): number {
  // Polymarket minimum order size is 5 shares
  return Math.max(5, Math.round(targetSize));
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           POLYMARKET COPY TRADING SCRIPT                   ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Target Account: ${TARGET_ACCOUNT.slice(0, 20)}...          ║`);
  console.log(`║  Copy Mode:      MIRROR (exact size)                       ║`);
  console.log(`║  Stop Loss:      -${STOP_LOSS_PERCENT}% of capital                            ║`);
  console.log(`║  Trading:        ${ENABLE_TRADING ? 'ENABLED' : 'DISABLED (dry run)'}                         ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Validate environment
  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    log('Missing API credentials. Set POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE', 'ERROR');
    process.exit(1);
  }

  if (ENABLE_TRADING && !POLYMARKET_PRIVATE_KEY) {
    log('Missing POLYMARKET_PRIVATE_KEY for live trading', 'ERROR');
    process.exit(1);
  }

  // Load CLOB client
  log('Loading CLOB client...');
  const loaded = await loadClobClient();
  if (!loaded) {
    log('Failed to load CLOB client', 'ERROR');
    process.exit(1);
  }

  // Initialize CLOB client
  log('Initializing CLOB client...');

  let clobClient: any;

  // Polymarket Proxy Wallet (smart account) - funds are held here
  // Signature types: 0 = EOA, 1 = Poly Proxy (MagicLink), 2 = Gnosis Safe (MetaMask)
  const signatureType = 2; // 2 = Gnosis Safe (your wallet is a Gnosis Safe v1.3.0)
  const funder = "0x2163f00898fb58f47573e89940ff728a5e07ac09";

  if (ENABLE_TRADING && POLYMARKET_PRIVATE_KEY) {
    const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);
    log(`Wallet address: ${wallet.address}`);
    log(`Proxy wallet:   ${funder}`);

    // Derive API credentials with proxy wallet configuration
    try {
      const tempClient = new ClobClient(CLOB_HOST, 137, wallet, undefined, signatureType, funder);
      const creds = await tempClient.createOrDeriveApiKey();
      log(`API credentials derived: ${(creds.key || creds.apiKey)?.slice(0, 10)}...`);

      // Initialize with derived creds and proxy wallet
      clobClient = new ClobClient(CLOB_HOST, 137, wallet, creds, signatureType, funder);
    } catch (error) {
      log(`Falling back to provided API credentials`, 'WARN');
      // Use provided credentials with proxy wallet configuration
      clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
        key: POLYMARKET_API_KEY,
        secret: POLYMARKET_SECRET,
        passphrase: POLYMARKET_PASSPHRASE,
      }, signatureType, funder);
    }
  }

  // Get initial trades to set the baseline
  log(`Fetching initial trades for target: ${TARGET_ACCOUNT}`);
  const initialTrades = await getAccountTrades(TARGET_ACCOUNT, 50);
  log(`Found ${initialTrades.length} recent trades`);

  // Store all existing trade IDs so we don't copy them
  for (const trade of initialTrades) {
    const tradeId = trade.transactionHash || trade.id || `${trade.asset}-${trade.size}-${trade.timestamp}`;
    seenTradeIds.add(tradeId);
  }

  if (initialTrades.length > 0) {
    log(`Marked ${seenTradeIds.size} existing trades as seen`);
    log(`Showing last 5 trades:`);
    for (const trade of initialTrades.slice(0, 5)) {
      const size = parseFloat(trade.size || '0').toFixed(2);
      const price = parseFloat(trade.price || '0').toFixed(4);
      log(`  - ${trade.side} ${size} @ $${price} (${trade.outcome || 'Unknown'})`);
    }
  }

  console.log('');

  // Fetch initial portfolio value for stop loss tracking
  log('Fetching portfolio value for stop loss tracking...');
  const usdcBalance = await getWalletBalance();
  const positionValue = await getPositionValues();
  initialPortfolioValue = usdcBalance + positionValue;
  log(`USDC Balance:    $${usdcBalance.toFixed(2)}`);
  log(`Position Value:  $${positionValue.toFixed(2)}`);
  log(`Total Portfolio: $${initialPortfolioValue.toFixed(2)}`);
  log(`Stop Loss: -${STOP_LOSS_PERCENT}% ($${(initialPortfolioValue * STOP_LOSS_PERCENT / 100).toFixed(2)} max loss)`);
  console.log('');

  log('Starting copy trading loop...');
  log('Watching for NEW trades from target...');
  console.log('────────────────────────────────────────────────────────────');

  let cycleCount = 0;

  while (true) {
    cycleCount++;

    try {
      // Detect NEW trades using the trades API
      const trades = await detectNewTrades(TARGET_ACCOUNT);

      if (trades.length > 0) {
        log(`Detected ${trades.length} trade(s) to copy!`, 'TRADE');

        for (const trade of trades) {
          // Create unique hash for this trade
          const tradeHash = `${trade.tokenId}-${trade.side}-${trade.timestamp}`;

          // Skip if already copied
          if (copiedTrades.has(tradeHash)) {
            log(`Trade already copied: ${tradeHash.slice(0, 30)}...`, 'INFO');
            continue;
          }

          // Calculate our copy size (proportional scaling)
          const copySize = calculateCopySize(trade.size);
          log(``, 'INFO');
          log(`═══ COPY TRADE ═══`, 'TRADE');
          log(`Target ${trade.side}: ${trade.size.toFixed(2)} shares @ $${trade.price.toFixed(4)}`, 'INFO');
          log(`Our ${trade.side}: ${copySize} shares (mirror)`, 'INFO');

          if (ENABLE_TRADING && clobClient) {
            // Get market info
            const marketInfo = await getMarketInfo(trade.conditionId) || {
              tickSize: '0.01',
              negRisk: false,
            };

            // Execute the copy trade
            const result = await executeCopyTrade(
              clobClient,
              trade.tokenId,
              trade.side,
              copySize,
              trade.price,
              { tickSize: marketInfo.tick_size || '0.01', negRisk: marketInfo.neg_risk || false }
            );

            // Record the copied trade
            copiedTrades.set(tradeHash, {
              originalTradeHash: tradeHash,
              tokenId: trade.tokenId,
              conditionId: trade.conditionId,
              side: trade.side,
              size: copySize,
              price: result.price || trade.price,
              ourOrderId: result.orderId,
              status: result.success ? 'executed' : 'failed',
              timestamp: Date.now(),
            });

            if (result.success) {
              tradesExecuted++;
              log(`✅ Copy trade executed!`, 'TRADE');

              // Fetch current portfolio value and calculate PnL
              const currentPortfolio = await getPortfolioValue();
              const pnl = currentPortfolio - initialPortfolioValue;
              const pnlPercent = initialPortfolioValue > 0 ? (pnl / initialPortfolioValue) * 100 : 0;
              log(`📊 Portfolio: $${currentPortfolio.toFixed(2)} | PnL: $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`, 'INFO');

              // Check stop loss
              if (await checkStopLoss()) {
                log(``, 'ERROR');
                log(`🛑 STOP LOSS TRIGGERED!`, 'ERROR');
                log(`Loss: ${pnlPercent.toFixed(2)}% exceeds -${STOP_LOSS_PERCENT}% limit`, 'ERROR');
                log(`Initial Portfolio: $${initialPortfolioValue.toFixed(2)}`, 'ERROR');
                log(`Current Portfolio: $${currentPortfolio.toFixed(2)}`, 'ERROR');
                log(`Trades Executed: ${tradesExecuted}`, 'ERROR');
                log(`Exiting...`, 'ERROR');
                process.exit(1);
              }
            } else {
              log(`❌ Copy trade failed`, 'ERROR');
            }
          } else {
            log(`[DRY RUN] Would execute ${trade.side} for ${copySize} shares`, 'INFO');

            copiedTrades.set(tradeHash, {
              originalTradeHash: tradeHash,
              tokenId: trade.tokenId,
              conditionId: trade.conditionId,
              side: trade.side,
              size: copySize,
              price: trade.price,
              status: 'pending',
              timestamp: Date.now(),
            });
          }

          log(`═════════════════`, 'INFO');
          log(``, 'INFO');
        }
      }

      // Display status every 12 cycles (1 minute at 5s interval)
      if (cycleCount % 12 === 0) {
        const currentPortfolio = await getPortfolioValue();
        const pnl = currentPortfolio - initialPortfolioValue;
        const pnlPercent = initialPortfolioValue > 0 ? (pnl / initialPortfolioValue) * 100 : 0;
        const pnlStr = `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`;
        log(`[Cycle ${cycleCount}] Portfolio: $${currentPortfolio.toFixed(2)} (${pnlStr}) | Trades: ${copiedTrades.size}`, 'INFO');

        // Check stop loss periodically too
        if (pnlPercent <= -STOP_LOSS_PERCENT) {
          log(``, 'ERROR');
          log(`🛑 STOP LOSS TRIGGERED!`, 'ERROR');
          log(`Loss: ${pnlPercent.toFixed(2)}% exceeds -${STOP_LOSS_PERCENT}% limit`, 'ERROR');
          log(`Exiting...`, 'ERROR');
          process.exit(1);
        }
      }

    } catch (error) {
      log(`Error in main loop: ${error}`, 'ERROR');
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// Run
main().catch(console.error);
