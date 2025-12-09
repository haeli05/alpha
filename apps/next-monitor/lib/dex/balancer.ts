// Balancer V2 price adapter
import { createPublicClient, http, parseAbi, formatUnits, type PublicClient } from 'viem';
import type { TokenInfo, PriceQuote, DexConfig } from './types';
import { logger } from '@/lib/logger';

// Balancer V2 Vault ABI (partial)
const VAULT_ABI = parseAbi([
  'function getPoolTokens(bytes32 poolId) external view returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)',
]);

// Balancer V2 Pool ABI (partial)
const POOL_ABI = parseAbi([
  'function getPoolId() external view returns (bytes32)',
  'function getSwapFeePercentage() external view returns (uint256)',
  'function getNormalizedWeights() external view returns (uint256[] memory)',
]);

// Balancer Queries contract for simulating swaps
const QUERIES_ABI = parseAbi([
  'function querySwap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) external returns (uint256)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
]);

// Known Balancer V2 addresses
const BALANCER_ADDRESSES: Record<number, { vault: `0x${string}`; queries: `0x${string}` }> = {
  1: {
    vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    queries: '0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5',
  },
  137: {
    vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    queries: '0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5',
  },
  42161: {
    vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    queries: '0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5',
  },
};

export class BalancerAdapter {
  private client: PublicClient;
  private config: DexConfig;
  private vaultAddress: `0x${string}`;
  private queriesAddress: `0x${string}`;

  constructor(config: DexConfig) {
    this.config = config;
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });

    const addresses = BALANCER_ADDRESSES[config.chainId];
    if (!addresses) {
      throw new Error(`Balancer not supported on chain ${config.chainId}`);
    }
    this.vaultAddress = addresses.vault;
    this.queriesAddress = addresses.queries;
  }

  // Get pool tokens and balances
  async getPoolTokens(
    poolId: `0x${string}`
  ): Promise<{ tokens: `0x${string}`[]; balances: bigint[] } | null> {
    try {
      const result = await this.client.readContract({
        address: this.vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getPoolTokens',
        args: [poolId],
      });

      return {
        tokens: result[0] as `0x${string}`[],
        balances: result[1] as bigint[],
      };
    } catch (e) {
      logger.error('Balancer', 'Failed to get pool tokens', { error: String(e), poolId });
      return null;
    }
  }

  // Get quote using Balancer Queries contract
  async getQuote(
    poolId: `0x${string}`,
    inputToken: TokenInfo,
    outputToken: TokenInfo,
    inputAmount: bigint
  ): Promise<PriceQuote | null> {
    try {
      // SwapKind.GIVEN_IN = 0
      const singleSwap = {
        poolId,
        kind: 0 as const,
        assetIn: inputToken.address,
        assetOut: outputToken.address,
        amount: inputAmount,
        userData: '0x' as `0x${string}`,
      };

      const funds = {
        sender: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        fromInternalBalance: false,
        recipient: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        toInternalBalance: false,
      };

      const outputAmount = await this.client.readContract({
        address: this.queriesAddress,
        abi: QUERIES_ABI,
        functionName: 'querySwap',
        args: [singleSwap, funds],
      });

      // Calculate price
      const inputAdjusted = Number(formatUnits(inputAmount, inputToken.decimals));
      const outputAdjusted = Number(formatUnits(outputAmount, outputToken.decimals));
      const price = inputAdjusted > 0 ? outputAdjusted / inputAdjusted : 0;

      // Get pool balances for price impact calculation
      const poolTokens = await this.getPoolTokens(poolId);
      let priceImpact = 0;

      if (poolTokens) {
        const inputIndex = poolTokens.tokens.findIndex(
          t => t.toLowerCase() === inputToken.address.toLowerCase()
        );
        const outputIndex = poolTokens.tokens.findIndex(
          t => t.toLowerCase() === outputToken.address.toLowerCase()
        );

        if (inputIndex >= 0 && outputIndex >= 0) {
          const inputReserve = poolTokens.balances[inputIndex];
          const outputReserve = poolTokens.balances[outputIndex];

          // Simple price impact estimation
          const reserveRatio = Number(formatUnits(outputReserve, outputToken.decimals)) /
            Number(formatUnits(inputReserve, inputToken.decimals));
          priceImpact = Math.abs((price - reserveRatio) / reserveRatio) * 100;
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
      logger.error('Balancer', 'Failed to get quote', { error: String(e) });
      return null;
    }
  }

  // Get token info
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
      logger.error('Balancer', 'Failed to get token info', { error: String(e), address });
      return null;
    }
  }
}

// Create Balancer adapter for specific chain
export function createBalancerAdapter(
  chainId: number,
  rpcUrl: string
): BalancerAdapter {
  return new BalancerAdapter({
    name: `Balancer-${chainId}`,
    type: 'balancer',
    chainId,
    rpcUrl,
  });
}
