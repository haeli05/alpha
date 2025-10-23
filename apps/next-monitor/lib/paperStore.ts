import fs from 'node:fs';
import path from 'node:path';

export type OrderSide = 'BUY' | 'SELL';
export type Order = {
  id: string;
  ts: number; // ms
  symbol: string;
  side: OrderSide;
  qty: number; // base asset quantity
  price: number; // executed price
};

export type Position = {
  symbol: string;
  qty: number;
  avgPrice: number | null;
  realizedPnl: number;
};

const DATA_DIR = path.resolve(process.cwd(), '.data');
const FILE = path.join(DATA_DIR, 'paper.json');

type Store = { orders: Order[] };

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(): Store {
  ensureDir();
  if (!fs.existsSync(FILE)) return { orders: [] };
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Store;
  if (!Array.isArray(j.orders)) j.orders = [];
  return j;
}

function writeStore(s: Store) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, FILE);
}

export function listOrders(symbol?: string): Order[] {
  const s = readStore();
  return symbol ? s.orders.filter((o) => o.symbol === symbol) : s.orders;
}

export function placeOrder(symbol: string, side: OrderSide, qty: number, price: number): Order {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');
  if (!Number.isFinite(price) || price <= 0) throw new Error('price must be > 0');
  const s = readStore();
  const order: Order = {
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    symbol,
    side,
    qty,
    price,
  };
  s.orders.push(order);
  writeStore(s);
  return order;
}

export function computePosition(orders: Order[]): Position {
  let qty = 0;
  let avgPrice: number | null = null;
  let realizedPnl = 0;
  for (const o of orders) {
    const dir = o.side === 'BUY' ? 1 : -1;
    const prevQty = qty;
    qty += dir * o.qty;

    // If same direction as existing position or flat -> adjust avg price
    if ((prevQty >= 0 && dir > 0) || (prevQty <= 0 && dir < 0) || prevQty === 0) {
      const absPrev = Math.abs(prevQty);
      const absNew = Math.abs(qty);
      const addQty = o.qty;
      if (absNew === 0) {
        avgPrice = null;
      } else if (!avgPrice) {
        avgPrice = o.price;
      } else {
        avgPrice = (avgPrice * absPrev + o.price * addQty) / (absPrev + addQty);
      }
    } else {
      // Closing part or all of position -> realized PnL
      const closeQty = Math.min(Math.abs(prevQty), o.qty);
      if (avgPrice != null) {
        // If closing a long: SELL -> (price - avg) * qty; closing a short: BUY -> (avg - price) * qty
        const pnlPerUnit = prevQty > 0 ? (o.price - avgPrice) : (avgPrice - o.price);
        realizedPnl += pnlPerUnit * closeQty;
      }
      // Adjust avg price if flipped beyond flat: remaining becomes new entry at this order price
      if ((prevQty > 0 && qty < 0) || (prevQty < 0 && qty > 0)) {
        avgPrice = o.price;
      }
    }
  }
  return { symbol: orders[0]?.symbol ?? '', qty, avgPrice, realizedPnl };
}

