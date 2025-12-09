'use client';

import { useState, useEffect, useCallback } from 'react';
import type { PolymarketMarket } from '@/lib/polymarket';
import {
  HedgeStrategyConfig,
  calculateHedgePosition,
  calculatePnLScenarios,
  checkEntryConditions,
  MarketState,
} from '@/lib/polymarket/strategy';

interface Props {
  market: PolymarketMarket;
  yesTokenId?: string;
  noTokenId?: string;
  yesPrice: number;
  noPrice: number;
  onConfigChange?: (config: HedgeStrategyConfig | null) => void;
}

export default function StrategyPanel({
  market,
  yesTokenId,
  noTokenId,
  yesPrice,
  noPrice,
  onConfigChange,
}: Props) {
  // Strategy config state
  const [yesEntryPrice, setYesEntryPrice] = useState(yesPrice.toFixed(2));
  const [noEntryPrice, setNoEntryPrice] = useState(noPrice.toFixed(2));
  const [yesSize, setYesSize] = useState('100');
  const [noSize, setNoSize] = useState('100');
  const [maxSlippageBps, setMaxSlippageBps] = useState('100');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [takeProfitPrice, setTakeProfitPrice] = useState('');

  // Live market state
  const [marketState, setMarketState] = useState<MarketState>({
    yesPrice,
    noPrice,
    yesBid: yesPrice,
    yesAsk: yesPrice,
    noBid: noPrice,
    noAsk: noPrice,
    timestamp: Date.now(),
  });

  // Strategy enabled
  const [strategyEnabled, setStrategyEnabled] = useState(false);

  // Fetch live prices
  useEffect(() => {
    if (!yesTokenId || !noTokenId) return;

    let mounted = true;

    async function fetchPrices() {
      try {
        const [yesRes, noRes] = await Promise.all([
          fetch(`/api/polymarket/orderbook?token_id=${yesTokenId}`),
          fetch(`/api/polymarket/orderbook?token_id=${noTokenId}`),
        ]);

        if (!mounted) return;

        const [yesBook, noBook] = await Promise.all([yesRes.json(), noRes.json()]);

        const yesBid = yesBook.bids?.[0] ? parseFloat(yesBook.bids[0].price) : yesPrice;
        const yesAsk = yesBook.asks?.[0] ? parseFloat(yesBook.asks[0].price) : yesPrice;
        const noBid = noBook.bids?.[0] ? parseFloat(noBook.bids[0].price) : noPrice;
        const noAsk = noBook.asks?.[0] ? parseFloat(noBook.asks[0].price) : noPrice;

        setMarketState({
          yesPrice: yesBook.midpoint || (yesBid + yesAsk) / 2,
          noPrice: noBook.midpoint || (noBid + noAsk) / 2,
          yesBid,
          yesAsk,
          noBid,
          noAsk,
          timestamp: Date.now(),
        });
      } catch {
        // Ignore errors in background fetch
      }
    }

    fetchPrices();
    const interval = setInterval(fetchPrices, 3000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [yesTokenId, noTokenId, yesPrice, noPrice]);

  // Build config object
  const buildConfig = useCallback((): HedgeStrategyConfig | null => {
    const yesEntry = parseFloat(yesEntryPrice);
    const noEntry = parseFloat(noEntryPrice);
    const yesSz = parseFloat(yesSize);
    const noSz = parseFloat(noSize);
    const slippage = parseInt(maxSlippageBps);

    if (isNaN(yesEntry) || isNaN(noEntry) || isNaN(yesSz) || isNaN(noSz) || isNaN(slippage)) {
      return null;
    }

    return {
      yesEntryPrice: yesEntry,
      noEntryPrice: noEntry,
      yesSize: yesSz,
      noSize: noSz,
      maxSlippageBps: slippage,
      stopLossPrice: stopLossPrice ? parseFloat(stopLossPrice) : undefined,
      takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : undefined,
    };
  }, [yesEntryPrice, noEntryPrice, yesSize, noSize, maxSlippageBps, stopLossPrice, takeProfitPrice]);

  // Calculate position preview
  const config = buildConfig();
  const position = config
    ? calculateHedgePosition(config, parseFloat(yesEntryPrice), parseFloat(noEntryPrice))
    : null;
  const pnlScenarios = position ? calculatePnLScenarios(position) : null;
  const entryConditions = config ? checkEntryConditions(config, marketState) : null;

  // Notify parent of config changes
  useEffect(() => {
    onConfigChange?.(strategyEnabled ? config : null);
  }, [strategyEnabled, config, onConfigChange]);

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Hedge Strategy</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={strategyEnabled}
            onChange={(e) => setStrategyEnabled(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <span style={{ fontSize: 14, fontWeight: 500 }}>Enable</span>
        </label>
      </div>

      {/* Live Prices */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          padding: 12,
          backgroundColor: '#f9fafb',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <div>
          <div style={{ color: '#6b7280', marginBottom: 4 }}>YES Bid/Ask</div>
          <div style={{ fontWeight: 600, color: '#22c55e' }}>
            ${marketState.yesBid.toFixed(3)} / ${marketState.yesAsk.toFixed(3)}
          </div>
        </div>
        <div>
          <div style={{ color: '#6b7280', marginBottom: 4 }}>NO Bid/Ask</div>
          <div style={{ fontWeight: 600, color: '#ef4444' }}>
            ${marketState.noBid.toFixed(3)} / ${marketState.noAsk.toFixed(3)}
          </div>
        </div>
      </div>

      {/* Entry Configuration */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            YES Entry Price
          </label>
          <input
            type="number"
            value={yesEntryPrice}
            onChange={(e) => setYesEntryPrice(e.target.value)}
            min="0.01"
            max="0.99"
            step="0.01"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            YES Size (USDC)
          </label>
          <input
            type="number"
            value={yesSize}
            onChange={(e) => setYesSize(e.target.value)}
            min="1"
            step="10"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            NO Hedge Price
          </label>
          <input
            type="number"
            value={noEntryPrice}
            onChange={(e) => setNoEntryPrice(e.target.value)}
            min="0.01"
            max="0.99"
            step="0.01"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            NO Size (USDC)
          </label>
          <input
            type="number"
            value={noSize}
            onChange={(e) => setNoSize(e.target.value)}
            min="1"
            step="10"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Risk Parameters */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            Max Slippage (bps)
          </label>
          <input
            type="number"
            value={maxSlippageBps}
            onChange={(e) => setMaxSlippageBps(e.target.value)}
            min="1"
            step="10"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            Stop Loss (optional)
          </label>
          <input
            type="number"
            value={stopLossPrice}
            onChange={(e) => setStopLossPrice(e.target.value)}
            placeholder="0.20"
            min="0.01"
            max="0.99"
            step="0.01"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            Take Profit (optional)
          </label>
          <input
            type="number"
            value={takeProfitPrice}
            onChange={(e) => setTakeProfitPrice(e.target.value)}
            placeholder="0.80"
            min="0.01"
            max="0.99"
            step="0.01"
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 14,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Position Preview */}
      {position && pnlScenarios && (
        <div
          style={{
            padding: 12,
            backgroundColor: '#f0fdf4',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Position Preview</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>YES Shares: <b>{position.yesShares.toFixed(2)}</b></div>
            <div>NO Shares: <b>{position.noShares.toFixed(2)}</b></div>
            <div>Total Cost: <b>${position.totalCost.toFixed(2)}</b></div>
            <div>Break-even YES: <b>${position.breakEvenYesPrice.toFixed(3)}</b></div>
          </div>

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid #bbf7d0',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>P&L Scenarios</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ color: '#22c55e' }}>
                If YES wins: <b>+${pnlScenarios.yesWins.pnl.toFixed(2)}</b>{' '}
                ({pnlScenarios.yesWins.roi.toFixed(1)}%)
              </div>
              <div style={{ color: pnlScenarios.noWins.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                If NO wins: <b>{pnlScenarios.noWins.pnl >= 0 ? '+' : ''}${pnlScenarios.noWins.pnl.toFixed(2)}</b>{' '}
                ({pnlScenarios.noWins.roi.toFixed(1)}%)
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Entry Conditions */}
      {entryConditions && (
        <div
          style={{
            padding: 12,
            backgroundColor: entryConditions.yesEntry || entryConditions.noEntry ? '#fef9c3' : '#f3f4f6',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Entry Conditions</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: entryConditions.yesEntry ? '#22c55e' : '#d1d5db',
                }}
              />
              YES: Ask ${marketState.yesAsk.toFixed(3)} {entryConditions.yesEntry ? '<=' : '>'} ${config?.yesEntryPrice.toFixed(2)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: entryConditions.noEntry ? '#22c55e' : '#d1d5db',
                }}
              />
              NO: Ask ${marketState.noAsk.toFixed(3)} {entryConditions.noEntry ? '<=' : '>'} ${config?.noEntryPrice.toFixed(2)}
            </div>
          </div>
          {entryConditions.reasons.length > 0 && (
            <div style={{ marginTop: 8, color: '#ca8a04', fontWeight: 500 }}>
              Signal: {entryConditions.reasons.join(' | ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
