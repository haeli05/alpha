/**
 * POLYMARKET AUTO-CLAIM SCRIPT (Gasless via Relayer)
 *
 * Automatically claims winnings from resolved markets using Polymarket's relayer.
 * No gas needed - Polymarket pays for transactions.
 *
 * USAGE: npx tsx auto-claim.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';
import { utils } from 'ethers';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CHECK_INTERVAL_MS = 10 * 1000; // Check every 10 seconds
const MIN_CLAIM_INTERVAL_MS = 60 * 1000; // Don't claim more than once per minute
const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

// ============================================================================
// API ENDPOINTS
// ============================================================================

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_API_HOST = 'https://data-api.polymarket.com';
const RELAYER_HOST = 'https://relayer-v2.polymarket.com';

// Contract addresses
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Tokens

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'CLAIM' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = { INFO: '   ', WARN: '⚠️ ', ERROR: '❌', CLAIM: '💰' }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// RELAYER CLIENT
// ============================================================================

let RelayClient: any;
let RelayerTxType: any;
let BuilderConfig: any;

async function loadRelayerClient(): Promise<boolean> {
  try {
    const module = await import('@polymarket/builder-relayer-client');
    RelayClient = module.RelayClient;
    RelayerTxType = module.RelayerTxType;

    // Try to load BuilderConfig from builder-signing-sdk
    try {
      const signingModule = await import('@polymarket/builder-signing-sdk');
      BuilderConfig = signingModule.BuilderConfig;
    } catch (e) {
      log('BuilderConfig not available, will try without', 'WARN');
    }

    if (!RelayClient) {
      log(`Available exports: ${Object.keys(module).join(', ')}`, 'INFO');
      throw new Error('RelayClient not found in module');
    }
    return true;
  } catch (error) {
    log(`Failed to load relayer client: ${error}`, 'ERROR');
    return false;
  }
}

// ============================================================================
// POLYMARKET API FUNCTIONS
// ============================================================================

interface Position {
  asset: string;
  conditionId: string;
  size: number;
  outcome: string;
}

async function getPositions(): Promise<Position[]> {
  try {
    const res = await fetch(`${DATA_API_HOST}/positions?user=${PROXY_WALLET.toLowerCase()}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((p: any) => ({
      asset: p.asset || p.tokenId,
      conditionId: p.conditionId || p.condition_id,
      size: parseFloat(p.size || p.amount || '0'),
      outcome: p.outcome || 'Unknown',
    }));
  } catch (error) {
    log(`Error fetching positions: ${error}`, 'ERROR');
    return [];
  }
}

async function getMarketByConditionId(conditionId: string): Promise<any> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    return null;
  }
}

async function isConditionResolved(conditionId: string): Promise<boolean> {
  try {
    const { providers, Contract } = await import('ethers');
    const provider = new providers.JsonRpcProvider('https://polygon-rpc.com');
    const ctf = new Contract(CTF_ADDRESS, [
      'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    ], provider);
    const conditionIdBytes = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;
    const denominator = await ctf.payoutDenominator(conditionIdBytes);
    return denominator.gt(0);
  } catch (error) {
    return false;
  }
}

async function getResolvedPositions(): Promise<{ position: Position; market: any }[]> {
  const positions = await getPositions();
  const resolved: { position: Position; market: any }[] = [];

  log(`Checking ${positions.length} positions...`);

  for (const pos of positions) {
    if (!pos.conditionId || pos.size <= 0) continue;

    // Check on-chain if condition is resolved (payoutDenominator > 0)
    const isResolved = await isConditionResolved(pos.conditionId);

    if (isResolved) {
      const market = await getMarketByConditionId(pos.conditionId);
      log(`Found resolved: ${market?.question?.slice(0, 50) || pos.conditionId.slice(0, 20)}...`);
      resolved.push({ position: pos, market });
    }
  }

  return resolved;
}

// ============================================================================
// CLAIM FUNCTIONS (Gasless via Relayer)
// ============================================================================

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

async function claimViaRelayer(
  relayerClient: any,
  conditionId: string
): Promise<boolean> {
  try {
    const conditionIdBytes = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;
    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const indexSets = [1, 2]; // Both Yes and No outcomes

    // Encode the redeemPositions call
    const iface = new utils.Interface(CTF_ABI);
    const redeemData = iface.encodeFunctionData('redeemPositions', [
      USDC_ADDRESS,
      parentCollectionId,
      conditionIdBytes,
      indexSets,
    ]);

    log(`Claiming via relayer for ${conditionId.slice(0, 15)}...`, 'CLAIM');

    // Execute via relayer (gasless)
    const tx = {
      to: CTF_ADDRESS,
      data: redeemData,
      value: '0',
    };

    const response = await relayerClient.execute([tx], 'Redeem positions');

    if (response) {
      log(`Relayer submitted! Waiting for confirmation...`, 'CLAIM');
      const result = await response.wait();

      if (result && result.status === 1) {
        log(`✅ Successfully claimed! TX: ${result.transactionHash}`, 'CLAIM');
        return true;
      }
    }

    log(`Claim may have failed`, 'WARN');
    return false;
  } catch (error: any) {
    const msg = error.message || String(error);
    if (msg.includes('already') || msg.includes('nothing') || msg.includes('zero')) {
      log(`Already claimed or nothing to claim: ${conditionId.slice(0, 15)}...`, 'INFO');
    } else {
      log(`Claim error: ${msg.slice(0, 100)}`, 'ERROR');
    }
    return false;
  }
}

// ============================================================================
// MAIN
// ============================================================================

let lastClaimTime = 0;
const claimedConditions = new Set<string>();

async function checkAndClaim(relayerClient: any) {
  log('═══════════════════════════════════════════════════════════');

  const resolvedPositions = await getResolvedPositions();

  // Filter already claimed
  const unclaimed = resolvedPositions.filter(
    (r) => !claimedConditions.has(r.position.conditionId)
  );

  if (unclaimed.length === 0) {
    log('No new positions to claim');
    return;
  }

  log(`Found ${unclaimed.length} position(s) to claim`, 'CLAIM');

  // Group by conditionId
  const conditionIds = [...new Set(unclaimed.map((r) => r.position.conditionId))];

  for (const conditionId of conditionIds) {
    const items = unclaimed.filter((r) => r.position.conditionId === conditionId);
    const market = items[0]?.market;
    const totalSize = items.reduce((sum, r) => sum + r.position.size, 0);

    log(`Market: ${market?.question?.slice(0, 45)}...`);
    log(`  Size: ${totalSize.toFixed(2)} shares`);

    const success = await claimViaRelayer(relayerClient, conditionId);
    if (success) {
      claimedConditions.add(conditionId);
    }

    await sleep(2000);
  }

  log('═══════════════════════════════════════════════════════════');
}

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       POLYMARKET AUTO-CLAIM (Gasless via Relayer)          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Wallet:  ${PROXY_WALLET.slice(0, 20)}...                ║`);
  console.log(`║  Check:   Every ${CHECK_INTERVAL_MS / 1000} seconds                                 ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!POLYMARKET_PRIVATE_KEY) {
    log('Missing POLYMARKET_PRIVATE_KEY', 'ERROR');
    process.exit(1);
  }

  // Load relayer client
  log('Loading relayer client...');
  const loaded = await loadRelayerClient();
  if (!loaded) {
    log('Failed to load relayer client', 'ERROR');
    process.exit(1);
  }

  // Initialize relayer client with provider
  const { providers } = await import('ethers');
  const provider = new providers.JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(POLYMARKET_PRIVATE_KEY, provider);
  log(`Signer: ${wallet.address}`);

  let relayerClient: any;
  try {
    // Create builder credentials using CLOB API credentials
    let builderConfig: any = undefined;

    if (BuilderConfig && POLYMARKET_API_KEY && POLYMARKET_SECRET && POLYMARKET_PASSPHRASE) {
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: POLYMARKET_API_KEY,
          secret: POLYMARKET_SECRET,
          passphrase: POLYMARKET_PASSPHRASE,
        },
      });
      log('Using API credentials for builder config');
    }

    // RelayClient(relayerUrl, chainId, signer, builderConfig, relayTxType)
    relayerClient = new RelayClient(
      RELAYER_HOST,
      137, // Polygon
      wallet,
      builderConfig,
      RelayerTxType.SAFE
    );
    log('Relayer client initialized');
  } catch (error) {
    log(`Failed to init relayer: ${error}`, 'ERROR');
    process.exit(1);
  }

  // Initial check
  await checkAndClaim(relayerClient);

  // Periodic checks
  setInterval(async () => {
    const now = Date.now();

    const resolved = await getResolvedPositions();
    const unclaimed = resolved.filter((r) => !claimedConditions.has(r.position.conditionId));

    if (unclaimed.length > 0 && now - lastClaimTime >= MIN_CLAIM_INTERVAL_MS) {
      await checkAndClaim(relayerClient);
      lastClaimTime = Date.now();
    }
  }, CHECK_INTERVAL_MS);

  log('Monitoring for claimable positions...');
}

main().catch(console.error);
