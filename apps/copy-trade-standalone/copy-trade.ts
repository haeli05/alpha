/**
 * POLYMARKET COPY TRADING SCRIPT (Standalone)
 *
 * USAGE: npx tsx copy-trade.ts
 *
 * REQUIRED ENV VARS (in .env file):
 * - POLYMARKET_API_KEY
 * - POLYMARKET_SECRET
 * - POLYMARKET_PASSPHRASE
 * - POLYMARKET_PRIVATE_KEY
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const TARGET_ACCOUNT = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const STOP_LOSS_PERCENT = 12;
const POLL_INTERVAL_MS = 500; // Poll every 0.5 seconds (2x per second)
const ENABLE_TRADING = true;

// ============================================================================
// CAPITAL TRACKING
// ============================================================================

let initialPortfolioValue = 0;
let tradesExecuted = 0;
const ourPositions: Map<string, { size: number; costBasis: number }> = new Map();

// Fill statistics
const fillStats = {
  fak: 0,
  gtc: 0,
};

async function getPositionValues(): Promise<number> {
  try {
    const res = await fetch(`${DATA_API_HOST}/positions?user=${PROXY_WALLET.toLowerCase()}`);
    if (!res.ok) return 0;
    const positions = await res.json();
    if (!Array.isArray(positions)) return 0;
    let totalValue = 0;
    for (const pos of positions) {
      // Use currentValue from API - this is the most accurate value
      // It already accounts for current price and resolved markets
      const currentValue = parseFloat(pos.currentValue || '0');
      totalValue += currentValue;
    }
    return totalValue;
  } catch (error) {
    log(`Error fetching position values: ${error}`, 'WARN');
    return 0;
  }
}

async function getPortfolioValue(): Promise<number> {
  const usdcBalance = await getWalletBalance();
  const positionValue = await getPositionValues();
  return usdcBalance + positionValue;
}

async function getCurrentPnL(): Promise<number> {
  const currentValue = await getPortfolioValue();
  return currentValue - initialPortfolioValue;
}

async function getPnLPercent(): Promise<number> {
  if (initialPortfolioValue <= 0) return 0;
  const pnl = await getCurrentPnL();
  return (pnl / initialPortfolioValue) * 100;
}

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

const POLYGON_RPCS = [
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com',
  'https://1rpc.io/matic',
];
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

async function getWalletBalance(): Promise<number> {
  const { providers, Contract } = await import('ethers');

  for (const rpc of POLYGON_RPCS) {
    try {
      const provider = new providers.JsonRpcProvider(rpc);
      const usdc = new Contract(USDC_ADDRESS, [
        'function balanceOf(address) view returns (uint256)',
      ], provider);
      const balance = await usdc.balanceOf(PROXY_WALLET);
      return Number(balance) / 1e6;
    } catch (error) {
      // Try next RPC
    }
  }

  log('All RPCs failed for wallet balance', 'WARN');
  return 0;
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
  asset: string;
  market: string;
  outcome: string;
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

let previousPositions: Map<string, Position> = new Map();
const copiedTrades: Map<string, CopiedTrade> = new Map();
const seenTradeIds: Set<string> = new Set();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = { INFO: '   ', WARN: '⚠️ ', ERROR: '❌', TRADE: '💰' }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// POLYMARKET API FUNCTIONS
// ============================================================================

async function getAccountTrades(address: string, limit: number = 100): Promise<any[]> {
  try {
    const url = `${DATA_API_HOST}/trades?user=${address.toLowerCase()}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch trades: ${res.status} - ${text}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data;
  } catch (error) {
    log(`Error fetching trades for ${address}: ${error}`, 'ERROR');
    return [];
  }
}

async function getMarketInfo(conditionId: string): Promise<any> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    return null;
  }
}

// ============================================================================
// TRADING FUNCTIONS
// ============================================================================

async function executeCopyTrade(
  clobClient: any,
  tokenId: string,
  side: 'BUY' | 'SELL',
  size: number,
  targetPrice: number,
  marketInfo: { tickSize: string; negRisk: boolean }
): Promise<{ success: boolean; orderId?: string; price?: number; error?: string }> {
  const tick = parseFloat(marketInfo.tickSize || '0.01');
  const MIN_ORDER_VALUE = 1.05;

  // Helper to place order and get filled amount
  async function placeAndCheck(price: number, orderSize: number, orderType: any): Promise<{ filled: number; orderId?: string }> {
    price = Math.round(price / tick) * tick;
    price = Math.round(price * 100) / 100;
    price = Math.max(0.01, Math.min(price, 0.99));

    try {
      const response = await clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: price,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          size: orderSize,
          feeRateBps: 0,
        },
        { tickSize: marketInfo.tickSize, negRisk: marketInfo.negRisk },
        orderType
      );

      const orderId = response?.order_id || response?.orderID || response?.id || null;
      if (!orderId) return { filled: 0 };

      // Check how much was filled
      await sleep(200);
      try {
        const info = await clobClient.getOrder(orderId);
        const sizeFilled = parseFloat(info?.size_matched || info?.sizeFilled || '0');
        return { filled: sizeFilled, orderId };
      } catch (e) {
        // Assume full fill if we can't check
        return { filled: orderSize, orderId };
      }
    } catch (e) {
      return { filled: 0 };
    }
  }

  try {
    const minSharesForValue = Math.ceil(MIN_ORDER_VALUE / targetPrice);
    const totalSize = Math.max(size, minSharesForValue);
    let remaining = totalSize;
    let lastOrderId: string | undefined;

    // Step 1: FAK at market price ($0.99 for buy, $0.01 for sell)
    const maxPrice = side === 'BUY' ? 0.99 : 0.01;
    log(`Trying ${side} FAK @ $${maxPrice.toFixed(2)} (market) for ${totalSize} shares`, 'TRADE');
    let result = await placeAndCheck(maxPrice, remaining, OrderType.FAK);
    if (result.filled > 0) {
      log(`Filled ${result.filled} via FAK`, 'TRADE');
      remaining -= result.filled;
      lastOrderId = result.orderId;
      fillStats.fak++;
    }

    // Step 2: GTC at exact price for remainder (will hang until filled)
    if (remaining > 0) {
      log(`Placing GTC @ $${targetPrice.toFixed(2)} for ${remaining} remainder (will hang)`, 'TRADE');
      try {
        const response = await clobClient.createAndPostOrder(
          {
            tokenID: tokenId,
            price: targetPrice,
            side: side === 'BUY' ? Side.BUY : Side.SELL,
            size: remaining,
            feeRateBps: 0,
          },
          { tickSize: marketInfo.tickSize, negRisk: marketInfo.negRisk },
          OrderType.GTC
        );
        const gtcOrderId = response?.order_id || response?.orderID || response?.id;
        if (gtcOrderId) {
          log(`GTC order placed: ${gtcOrderId.slice(0, 20)}...`, 'TRADE');
          lastOrderId = gtcOrderId;
          fillStats.gtc++;
        }
      } catch (e) {
        log(`GTC order failed: ${e}`, 'WARN');
      }
    }

    log(`[Stats: FAK=${fillStats.fak}, GTC=${fillStats.gtc}]`, 'INFO');
    return { success: true, orderId: lastOrderId, price: targetPrice };

  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    log(`Error executing copy trade: ${errorMsg}`, 'ERROR');
    return { success: false, error: errorMsg };
  }
}

// ============================================================================
// POSITION MONITORING
// ============================================================================

async function detectNewTrades(address: string): Promise<TargetTrade[]> {
  const trades = await getAccountTrades(address, 200); // Fetch more to catch bursts
  const newTrades: TargetTrade[] = [];

  for (const trade of trades) {
    const tradeId = trade.transactionHash || trade.id || `${trade.asset}-${trade.size}-${trade.timestamp}`;
    if (seenTradeIds.has(tradeId)) continue;
    seenTradeIds.add(tradeId);

    let timestamp = Date.now();
    if (trade.timestamp) {
      const ts = typeof trade.timestamp === 'number' ? trade.timestamp : parseInt(trade.timestamp);
      timestamp = ts < 4102444800 ? ts * 1000 : ts;
    }

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

function calculateCopySize(targetSize: number): number {
  // Scale proportionally: target min ~18, our min 5
  // Ratio: 5/18 ≈ 0.28
  const scaled = Math.round(targetSize * (5 / 18));
  return Math.max(5, scaled);
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
  console.log(`║  Copy Mode:      SCALE 5:18 (min 5 shares)                 ║`);
  console.log(`║  Stop Loss:      -${STOP_LOSS_PERCENT}% of capital                            ║`);
  console.log(`║  Trading:        ${ENABLE_TRADING ? 'ENABLED' : 'DISABLED (dry run)'}                         ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    log('Missing API credentials. Set POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE', 'ERROR');
    process.exit(1);
  }

  if (ENABLE_TRADING && !POLYMARKET_PRIVATE_KEY) {
    log('Missing POLYMARKET_PRIVATE_KEY for live trading', 'ERROR');
    process.exit(1);
  }

  log('Loading CLOB client...');
  const loaded = await loadClobClient();
  if (!loaded) {
    log('Failed to load CLOB client', 'ERROR');
    process.exit(1);
  }

  log('Initializing CLOB client...');

  let clobClient: any;
  const signatureType = 2;
  const funder = "0x2163f00898fb58f47573e89940ff728a5e07ac09";

  if (ENABLE_TRADING && POLYMARKET_PRIVATE_KEY) {
    const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);
    log(`Wallet address: ${wallet.address}`);
    log(`Proxy wallet:   ${funder}`);

    try {
      const tempClient = new ClobClient(CLOB_HOST, 137, wallet, undefined, signatureType, funder);
      const creds = await tempClient.createOrDeriveApiKey();
      log(`API credentials derived: ${(creds.key || creds.apiKey)?.slice(0, 10)}...`);
      clobClient = new ClobClient(CLOB_HOST, 137, wallet, creds, signatureType, funder);
    } catch (error) {
      log(`Falling back to provided API credentials`, 'WARN');
      clobClient = new ClobClient(CLOB_HOST, 137, wallet, {
        key: POLYMARKET_API_KEY,
        secret: POLYMARKET_SECRET,
        passphrase: POLYMARKET_PASSPHRASE,
      }, signatureType, funder);
    }
  }

  log(`Fetching initial trades for target: ${TARGET_ACCOUNT}`);
  const initialTrades = await getAccountTrades(TARGET_ACCOUNT, 200);
  log(`Found ${initialTrades.length} recent trades`);

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
      const trades = await detectNewTrades(TARGET_ACCOUNT);

      if (trades.length > 0) {
        log(`Detected ${trades.length} trade(s) to copy!`, 'TRADE');

        for (const trade of trades) {
          const tradeHash = `${trade.tokenId}-${trade.side}-${trade.timestamp}`;

          if (copiedTrades.has(tradeHash)) {
            log(`Trade already copied: ${tradeHash.slice(0, 30)}...`, 'INFO');
            continue;
          }

          const copySize = calculateCopySize(trade.size);
          log(``, 'INFO');
          log(`═══ COPY TRADE ═══`, 'TRADE');
          log(`Target ${trade.side}: ${trade.size.toFixed(2)} shares @ $${trade.price.toFixed(4)}`, 'INFO');
          log(`Our ${trade.side}: ${copySize} shares (mirror)`, 'INFO');

          if (ENABLE_TRADING && clobClient) {
            const marketInfo = await getMarketInfo(trade.conditionId) || {
              tickSize: '0.01',
              negRisk: false,
            };

            const result = await executeCopyTrade(
              clobClient,
              trade.tokenId,
              trade.side,
              copySize,
              trade.price,
              { tickSize: marketInfo.tick_size || '0.01', negRisk: marketInfo.neg_risk || false }
            );

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

              const currentPortfolio = await getPortfolioValue();
              const pnl = currentPortfolio - initialPortfolioValue;
              const pnlPercent = initialPortfolioValue > 0 ? (pnl / initialPortfolioValue) * 100 : 0;
              log(`📊 Portfolio: $${currentPortfolio.toFixed(2)} | PnL: $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`, 'INFO');

              if (await checkStopLoss()) {
                log(``, 'ERROR');
                log(`🛑 STOP LOSS TRIGGERED!`, 'ERROR');
                log(`Loss: ${pnlPercent.toFixed(2)}% exceeds -${STOP_LOSS_PERCENT}% limit`, 'ERROR');
                log(`Exiting...`, 'ERROR');
                process.exit(1);
              }
            } else {
              log(`❌ COPY TRADE FAILED`, 'ERROR');
              log(`   Token: ${trade.tokenId.slice(0, 20)}...`, 'ERROR');
              log(`   Side: ${trade.side} | Size: ${copySize} | Price: $${trade.price.toFixed(4)}`, 'ERROR');
              if (result.error) {
                log(`   Error: ${result.error.slice(0, 100)}`, 'ERROR');
              }
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

      if (cycleCount % 120 === 0) { // Log status every ~12 seconds
        const currentPortfolio = await getPortfolioValue();
        const pnl = currentPortfolio - initialPortfolioValue;
        const pnlPercent = initialPortfolioValue > 0 ? (pnl / initialPortfolioValue) * 100 : 0;
        const pnlStr = `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`;
        log(`[Cycle ${cycleCount}] Portfolio: $${currentPortfolio.toFixed(2)} (${pnlStr}) | Trades: ${copiedTrades.size}`, 'INFO');

        if (pnlPercent <= -STOP_LOSS_PERCENT) {
          log(``, 'ERROR');
          log(`🛑 STOP LOSS TRIGGERED!`, 'ERROR');
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

main().catch(console.error);
