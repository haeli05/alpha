import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface MarketTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
  updatedAt: number;
}

export interface MarketData {
  ticker: MarketTicker | null;
  closes: number[];
  isLoading: boolean;
  error: string | null;
}

interface MarketState {
  // Market data by symbol
  markets: Record<string, MarketData>;

  // WebSocket connection status
  wsStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  wsReconnectCount: number;

  // Actions
  updateTicker: (symbol: string, ticker: Partial<MarketTicker>) => void;
  setMarketData: (symbol: string, data: Partial<MarketData>) => void;
  setMarketError: (symbol: string, error: string | null) => void;
  setWsStatus: (status: MarketState['wsStatus']) => void;
  incrementReconnectCount: () => void;
  resetReconnectCount: () => void;
  clearMarket: (symbol: string) => void;
  clearAllMarkets: () => void;
}

const initialMarketData: MarketData = {
  ticker: null,
  closes: [],
  isLoading: false,
  error: null,
};

export const useMarketStore = create<MarketState>()(
  subscribeWithSelector((set, get) => ({
    markets: {},
    wsStatus: 'disconnected',
    wsReconnectCount: 0,

    updateTicker: (symbol, tickerUpdate) => {
      set((state) => {
        const current = state.markets[symbol] || { ...initialMarketData };
        const currentTicker = current.ticker || {
          symbol,
          lastPrice: 0,
          priceChangePercent: 0,
          highPrice: 0,
          lowPrice: 0,
          volume: 0,
          quoteVolume: 0,
          updatedAt: Date.now(),
        };

        return {
          markets: {
            ...state.markets,
            [symbol]: {
              ...current,
              ticker: {
                ...currentTicker,
                ...tickerUpdate,
                updatedAt: Date.now(),
              },
              error: null,
            },
          },
        };
      });
    },

    setMarketData: (symbol, data) => {
      set((state) => {
        const current = state.markets[symbol] || { ...initialMarketData };
        return {
          markets: {
            ...state.markets,
            [symbol]: {
              ...current,
              ...data,
            },
          },
        };
      });
    },

    setMarketError: (symbol, error) => {
      set((state) => {
        const current = state.markets[symbol] || { ...initialMarketData };
        return {
          markets: {
            ...state.markets,
            [symbol]: {
              ...current,
              error,
              isLoading: false,
            },
          },
        };
      });
    },

    setWsStatus: (status) => {
      set({ wsStatus: status });
    },

    incrementReconnectCount: () => {
      set((state) => ({ wsReconnectCount: state.wsReconnectCount + 1 }));
    },

    resetReconnectCount: () => {
      set({ wsReconnectCount: 0 });
    },

    clearMarket: (symbol) => {
      set((state) => {
        const { [symbol]: _, ...rest } = state.markets;
        return { markets: rest };
      });
    },

    clearAllMarkets: () => {
      set({ markets: {} });
    },
  }))
);

// Selectors
export const selectMarket = (symbol: string) => (state: MarketState) =>
  state.markets[symbol] || initialMarketData;

export const selectTicker = (symbol: string) => (state: MarketState) =>
  state.markets[symbol]?.ticker || null;

export const selectWsStatus = (state: MarketState) => state.wsStatus;

export const selectAllSymbols = (state: MarketState) =>
  Object.keys(state.markets);

// Helper hook for subscribing to specific market updates
export function useMarket(symbol: string) {
  return useMarketStore((state) => selectMarket(symbol)(state));
}

export function useTicker(symbol: string) {
  return useMarketStore((state) => selectTicker(symbol)(state));
}

export function useWsStatus() {
  return useMarketStore(selectWsStatus);
}

export default useMarketStore;
