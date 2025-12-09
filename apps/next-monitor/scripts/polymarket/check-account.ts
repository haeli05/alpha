/**
 * Polymarket Account Check Script
 *
 * Tests API connection and shows account info.
 *
 * Usage: npx tsx scripts/polymarket/check-account.ts
 */

import crypto from 'crypto';

const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

// Generate L2 auth headers for authenticated requests
function getAuthHeaders(
  method: string,
  path: string,
  body: string = ''
): Record<string, string> {
  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    throw new Error('Missing API credentials');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const signature = crypto
    .createHmac('sha256', Buffer.from(POLYMARKET_SECRET, 'base64'))
    .update(message)
    .digest('base64');

  return {
    'POLY_API_KEY': POLYMARKET_API_KEY,
    'POLY_PASSPHRASE': POLYMARKET_PASSPHRASE,
    'POLY_TIMESTAMP': timestamp,
    'POLY_SIGNATURE': signature,
  };
}

async function main() {
  console.log('=== Polymarket Account Check ===\n');

  // Check env vars
  console.log('Environment Variables:');
  console.log(`  POLYMARKET_API_KEY: ${POLYMARKET_API_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`  POLYMARKET_SECRET: ${POLYMARKET_SECRET ? '✓ Set' : '✗ Missing'}`);
  console.log(`  POLYMARKET_PASSPHRASE: ${POLYMARKET_PASSPHRASE ? '✓ Set' : '✗ Missing'}`);
  console.log('');

  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    console.error('Missing required environment variables.');
    console.error('Add them to .env.local in the project root.');
    process.exit(1);
  }

  // Test public endpoints
  console.log('Testing Public API...');

  try {
    // Test Gamma API
    const marketsRes = await fetch(`${GAMMA_HOST}/markets?limit=1&active=true`);
    if (marketsRes.ok) {
      console.log('  ✓ Gamma API connected');
    } else {
      console.log(`  ✗ Gamma API error: ${marketsRes.status}`);
    }

    // Test CLOB API (public)
    const healthRes = await fetch(`${CLOB_HOST}/`);
    if (healthRes.ok) {
      console.log('  ✓ CLOB API connected');
    } else {
      console.log(`  ✗ CLOB API error: ${healthRes.status}`);
    }
  } catch (e) {
    console.log(`  ✗ Connection error: ${e}`);
  }

  // Test authenticated endpoints
  console.log('\nTesting Authenticated API...');

  try {
    const path = '/orders';
    const headers = getAuthHeaders('GET', path);

    const ordersRes = await fetch(`${CLOB_HOST}${path}`, { headers });
    const ordersData = await ordersRes.text();

    if (ordersRes.ok) {
      const orders = JSON.parse(ordersData);
      console.log(`  ✓ Auth successful`);
      console.log(`  Active orders: ${orders.length || 0}`);
    } else {
      console.log(`  ✗ Auth failed: ${ordersRes.status}`);
      console.log(`  Response: ${ordersData.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ✗ Auth error: ${e}`);
  }

  console.log('\n=== Check Complete ===');
}

main();
