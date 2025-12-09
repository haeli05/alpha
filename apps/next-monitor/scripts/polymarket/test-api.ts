/**
 * Simple Polymarket API Test
 * Tests public API endpoints without SDK
 */

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

// Test token from the Bitcoin market
const TEST_TOKEN_ID = '21742633143463906290569050155826241533067272736897614950488156847949938836455';

async function testPublicAPI() {
  console.log('=== Polymarket API Test ===\n');

  // Test 1: Gamma API - Get markets
  console.log('1. Testing Gamma API (markets)...');
  try {
    const res = await fetch(`${GAMMA_HOST}/markets?limit=3&active=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const markets = await res.json();
    console.log(`   ✓ Got ${markets.length} markets`);
    if (markets[0]) {
      console.log(`   First market: "${markets[0].question?.slice(0, 50)}..."`);
    }
  } catch (e) {
    console.log(`   ✗ Error: ${e}`);
  }

  // Test 2: CLOB API - Get orderbook
  console.log('\n2. Testing CLOB API (orderbook)...');
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${TEST_TOKEN_ID}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const book = await res.json();
    console.log(`   ✓ Got orderbook`);
    console.log(`   Bids: ${book.bids?.length || 0}, Asks: ${book.asks?.length || 0}`);
    if (book.bids?.[0]) {
      console.log(`   Best bid: $${book.bids[0].price}`);
    }
    if (book.asks?.[0]) {
      console.log(`   Best ask: $${book.asks[0].price}`);
    }
  } catch (e) {
    console.log(`   ✗ Error: ${e}`);
  }

  // Test 3: CLOB API - Get midpoint
  console.log('\n3. Testing CLOB API (midpoint)...');
  try {
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${TEST_TOKEN_ID}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`   ✓ Midpoint: $${data.mid}`);
  } catch (e) {
    console.log(`   ✗ Error: ${e}`);
  }

  // Test 4: Price history
  console.log('\n4. Testing CLOB API (price history)...');
  try {
    const now = Math.floor(Date.now() / 1000);
    const startTs = now - 86400; // 24h ago
    const res = await fetch(
      `${CLOB_HOST}/prices-history?token_id=${TEST_TOKEN_ID}&startTs=${startTs}&endTs=${now}&fidelity=3600`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`   ✓ Got ${data.history?.length || 0} price points`);
  } catch (e) {
    console.log(`   ✗ Error: ${e}`);
  }

  // Check env vars
  console.log('\n=== Environment Check ===');
  console.log(`POLYMARKET_API_KEY: ${process.env.POLYMARKET_API_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`POLYMARKET_SECRET: ${process.env.POLYMARKET_SECRET ? '✓ Set' : '✗ Missing'}`);
  console.log(`POLYMARKET_PASSPHRASE: ${process.env.POLYMARKET_PASSPHRASE ? '✓ Set' : '✗ Missing'}`);
  console.log(`POLYMARKET_PRIVATE_KEY: ${process.env.POLYMARKET_PRIVATE_KEY ? '✓ Set' : '✗ Missing'}`);

  console.log('\n=== Test Complete ===');
}

testPublicAPI();
