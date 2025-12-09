/**
 * Polymarket Buy & Sell Sample Script
 *
 * This script:
 * 1. Buys $1 of YES shares on a specified market
 * 2. Waits 10 minutes
 * 3. Sells all YES shares
 *
 * Note: Full trading requires EIP-712 signing. This is a simulation/example.
 *
 * Usage: npx tsx scripts/polymarket/buy-sell-sample.ts
 */

import crypto from 'crypto';

// Configuration from environment
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;

// Market: Fed rate hike in 2025 (active market)
const MARKET_SLUG = 'fed-rate-hike-in-2025';

// Trade parameters
const BUY_AMOUNT_USD = 1;
const WAIT_MINUTES = 10;

// API endpoints
const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Generate HMAC signature for authenticated requests
function generateSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string = ''
): string {
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(message)
    .digest('base64');
}

async function getMarketBySlug(slug: string) {
  const res = await fetch(`${GAMMA_HOST}/markets/slug/${slug}`);
  if (!res.ok) throw new Error(`Failed to fetch market: ${res.status}`);
  return res.json();
}

async function getClobMarket(conditionId: string) {
  const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
  if (!res.ok) throw new Error(`Failed to fetch CLOB market: ${res.status}`);
  return res.json();
}

async function getOrderBook(tokenId: string) {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`Failed to fetch orderbook: ${res.status}`);
  return res.json();
}

async function getMidpoint(tokenId: string): Promise<number> {
  const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`Failed to fetch midpoint: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.mid);
}

async function main() {
  log('=== Polymarket Trading Script ===');
  log(`Market: ${MARKET_SLUG}`);
  log(`Amount: $${BUY_AMOUNT_USD}`);
  log(`Wait: ${WAIT_MINUTES} minutes`);
  log('');

  // Check credentials
  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    console.error('Missing API credentials. Set in .env.local:');
    console.error('  POLYMARKET_API_KEY');
    console.error('  POLYMARKET_SECRET');
    console.error('  POLYMARKET_PASSPHRASE');
    process.exit(1);
  }

  log('API credentials found');

  try {
    // Fetch market info
    log('Fetching market info...');
    const market = await getMarketBySlug(MARKET_SLUG);

    if (!market) {
      throw new Error('Market not found');
    }

    log(`Market: ${market.question}`);
    log(`Condition ID: ${market.conditionId}`);

    // Fetch tokens from CLOB API (Gamma API doesn't include tokens)
    log('Fetching token info from CLOB...');
    const clobMarket = await getClobMarket(market.conditionId);
    const tokens = clobMarket.tokens || [];
    log(`Available outcomes: ${tokens.map((t: { outcome: string }) => t.outcome).join(', ')}`);

    // Try YES first, then first positive outcome (Up, etc.)
    const positiveToken = tokens.find((t: { outcome: string }) =>
      t.outcome?.toLowerCase() === 'yes'
    ) || tokens.find((t: { outcome: string }) =>
      t.outcome?.toLowerCase() === 'up'
    ) || tokens[0];

    if (!positiveToken) {
      throw new Error('No tradeable token found');
    }

    const tokenId = positiveToken.token_id;
    log(`Token: ${positiveToken.outcome} (${tokenId.slice(0, 20)}...)`);

    // Get current price
    log('Fetching orderbook...');
    const orderbook = await getOrderBook(tokenId);

    const bestAsk = orderbook.asks?.[0];
    const bestBid = orderbook.bids?.[0];

    if (!bestAsk) {
      throw new Error('No asks in orderbook');
    }

    const askPrice = parseFloat(bestAsk.price);
    const bidPrice = bestBid ? parseFloat(bestBid.price) : 0;

    log(`Best Ask: $${askPrice.toFixed(4)}`);
    log(`Best Bid: $${bidPrice.toFixed(4)}`);
    log(`Spread: ${((askPrice - bidPrice) * 100).toFixed(2)}%`);

    // Calculate shares
    const sharesToBuy = BUY_AMOUNT_USD / askPrice;
    log(`Would buy: ${sharesToBuy.toFixed(2)} shares @ $${askPrice.toFixed(4)}`);

    // Simulate order placement
    log('');
    log('=== SIMULATION MODE ===');
    log('Full trading requires EIP-712 signing with your wallet private key.');
    log('To enable real trading, you need to:');
    log('1. Add POLYMARKET_PRIVATE_KEY to .env.local');
    log('2. Install py_clob_client or use the official SDK');
    log('');

    // Simulate wait
    log(`Simulating ${WAIT_MINUTES} minute wait...`);
    log('(Shortened to 5 seconds for demo)');
    await sleep(5000);

    // Get updated price
    const newMid = await getMidpoint(tokenId);
    log(`Current midpoint: $${newMid.toFixed(4)}`);

    // Calculate simulated P&L
    const entryValue = sharesToBuy * askPrice;
    const currentValue = sharesToBuy * newMid;
    const pnl = currentValue - entryValue;
    const pnlPct = ((currentValue / entryValue) - 1) * 100;

    log('');
    log('=== Simulated Trade Summary ===');
    log(`Entry: ${sharesToBuy.toFixed(2)} shares @ $${askPrice.toFixed(4)} = $${entryValue.toFixed(2)}`);
    log(`Current: ${sharesToBuy.toFixed(2)} shares @ $${newMid.toFixed(4)} = $${currentValue.toFixed(2)}`);
    log(`P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
