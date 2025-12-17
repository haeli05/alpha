/**
 * BTC SIGNAL ANALYZER
 *
 * Monitors BTC price on Binance and correlates with Polymarket wallet trades.
 * Goal: See if the successful arber is front-running BTC moves.
 *
 * USAGE: npx tsx btc-signal-analyzer.ts
 */

import WebSocket from 'ws';

const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const DATA_API_HOST = 'https://data-api.polymarket.com';

// Signal detection parameters
const PRICE_MOVE_THRESHOLD = 0.001; // 0.1% move
const TIME_WINDOW_MS = 5000; // 5 second window
const VOLUME_THRESHOLD = 10; // BTC volume in window

// ============================================================================
// BTC PRICE MONITORING (Binance WebSocket)
// ============================================================================

interface PricePoint {
  timestamp: number;
  price: number;
  volume: number;
}

interface Signal {
  timestamp: number;
  type: 'PUMP' | 'DUMP';
  priceChange: number;
  priceChangePercent: number;
  volume: number;
  price: number;
}

const priceHistory: PricePoint[] = [];
const signals: Signal[] = [];
let lastSignalTime = 0;

function connectCoinbaseWebSocket(): WebSocket {
  // Coinbase WebSocket for BTC-USD
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');

  ws.on('open', () => {
    console.log('[COINBASE] Connected, subscribing to BTC-USD...');
    ws.send(JSON.stringify({
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['matches'], // Trade matches
    }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'subscriptions') {
        console.log('[COINBASE] Subscribed to BTC-USD matches');
        return;
      }

      if (msg.type === 'match' || msg.type === 'last_match') {
        const point: PricePoint = {
          timestamp: new Date(msg.time).getTime(),
          price: parseFloat(msg.price),
          volume: parseFloat(msg.size),
        };

        priceHistory.push(point);

        // Keep only last 60 seconds of data
        const cutoff = Date.now() - 60000;
        while (priceHistory.length > 0 && priceHistory[0].timestamp < cutoff) {
          priceHistory.shift();
        }

        // Check for signals
        detectSignal(point);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('error', (err) => {
    console.error('[COINBASE] WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('[COINBASE] Connection closed, reconnecting...');
    setTimeout(() => connectCoinbaseWebSocket(), 5000);
  });

  return ws;
}

function detectSignal(current: PricePoint): void {
  // Look back TIME_WINDOW_MS
  const windowStart = current.timestamp - TIME_WINDOW_MS;
  const windowPoints = priceHistory.filter(p => p.timestamp >= windowStart);

  if (windowPoints.length < 2) return;

  const startPrice = windowPoints[0].price;
  const priceChange = current.price - startPrice;
  const priceChangePercent = priceChange / startPrice;
  const windowVolume = windowPoints.reduce((sum, p) => sum + p.volume, 0);

  // Debounce - don't fire signals too frequently
  if (Date.now() - lastSignalTime < 3000) return;

  // Check thresholds
  if (Math.abs(priceChangePercent) >= PRICE_MOVE_THRESHOLD && windowVolume >= VOLUME_THRESHOLD) {
    const signal: Signal = {
      timestamp: current.timestamp,
      type: priceChange > 0 ? 'PUMP' : 'DUMP',
      priceChange,
      priceChangePercent,
      volume: windowVolume,
      price: current.price,
    };

    signals.push(signal);
    lastSignalTime = Date.now();

    const time = new Date(signal.timestamp).toISOString().slice(11, 23);
    const pctStr = (signal.priceChangePercent * 100).toFixed(3);
    const icon = signal.type === 'PUMP' ? '🟢' : '🔴';

    console.log(`\n${icon} [SIGNAL] ${signal.type} @ ${time}`);
    console.log(`   Price: $${signal.price.toFixed(2)} (${pctStr}% in ${TIME_WINDOW_MS / 1000}s)`);
    console.log(`   Volume: ${signal.volume.toFixed(2)} BTC`);
  }
}

// ============================================================================
// POLYMARKET TRADE MONITORING
// ============================================================================

interface Trade {
  timestamp: number;
  outcome: string;
  side: string;
  price: number;
  size: number;
}

let lastTradeTimestamp = 0;
const recentTrades: Trade[] = [];

async function fetchRecentTrades(): Promise<Trade[]> {
  try {
    const url = `${DATA_API_HOST}/trades?user=${TARGET_WALLET.toLowerCase()}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((t: any) => ({
      timestamp: typeof t.timestamp === 'number'
        ? (t.timestamp < 4102444800 ? t.timestamp * 1000 : t.timestamp)
        : parseInt(t.timestamp) * 1000,
      outcome: t.outcome || 'Unknown',
      side: t.side,
      price: parseFloat(t.price || '0'),
      size: parseFloat(t.size || '0'),
    }));
  } catch {
    return [];
  }
}

async function pollTrades(): Promise<void> {
  const trades = await fetchRecentTrades();

  for (const trade of trades) {
    if (trade.timestamp > lastTradeTimestamp) {
      recentTrades.push(trade);
      lastTradeTimestamp = Math.max(lastTradeTimestamp, trade.timestamp);

      const time = new Date(trade.timestamp).toISOString().slice(11, 23);
      const outcome = trade.outcome.padEnd(6);

      console.log(`\n💰 [TRADE] ${trade.side} ${outcome} @ ${time}`);
      console.log(`   Size: ${trade.size.toFixed(2)} @ $${trade.price.toFixed(4)}`);

      // Check if there was a recent signal
      const signalWindow = 30000; // 30 second correlation window
      const recentSignals = signals.filter(
        s => Math.abs(s.timestamp - trade.timestamp) < signalWindow
      );

      if (recentSignals.length > 0) {
        console.log(`   🔗 CORRELATED SIGNALS:`);
        for (const sig of recentSignals) {
          const lag = (trade.timestamp - sig.timestamp) / 1000;
          const lagStr = lag >= 0 ? `+${lag.toFixed(1)}s after` : `${Math.abs(lag).toFixed(1)}s before`;
          console.log(`      ${sig.type} @ $${sig.price.toFixed(2)} (${lagStr} signal)`);
        }
      }
    }
  }
}

// ============================================================================
// CORRELATION ANALYSIS
// ============================================================================

function analyzeCorrelation(): void {
  console.log('\n' + '='.repeat(80));
  console.log('SIGNAL-TRADE CORRELATION ANALYSIS');
  console.log('='.repeat(80));

  if (signals.length === 0 || recentTrades.length === 0) {
    console.log('Not enough data yet. Keep running to collect more.');
    return;
  }

  let correlatedTrades = 0;
  let pumpYesBuys = 0;
  let pumpNoBuys = 0;
  let dumpYesBuys = 0;
  let dumpNoBuys = 0;

  for (const trade of recentTrades) {
    // Find signals within 30s before the trade
    const relevantSignals = signals.filter(
      s => trade.timestamp - s.timestamp > 0 && trade.timestamp - s.timestamp < 30000
    );

    if (relevantSignals.length > 0) {
      correlatedTrades++;
      const latestSignal = relevantSignals[relevantSignals.length - 1];
      const isYes = trade.outcome.toLowerCase().includes('yes') ||
                    trade.outcome.toLowerCase().includes('up');

      if (latestSignal.type === 'PUMP') {
        if (isYes) pumpYesBuys++;
        else pumpNoBuys++;
      } else {
        if (isYes) dumpYesBuys++;
        else dumpNoBuys++;
      }
    }
  }

  console.log(`\nTrades with preceding signal (30s window): ${correlatedTrades}/${recentTrades.length}`);
  console.log(`\nBreakdown:`);
  console.log(`  PUMP signal → Yes buy: ${pumpYesBuys}`);
  console.log(`  PUMP signal → No buy:  ${pumpNoBuys}`);
  console.log(`  DUMP signal → Yes buy: ${dumpYesBuys}`);
  console.log(`  DUMP signal → No buy:  ${dumpNoBuys}`);

  if (correlatedTrades > 0) {
    const expectedBehavior = pumpYesBuys + dumpNoBuys;
    const contraryBehavior = pumpNoBuys + dumpYesBuys;
    console.log(`\n  Expected (pump→yes, dump→no): ${expectedBehavior}`);
    console.log(`  Contrary (pump→no, dump→yes): ${contraryBehavior}`);

    if (expectedBehavior > contraryBehavior) {
      console.log(`\n  ✅ Wallet appears to FOLLOW BTC signals`);
    } else if (contraryBehavior > expectedBehavior) {
      console.log(`\n  🔄 Wallet appears to FADE BTC signals`);
    } else {
      console.log(`\n  ❓ No clear pattern detected`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           BTC SIGNAL ANALYZER                              ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Target Wallet: ${TARGET_WALLET.slice(0, 20)}...           ║`);
  console.log(`║  Signal Threshold: ${(PRICE_MOVE_THRESHOLD * 100).toFixed(2)}% in ${TIME_WINDOW_MS / 1000}s              ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize last trade timestamp
  const initialTrades = await fetchRecentTrades();
  if (initialTrades.length > 0) {
    lastTradeTimestamp = Math.max(...initialTrades.map(t => t.timestamp));
    console.log(`[INIT] Found ${initialTrades.length} existing trades, watching for new ones...`);
  }

  // Connect to Coinbase
  console.log('[INIT] Connecting to Coinbase BTC-USD stream...');
  connectCoinbaseWebSocket();

  // Poll Polymarket trades
  console.log('[INIT] Starting Polymarket trade polling (every 2s)...');
  setInterval(pollTrades, 2000);

  // Periodic correlation analysis
  setInterval(analyzeCorrelation, 60000); // Every minute

  console.log('\n[RUNNING] Monitoring for signals and trades...');
  console.log('[RUNNING] Press Ctrl+C to stop\n');
}

main().catch(console.error);
