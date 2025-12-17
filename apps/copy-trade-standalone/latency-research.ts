/**
 * LATENCY ARBITRAGE RESEARCH
 *
 * Measures:
 * 1. RTDS price update latency vs Polymarket orderbook
 * 2. Time window between price move and orderbook adjustment
 * 3. Executable order flow opportunities
 *
 * Records data to analyze if latency arb is viable
 */

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const RTDS_HOST = 'wss://ws-live-data.polymarket.com';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  ASSETS: ['btc', 'eth'],  // Focus on most liquid
  POLL_INTERVAL_MS: 100,   // Poll orderbook every 100ms
  PRICE_MOVE_THRESHOLD: 0.0001,  // 0.01% price move (very sensitive)
  LOG_INTERVAL_MS: 30000,  // Log stats every 30s
  RUN_DURATION_MS: 24 * 60 * 60 * 1000,  // Run for 24 hours
};

// ============================================================================
// STATE
// ============================================================================

interface PriceUpdate {
  asset: string;
  price: number;
  timestamp: number;
  source: 'rtds' | 'orderbook';
}

interface ArbOpportunity {
  timestamp: number;
  asset: string;
  rtdsPrice: number;
  rtdsPriceChange: number;  // % change
  upBid: number;
  downBid: number;
  combined: number;
  expectedDirection: 'up' | 'down';  // Based on RTDS move
  cheapSide: 'up' | 'down';  // Which side is cheap on orderbook
  latencyMs: number;  // Time since RTDS update
  executable: boolean;  // Was there liquidity to hit?
  potentialProfit: number;  // Estimated profit in cents
}

// Track RTDS prices
const rtdsPrices: Record<string, { price: number; timestamp: number; prevPrice: number }> = {};

// Track orderbook state
const orderbookState: Record<string, {
  upBid: number;
  downBid: number;
  upAsk: number;
  downAsk: number;
  timestamp: number;
}> = {};

// Market tokens
const marketTokens: Record<string, { upToken: string; downToken: string }> = {};

// Stats
const stats = {
  rtdsUpdates: 0,
  orderbookPolls: 0,
  priceMoves: 0,
  arbOpportunities: 0,
  executableOpportunities: 0,
  totalLatencyMs: 0,
  opportunities: [] as ArbOpportunity[],
};

// ============================================================================
// LOGGING
// ============================================================================

function log(msg: string, type: 'INFO' | 'RTDS' | 'ARB' | 'STAT' = 'INFO'): void {
  const colors: Record<string, string> = {
    INFO: '\x1b[37m',
    RTDS: '\x1b[36m',
    ARB: '\x1b[32m',
    STAT: '\x1b[33m',
  };
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${colors[type]}[${time}] [${type}] ${msg}\x1b[0m`);
}

// ============================================================================
// RTDS CONNECTION
// ============================================================================

function connectRTDS(): WebSocket {
  const ws = new WebSocket(RTDS_HOST);

  ws.on('open', () => {
    log('RTDS connected', 'INFO');

    ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices',
        type: 'update'
      }]
    }));

    // Ping to keep alive
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'ping' }));
      }
    }, 5000);
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.topic === 'crypto_prices' && msg.payload) {
        const symbol = (msg.payload.symbol || '').toLowerCase();
        const price = parseFloat(msg.payload.value || '0');
        const timestamp = Date.now();

        let asset = '';
        if (symbol.includes('btc')) asset = 'btc';
        else if (symbol.includes('eth')) asset = 'eth';
        else if (symbol.includes('sol')) asset = 'sol';
        else if (symbol.includes('xrp')) asset = 'xrp';

        if (asset && price > 0 && CONFIG.ASSETS.includes(asset)) {
          const prev = rtdsPrices[asset];
          const prevPrice = prev?.price || price;

          rtdsPrices[asset] = { price, timestamp, prevPrice };
          stats.rtdsUpdates++;

          // Check for significant price move
          const pctChange = Math.abs((price - prevPrice) / prevPrice);
          if (pctChange > CONFIG.PRICE_MOVE_THRESHOLD) {
            stats.priceMoves++;
            const direction = price > prevPrice ? 'UP' : 'DOWN';
            log(`${asset.toUpperCase()} moved ${direction} ${(pctChange * 100).toFixed(3)}% ($${prevPrice.toFixed(2)} -> $${price.toFixed(2)})`, 'RTDS');

            // Check for arb opportunity
            checkArbOpportunity(asset, price, prevPrice, timestamp);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    log('RTDS disconnected, reconnecting...', 'INFO');
    setTimeout(() => connectRTDS(), 1000);
  });

  ws.on('error', (err) => {
    log(`RTDS error: ${err.message}`, 'INFO');
  });

  return ws;
}

// ============================================================================
// ORDERBOOK POLLING
// ============================================================================

async function fetchOrderbook(tokenId: string): Promise<{ bestBid: number; bestAsk: number; bidSize: number; askSize: number }> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return { bestBid: 0, bestAsk: 1, bidSize: 0, askSize: 0 };

    const book = await res.json();
    let bestBid = 0, bestAsk = 1, bidSize = 0, askSize = 0;

    for (const b of book.bids || []) {
      const p = parseFloat(b.price);
      const s = parseFloat(b.size);
      if (p > bestBid) {
        bestBid = p;
        bidSize = s;
      }
    }
    for (const a of book.asks || []) {
      const p = parseFloat(a.price);
      const s = parseFloat(a.size);
      if (p < bestAsk) {
        bestAsk = p;
        askSize = s;
      }
    }

    return { bestBid, bestAsk, bidSize, askSize };
  } catch {
    return { bestBid: 0, bestAsk: 1, bidSize: 0, askSize: 0 };
  }
}

async function pollOrderbooks(): Promise<void> {
  const timestamp = Date.now();

  for (const asset of CONFIG.ASSETS) {
    const tokens = marketTokens[asset];
    if (!tokens) continue;

    const [upBook, downBook] = await Promise.all([
      fetchOrderbook(tokens.upToken),
      fetchOrderbook(tokens.downToken),
    ]);

    orderbookState[asset] = {
      upBid: upBook.bestBid,
      downBid: downBook.bestBid,
      upAsk: upBook.bestAsk,
      downAsk: downBook.bestAsk,
      timestamp,
    };

    stats.orderbookPolls++;
  }
}

// ============================================================================
// ARB DETECTION
// ============================================================================

function checkArbOpportunity(asset: string, newPrice: number, oldPrice: number, rtdsTimestamp: number): void {
  const ob = orderbookState[asset];
  if (!ob) return;

  // Skip if no liquidity on either side (market probably expired)
  if (ob.upBid === 0 || ob.downBid === 0) {
    log(`${asset.toUpperCase()}: No liquidity (Up $${ob.upBid} Down $${ob.downBid}) - skipping`, 'INFO');
    return;
  }

  const priceChange = (newPrice - oldPrice) / oldPrice;
  const direction: 'up' | 'down' = priceChange > 0 ? 'up' : 'down';

  // When price goes UP, UP token should get more expensive, DOWN should get cheaper
  // So we want to BUY the side that will become more valuable
  // If BTC goes UP -> buy UP before it gets more expensive
  // If BTC goes DOWN -> buy DOWN before it gets more expensive

  const targetAsk = direction === 'up' ? ob.upAsk : ob.downAsk;
  const oppositeAsk = direction === 'up' ? ob.downAsk : ob.upAsk;

  const latencyMs = Date.now() - rtdsTimestamp;

  // Calculate if there's profit potential
  // If we buy target side at ask, can we sell opposite to lock in profit?
  const combined = targetAsk + oppositeAsk;
  const spread = combined - 1.0;  // negative = profitable

  // Is there executable liquidity at good price?
  // executable = ask exists and combined < 1.0 (instant arb)
  const hasLiquidity = targetAsk > 0.05 && targetAsk < 0.95;
  const isProfitable = combined < 1.0;
  const executable = hasLiquidity && isProfitable;

  // Why not executable?
  let reason = 'OK';
  if (!hasLiquidity) reason = 'NO_LIQ';
  else if (!isProfitable) reason = `SPREAD_${(spread * 100).toFixed(1)}c`;

  const potentialProfit = isProfitable ? (1 - combined) * 100 : 0;  // cents per share

  const opp: ArbOpportunity = {
    timestamp: Date.now(),
    asset,
    rtdsPrice: newPrice,
    rtdsPriceChange: priceChange * 100,
    upBid: ob.upBid,
    downBid: ob.downBid,
    combined,
    expectedDirection: direction,
    cheapSide: ob.upBid < ob.downBid ? 'up' : 'down',
    latencyMs,
    executable,
    potentialProfit,
  };

  stats.opportunities.push(opp);
  stats.arbOpportunities++;
  if (executable) stats.executableOpportunities++;
  stats.totalLatencyMs += latencyMs;

  const execStr = executable ? `YES +${potentialProfit.toFixed(1)}c` : `NO (${reason})`;
  log(`${asset.toUpperCase()} ${direction.toUpperCase()} ${(priceChange * 100).toFixed(3)}% | Ask: $${targetAsk.toFixed(2)} | Comb: $${combined.toFixed(3)} | ${latencyMs}ms | ${execStr}`, 'ARB');
}

// ============================================================================
// MARKET SETUP
// ============================================================================

let lastMarketWindow = 0;

async function loadMarketTokens(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const interval = 15 * 60;
  const currentWindowStart = Math.floor(nowSec / interval) * interval;

  // Only reload if window changed
  if (currentWindowStart === lastMarketWindow) return;
  lastMarketWindow = currentWindowStart;

  log(`New 15-min window starting - refreshing markets...`, 'INFO');

  for (const asset of CONFIG.ASSETS) {
    const slug = `${asset}-updown-15m-${currentWindowStart}`;

    try {
      const res = await fetch(`${GAMMA_HOST}/events?slug=${slug}`);
      if (!res.ok) {
        log(`${asset.toUpperCase()}: Market ${slug} not found (${res.status})`, 'INFO');
        continue;
      }

      const data = await res.json();
      const m = data?.[0]?.markets?.[0];
      if (!m) {
        log(`${asset.toUpperCase()}: No market data in response`, 'INFO');
        continue;
      }

      const tokens = JSON.parse(m.clobTokenIds || '[]');
      if (tokens.length >= 2) {
        marketTokens[asset] = { upToken: tokens[0], downToken: tokens[1] };
        log(`${asset.toUpperCase()}: Loaded ${slug}`, 'INFO');
      }
    } catch (e: any) {
      log(`${asset.toUpperCase()}: Error - ${e.message}`, 'INFO');
    }
  }
}

// ============================================================================
// STATS REPORTING
// ============================================================================

function saveData(): void {
  const data = {
    timestamp: new Date().toISOString(),
    stats: {
      rtdsUpdates: stats.rtdsUpdates,
      orderbookPolls: stats.orderbookPolls,
      priceMoves: stats.priceMoves,
      arbOpportunities: stats.arbOpportunities,
      executableOpportunities: stats.executableOpportunities,
      avgLatencyMs: stats.arbOpportunities > 0 ? stats.totalLatencyMs / stats.arbOpportunities : 0,
    },
    opportunities: stats.opportunities,
  };

  writeFileSync('/root/polymarket/latency-data.json', JSON.stringify(data, null, 2));
  log(`Saved ${stats.opportunities.length} opportunities to latency-data.json`, 'STAT');
}

function reportStats(): void {
  const avgLatency = stats.arbOpportunities > 0
    ? (stats.totalLatencyMs / stats.arbOpportunities).toFixed(1)
    : '0';

  // Save data to file every report
  saveData();

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                      LATENCY ARB RESEARCH STATS                                ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  RTDS Updates: ${stats.rtdsUpdates.toString().padEnd(10)} | Orderbook Polls: ${stats.orderbookPolls}`.padEnd(83) + '║');
  console.log(`║  Price Moves (>${(CONFIG.PRICE_MOVE_THRESHOLD * 100).toFixed(1)}%): ${stats.priceMoves}`.padEnd(83) + '║');
  console.log(`║  Arb Opportunities: ${stats.arbOpportunities} | Executable: ${stats.executableOpportunities}`.padEnd(83) + '║');
  console.log(`║  Avg Latency: ${avgLatency}ms`.padEnd(83) + '║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');

  // Show recent opportunities
  const recent = stats.opportunities.slice(-5);
  for (const opp of recent) {
    const time = new Date(opp.timestamp).toISOString().slice(11, 19);
    const execStr = opp.executable ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m';
    console.log(`║  ${time} | ${opp.asset.toUpperCase()} ${opp.expectedDirection.toUpperCase().padEnd(4)} | ${opp.rtdsPriceChange.toFixed(2)}% | ${opp.latencyMs}ms | Exec: ${execStr}`.padEnd(91) + '║');
  }

  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           LATENCY ARBITRAGE RESEARCH                                           ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Measuring RTDS price feed vs Polymarket orderbook latency                     ║');
  console.log('║  Looking for executable arb windows when prices move                           ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Poll interval: ${CONFIG.POLL_INTERVAL_MS}ms | Move threshold: ${(CONFIG.PRICE_MOVE_THRESHOLD * 100).toFixed(1)}%`.padEnd(83) + '║');
  console.log(`║  Run duration: ${CONFIG.RUN_DURATION_MS / 60000} minutes`.padEnd(83) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load market tokens
  await loadMarketTokens();

  if (Object.keys(marketTokens).length === 0) {
    log('No markets loaded - exiting', 'INFO');
    process.exit(1);
  }

  // Connect to RTDS
  connectRTDS();

  // Poll orderbooks at high frequency
  const pollInterval = setInterval(pollOrderbooks, CONFIG.POLL_INTERVAL_MS);

  // Report stats periodically
  const statsInterval = setInterval(reportStats, CONFIG.LOG_INTERVAL_MS);

  // Refresh market tokens every 30 seconds (catches new 15-min windows quickly)
  setInterval(loadMarketTokens, 30 * 1000);

  // Stop after duration
  setTimeout(() => {
    clearInterval(pollInterval);
    clearInterval(statsInterval);

    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log('FINAL REPORT');
    console.log('═'.repeat(80));
    reportStats();

    // Dump all opportunities to JSON
    console.log('\nAll opportunities:');
    console.log(JSON.stringify(stats.opportunities, null, 2));

    process.exit(0);
  }, CONFIG.RUN_DURATION_MS);
}

process.on('SIGINT', () => {
  console.log('\n\nInterrupted - Final stats:');
  reportStats();
  process.exit(0);
});

main().catch(console.error);
