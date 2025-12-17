/**
 * POLYMARKET WALLET ANALYZER
 *
 * Analyzes a wallet's trading patterns to reverse-engineer their strategy.
 *
 * USAGE: npx tsx analyze-wallet.ts
 */

const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';

interface Trade {
  id: string;
  timestamp: number;
  conditionId: string;
  asset: string; // tokenId
  outcome: string; // "Yes" or "No"
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  transactionHash: string;
}

interface MarketTrades {
  conditionId: string;
  question?: string;
  trades: Trade[];
  yesBuys: Trade[];
  noBuys: Trade[];
  yesSells: Trade[];
  noSells: Trade[];
}

async function fetchTrades(address: string, limit = 1000): Promise<Trade[]> {
  const url = `${DATA_API_HOST}/trades?user=${address.toLowerCase()}&limit=${limit}`;
  console.log(`Fetching trades from: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch trades: ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map((t: any) => ({
    id: t.id || t.transactionHash,
    timestamp: typeof t.timestamp === 'number'
      ? (t.timestamp < 4102444800 ? t.timestamp * 1000 : t.timestamp)
      : parseInt(t.timestamp) * 1000,
    conditionId: t.conditionId || t.condition_id,
    asset: t.asset,
    outcome: t.outcome || 'Unknown',
    side: t.side as 'BUY' | 'SELL',
    price: parseFloat(t.price || '0'),
    size: parseFloat(t.size || '0'),
    transactionHash: t.transactionHash,
  }));
}

async function getMarketInfo(conditionId: string): Promise<any> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function groupByMarket(trades: Trade[]): Map<string, MarketTrades> {
  const markets = new Map<string, MarketTrades>();

  for (const trade of trades) {
    if (!markets.has(trade.conditionId)) {
      markets.set(trade.conditionId, {
        conditionId: trade.conditionId,
        trades: [],
        yesBuys: [],
        noBuys: [],
        yesSells: [],
        noSells: [],
      });
    }

    const market = markets.get(trade.conditionId)!;
    market.trades.push(trade);

    const isYes = trade.outcome.toLowerCase().includes('yes') ||
                  trade.outcome.toLowerCase().includes('up');
    const isNo = trade.outcome.toLowerCase().includes('no') ||
                 trade.outcome.toLowerCase().includes('down');

    if (trade.side === 'BUY') {
      if (isYes) market.yesBuys.push(trade);
      else if (isNo) market.noBuys.push(trade);
    } else {
      if (isYes) market.yesSells.push(trade);
      else if (isNo) market.noSells.push(trade);
    }
  }

  return markets;
}

function analyzeMarket(market: MarketTrades): void {
  const { conditionId, trades, yesBuys, noBuys, yesSells, noSells } = market;

  // Sort by timestamp
  trades.sort((a, b) => a.timestamp - b.timestamp);
  yesBuys.sort((a, b) => a.timestamp - b.timestamp);
  noBuys.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`MARKET: ${conditionId.slice(0, 20)}...`);
  console.log(`Question: ${market.question || 'Unknown'}`);
  console.log(`${'='.repeat(80)}`);

  console.log(`\nTrade Summary:`);
  console.log(`  Yes Buys:  ${yesBuys.length} trades, ${yesBuys.reduce((s, t) => s + t.size, 0).toFixed(2)} shares`);
  console.log(`  No Buys:   ${noBuys.length} trades, ${noBuys.reduce((s, t) => s + t.size, 0).toFixed(2)} shares`);
  console.log(`  Yes Sells: ${yesSells.length} trades, ${yesSells.reduce((s, t) => s + t.size, 0).toFixed(2)} shares`);
  console.log(`  No Sells:  ${noSells.length} trades, ${noSells.reduce((s, t) => s + t.size, 0).toFixed(2)} shares`);

  // Analyze timing between Yes and No buys
  if (yesBuys.length > 0 && noBuys.length > 0) {
    console.log(`\nTiming Analysis:`);

    // Calculate average prices
    const avgYesPrice = yesBuys.reduce((s, t) => s + t.price * t.size, 0) /
                        yesBuys.reduce((s, t) => s + t.size, 0);
    const avgNoPrice = noBuys.reduce((s, t) => s + t.price * t.size, 0) /
                       noBuys.reduce((s, t) => s + t.size, 0);
    const combinedPrice = avgYesPrice + avgNoPrice;

    console.log(`  Avg Yes Price: $${avgYesPrice.toFixed(4)}`);
    console.log(`  Avg No Price:  $${avgNoPrice.toFixed(4)}`);
    console.log(`  Combined:      $${combinedPrice.toFixed(4)} (profit: ${((1 - combinedPrice) * 100).toFixed(2)}%)`);

    // Time between first Yes buy and first No buy
    const firstYes = yesBuys[0];
    const firstNo = noBuys[0];
    const timeDiffMs = Math.abs(firstYes.timestamp - firstNo.timestamp);
    const timeDiffSec = timeDiffMs / 1000;

    console.log(`\n  First Yes: ${new Date(firstYes.timestamp).toISOString()} @ $${firstYes.price.toFixed(4)}`);
    console.log(`  First No:  ${new Date(firstNo.timestamp).toISOString()} @ $${firstNo.price.toFixed(4)}`);
    console.log(`  Time Gap:  ${timeDiffSec.toFixed(1)}s (${(timeDiffMs / 60000).toFixed(2)} min)`);
    console.log(`  Sequence:  ${firstYes.timestamp < firstNo.timestamp ? 'YES first' : 'NO first'}`);
  }

  // Show trade timeline
  console.log(`\nTrade Timeline:`);
  for (const trade of trades.slice(0, 20)) {
    const time = new Date(trade.timestamp).toISOString().slice(11, 19);
    const outcome = trade.outcome.padEnd(6);
    const side = trade.side.padEnd(4);
    console.log(`  ${time} | ${outcome} | ${side} | ${trade.size.toFixed(2).padStart(8)} @ $${trade.price.toFixed(4)}`);
  }
  if (trades.length > 20) {
    console.log(`  ... and ${trades.length - 20} more trades`);
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           POLYMARKET WALLET ANALYZER                       ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_WALLET.slice(0, 20)}...                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Fetch trades
  console.log('Fetching trade history...');
  const trades = await fetchTrades(TARGET_WALLET, 2000);
  console.log(`Found ${trades.length} trades`);

  if (trades.length === 0) {
    console.log('No trades found');
    return;
  }

  // Group by market
  const markets = groupByMarket(trades);
  console.log(`Across ${markets.size} markets`);

  // Overall statistics
  const totalYesBuys = trades.filter(t => t.side === 'BUY' &&
    (t.outcome.toLowerCase().includes('yes') || t.outcome.toLowerCase().includes('up'))).length;
  const totalNoBuys = trades.filter(t => t.side === 'BUY' &&
    (t.outcome.toLowerCase().includes('no') || t.outcome.toLowerCase().includes('down'))).length;

  console.log(`\nOverall Stats:`);
  console.log(`  Total Yes Buys: ${totalYesBuys}`);
  console.log(`  Total No Buys:  ${totalNoBuys}`);
  console.log(`  Total Sells:    ${trades.filter(t => t.side === 'SELL').length}`);

  // Analyze each market (most recent first)
  const sortedMarkets = Array.from(markets.values())
    .sort((a, b) => {
      const latestA = Math.max(...a.trades.map(t => t.timestamp));
      const latestB = Math.max(...b.trades.map(t => t.timestamp));
      return latestB - latestA;
    });

  // Get market info for recent markets
  console.log('\nFetching market info...');
  for (const market of sortedMarkets.slice(0, 10)) {
    const info = await getMarketInfo(market.conditionId);
    if (info) {
      market.question = info.question || info.description;
    }
  }

  // Analyze top 10 most recent markets
  for (const market of sortedMarkets.slice(0, 10)) {
    analyzeMarket(market);
  }

  // Summary: Combined prices across all markets
  console.log(`\n${'='.repeat(80)}`);
  console.log('COMBINED PRICE ANALYSIS (All Markets with Yes+No buys)');
  console.log(`${'='.repeat(80)}`);

  const combinedPrices: number[] = [];
  const timeGaps: number[] = [];

  for (const market of sortedMarkets) {
    if (market.yesBuys.length > 0 && market.noBuys.length > 0) {
      const avgYes = market.yesBuys.reduce((s, t) => s + t.price * t.size, 0) /
                     market.yesBuys.reduce((s, t) => s + t.size, 0);
      const avgNo = market.noBuys.reduce((s, t) => s + t.price * t.size, 0) /
                    market.noBuys.reduce((s, t) => s + t.size, 0);
      combinedPrices.push(avgYes + avgNo);

      const firstYes = market.yesBuys.sort((a, b) => a.timestamp - b.timestamp)[0];
      const firstNo = market.noBuys.sort((a, b) => a.timestamp - b.timestamp)[0];
      timeGaps.push(Math.abs(firstYes.timestamp - firstNo.timestamp) / 1000);
    }
  }

  if (combinedPrices.length > 0) {
    const avgCombined = combinedPrices.reduce((a, b) => a + b, 0) / combinedPrices.length;
    const minCombined = Math.min(...combinedPrices);
    const maxCombined = Math.max(...combinedPrices);

    console.log(`\nCombined Price (Yes + No):`);
    console.log(`  Average: $${avgCombined.toFixed(4)} (profit: ${((1 - avgCombined) * 100).toFixed(2)}%)`);
    console.log(`  Min:     $${minCombined.toFixed(4)} (profit: ${((1 - minCombined) * 100).toFixed(2)}%)`);
    console.log(`  Max:     $${maxCombined.toFixed(4)} (profit: ${((1 - maxCombined) * 100).toFixed(2)}%)`);

    const avgGap = timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length;
    const minGap = Math.min(...timeGaps);
    const maxGap = Math.max(...timeGaps);

    console.log(`\nTime Between Yes/No Buys:`);
    console.log(`  Average: ${avgGap.toFixed(1)}s`);
    console.log(`  Min:     ${minGap.toFixed(1)}s`);
    console.log(`  Max:     ${maxGap.toFixed(1)}s`);
  }
}

main().catch(console.error);
