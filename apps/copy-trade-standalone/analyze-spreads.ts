/**
 * SPREAD ANALYSIS
 *
 * Analyzes if the wallet is consistently getting combined prices < $1
 *
 * USAGE: npx tsx analyze-spreads.ts
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

interface MarketAnalysis {
  conditionId: string;
  question?: string;
  upTrades: Trade[];
  downTrades: Trade[];
  totalUpShares: number;
  totalDownShares: number;
  avgUpPrice: number;
  avgDownPrice: number;
  combinedPrice: number;
  profit: number; // per share if held to resolution
  profitPercent: number;
  minShares: number; // hedged shares (min of up/down)
  totalProfitUSD: number; // minShares * profit
  timeSpanMs: number;
  firstTradeTime: number;
  lastTradeTime: number;
}

async function fetchTrades(): Promise<Trade[]> {
  const allTrades: Trade[] = [];
  let offset = 0;
  const limit = 500;

  console.log('Fetching all trades (paginating)...');

  while (true) {
    const url = `${DATA_API_HOST}/trades?user=${TARGET_WALLET.toLowerCase()}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const trades = data.map((t: any) => ({
      timestamp: typeof t.timestamp === 'number'
        ? (t.timestamp < 4102444800 ? t.timestamp * 1000 : t.timestamp)
        : parseInt(t.timestamp) * 1000,
      conditionId: t.conditionId,
      outcome: t.outcome || 'Unknown',
      side: t.side as 'BUY' | 'SELL',
      price: parseFloat(t.price || '0'),
      size: parseFloat(t.size || '0'),
    }));

    allTrades.push(...trades);
    console.log(`  Fetched ${allTrades.length} trades...`);

    if (data.length < limit) break; // No more data
    offset += limit;

    // Rate limit
    await new Promise(r => setTimeout(r, 200));

    // Safety limit - 10000 trades max
    if (allTrades.length >= 10000) break;
  }

  return allTrades;
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

function analyzeMarkets(trades: Trade[]): MarketAnalysis[] {
  // Group by conditionId
  const markets = new Map<string, Trade[]>();
  for (const trade of trades) {
    if (!markets.has(trade.conditionId)) {
      markets.set(trade.conditionId, []);
    }
    markets.get(trade.conditionId)!.push(trade);
  }

  const results: MarketAnalysis[] = [];

  for (const [conditionId, marketTrades] of markets) {
    const upTrades = marketTrades.filter(t =>
      t.side === 'BUY' &&
      (t.outcome.toLowerCase().includes('up') || t.outcome.toLowerCase().includes('yes'))
    );
    const downTrades = marketTrades.filter(t =>
      t.side === 'BUY' &&
      (t.outcome.toLowerCase().includes('down') || t.outcome.toLowerCase().includes('no'))
    );

    if (upTrades.length === 0 || downTrades.length === 0) continue;

    const totalUpShares = upTrades.reduce((s, t) => s + t.size, 0);
    const totalDownShares = downTrades.reduce((s, t) => s + t.size, 0);

    // Volume-weighted average prices
    const avgUpPrice = upTrades.reduce((s, t) => s + t.price * t.size, 0) / totalUpShares;
    const avgDownPrice = downTrades.reduce((s, t) => s + t.price * t.size, 0) / totalDownShares;

    const combinedPrice = avgUpPrice + avgDownPrice;
    const profit = 1 - combinedPrice; // profit per hedged share pair
    const profitPercent = (profit / combinedPrice) * 100;

    const minShares = Math.min(totalUpShares, totalDownShares);
    const totalProfitUSD = minShares * profit;

    const allTimestamps = marketTrades.map(t => t.timestamp);
    const firstTradeTime = Math.min(...allTimestamps);
    const lastTradeTime = Math.max(...allTimestamps);

    results.push({
      conditionId,
      upTrades,
      downTrades,
      totalUpShares,
      totalDownShares,
      avgUpPrice,
      avgDownPrice,
      combinedPrice,
      profit,
      profitPercent,
      minShares,
      totalProfitUSD,
      timeSpanMs: lastTradeTime - firstTradeTime,
      firstTradeTime,
      lastTradeTime,
    });
  }

  return results.sort((a, b) => b.firstTradeTime - a.firstTradeTime);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           SPREAD ANALYSIS                                  ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_WALLET.slice(0, 20)}...                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const trades = await fetchTrades();
  console.log(`\nTotal trades fetched: ${trades.length}`);

  // Show time range
  const timestamps = trades.map(t => t.timestamp);
  const earliest = new Date(Math.min(...timestamps));
  const latest = new Date(Math.max(...timestamps));
  const hoursCovered = (latest.getTime() - earliest.getTime()) / (1000 * 60 * 60);
  console.log(`Time range: ${earliest.toISOString()} to ${latest.toISOString()}`);
  console.log(`Hours covered: ${hoursCovered.toFixed(1)}\n`);

  const markets = analyzeMarkets(trades);
  console.log(`Analyzed ${markets.length} markets with both Up and Down buys\n`);

  // Fetch market info for display
  console.log('Fetching market info...');
  for (const market of markets.slice(0, 20)) {
    const info = await getMarketInfo(market.conditionId);
    if (info) {
      market.question = info.question?.slice(0, 50) || info.description?.slice(0, 50);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // ========================================================================
  // DETAILED MARKET BREAKDOWN
  // ========================================================================

  console.log('\n' + '='.repeat(100));
  console.log('MARKET-BY-MARKET SPREAD ANALYSIS');
  console.log('='.repeat(100));

  let totalProfit = 0;
  let totalHedgedShares = 0;
  let profitableMarkets = 0;
  let unprofitableMarkets = 0;

  for (const m of markets) {
    const profitIcon = m.profit >= 0 ? '✅' : '❌';
    const timeSpan = (m.timeSpanMs / 1000).toFixed(0);
    const time = new Date(m.firstTradeTime).toISOString().slice(11, 19);

    console.log(`\n${profitIcon} ${m.question || m.conditionId.slice(0, 30)}`);
    console.log(`   Time: ${time} | Span: ${timeSpan}s`);
    console.log(`   Up:   ${m.totalUpShares.toFixed(1)} shares @ $${m.avgUpPrice.toFixed(4)}`);
    console.log(`   Down: ${m.totalDownShares.toFixed(1)} shares @ $${m.avgDownPrice.toFixed(4)}`);
    console.log(`   Combined: $${m.combinedPrice.toFixed(4)} | Profit: ${m.profit >= 0 ? '+' : ''}$${m.profit.toFixed(4)}/share (${m.profitPercent >= 0 ? '+' : ''}${m.profitPercent.toFixed(2)}%)`);
    console.log(`   Hedged: ${m.minShares.toFixed(1)} shares | Total P&L: ${m.totalProfitUSD >= 0 ? '+' : ''}$${m.totalProfitUSD.toFixed(2)}`);

    totalProfit += m.totalProfitUSD;
    totalHedgedShares += m.minShares;
    if (m.profit >= 0) profitableMarkets++;
    else unprofitableMarkets++;
  }

  // ========================================================================
  // SUMMARY
  // ========================================================================

  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));

  console.log(`\nMarkets analyzed: ${markets.length}`);
  console.log(`  Profitable (combined < $1): ${profitableMarkets}`);
  console.log(`  Unprofitable (combined > $1): ${unprofitableMarkets}`);
  console.log(`  Win rate: ${(profitableMarkets / markets.length * 100).toFixed(1)}%`);

  console.log(`\nTotal hedged shares: ${totalHedgedShares.toFixed(1)}`);
  console.log(`Total P&L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`);

  const avgCombined = markets.reduce((s, m) => s + m.combinedPrice, 0) / markets.length;
  const avgProfit = markets.reduce((s, m) => s + m.profit, 0) / markets.length;

  console.log(`\nAverage combined price: $${avgCombined.toFixed(4)}`);
  console.log(`Average profit/share: ${avgProfit >= 0 ? '+' : ''}$${avgProfit.toFixed(4)} (${(avgProfit * 100).toFixed(2)} cents)`);

  // Distribution
  console.log('\n' + '─'.repeat(50));
  console.log('COMBINED PRICE DISTRIBUTION');
  console.log('─'.repeat(50));

  const under95 = markets.filter(m => m.combinedPrice < 0.95).length;
  const under98 = markets.filter(m => m.combinedPrice >= 0.95 && m.combinedPrice < 0.98).length;
  const under100 = markets.filter(m => m.combinedPrice >= 0.98 && m.combinedPrice < 1.00).length;
  const at100 = markets.filter(m => m.combinedPrice >= 1.00 && m.combinedPrice < 1.02).length;
  const over102 = markets.filter(m => m.combinedPrice >= 1.02 && m.combinedPrice < 1.05).length;
  const over105 = markets.filter(m => m.combinedPrice >= 1.05).length;

  console.log(`  < $0.95 (>5% profit):    ${under95} markets`);
  console.log(`  $0.95-$0.98 (2-5%):      ${under98} markets`);
  console.log(`  $0.98-$1.00 (0-2%):      ${under100} markets`);
  console.log(`  $1.00-$1.02 (0-2% loss): ${at100} markets`);
  console.log(`  $1.02-$1.05 (2-5% loss): ${over102} markets`);
  console.log(`  > $1.05 (>5% loss):      ${over105} markets`);

  // Time analysis
  console.log('\n' + '─'.repeat(50));
  console.log('EXECUTION TIME ANALYSIS');
  console.log('─'.repeat(50));

  const avgTimeSpan = markets.reduce((s, m) => s + m.timeSpanMs, 0) / markets.length / 1000;
  const minTimeSpan = Math.min(...markets.map(m => m.timeSpanMs)) / 1000;
  const maxTimeSpan = Math.max(...markets.map(m => m.timeSpanMs)) / 1000;

  console.log(`  Average time to complete both legs: ${avgTimeSpan.toFixed(1)}s`);
  console.log(`  Fastest: ${minTimeSpan.toFixed(1)}s`);
  console.log(`  Slowest: ${maxTimeSpan.toFixed(1)}s`);

  // Correlation: faster execution = better prices?
  const fastMarkets = markets.filter(m => m.timeSpanMs < avgTimeSpan * 1000);
  const slowMarkets = markets.filter(m => m.timeSpanMs >= avgTimeSpan * 1000);

  const fastAvgCombined = fastMarkets.reduce((s, m) => s + m.combinedPrice, 0) / fastMarkets.length;
  const slowAvgCombined = slowMarkets.reduce((s, m) => s + m.combinedPrice, 0) / slowMarkets.length;

  console.log(`\n  Fast execution (<${avgTimeSpan.toFixed(0)}s) avg combined: $${fastAvgCombined.toFixed(4)}`);
  console.log(`  Slow execution (>${avgTimeSpan.toFixed(0)}s) avg combined: $${slowAvgCombined.toFixed(4)}`);

  if (fastAvgCombined < slowAvgCombined) {
    console.log(`\n  ⚡ INSIGHT: Faster execution = better prices (${((slowAvgCombined - fastAvgCombined) * 100).toFixed(2)} cents difference)`);
  }
}

main().catch(console.error);
