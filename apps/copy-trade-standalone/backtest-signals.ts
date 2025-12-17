/**
 * BACKTEST: BTC Signal Correlation Analysis
 *
 * Analyzes historical correlation between BTC price moves and wallet trades.
 *
 * USAGE: npx tsx backtest-signals.ts
 */

const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const DATA_API_HOST = 'https://data-api.polymarket.com';

// ============================================================================
// DATA TYPES
// ============================================================================

interface Trade {
  timestamp: number;
  conditionId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

interface BTCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TradeWithContext {
  trade: Trade;
  btcPriceBefore: number;
  btcPriceAt: number;
  btcChange1m: number; // % change 1 min before
  btcChange5m: number; // % change 5 min before
  btcChangePercent1m: number;
  btcChangePercent5m: number;
}

// ============================================================================
// FETCH DATA
// ============================================================================

async function fetchTrades(limit = 2000): Promise<Trade[]> {
  console.log('Fetching wallet trades...');
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

async function fetchBTCCandles(startTime: number, endTime: number): Promise<BTCCandle[]> {
  // Coinbase Pro API - 1 minute candles
  // granularity: 60 = 1 minute
  const start = new Date(startTime).toISOString();
  const end = new Date(endTime).toISOString();

  const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?start=${start}&end=${end}&granularity=60`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'backtest-script' }
    });

    if (!res.ok) {
      console.error(`Coinbase API error: ${res.status}`);
      return [];
    }

    const data = await res.json();

    // Coinbase returns: [timestamp, low, high, open, close, volume]
    return data.map((c: number[]) => ({
      timestamp: c[0] * 1000,
      low: c[1],
      high: c[2],
      open: c[3],
      close: c[4],
      volume: c[5],
    })).sort((a: BTCCandle, b: BTCCandle) => a.timestamp - b.timestamp);
  } catch (e) {
    console.error('Error fetching BTC candles:', e);
    return [];
  }
}

// ============================================================================
// ANALYSIS
// ============================================================================

function findBTCPrice(candles: BTCCandle[], timestamp: number): number | null {
  // Find the candle that contains this timestamp
  for (const candle of candles) {
    if (timestamp >= candle.timestamp && timestamp < candle.timestamp + 60000) {
      return candle.close;
    }
  }
  // Find closest candle
  let closest = candles[0];
  let minDiff = Math.abs(candles[0]?.timestamp - timestamp);
  for (const candle of candles) {
    const diff = Math.abs(candle.timestamp - timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = candle;
    }
  }
  return closest?.close || null;
}

function findBTCPriceAt(candles: BTCCandle[], timestamp: number, offsetMs: number): number | null {
  return findBTCPrice(candles, timestamp + offsetMs);
}

async function analyzeTradesWithBTC(trades: Trade[]): Promise<TradeWithContext[]> {
  const results: TradeWithContext[] = [];

  // Get time range
  const timestamps = trades.map(t => t.timestamp);
  const minTime = Math.min(...timestamps) - 10 * 60 * 1000; // 10 min buffer
  const maxTime = Math.max(...timestamps) + 60 * 1000;

  console.log(`Fetching BTC prices from ${new Date(minTime).toISOString()} to ${new Date(maxTime).toISOString()}`);

  // Coinbase limits to 300 candles per request, so we need to chunk
  const chunkSize = 300 * 60 * 1000; // 300 minutes
  const allCandles: BTCCandle[] = [];

  for (let start = minTime; start < maxTime; start += chunkSize) {
    const end = Math.min(start + chunkSize, maxTime);
    console.log(`  Fetching chunk: ${new Date(start).toISOString().slice(11, 19)} - ${new Date(end).toISOString().slice(11, 19)}`);

    const candles = await fetchBTCCandles(start, end);
    allCandles.push(...candles);

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`Fetched ${allCandles.length} BTC candles`);

  // Sort candles by timestamp
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  // Analyze each trade
  for (const trade of trades) {
    const btcPriceAt = findBTCPrice(allCandles, trade.timestamp);
    const btcPrice1mBefore = findBTCPriceAt(allCandles, trade.timestamp, -60 * 1000);
    const btcPrice5mBefore = findBTCPriceAt(allCandles, trade.timestamp, -5 * 60 * 1000);

    if (btcPriceAt && btcPrice1mBefore && btcPrice5mBefore) {
      const btcChange1m = btcPriceAt - btcPrice1mBefore;
      const btcChange5m = btcPriceAt - btcPrice5mBefore;

      results.push({
        trade,
        btcPriceBefore: btcPrice1mBefore,
        btcPriceAt,
        btcChange1m,
        btcChange5m,
        btcChangePercent1m: (btcChange1m / btcPrice1mBefore) * 100,
        btcChangePercent5m: (btcChange5m / btcPrice5mBefore) * 100,
      });
    }
  }

  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           BACKTEST: BTC SIGNAL CORRELATION                 ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_WALLET.slice(0, 20)}...                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Fetch trades
  const trades = await fetchTrades(500);
  console.log(`Found ${trades.length} trades\n`);

  // Filter to BTC markets only (Up/Down outcomes)
  const btcTrades = trades.filter(t =>
    t.outcome.toLowerCase().includes('up') ||
    t.outcome.toLowerCase().includes('down')
  );
  console.log(`BTC Up/Down trades: ${btcTrades.length}\n`);

  // Analyze with BTC context
  const analyzed = await analyzeTradesWithBTC(btcTrades);
  console.log(`\nAnalyzed ${analyzed.length} trades with BTC context\n`);

  // ========================================================================
  // CORRELATION ANALYSIS
  // ========================================================================

  console.log('='.repeat(80));
  console.log('CORRELATION ANALYSIS');
  console.log('='.repeat(80));

  // Categorize trades
  const upBuys = analyzed.filter(a =>
    a.trade.side === 'BUY' &&
    (a.trade.outcome.toLowerCase().includes('up') || a.trade.outcome.toLowerCase().includes('yes'))
  );
  const downBuys = analyzed.filter(a =>
    a.trade.side === 'BUY' &&
    (a.trade.outcome.toLowerCase().includes('down') || a.trade.outcome.toLowerCase().includes('no'))
  );

  console.log(`\nUp/Yes Buys: ${upBuys.length}`);
  console.log(`Down/No Buys: ${downBuys.length}`);

  // Analyze: When BTC pumped (1m), did he buy Up or Down?
  const threshold = 0.05; // 0.05% move threshold

  const btcPumpedTrades = analyzed.filter(a => a.btcChangePercent1m > threshold);
  const btcDumpedTrades = analyzed.filter(a => a.btcChangePercent1m < -threshold);
  const btcFlatTrades = analyzed.filter(a => Math.abs(a.btcChangePercent1m) <= threshold);

  console.log(`\nTrades after BTC pump (>${threshold}% in 1m): ${btcPumpedTrades.length}`);
  console.log(`Trades after BTC dump (<-${threshold}% in 1m): ${btcDumpedTrades.length}`);
  console.log(`Trades when BTC flat: ${btcFlatTrades.length}`);

  // When BTC pumped, what did he buy?
  const pumpUpBuys = btcPumpedTrades.filter(a =>
    a.trade.outcome.toLowerCase().includes('up')
  ).length;
  const pumpDownBuys = btcPumpedTrades.filter(a =>
    a.trade.outcome.toLowerCase().includes('down')
  ).length;

  const dumpUpBuys = btcDumpedTrades.filter(a =>
    a.trade.outcome.toLowerCase().includes('up')
  ).length;
  const dumpDownBuys = btcDumpedTrades.filter(a =>
    a.trade.outcome.toLowerCase().includes('down')
  ).length;

  console.log(`\n${'─'.repeat(50)}`);
  console.log('After BTC PUMP:');
  console.log(`  Bought UP:   ${pumpUpBuys} (${(pumpUpBuys / btcPumpedTrades.length * 100 || 0).toFixed(1)}%)`);
  console.log(`  Bought DOWN: ${pumpDownBuys} (${(pumpDownBuys / btcPumpedTrades.length * 100 || 0).toFixed(1)}%)`);

  console.log(`\nAfter BTC DUMP:`);
  console.log(`  Bought UP:   ${dumpUpBuys} (${(dumpUpBuys / btcDumpedTrades.length * 100 || 0).toFixed(1)}%)`);
  console.log(`  Bought DOWN: ${dumpDownBuys} (${(dumpDownBuys / btcDumpedTrades.length * 100 || 0).toFixed(1)}%)`);
  console.log(`${'─'.repeat(50)}`);

  // Calculate correlation
  const followsSignal = pumpUpBuys + dumpDownBuys;
  const fadesSignal = pumpDownBuys + dumpUpBuys;
  const totalSignalTrades = btcPumpedTrades.length + btcDumpedTrades.length;

  console.log(`\nSIGNAL FOLLOWING vs FADING:`);
  console.log(`  Follows signal (pump→up, dump→down): ${followsSignal} (${(followsSignal / totalSignalTrades * 100 || 0).toFixed(1)}%)`);
  console.log(`  Fades signal (pump→down, dump→up):   ${fadesSignal} (${(fadesSignal / totalSignalTrades * 100 || 0).toFixed(1)}%)`);

  if (followsSignal > fadesSignal * 1.2) {
    console.log(`\n  ✅ CONCLUSION: Wallet FOLLOWS BTC momentum`);
  } else if (fadesSignal > followsSignal * 1.2) {
    console.log(`\n  🔄 CONCLUSION: Wallet FADES BTC momentum (contrarian)`);
  } else {
    console.log(`\n  ❓ CONCLUSION: No clear directional bias`);
  }

  // ========================================================================
  // DETAILED TRADE LOG
  // ========================================================================

  console.log(`\n${'='.repeat(80)}`);
  console.log('SAMPLE TRADES WITH BTC CONTEXT (last 30)');
  console.log('='.repeat(80));

  const recentTrades = analyzed.slice(0, 30);
  for (const a of recentTrades) {
    const time = new Date(a.trade.timestamp).toISOString().slice(11, 19);
    const outcome = a.trade.outcome.padEnd(6);
    const btcDir = a.btcChangePercent1m > 0.02 ? '📈' : a.btcChangePercent1m < -0.02 ? '📉' : '➡️';

    console.log(`${time} | ${a.trade.side} ${outcome} @ $${a.trade.price.toFixed(2)} | BTC ${btcDir} ${a.btcChangePercent1m >= 0 ? '+' : ''}${a.btcChangePercent1m.toFixed(3)}% (1m)`);
  }

  // ========================================================================
  // PROFITABILITY BY BTC CONDITION
  // ========================================================================

  console.log(`\n${'='.repeat(80)}`);
  console.log('AVERAGE ENTRY PRICES BY BTC CONDITION');
  console.log('='.repeat(80));

  // When BTC pumped, what prices did he get?
  if (btcPumpedTrades.length > 0) {
    const avgUpPrice = btcPumpedTrades
      .filter(a => a.trade.outcome.toLowerCase().includes('up'))
      .reduce((s, a) => s + a.trade.price, 0) /
      btcPumpedTrades.filter(a => a.trade.outcome.toLowerCase().includes('up')).length || 0;

    const avgDownPrice = btcPumpedTrades
      .filter(a => a.trade.outcome.toLowerCase().includes('down'))
      .reduce((s, a) => s + a.trade.price, 0) /
      btcPumpedTrades.filter(a => a.trade.outcome.toLowerCase().includes('down')).length || 0;

    console.log(`\nAfter BTC pump:`);
    console.log(`  Avg UP price:   $${avgUpPrice.toFixed(4)}`);
    console.log(`  Avg DOWN price: $${avgDownPrice.toFixed(4)}`);
  }

  if (btcDumpedTrades.length > 0) {
    const avgUpPrice = btcDumpedTrades
      .filter(a => a.trade.outcome.toLowerCase().includes('up'))
      .reduce((s, a) => s + a.trade.price, 0) /
      btcDumpedTrades.filter(a => a.trade.outcome.toLowerCase().includes('up')).length || 0;

    const avgDownPrice = btcDumpedTrades
      .filter(a => a.trade.outcome.toLowerCase().includes('down'))
      .reduce((s, a) => s + a.trade.price, 0) /
      btcDumpedTrades.filter(a => a.trade.outcome.toLowerCase().includes('down')).length || 0;

    console.log(`\nAfter BTC dump:`);
    console.log(`  Avg UP price:   $${avgUpPrice.toFixed(4)}`);
    console.log(`  Avg DOWN price: $${avgDownPrice.toFixed(4)}`);
  }
}

main().catch(console.error);
