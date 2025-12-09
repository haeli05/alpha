// Uniswap V2-style AMM price adapter (works with most DEX forks)
import { createPublicClient, http, parseAbi, formatUnits, type PublicClient } from 'viem';
import type { TokenInfo, PriceQuote, PoolReserves, DexConfig } from './types';
import { logger } from '@/lib/logger';

// Standard Uniswap V2 ABIs
const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
]);

const PAIR_ABI = parseAbi([
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
]);

const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
]);

export class UniswapV2Adapter {
  private client: PublicClient;
  private config: DexConfig;

  constructor(config: DexConfig) {
    this.config = config;
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  // Get pair address for two tokens
  async getPairAddress(tokenA: `0x${string}`, tokenB: `0x${string}`): Promise<`0x${string}` | null> {
    if (!this.config.factoryAddress) {
      logger.error('UniswapV2', 'Factory address not configured');
      return null;
    }

    try {
      const pair = await this.client.readContract({
        address: this.config.factoryAddress,
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [tokenA, tokenB],
      });

      if (pair === '0x0000000000000000000000000000000000000000') {
        return null;
      }

      return pair as `0x${string}`;
    } catch (e) {
      logger.error('UniswapV2', 'Failed to get pair address', { error: String(e) });
      return null;
    }
  }

  // Get pool reserves directly from pair contract
  async getReserves(
    pairAddress: `0x${string}`,
    token0: TokenInfo,
    token1: TokenInfo
  ): Promise<PoolReserves | null> {
    try {
      const [reserves, pairToken0] = await Promise.all([
        this.client.readContract({
          address: pairAddress,
          abi: PAIR_ABI,
          functionName: 'getReserves',
        }),
        this.client.readContract({
          address: pairAddress,
          abi: PAIR_ABI,
          functionName: 'token0',
        }),
      ]);

      const [reserve0, reserve1] = reserves;

      // Determine if our token0 matches the pair's token0
      const isToken0First = pairToken0.toLowerCase() === token0.address.toLowerCase();

      const actualReserve0 = isToken0First ? reserve0 : reserve1;
      const actualReserve1 = isToken0First ? reserve1 : reserve0;

      // Calculate mid price (token1 per token0)
      const reserve0Adjusted = Number(formatUnits(actualReserve0, token0.decimals));
      const reserve1Adjusted = Number(formatUnits(actualReserve1, token1.decimals));
      const midPrice = reserve0Adjusted > 0 ? reserve1Adjusted / reserve0Adjusted : 0;

      return {
        dex: this.config.name,
        poolAddress: pairAddress,
        token0,
        token1,
        reserve0: actualReserve0,
        reserve1: actualReserve1,
        midPrice,
        timestamp: Date.now(),
      };
    } catch (e) {
      logger.error('UniswapV2', 'Failed to get reserves', { error: String(e), pairAddress });
      return null;
    }
  }

  // Get quote using router's getAmountsOut
  async getQuote(
    inputToken: TokenInfo,
    outputToken: TokenInfo,
    inputAmount: bigint
  ): Promise<PriceQuote | null> {
    if (!this.config.routerAddress) {
      logger.error('UniswapV2', 'Router address not configured');
      return null;
    }

    try {
      const amounts = await this.client.readContract({
        address: this.config.routerAddress,
        abi: ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [inputAmount, [inputToken.address, outputToken.address]],
      });

      const outputAmount = amounts[1];

      // Calculate price (output per input)
      const inputAdjusted = Number(formatUnits(inputAmount, inputToken.decimals));
      const outputAdjusted = Number(formatUnits(outputAmount, outputToken.decimals));
      const price = inputAdjusted > 0 ? outputAdjusted / inputAdjusted : 0;

      // Estimate price impact by comparing with mid price
      const pairAddress = await this.getPairAddress(inputToken.address, outputToken.address);
      let priceImpact = 0;

      if (pairAddress) {
        const reserves = await this.getReserves(pairAddress, inputToken, outputToken);
        if (reserves && reserves.midPrice > 0) {
          priceImpact = Math.abs((price - reserves.midPrice) / reserves.midPrice) * 100;
        }
      }

      return {
        dex: this.config.name,
        inputToken,
        outputToken,
        inputAmount,
        outputAmount,
        price,
        priceImpact,
        timestamp: Date.now(),
      };
    } catch (e) {
      logger.error('UniswapV2', 'Failed to get quote', { error: String(e) });
      return null;
    }
  }

  // Get token info from contract
  async getTokenInfo(address: `0x${string}`): Promise<TokenInfo | null> {
    try {
      const [decimals, symbol] = await Promise.all([
        this.client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
        this.client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: 'symbol',
        }),
      ]);

      return {
        address,
        symbol,
        decimals,
      };
    } catch (e) {
      logger.error('UniswapV2', 'Failed to get token info', { error: String(e), address });
      return null;
    }
  }
}

// Pre-configured adapters for common DEXs
export function createPlasmaAdapter(rpcUrl: string = 'https://rpc.plasma.to'): UniswapV2Adapter {
  return new UniswapV2Adapter({
    name: 'Plasma-DEX',
    type: 'uniswap-v2',
    chainId: 9745,
    rpcUrl,
    // These addresses need to be filled with actual Plasma DEX addresses
    routerAddress: undefined, // TODO: Add actual router address
    factoryAddress: undefined, // TODO: Add actual factory address
  });
}
