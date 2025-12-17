/**
 * LIVE SPREAD SCANNER
 * Gets actual markets from target's positions and monitors spreads
 */

import dotenv from 'dotenv';
dotenv.config();

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const TARGET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

interface Market {
  title: string;
  slug: string;
  upToken: string;
  downToken: string;
}

async function getMarketsFromTarget(): Promise<Market[]> {
  const res = await fetch(`${DATA_API}/positions?user=${TARGET}&sizeThreshold=1`);
  const positions = await res.json();

  const marketMap = new Map<string, Market>();

  for (const pos of positions) {
    if (pos.outcome !== 'Up' && pos.outcome !== 'Down') continue;
    if (!pos.curPrice || pos.curPrice <= 0) continue;

    const slug = pos.slug || pos.eventSlug;
    if (!slug) continue;

    if (!marketMap.has(slug)) {
      marketMap.set(slug, {
        title: pos.title,
        slug,
        upToken: pos.outcome === 'Up' ? pos.asset : pos.oppositeAsset,
        downToken: pos.outcome === 'Down' ? pos.asset : pos.oppositeAsset,
      });
    }
  }

  return Array.from(marketMap.values());
}

async function getBestBid(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    const book = await res.json();
    let best = 0;
    for (const b of (book.bids || [])) {
      const p = parseFloat(b.price);
      if (p > best) best = p;
    }
    return best;
  } catch { return 0; }
}

async function scan() {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           LIVE SPREAD SCANNER - 15 MINUTE RUN                                  ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Getting live markets from target wallet positions                             ║');
  console.log('║  Target: Combined < $0.98 (2¢+ profit per share)                               ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const markets = await getMarketsFromTarget();
  console.log(`Found ${markets.length} live markets from target's positions`);
  console.log('');

  let scans = 0;
  let opps = 0;
  const oppLog: string[] = [];

  const scanOnce = async () => {
    scans++;
    const time = new Date().toISOString().slice(11, 19);
    console.log(`\n[${time}] Scan #${scans}`);
    console.log('─'.repeat(90));

    for (const market of markets) {
      const [upBid, downBid] = await Promise.all([
        getBestBid(market.upToken),
        getBestBid(market.downToken),
      ]);

      const upPrice = upBid + 0.01;
      const downPrice = downBid + 0.01;
      const combined = upPrice + downPrice;
      const profit = ((1 - combined) * 100).toFixed(1);

      const isOpp = combined < 0.98;
      if (isOpp) {
        opps++;
        oppLog.push(`${time} | ${market.title.slice(0, 40)} | $${combined.toFixed(3)} | ${profit}¢`);
      }

      const marker = isOpp ? '🎯' : combined < 1.0 ? '  ' : '❌';
      const color = isOpp ? '\x1b[32m' : combined < 1.0 ? '\x1b[33m' : '\x1b[31m';

      const shortTitle = market.title.replace('Up or Down - ', '').slice(0, 40);
      console.log(`${marker} ${shortTitle.padEnd(42)} | Up $${upPrice.toFixed(2)} + Down $${downPrice.toFixed(2)} = ${color}$${combined.toFixed(3)}\x1b[0m (${profit}¢)`);
    }

    console.log('─'.repeat(90));
    console.log(`Opportunities (< $0.98): ${opps} total | Scans: ${scans}`);

    if (oppLog.length > 0) {
      console.log('\nRecent opportunities:');
      for (const opp of oppLog.slice(-3)) {
        console.log(`  🎯 ${opp}`);
      }
    }
  };

  // Run for 15 minutes
  await scanOnce();
  const interval = setInterval(scanOnce, 5000);

  setTimeout(() => {
    clearInterval(interval);
    console.log('\n\n');
    console.log('═'.repeat(90));
    console.log('FINAL REPORT - 15 MINUTE SCAN');
    console.log('═'.repeat(90));
    console.log(`Total scans: ${scans}`);
    console.log(`Total opportunities (< $0.98): ${opps}`);
    console.log(`Opportunity rate: ${((opps / scans) * 100).toFixed(2)}%`);

    if (oppLog.length > 0) {
      console.log('\nAll opportunities found:');
      for (const opp of oppLog) {
        console.log(`  🎯 ${opp}`);
      }
    } else {
      console.log('\n❌ No opportunities found with combined < $0.98');
      console.log('   Markets are too efficient - spreads staying at $1.00');
    }

    process.exit(0);
  }, 15 * 60 * 1000);

  process.on('SIGINT', () => {
    console.log('\n\nInterrupted early...');
    console.log(`Scans: ${scans} | Opportunities: ${opps}`);
    process.exit(0);
  });
}

scan().catch(console.error);
