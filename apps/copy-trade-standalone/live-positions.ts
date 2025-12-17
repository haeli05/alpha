/**
 * LIVE POSITION TRACKER
 *
 * Shows target wallet's real-time positions in BTC/ETH Up/Down markets
 * with combined price analysis and profit calculations.
 *
 * USAGE: npx tsx live-positions.ts
 */

const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';

interface Trade {
  timestamp: number;
  conditionId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

interface MarketPosition {
  conditionId: string;
  question: string;
  endDate?: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  avgUpPrice: number;
  avgDownPrice: number;
  combinedPrice: number;
  hedgedShares: number;
  expectedProfit: number;
  profitPct: number;
  recentTrades: Trade[];
}

async function fetchTrades(limit = 200): Promise<Trade[]> {
  const url = `${DATA_API_HOST}/trades?user=${TARGET_WALLET.toLowerCase()}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);

  const data = await res.json();
  return data.map((t: any) => ({
    timestamp: typeof t.timestamp === 'number'
      ? (t.timestamp < 4102444800 ? t.timestamp * 1000 : t.timestamp)
      : parseInt(t.timestamp) * 1000,
    conditionId: t.conditionId,
    outcome: t.outcome || 'Unknown',
    side: t.side as 'BUY' | 'SELL',
    price: parseFloat(t.price || '0'),
    size: parseFloat(t.size || '0'),
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

function analyzePositions(trades: Trade[]): Map<string, { up: Trade[], down: Trade[] }> {
  const markets = new Map<string, { up: Trade[], down: Trade[] }>();

  for (const trade of trades) {
    if (trade.side !== 'BUY') continue; // Only count buys for now

    const isUp = trade.outcome.toLowerCase() === 'up' || trade.outcome.toLowerCase() === 'yes';
    const isDown = trade.outcome.toLowerCase() === 'down' || trade.outcome.toLowerCase() === 'no';
    if (!isUp && !isDown) continue;

    if (!markets.has(trade.conditionId)) {
      markets.set(trade.conditionId, { up: [], down: [] });
    }

    const market = markets.get(trade.conditionId)!;
    if (isUp) market.up.push(trade);
    else market.down.push(trade);
  }

  return markets;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    LIVE POSITION TRACKER                                       ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_WALLET}       ║`);
  console.log(`║  Time:   ${new Date().toISOString()}                            ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const trades = await fetchTrades(200);
  console.log(`Loaded ${trades.length} recent trades\n`);

  const marketTrades = analyzePositions(trades);
  const positions: MarketPosition[] = [];

  // Build position info for each market
  for (const [conditionId, { up, down }] of marketTrades) {
    const marketInfo = await getMarketInfo(conditionId);
    if (!marketInfo?.question?.includes('Up or Down')) continue;

    const upShares = up.reduce((s, t) => s + t.size, 0);
    const downShares = down.reduce((s, t) => s + t.size, 0);
    const upCost = up.reduce((s, t) => s + t.size * t.price, 0);
    const downCost = down.reduce((s, t) => s + t.size * t.price, 0);
    const avgUpPrice = upShares > 0 ? upCost / upShares : 0;
    const avgDownPrice = downShares > 0 ? downCost / downShares : 0;
    const combinedPrice = avgUpPrice + avgDownPrice;
    const hedgedShares = Math.min(upShares, downShares);
    const expectedProfit = hedgedShares * (1 - combinedPrice);
    const profitPct = combinedPrice > 0 ? ((1 - combinedPrice) / combinedPrice) * 100 : 0;

    const allTrades = [...up, ...down].sort((a, b) => b.timestamp - a.timestamp);

    positions.push({
      conditionId,
      question: marketInfo.question,
      endDate: marketInfo.end_date_iso,
      upShares,
      downShares,
      upCost,
      downCost,
      avgUpPrice,
      avgDownPrice,
      combinedPrice,
      hedgedShares,
      expectedProfit,
      profitPct,
      recentTrades: allTrades.slice(0, 5),
    });

    await new Promise(r => setTimeout(r, 100));
  }

  // Sort by most recent activity
  positions.sort((a, b) => {
    const aLast = a.recentTrades[0]?.timestamp || 0;
    const bLast = b.recentTrades[0]?.timestamp || 0;
    return bLast - aLast;
  });

  // Display positions
  let totalProfit = 0;
  let totalHedged = 0;

  for (const pos of positions) {
    const profitIcon = pos.expectedProfit > 0 ? '🟢' : pos.expectedProfit < 0 ? '🔴' : '⚪';
    const now = Date.now();
    const end = pos.endDate ? new Date(pos.endDate).getTime() : now;
    const minsLeft = Math.max(0, (end - now) / 60000);
    const timeStr = minsLeft > 0 ? `${minsLeft.toFixed(0)} min left` : 'ENDED';

    console.log('═'.repeat(80));
    console.log(`${profitIcon} ${pos.question}`);
    console.log(`   Status: ${timeStr}`);
    console.log('');
    console.log('   POSITION BREAKDOWN:');
    console.log('   ┌──────────────┬────────────┬────────────┬────────────┐');
    console.log('   │ Side         │ Shares     │ Avg Price  │ Cost       │');
    console.log('   ├──────────────┼────────────┼────────────┼────────────┤');
    console.log(`   │ Up (Yes)     │ ${pos.upShares.toFixed(2).padStart(10)} │ $${pos.avgUpPrice.toFixed(4).padStart(8)} │ $${pos.upCost.toFixed(2).padStart(8)} │`);
    console.log(`   │ Down (No)    │ ${pos.downShares.toFixed(2).padStart(10)} │ $${pos.avgDownPrice.toFixed(4).padStart(8)} │ $${pos.downCost.toFixed(2).padStart(8)} │`);
    console.log('   └──────────────┴────────────┴────────────┴────────────┘');
    console.log('');
    console.log(`   ARBITRAGE ANALYSIS:`);
    console.log(`   • Combined Price: $${pos.combinedPrice.toFixed(4)}`);
    console.log(`   • Hedged Shares:  ${pos.hedgedShares.toFixed(2)} (${((pos.hedgedShares / Math.max(pos.upShares, pos.downShares)) * 100).toFixed(0)}% hedged)`);
    console.log(`   • Expected P&L:   $${pos.expectedProfit.toFixed(2)} (${pos.profitPct.toFixed(2)}%)`);
    console.log('');
    console.log('   RECENT TRADES:');
    for (const t of pos.recentTrades) {
      const time = new Date(t.timestamp).toISOString().slice(11, 19);
      console.log(`     ${time} | ${t.side.padEnd(4)} ${t.outcome.padEnd(4)} | ${t.size.toFixed(2).padStart(8)} @ $${t.price.toFixed(4)}`);
    }
    console.log('');

    totalProfit += pos.expectedProfit;
    totalHedged += pos.hedgedShares;
  }

  console.log('═'.repeat(80));
  console.log('');
  console.log('SUMMARY:');
  console.log(`  Markets Traded: ${positions.length}`);
  console.log(`  Total Hedged:   ${totalHedged.toFixed(2)} shares`);
  console.log(`  Total Expected: $${totalProfit.toFixed(2)}`);
  console.log('');

  // Profitability breakdown
  const profitable = positions.filter(p => p.expectedProfit > 0);
  const unprofitable = positions.filter(p => p.expectedProfit <= 0);

  console.log('PROFITABILITY:');
  console.log(`  Profitable markets: ${profitable.length} (+$${profitable.reduce((s, p) => s + p.expectedProfit, 0).toFixed(2)})`);
  console.log(`  Unprofitable:       ${unprofitable.length} ($${unprofitable.reduce((s, p) => s + p.expectedProfit, 0).toFixed(2)})`);
  console.log('');

  // Combined price distribution
  console.log('COMBINED PRICE DISTRIBUTION:');
  const under95 = positions.filter(p => p.combinedPrice < 0.95).length;
  const under98 = positions.filter(p => p.combinedPrice >= 0.95 && p.combinedPrice < 0.98).length;
  const under100 = positions.filter(p => p.combinedPrice >= 0.98 && p.combinedPrice < 1.00).length;
  const over100 = positions.filter(p => p.combinedPrice >= 1.00).length;

  console.log(`  < $0.95 (5%+ profit):   ${under95}`);
  console.log(`  $0.95-$0.98 (2-5%):     ${under98}`);
  console.log(`  $0.98-$1.00 (0-2%):     ${under100}`);
  console.log(`  >= $1.00 (loss):        ${over100}`);
}

main().catch(console.error);
