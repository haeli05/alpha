import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

export type DefiConfig = {
  rpcUrl: string;
  chainId?: number;
  privateKey?: `0x${string}`; // NEVER commit real keys
};

export function makeClients(cfg: DefiConfig) {
  const chain = cfg.chainId === 1 || !cfg.chainId ? mainnet : { ...mainnet, id: cfg.chainId };
  const transport = http(cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport });
  let wallet: ReturnType<typeof createWalletClient> | null = null;
  if (cfg.privateKey) {
    const account = privateKeyToAccount(cfg.privateKey);
    wallet = createWalletClient({ chain, transport, account });
  }
  return { pub, wallet };
}

export async function simulateAndSend({
  cfg,
  to,
  data,
  value,
  gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
}: {
  cfg: DefiConfig;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}) {
  const { pub, wallet } = makeClients(cfg);
  if (!wallet) throw new Error('Wallet client missing (no private key provided)');
  const acc = wallet.account!;
  // Dry-run the call
  await pub.call({ to, data, value });
  // Send the transaction
  const hash = await wallet.sendTransaction({ account: wallet.account!, chain: (wallet as any).chain, to, data, value, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas } as any);
  return { hash };
}

// NOTE: For real swaps, generate calldata via an aggregator (0x/1inch) or a router SDK,
// then use simulateAndSend to preview and submit with your slippage/timing controls.
