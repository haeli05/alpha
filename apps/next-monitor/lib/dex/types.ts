// Common DEX types for market making

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface PriceQuote {
  dex: string;
  inputToken: TokenInfo;
  outputToken: TokenInfo;
  inputAmount: bigint;
  outputAmount: bigint;
  price: number; // output per input
  priceImpact: number; // percentage
  timestamp: number;
}

export interface PoolReserves {
  dex: string;
  poolAddress: `0x${string}`;
  token0: TokenInfo;
  token1: TokenInfo;
  reserve0: bigint;
  reserve1: bigint;
  midPrice: number; // token1 per token0
  timestamp: number;
}

export interface ArbitrageOpportunity {
  buyDex: string;
  sellDex: string;
  token: TokenInfo;
  quoteToken: TokenInfo;
  buyPrice: number;
  sellPrice: number;
  spreadBps: number; // spread in basis points
  estimatedProfit: number;
  timestamp: number;
}

export interface MarketMakerConfig {
  // Trading pairs
  baseToken: TokenInfo;
  quoteToken: TokenInfo;

  // DEX configurations
  dexes: DexConfig[];

  // Strategy parameters
  minSpreadBps: number; // minimum spread to trade (in basis points)
  maxPositionSize: bigint; // max position in base token
  orderSize: bigint; // size per order in base token

  // Risk parameters
  maxSlippageBps: number;
  maxGasPrice: bigint;
  cooldownMs: number; // minimum time between trades
}

export interface DexConfig {
  name: string;
  type: 'uniswap-v2' | 'uniswap-v3' | 'balancer' | 'curve';
  chainId: number;
  rpcUrl: string;
  routerAddress?: `0x${string}`;
  factoryAddress?: `0x${string}`;
  poolAddress?: `0x${string}`;
}

export interface Trade {
  id: string;
  timestamp: number;
  dex: string;
  side: 'BUY' | 'SELL';
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  baseAmount: bigint;
  quoteAmount: bigint;
  price: number;
  txHash?: string;
  status: 'pending' | 'confirmed' | 'failed';
  gasUsed?: bigint;
  gasCost?: bigint;
}

export interface Position {
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  baseBalance: bigint;
  quoteBalance: bigint;
  avgEntryPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
}
