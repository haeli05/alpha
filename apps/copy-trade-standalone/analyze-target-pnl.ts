/**
 * TARGET WALLET P&L ANALYZER
 *
 * Analyzes copy-trade target's exact strategy by:
 * 1. Fetching all their trades with token IDs
 * 2. Mapping tokens to specific markets
 * 3. Tracking positions and calculating P&L per market
 * 4. Identifying their entry/exit patterns
 */

import * as dotenv from 'dotenv';
dotenv.config();

const TARGET_ADDRESS = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

// ============================================================================
// MARKET TOKEN MAPPING
// ============================================================================

interface MarketInfo {
  slug: string;
  asset: string;
  duration: string;
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
}

const marketsByToken: Map<string, MarketInfo> = new Map();
const marketsByCondition: Map<string, MarketInfo> = new Map();

async function loadAllMarkets(): Promise<void> {
  const slugs = [
    'btc-up-or-down-15m', 'eth-up-or-down-15m', 'sol-up-or-down-15m', 'xrp-up-or-down-15m',
    'btc-up-or-down-1hr', 'eth-up-or-down-1hr', 'sol-up-or-down-1hr', 'xrp-up-or-down-1hr',
  ];

  console.log('Loading market token mappings...');

  for (const slug of slugs) {
    try {
      // Get current and recent markets for this series
      const res = await fetch(`${GAMMA_HOST}/markets?slug=${slug}&limit=10`);
      if (!res.ok) continue;

      const markets = await res.json();

      for (const m of markets) {
        const tokens = JSON.parse(m.clobTokenIds || '[]');
        if (tokens.length < 2) continue;

        const info: MarketInfo = {
          slug,
          asset: slug.split('-')[0].toUpperCase(),
          duration: slug.includes('15m') ? '15m' : '1hr',
          upTokenId: tokens[0],
          downTokenId: tokens[1],
          conditionId: m.conditionId,
        };

        marketsByToken.set(tokens[0], info);
        marketsByToken.set(tokens[1], info);
        marketsByCondition.set(m.conditionId, info);
      }
    } catch (e) {
      // Continue
    }
  }

  console.log(`Loaded ${marketsByToken.size / 2} market instances`);
}

// ============================================================================
// TRADE FETCHING
// ============================================================================

interface Trade {
  id: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  outcome: string;
  price: number;
  size: number;
  tokenId?: string;
  conditionId?: string;
  market?: MarketInfo;
}

async function fetchTargetTrades(limit: number = 500): Promise<Trade[]> {
  console.log(`\nFetching ${limit} trades for target...`);

  const trades: Trade[] = [];

  try {
    // Try the trades endpoint with maker filter
    const res = await fetch(`${DATA_API}/trades?maker=${TARGET_ADDRESS}&limit=${limit}`);
    if (!res.ok) {
      console.log('Data API failed, trying CLOB API...');
      return trades;
    }

    const data = await res.json();
    console.log(`Got ${data.length} trades from API`);

    for (const t of data) {
      const trade: Trade = {
        id: t.id || `${t.timestamp}-${t.price}-${t.size}`,
        timestamp: t.timestamp,
        side: t.side,
        outcome: t.outcome,
        price: parseFloat(t.price),
        size: parseFloat(t.size),
        tokenId: t.asset_id || t.token_id,
        conditionId: t.condition_id,
      };

      // Try to match to a market
      if (trade.tokenId && marketsByToken.has(trade.tokenId)) {
        trade.market = marketsByToken.get(trade.tokenId);
      } else if (trade.conditionId && marketsByCondition.has(trade.conditionId)) {
        trade.market = marketsByCondition.get(trade.conditionId);
      }

      trades.push(trade);
    }
  } catch (e) {
    console.log('Error fetching trades:', e);
  }

  return trades;
}

// ============================================================================
// POSITION TRACKING & P&L CALCULATION
// ============================================================================

interface Position {
  market: string;
  outcome: string;
  shares: number;
  avgCost: number;
  totalCost: number;
  realizedPnL: number;
  trades: Trade[];
}

function analyzePositions(trades: Trade[]): Map<string, Position> {
  const positions: Map<string, Position> = new Map();

  // Process trades in chronological order
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  for (const trade of sortedTrades) {
    // Skip non Up/Down trades
    if (trade.outcome !== 'Up' && trade.outcome !== 'Down') continue;

    const marketKey = trade.market
      ? `${trade.market.asset}-${trade.market.duration}`
      : 'UNKNOWN';
    const posKey = `${marketKey}-${trade.outcome}`;

    let pos = positions.get(posKey);
    if (!pos) {
      pos = {
        market: marketKey,
        outcome: trade.outcome,
        shares: 0,
        avgCost: 0,
        totalCost: 0,
        realizedPnL: 0,
        trades: [],
      };
      positions.set(posKey, pos);
    }

    pos.trades.push(trade);

    if (trade.side === 'BUY') {
      // Add to position
      const newTotalCost = pos.totalCost + (trade.price * trade.size);
      const newShares = pos.shares + trade.size;
      pos.avgCost = newShares > 0 ? newTotalCost / newShares : 0;
      pos.shares = newShares;
      pos.totalCost = newTotalCost;
    } else {
      // SELL - realize P&L
      const sellValue = trade.price * trade.size;
      const costBasis = pos.avgCost * trade.size;
      const pnl = sellValue - costBasis;

      pos.realizedPnL += pnl;
      pos.shares -= trade.size;
      pos.totalCost = pos.avgCost * pos.shares;

      if (pos.shares < 0) pos.shares = 0;
    }
  }

  return positions;
}

// ============================================================================
// PAIR ANALYSIS
// ============================================================================

interface PairTrade {
  timestamp: number;
  market: string;
  upPrice: number;
  downPrice: number;
  combined: number;
  profit: number;
  size: number;
}

function analyzePairs(trades: Trade[]): PairTrade[] {
  const pairs: PairTrade[] = [];

  // Group trades by timestamp (same second = likely paired)
  const byTimestamp: Map<number, Trade[]> = new Map();

  for (const trade of trades) {
    if (trade.outcome !== 'Up' && trade.outcome !== 'Down') continue;
    if (trade.side !== 'BUY') continue;

    const ts = trade.timestamp;
    if (!byTimestamp.has(ts)) {
      byTimestamp.set(ts, []);
    }
    byTimestamp.get(ts)!.push(trade);
  }

  // Find Up+Down pairs at same timestamp
  for (const [ts, groupTrades] of byTimestamp) {
    const ups = groupTrades.filter(t => t.outcome === 'Up');
    const downs = groupTrades.filter(t => t.outcome === 'Down');

    // Try to match by market
    for (const up of ups) {
      for (const down of downs) {
        // Check if same market (or unknown)
        const upMarket = up.market ? `${up.market.asset}-${up.market.duration}` : 'UNK';
        const downMarket = down.market ? `${down.market.asset}-${down.market.duration}` : 'UNK';

        if (upMarket === downMarket || upMarket === 'UNK' || downMarket === 'UNK') {
          const combined = up.price + down.price;
          const size = Math.min(up.size, down.size);
          const profit = (1 - combined) * size;

          pairs.push({
            timestamp: ts,
            market: upMarket !== 'UNK' ? upMarket : downMarket,
            upPrice: up.price,
            downPrice: down.price,
            combined,
            profit,
            size,
          });
        }
      }
    }
  }

  return pairs;
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           TARGET WALLET P&L ANALYZER                                           ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_ADDRESS}                                   ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load market mappings
  await loadAllMarkets();

  // Fetch trades
  const trades = await fetchTargetTrades(1000);

  if (trades.length === 0) {
    console.log('No trades found');
    return;
  }

  // Filter to Up/Down only
  const upDownTrades = trades.filter(t => t.outcome === 'Up' || t.outcome === 'Down');
  console.log(`\nUp/Down trades: ${upDownTrades.length}`);

  // ========== TRADE BREAKDOWN ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TRADE BREAKDOWN');
  console.log('═══════════════════════════════════════════════════════════════════');

  const buys = upDownTrades.filter(t => t.side === 'BUY');
  const sells = upDownTrades.filter(t => t.side === 'SELL');

  console.log(`BUY trades: ${buys.length}`);
  console.log(`SELL trades: ${sells.length}`);

  const buyUp = buys.filter(t => t.outcome === 'Up');
  const buyDown = buys.filter(t => t.outcome === 'Down');
  const sellUp = sells.filter(t => t.outcome === 'Up');
  const sellDown = sells.filter(t => t.outcome === 'Down');

  console.log(`\n  BUY Up: ${buyUp.length} trades`);
  console.log(`  BUY Down: ${buyDown.length} trades`);
  console.log(`  SELL Up: ${sellUp.length} trades`);
  console.log(`  SELL Down: ${sellDown.length} trades`);

  // ========== PRICE ANALYSIS ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('PRICE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════');

  const avgBuyUp = buyUp.length > 0 ? buyUp.reduce((s, t) => s + t.price, 0) / buyUp.length : 0;
  const avgBuyDown = buyDown.length > 0 ? buyDown.reduce((s, t) => s + t.price, 0) / buyDown.length : 0;
  const avgSellUp = sellUp.length > 0 ? sellUp.reduce((s, t) => s + t.price, 0) / sellUp.length : 0;
  const avgSellDown = sellDown.length > 0 ? sellDown.reduce((s, t) => s + t.price, 0) / sellDown.length : 0;

  console.log(`\nAverage prices:`);
  console.log(`  BUY Up:    $${avgBuyUp.toFixed(3)}`);
  console.log(`  BUY Down:  $${avgBuyDown.toFixed(3)}`);
  console.log(`  SELL Up:   $${avgSellUp.toFixed(3)}`);
  console.log(`  SELL Down: $${avgSellDown.toFixed(3)}`);

  console.log(`\nAvg combined BUY: $${(avgBuyUp + avgBuyDown).toFixed(3)}`);

  if (avgSellUp > 0 && avgSellDown > 0) {
    console.log(`Avg combined SELL: $${(avgSellUp + avgSellDown).toFixed(3)}`);
  }

  // ========== PAIR ANALYSIS ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('PAIR ANALYSIS (Same-second Up+Down buys)');
  console.log('═══════════════════════════════════════════════════════════════════');

  const pairs = analyzePairs(trades);
  console.log(`\nFound ${pairs.length} potential pairs`);

  if (pairs.length > 0) {
    const profitablePairs = pairs.filter(p => p.combined < 1.0);
    const unprofitablePairs = pairs.filter(p => p.combined >= 1.0);

    console.log(`  Profitable (combined < $1.00): ${profitablePairs.length}`);
    console.log(`  Unprofitable (combined >= $1.00): ${unprofitablePairs.length}`);

    if (profitablePairs.length > 0) {
      const totalPairProfit = profitablePairs.reduce((s, p) => s + p.profit, 0);
      const avgCombined = profitablePairs.reduce((s, p) => s + p.combined, 0) / profitablePairs.length;
      console.log(`\n  Avg profitable combined: $${avgCombined.toFixed(3)}`);
      console.log(`  Total pair profit: $${totalPairProfit.toFixed(2)}`);
    }

    // Show sample pairs
    console.log('\nSample pairs (last 10):');
    const recentPairs = pairs.slice(-10);
    for (const p of recentPairs) {
      const time = new Date(p.timestamp * 1000).toISOString().slice(11, 19);
      const profitStr = p.profit >= 0 ? `+$${p.profit.toFixed(2)}` : `-$${Math.abs(p.profit).toFixed(2)}`;
      console.log(`  ${time} | ${p.market.padEnd(10)} | Up $${p.upPrice.toFixed(2)} + Down $${p.downPrice.toFixed(2)} = $${p.combined.toFixed(2)} | ${profitStr}`);
    }
  }

  // ========== SELL PATTERN ANALYSIS ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('SELL PATTERN ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Check if sells are at resolution prices ($0.99+)
  const resolutionSells = sells.filter(t => t.price >= 0.95);
  const normalSells = sells.filter(t => t.price < 0.95);

  console.log(`\nSells at resolution price (>=95¢): ${resolutionSells.length}`);
  console.log(`Sells at normal price (<95¢): ${normalSells.length}`);

  if (resolutionSells.length > 0) {
    const avgResPrice = resolutionSells.reduce((s, t) => s + t.price, 0) / resolutionSells.length;
    const totalResValue = resolutionSells.reduce((s, t) => s + t.price * t.size, 0);
    console.log(`  Avg resolution sell price: $${avgResPrice.toFixed(3)}`);
    console.log(`  Total resolution value: $${totalResValue.toFixed(2)}`);
  }

  // ========== VOLUME ANALYSIS ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('VOLUME ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════');

  const totalBuyVolume = buys.reduce((s, t) => s + t.price * t.size, 0);
  const totalSellVolume = sells.reduce((s, t) => s + t.price * t.size, 0);
  const totalBuyShares = buys.reduce((s, t) => s + t.size, 0);
  const totalSellShares = sells.reduce((s, t) => s + t.size, 0);

  console.log(`\nTotal BUY volume: $${totalBuyVolume.toFixed(2)} (${totalBuyShares.toFixed(0)} shares)`);
  console.log(`Total SELL volume: $${totalSellVolume.toFixed(2)} (${totalSellShares.toFixed(0)} shares)`);
  console.log(`Net flow: $${(totalSellVolume - totalBuyVolume).toFixed(2)}`);

  // ========== TIME PATTERN ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TIME PATTERN ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Group by hour
  const byHour: Map<number, Trade[]> = new Map();
  for (const t of upDownTrades) {
    const hour = new Date(t.timestamp * 1000).getUTCHours();
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour)!.push(t);
  }

  console.log('\nTrades by hour (UTC):');
  const sortedHours = [...byHour.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [hour, hourTrades] of sortedHours.slice(0, 10)) {
    console.log(`  ${hour.toString().padStart(2, '0')}:00 - ${hourTrades.length} trades`);
  }

  // ========== STRATEGY HYPOTHESIS ==========
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('STRATEGY HYPOTHESIS');
  console.log('═══════════════════════════════════════════════════════════════════');

  const profitablePairsCount = pairs.filter(p => p.combined < 1.0).length;
  const pairRatio = pairs.length > 0 ? profitablePairsCount / pairs.length : 0;
  const resRatio = sells.length > 0 ? resolutionSells.length / sells.length : 0;

  if (pairRatio > 0.8 && avgBuyUp + avgBuyDown < 0.98) {
    console.log('\n🎯 LIKELY STRATEGY: PAIR ARBITRAGE');
    console.log('   - Buys both Up and Down simultaneously');
    console.log('   - Combined price < $1.00 for guaranteed profit');
    console.log('   - Holds to resolution for $1.00 payout');
  } else if (resRatio > 0.5) {
    console.log('\n🎯 LIKELY STRATEGY: DIRECTIONAL + RESOLUTION');
    console.log('   - Takes directional positions');
    console.log('   - Sells winning side at resolution (~$0.99)');
  } else if (avgSellUp > avgBuyUp || avgSellDown > avgBuyDown) {
    console.log('\n🎯 LIKELY STRATEGY: MARKET MAKING');
    console.log('   - Buys at bid, sells at ask');
    console.log('   - Captures bid-ask spread');
  } else {
    console.log('\n🤔 STRATEGY UNCLEAR');
    console.log('   - Need more data or different analysis');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
