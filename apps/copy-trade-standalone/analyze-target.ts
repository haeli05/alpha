import WebSocket from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_ADDRESS = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

// Track RTDS prices
interface PriceUpdate {
  timestamp: number;
  asset: string;
  price: number;
  change1s: number;
}

const priceHistory: Map<string, PriceUpdate[]> = new Map();
const targetTrades: any[] = [];

// Connect to RTDS
function connectRTDS() {
  const ws = new WebSocket('wss://ws-live-data.polymarket.com');

  ws.on('open', () => {
    console.log('[RTDS] Connected');
    // Subscribe to crypto prices
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'live_data',
      assets: ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt']
    }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'price_update') {
        const asset = msg.asset;
        const price = parseFloat(msg.price);
        const now = Date.now();

        // Get previous price
        const history = priceHistory.get(asset) || [];
        const prev = history[history.length - 1];
        const change1s = prev ? ((price - prev.price) / prev.price) * 100 : 0;

        const update: PriceUpdate = { timestamp: now, asset, price, change1s };
        history.push(update);

        // Keep last 60 seconds
        while (history.length > 0 && now - history[0].timestamp > 60000) {
          history.shift();
        }
        priceHistory.set(asset, history);

        // Alert on significant moves (>0.1% in 1 second)
        if (Math.abs(change1s) > 0.1) {
          console.log(`[RTDS] ${asset.toUpperCase()} ${change1s > 0 ? '📈' : '📉'} ${change1s.toFixed(3)}% ($${price.toFixed(2)})`);
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[RTDS] Disconnected, reconnecting...');
    setTimeout(connectRTDS, 1000);
  });
}

// Poll target's trades
async function pollTargetTrades() {
  try {
    const resp = await fetch(`https://data-api.polymarket.com/trades?maker=${TARGET_ADDRESS}&limit=20`);
    const trades = await resp.json();

    for (const trade of trades) {
      // Check if we've seen this trade
      const tradeKey = `${trade.timestamp}-${trade.outcome}-${trade.price}-${trade.size}`;
      if (!targetTrades.find(t => t.key === tradeKey)) {
        targetTrades.push({ ...trade, key: tradeKey });

        // Only show Up/Down trades
        if (trade.outcome === 'Up' || trade.outcome === 'Down') {
          const time = new Date(trade.timestamp * 1000).toISOString();
          console.log(`\n[TARGET] ${time}`);
          console.log(`         ${trade.side} ${trade.outcome} @ $${trade.price.toFixed(2)} x ${trade.size}`);

          // Show recent price movements at time of trade
          console.log('         Recent RTDS:');
          for (const [asset, history] of priceHistory.entries()) {
            const recent = history.slice(-5);
            if (recent.length > 0) {
              const changes = recent.map(h => h.change1s.toFixed(3) + '%').join(' → ');
              console.log(`           ${asset}: ${changes}`);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Poll error:', e);
  }
}

// Get current order books for Up/Down markets
async function getMarketState() {
  const markets = [
    { slug: 'btc-up-or-down-15m', asset: 'BTC 15m' },
    { slug: 'eth-up-or-down-15m', asset: 'ETH 15m' },
    { slug: 'sol-up-or-down-15m', asset: 'SOL 15m' },
  ];

  console.log('\n=== MARKET STATE ===');

  for (const m of markets) {
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${m.slug}`);
      const data = await resp.json();
      if (data && data[0]) {
        const market = data[0];
        const outcomes = JSON.parse(market.outcomes || '[]');
        const prices = JSON.parse(market.outcomePrices || '[]');

        if (outcomes.length >= 2 && prices.length >= 2) {
          const upPrice = parseFloat(prices[0]);
          const downPrice = parseFloat(prices[1]);
          const combined = upPrice + downPrice;
          const profit = (1 - combined) * 100;

          console.log(`${m.asset}: Up $${upPrice.toFixed(2)} + Down $${downPrice.toFixed(2)} = $${combined.toFixed(2)} (${profit.toFixed(0)}¢ profit)`);
        }
      }
    } catch (e) {}
  }
  console.log('');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     TARGET ANALYSIS - Correlating trades with RTDS            ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${TARGET_ADDRESS}              ║`);
  console.log('║  Looking for: Price spike → Trade correlation                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Initial market state
  await getMarketState();

  // Connect to RTDS
  connectRTDS();

  // Poll target trades every 2 seconds
  setInterval(pollTargetTrades, 2000);

  // Show market state every 30 seconds
  setInterval(getMarketState, 30000);
}

main().catch(console.error);
