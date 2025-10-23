export type RiskConfig = {
  maxPositionQty?: number; // base units cap per symbol
  maxNotional?: number; // quote currency cap per symbol
  allowedSymbols?: string[];
};

export type PreTrade = { symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number };

export function preTradeCheck(cfg: RiskConfig, order: PreTrade): { ok: boolean; reason?: string } {
  if (cfg.allowedSymbols && !cfg.allowedSymbols.includes(order.symbol)) {
    return { ok: false, reason: 'symbol_not_allowed' };
  }
  if (cfg.maxPositionQty && order.qty > cfg.maxPositionQty) {
    return { ok: false, reason: 'max_qty_exceeded' };
  }
  const notion = order.qty * order.price;
  if (cfg.maxNotional && notion > cfg.maxNotional) {
    return { ok: false, reason: 'max_notional_exceeded' };
  }
  return { ok: true };
}

