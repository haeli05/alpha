/**
 * POSITION WATCHER
 *
 * Watches target wallet's active positions in the latest BTC Up/Down market.
 * Shows real-time trades, current positions, and combined price analysis.
 *
 * USAGE: npx tsx watch-positions.ts
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
  upShares: number;
  downShares: number;
  avgUpPrice: number;
  avgDownPrice: number;
  upCost: number;
  downCost: number;
  combinedPrice: number;
  profit: number;
  trades: Trade[];
  endTime?: Date;
}

// Track positions per market
const positions: Map<string, MarketPosition> = new Map();
let lastTradeTimestamp = 0;

async function getMarketInfo(conditionId: string): Promise<any> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchRecentTrades(): Promise<Trade[]> {
  try {
    const url = `${DATA_API_HOST}/trades?user=${TARGET_WALLET.toLowerCase()}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

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
  } catch {
    return [];
  }
}

async function fetchOrderBooks(conditionId: string, market: any): Promise<{ upAsk: number; downAsk: number; upBid: number; downBid: number } | null> {
  try {
    const tokens = market.tokens || [];
    const upToken = tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'yes' || t.outcome?.toLowerCase() === 'up'
    );
    const downToken = tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'no' || t.outcome?.toLowerCase() === 'down'
    );

    if (!upToken || !downToken) return null;

    const [upRes, downRes] = await Promise.all([
      fetch(`${CLOB_HOST}/book?token_id=${upToken.token_id}`),
      fetch(`${CLOB_HOST}/book?token_id=${downToken.token_id}`),
    ]);

    const upBook = await upRes.json();
    const downBook = await downRes.json();

    return {
      upAsk: upBook.asks?.[0]?.price ? parseFloat(upBook.asks[0].price) : 1,
      downAsk: downBook.asks?.[0]?.price ? parseFloat(downBook.asks[0].price) : 1,
      upBid: upBook.bids?.[0]?.price ? parseFloat(upBook.bids[0].price) : 0,
      downBid: downBook.bids?.[0]?.price ? parseFloat(downBook.bids[0].price) : 0,
    };
  } catch {
    return null;
  }
}

function processTradeIntoPosition(trade: Trade, marketInfo: any): void {
  const conditionId = trade.conditionId;

  // Only process Up/Down markets
  const isUp = trade.outcome.toLowerCase().includes('up') || trade.outcome.toLowerCase().includes('yes');
  const isDown = trade.outcome.toLowerCase().includes('down') || trade.outcome.toLowerCase().includes('no');
  if (!isUp && !isDown) return;

  let pos = positions.get(conditionId);
  if (!pos) {
    pos = {
      conditionId,
      question: marketInfo?.question || conditionId.slice(0, 20),
      upShares: 0,
      downShares: 0,
      avgUpPrice: 0,
      avgDownPrice: 0,
      upCost: 0,
      downCost: 0,
      combinedPrice: 0,
      profit: 0,
      trades: [],
      endTime: marketInfo?.end_date_iso ? new Date(marketInfo.end_date_iso) : undefined,
    };
    positions.set(conditionId, pos);
  }

  pos.trades.push(trade);

  if (trade.side === 'BUY') {
    if (isUp) {
      const totalCost = pos.upShares * pos.avgUpPrice + trade.size * trade.price;
      pos.upShares += trade.size;
      pos.avgUpPrice = pos.upShares > 0 ? totalCost / pos.upShares : 0;
      pos.upCost = pos.upShares * pos.avgUpPrice;
    } else if (isDown) {
      const totalCost = pos.downShares * pos.avgDownPrice + trade.size * trade.price;
      pos.downShares += trade.size;
      pos.avgDownPrice = pos.downShares > 0 ? totalCost / pos.downShares : 0;
      pos.downCost = pos.downShares * pos.avgDownPrice;
    }
  } else {
    // SELL
    if (isUp) {
      pos.upShares = Math.max(0, pos.upShares - trade.size);
    } else if (isDown) {
      pos.downShares = Math.max(0, pos.downShares - trade.size);
    }
  }

  // Calculate combined price and profit
  const minShares = Math.min(pos.upShares, pos.downShares);
  if (minShares > 0 && pos.upShares > 0 && pos.downShares > 0) {
    pos.combinedPrice = pos.avgUpPrice + pos.avgDownPrice;
    pos.profit = (1 - pos.combinedPrice) * minShares;
  } else {
    pos.combinedPrice = 0;
    pos.profit = 0;
  }
}

function displayPositions(): void {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    TARGET WALLET POSITION WATCHER                              ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Wallet: ${TARGET_WALLET}       ║`);
  console.log(`║  Time:   ${new Date().toISOString()}                            ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Sort by most recent activity
  const sortedPositions = Array.from(positions.values())
    .filter(p => p.upShares > 0 || p.downShares > 0)
    .sort((a, b) => {
      const aLast = a.trades.length > 0 ? a.trades[a.trades.length - 1].timestamp : 0;
      const bLast = b.trades.length > 0 ? b.trades[b.trades.length - 1].timestamp : 0;
      return bLast - aLast;
    });

  if (sortedPositions.length === 0) {
    console.log('  No active positions found.');
    return;
  }

  let totalProfit = 0;

  for (const pos of sortedPositions) {
    const minShares = Math.min(pos.upShares, pos.downShares);
    const hedgedPct = minShares > 0 ? (minShares / Math.max(pos.upShares, pos.downShares) * 100).toFixed(0) : '0';

    const profitIcon = pos.profit > 0 ? '🟢' : pos.profit < 0 ? '🔴' : '⚪';
    const timeToEnd = pos.endTime ? Math.max(0, (pos.endTime.getTime() - Date.now()) / 1000 / 60) : 0;
    const timeStr = timeToEnd > 0 ? `${timeToEnd.toFixed(0)}min` : 'ENDED';

    console.log('─'.repeat(80));
    console.log(`${profitIcon} ${pos.question.slice(0, 60)}`);
    console.log(`   Ends: ${timeStr}`);
    console.log('');
    console.log(`   Position        │ Shares     │ Avg Price  │ Cost`);
    console.log(`   ────────────────┼────────────┼────────────┼─────────────`);
    console.log(`   Up (Yes)        │ ${pos.upShares.toFixed(2).padStart(10)} │ $${pos.avgUpPrice.toFixed(4).padStart(8)} │ $${pos.upCost.toFixed(2).padStart(8)}`);
    console.log(`   Down (No)       │ ${pos.downShares.toFixed(2).padStart(10)} │ $${pos.avgDownPrice.toFixed(4).padStart(8)} │ $${pos.downCost.toFixed(2).padStart(8)}`);
    console.log('');

    if (minShares > 0) {
      console.log(`   Combined Price: $${pos.combinedPrice.toFixed(4)} | Hedged: ${minShares.toFixed(2)} shares (${hedgedPct}%)`);
      console.log(`   Expected Profit: $${pos.profit.toFixed(2)} (${((1 - pos.combinedPrice) * 100).toFixed(2)}%)`);
    } else {
      console.log(`   Not hedged (need both Up and Down)`);
    }

    // Show recent trades
    const recentTrades = pos.trades.slice(-5);
    if (recentTrades.length > 0) {
      console.log('');
      console.log(`   Recent Trades:`);
      for (const t of recentTrades) {
        const time = new Date(t.timestamp).toISOString().slice(11, 19);
        const outcome = t.outcome.padEnd(6);
        console.log(`     ${time} | ${t.side.padEnd(4)} ${outcome} | ${t.size.toFixed(2)} @ $${t.price.toFixed(4)}`);
      }
    }

    totalProfit += pos.profit;
  }

  console.log('');
  console.log('═'.repeat(80));
  console.log(`TOTAL EXPECTED PROFIT: $${totalProfit.toFixed(2)}`);
  console.log('═'.repeat(80));
}

async function pollAndUpdate(): Promise<void> {
  const trades = await fetchRecentTrades();

  // Process new trades
  let newTrades = 0;
  for (const trade of trades) {
    if (trade.timestamp > lastTradeTimestamp) {
      // Get market info if needed
      let marketInfo = null;
      const existing = positions.get(trade.conditionId);
      if (!existing) {
        marketInfo = await getMarketInfo(trade.conditionId);
      }

      processTradeIntoPosition(trade, marketInfo || existing);
      newTrades++;
    }
  }

  // Update last timestamp
  if (trades.length > 0) {
    lastTradeTimestamp = Math.max(lastTradeTimestamp, ...trades.map(t => t.timestamp));
  }

  displayPositions();

  if (newTrades > 0) {
    console.log(`\n  [NEW] ${newTrades} new trades detected`);
  }
}

async function main() {
  console.log('Starting position watcher...');
  console.log('Loading initial trades...');

  // Initial load - get all trades and build positions
  const initialTrades = await fetchRecentTrades();
  console.log(`Found ${initialTrades.length} recent trades`);

  // Process all trades (oldest first)
  const sortedTrades = initialTrades.sort((a, b) => a.timestamp - b.timestamp);

  for (const trade of sortedTrades) {
    const marketInfo = await getMarketInfo(trade.conditionId);
    processTradeIntoPosition(trade, marketInfo);
    await new Promise(r => setTimeout(r, 50)); // Rate limit
  }

  // Set last timestamp
  if (sortedTrades.length > 0) {
    lastTradeTimestamp = Math.max(...sortedTrades.map(t => t.timestamp));
  }

  // Display initial state
  displayPositions();

  // Poll for updates
  console.log('\nPolling for new trades every 3 seconds...');
  setInterval(pollAndUpdate, 3000);
}

main().catch(console.error);
