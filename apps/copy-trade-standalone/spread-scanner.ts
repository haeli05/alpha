/**
 * SPREAD SCANNER - Monitor all Up/Down markets for pair arb opportunities
 * Runs for 1 hour and logs all spreads, highlighting any < $0.98
 */

import * as dotenv from 'dotenv';
dotenv.config();

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

interface Market {
  slug: string;
  asset: string;
  duration: string;
  upTokenId: string;
  downTokenId: string;
  endTime?: Date;
}

const MARKET_SLUGS = [
  { slug: 'btc-up-or-down-15m', asset: 'BTC', duration: '15m' },
  { slug: 'eth-up-or-down-15m', asset: 'ETH', duration: '15m' },
  { slug: 'sol-up-or-down-15m', asset: 'SOL', duration: '15m' },
  { slug: 'xrp-up-or-down-15m', asset: 'XRP', duration: '15m' },
  { slug: 'btc-up-or-down-1hr', asset: 'BTC', duration: '1hr' },
  { slug: 'eth-up-or-down-1hr', asset: 'ETH', duration: '1hr' },
  { slug: 'sol-up-or-down-1hr', asset: 'SOL', duration: '1hr' },
  { slug: 'xrp-up-or-down-1hr', asset: 'XRP', duration: '1hr' },
];

const markets: Map<string, Market> = new Map();

// Stats
let scans = 0;
let opportunities = 0;
const opportunityLog: string[] = [];
const spreadHistory: { time: Date; spreads: Record<string, number> }[] = [];

async function fetchMarketData(slug: string): Promise<Market | null> {
  try {
    const res = await fetch(`${GAMMA_HOST}/markets?slug=${slug}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.[0]) return null;
    const m = data[0];
    const tokens = JSON.parse(m.clobTokenIds || '[]');
    if (tokens.length < 2) return null;
    return {
      slug,
      asset: slug.split('-')[0].toUpperCase(),
      duration: slug.includes('15m') ? '15m' : '1hr',
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      endTime: m.endDate ? new Date(m.endDate) : undefined,
    };
  } catch { return null; }
}

async function fetchBestBid(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return 0;
    const book = await res.json();
    let bestBid = 0;
    for (const b of (book.bids || [])) {
      const p = parseFloat(b.price);
      if (p > bestBid) bestBid = p;
    }
    return bestBid;
  } catch { return 0; }
}

async function refreshMarkets(): Promise<void> {
  for (const { slug } of MARKET_SLUGS) {
    const market = await fetchMarketData(slug);
    if (market) markets.set(slug, market);
  }
}

async function scanSpreads(): Promise<void> {
  scans++;
  const now = new Date();
  const timeStr = now.toISOString().slice(11, 19);
  const spreads: Record<string, number> = {};

  let output = `\n[${timeStr}] Scan #${scans}\n`;
  output += '─'.repeat(70) + '\n';

  for (const [slug, market] of markets) {
    // Skip expired markets
    if (market.endTime && market.endTime.getTime() < Date.now()) continue;

    const [upBid, downBid] = await Promise.all([
      fetchBestBid(market.upTokenId),
      fetchBestBid(market.downTokenId),
    ]);

    // Entry prices = bestBid + 1¢
    const upPrice = upBid + 0.01;
    const downPrice = downBid + 0.01;
    const combined = upPrice + downPrice;

    spreads[slug] = combined;

    let ttlStr = '';
    if (market.endTime) {
      const ttl = market.endTime.getTime() - Date.now();
      const mins = Math.floor(ttl / 60000);
      const secs = Math.floor((ttl % 60000) / 1000);
      ttlStr = `[${mins}:${secs.toString().padStart(2, '0')}]`;
    }

    const profitCents = ((1 - combined) * 100).toFixed(1);
    const isOpp = combined < 0.98;

    if (isOpp) {
      output += `🎯 ${market.asset} ${market.duration.padEnd(3)} ${ttlStr.padEnd(8)} | Up $${upPrice.toFixed(2)} + Down $${downPrice.toFixed(2)} = \x1b[32m$${combined.toFixed(3)}\x1b[0m (${profitCents}¢ profit!) ***\n`;
      opportunities++;
      opportunityLog.push(`${timeStr} | ${market.asset} ${market.duration} | $${combined.toFixed(3)} | ${profitCents}¢`);
    } else if (combined < 1.00) {
      output += `   ${market.asset} ${market.duration.padEnd(3)} ${ttlStr.padEnd(8)} | Up $${upPrice.toFixed(2)} + Down $${downPrice.toFixed(2)} = \x1b[33m$${combined.toFixed(3)}\x1b[0m (${profitCents}¢)\n`;
    } else {
      output += `   ${market.asset} ${market.duration.padEnd(3)} ${ttlStr.padEnd(8)} | Up $${upPrice.toFixed(2)} + Down $${downPrice.toFixed(2)} = \x1b[31m$${combined.toFixed(3)}\x1b[0m (${profitCents}¢)\n`;
    }
  }

  spreadHistory.push({ time: now, spreads });

  // Summary
  output += '─'.repeat(70) + '\n';
  output += `Opportunities found: ${opportunities} | Target: < $0.98\n`;

  if (opportunityLog.length > 0) {
    output += '\nRecent opportunities:\n';
    for (const opp of opportunityLog.slice(-5)) {
      output += `  ${opp}\n`;
    }
  }

  console.log(output);
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           SPREAD SCANNER - 1 HOUR MONITORING                                   ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Scanning all Up/Down markets for pair arb opportunities                       ║');
  console.log('║  Target: Combined < $0.98 (2¢+ profit per share)                               ║');
  console.log('║  Will run for 1 hour, scanning every 5 seconds                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load markets
  await refreshMarkets();
  console.log(`Loaded ${markets.size} markets`);

  // Refresh markets every 2 minutes
  setInterval(refreshMarkets, 2 * 60 * 1000);

  // Scan every 5 seconds
  const scanInterval = setInterval(scanSpreads, 5000);

  // Initial scan
  await scanSpreads();

  // Stop after 1 hour
  setTimeout(() => {
    clearInterval(scanInterval);

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('FINAL REPORT - 1 HOUR SCAN');
    console.log('═'.repeat(70));
    console.log(`Total scans: ${scans}`);
    console.log(`Opportunities found (< $0.98): ${opportunities}`);
    console.log(`Opportunity rate: ${((opportunities / scans) * 100).toFixed(2)}%`);

    if (opportunityLog.length > 0) {
      console.log('\nAll opportunities:');
      for (const opp of opportunityLog) {
        console.log(`  ${opp}`);
      }
    } else {
      console.log('\nNo opportunities found with combined < $0.98');
    }

    // Calculate average spreads
    const avgSpreads: Record<string, { sum: number; count: number }> = {};
    for (const entry of spreadHistory) {
      for (const [slug, spread] of Object.entries(entry.spreads)) {
        if (!avgSpreads[slug]) avgSpreads[slug] = { sum: 0, count: 0 };
        avgSpreads[slug].sum += spread;
        avgSpreads[slug].count++;
      }
    }

    console.log('\nAverage spreads:');
    for (const [slug, data] of Object.entries(avgSpreads)) {
      const avg = data.sum / data.count;
      console.log(`  ${slug}: $${avg.toFixed(3)}`);
    }

    process.exit(0);
  }, 60 * 60 * 1000); // 1 hour

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\nInterrupted - showing partial results...');
    console.log(`Scans completed: ${scans}`);
    console.log(`Opportunities: ${opportunities}`);
    if (opportunityLog.length > 0) {
      console.log('\nOpportunities found:');
      for (const opp of opportunityLog) {
        console.log(`  ${opp}`);
      }
    }
    process.exit(0);
  });
}

main().catch(console.error);
