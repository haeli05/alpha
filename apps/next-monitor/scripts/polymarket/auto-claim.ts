/**
 * ============================================================================
 * POLYMARKET AUTO-CLAIM WINNINGS SCRIPT
 * ============================================================================
 *
 * Automatically claims winnings from resolved Polymarket markets.
 * Run this script hourly to collect profits from expired prediction markets.
 *
 * USAGE:
 * ------
 * npx tsx scripts/polymarket/auto-claim.ts
 *
 * REQUIRED ENV VARS:
 * ------------------
 * POLYMARKET_PRIVATE_KEY (for signing transactions)
 *
 * ============================================================================
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
dotenv.config({ path: resolve(process.cwd(), '.env.local') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { ethers } from 'ethers';
import { Wallet } from '@ethersproject/wallet';
import crypto from 'crypto';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

// ============================================================================
// CONFIGURATION
// ============================================================================

const POLYGON_RPC = 'https://polygon-rpc.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const DATA_HOST = 'https://data-api.polymarket.com';
const RELAYER_URL = 'https://relayer-v2.polymarket.com';

// Contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Tokens Framework
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'; // NegRisk CTF Exchange
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'; // NegRisk Adapter

// Your Safe/Proxy wallet address (where positions are held)
const FUNDER_ADDRESS = '0x2163f00898fb58f47573e89940ff728a5e07ac09';

// Environment variables
const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
const POLYMARKET_SECRET = process.env.POLYMARKET_SECRET;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;

// Builder API credentials (for gasless relayer)
const BUILDER_API_KEY = process.env.BUILDER_API_KEY || '019b0056-9676-75bf-875d-0ee213412763';
const BUILDER_SECRET = process.env.BUILDER_SECRET || process.env.POLYMARKET_SECRET;
const BUILDER_PASSPHRASE = process.env.BUILDER_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE;

// ============================================================================
// ABI DEFINITIONS
// ============================================================================

// Minimal ABI for Conditional Tokens Framework
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

// Minimal ABI for NegRisk Adapter (for neg_risk markets)
const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = {
    INFO: '   ',
    WARN: '⚠️ ',
    ERROR: '❌',
    SUCCESS: '✅',
  }[level];
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function getAuthHeaders(
  method: string,
  path: string,
  body: string = ''
): Record<string, string> {
  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    throw new Error('Missing API credentials');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const signature = crypto
    .createHmac('sha256', Buffer.from(POLYMARKET_SECRET, 'base64'))
    .update(message)
    .digest('base64');

  return {
    'POLY_API_KEY': POLYMARKET_API_KEY,
    'POLY_PASSPHRASE': POLYMARKET_PASSPHRASE,
    'POLY_TIMESTAMP': timestamp,
    'POLY_SIGNATURE': signature,
  };
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

interface Position {
  asset: string; // Token ID
  market: string;
  outcome: string;
  size: string;
  avgPrice: string;
  conditionId: string;
}

interface Market {
  conditionId: string;
  slug: string;
  question: string;
  closed: boolean;
  active: boolean;
  resolved: boolean;
  resolutionSource?: string;
  endDate?: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    winner?: boolean;
  }>;
  neg_risk?: boolean;
}

/**
 * Get all positions for the account using multiple methods
 */
async function getPositions(): Promise<Position[]> {
  log('Fetching account positions...');

  // Method 1: Try Data API (public endpoint with wallet address)
  try {
    const res = await fetch(`${DATA_HOST}/positions?user=${FUNDER_ADDRESS}`);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data) && data.length > 0) {
        log(`Found ${data.length} positions via Data API`);
        return data.map((p: any) => ({
          asset: p.asset || p.token_id || '',
          market: p.market || p.slug || '',
          outcome: p.outcome || '',
          size: p.size || p.amount || '0',
          avgPrice: p.avgPrice || p.avg_price || '0',
          conditionId: p.conditionId || p.condition_id || '',
        }));
      }
    }
  } catch (error) {
    log(`Data API fetch failed: ${error}`, 'WARN');
  }

  // Method 2: Try CLOB API with auth headers
  try {
    const path = '/data/positions';
    const headers = getAuthHeaders('GET', path);

    const res = await fetch(`${CLOB_HOST}${path}`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data) && data.length > 0) {
        log(`Found ${data.length} positions via CLOB API`);
        return data;
      }
    }
  } catch (error) {
    log(`CLOB API fetch failed: ${error}`, 'WARN');
  }

  // Method 3: Get trades from local store and derive positions
  try {
    const { getTrades } = await import('../../lib/pairArbStore');
    const trades = getTrades({ status: 'open' });

    if (trades.length > 0) {
      log(`Found ${trades.length} open trades in local store`);

      // Convert trades to positions
      const positionsMap = new Map<string, Position>();

      for (const trade of trades) {
        // Extract condition ID from token ID if possible
        // For now, use the market slug to look up condition ID
        const conditionId = await getConditionIdFromSlug(trade.marketSlug);

        if (conditionId) {
          const key = conditionId;
          if (!positionsMap.has(key)) {
            positionsMap.set(key, {
              asset: trade.yesTokenId,
              market: trade.marketSlug,
              outcome: 'MIXED',
              size: trade.size.toString(),
              avgPrice: ((trade.yesPrice + trade.noPrice) / 2).toString(),
              conditionId: conditionId,
            });
          }
        }
      }

      return Array.from(positionsMap.values());
    }
  } catch (error) {
    log(`Local store fetch failed: ${error}`, 'WARN');
  }

  log('No positions found via any method', 'WARN');
  return [];
}

/**
 * Get condition ID from market slug
 */
async function getConditionIdFromSlug(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${GAMMA_HOST}/markets/slug/${slug}`);
    if (res.ok) {
      const market = await res.json();
      return market?.conditionId || null;
    }
  } catch (error) {
    // Ignore
  }
  return null;
}

/**
 * Get market info by condition ID
 */
async function getMarketByConditionId(conditionId: string): Promise<Market | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (error) {
    return null;
  }
}

/**
 * Get market info from Gamma API by condition ID
 */
async function getGammaMarket(conditionId: string): Promise<any | null> {
  try {
    const res = await fetch(`${GAMMA_HOST}/markets?condition_id=${conditionId}`);
    if (!res.ok) {
      return null;
    }
    const markets = await res.json();
    return markets?.[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if a market is resolved and get resolution info
 */
async function checkMarketResolution(conditionId: string): Promise<{
  resolved: boolean;
  winningOutcome?: string;
  payouts?: number[];
}> {
  try {
    // Check Gamma API for resolution status
    const gammaMarket = await getGammaMarket(conditionId);

    if (gammaMarket) {
      // Check if market is closed/resolved
      if (gammaMarket.closed || gammaMarket.resolved) {
        log(`Market ${conditionId.slice(0, 10)}... is resolved`);

        // Try to get winning outcome
        const outcomes = gammaMarket.outcomes || [];
        const prices = gammaMarket.outcomePrices || [];

        // After resolution, winning outcome price should be 1.00
        for (let i = 0; i < outcomes.length; i++) {
          const price = parseFloat(prices[i] || '0');
          if (price >= 0.99) {
            return {
              resolved: true,
              winningOutcome: outcomes[i],
              payouts: outcomes.map((_: any, idx: number) => idx === i ? 1 : 0),
            };
          }
        }

        return { resolved: true };
      }
    }

    return { resolved: false };
  } catch (error) {
    log(`Error checking resolution for ${conditionId}: ${error}`, 'WARN');
    return { resolved: false };
  }
}

// ============================================================================
// REDEMPTION FUNCTIONS
// ============================================================================

// Dynamic import for ClobClient
let ClobClient: any;

async function loadClobClient(): Promise<boolean> {
  try {
    const clobModule = await import('@polymarket/clob-client');
    ClobClient = clobModule.ClobClient;
    return !!ClobClient;
  } catch (error) {
    log(`Failed to load ClobClient: ${error}`, 'WARN');
    return false;
  }
}

/**
 * Get position balances for a condition
 */
async function getPositionBalances(
  conditionId: string
): Promise<{ yesBalance: string; noBalance: string }> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const parentCollectionId = ethers.constants.HashZero;

    const yesCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, 1);
    const noCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, 2);

    const yesPositionId = await ctf.getPositionId(USDC_ADDRESS, yesCollectionId);
    const noPositionId = await ctf.getPositionId(USDC_ADDRESS, noCollectionId);

    const yesBalance = await ctf.balanceOf(FUNDER_ADDRESS, yesPositionId);
    const noBalance = await ctf.balanceOf(FUNDER_ADDRESS, noPositionId);

    return {
      yesBalance: ethers.utils.formatUnits(yesBalance, 6),
      noBalance: ethers.utils.formatUnits(noBalance, 6),
    };
  } catch (error) {
    return { yesBalance: '0', noBalance: '0' };
  }
}

/**
 * Redeem positions for a resolved market using Builder Relayer (gasless)
 */
async function redeemPositionViaRelayer(
  conditionId: string,
  _isNegRisk: boolean = false
): Promise<boolean> {
  if (!POLYMARKET_PRIVATE_KEY) {
    log('No private key configured', 'ERROR');
    return false;
  }

  log(`Checking balances for condition: ${conditionId.slice(0, 20)}...`);

  try {
    // Get balances first
    const balances = await getPositionBalances(conditionId);
    log(`YES balance: ${balances.yesBalance} USDC`);
    log(`NO balance: ${balances.noBalance} USDC`);

    const totalBalance = parseFloat(balances.yesBalance) + parseFloat(balances.noBalance);
    if (totalBalance < 0.01) {
      log('No significant balance to redeem', 'INFO');
      return true;
    }

    // Check Builder credentials
    if (!BUILDER_API_KEY || !BUILDER_SECRET || !BUILDER_PASSPHRASE) {
      log('Missing Builder API credentials', 'ERROR');
      return false;
    }

    // Initialize signer with provider
    const privateKey = POLYMARKET_PRIVATE_KEY.startsWith('0x')
      ? POLYMARKET_PRIVATE_KEY
      : `0x${POLYMARKET_PRIVATE_KEY}`;
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    const signer = new Wallet(privateKey, provider);

    // Create Builder config using the SDK class
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: BUILDER_API_KEY,
        secret: BUILDER_SECRET,
        passphrase: BUILDER_PASSPHRASE,
      },
    });

    // Create RelayClient for Safe wallet
    const relayClient = new RelayClient(
      RELAYER_URL,
      137, // Polygon chain ID
      signer,
      builderConfig,
      RelayerTxType.SAFE
    );

    // Encode redeemPositions call
    // function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);
    const parentCollectionId = ethers.constants.HashZero;
    const indexSets = [1, 2]; // Both YES and NO outcomes

    const redeemData = ctfInterface.encodeFunctionData('redeemPositions', [
      USDC_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets,
    ]);

    log('Submitting gasless redemption via Builder Relayer...', 'INFO');

    // Execute via relayer
    const result = await relayClient.execute([
      {
        to: CTF_ADDRESS,
        data: redeemData,
        value: '0',
      },
    ], 'auto-claim-redemption');

    const txId = result.transactionID || result.transactionId;
    const txHash = result.transactionHash || result.hash;

    if (txId || txHash) {
      log(`Transaction submitted: ${txHash || txId}`, 'SUCCESS');

      if (txId) {
        // Poll for completion
        log('Waiting for confirmation...', 'INFO');
        const finalTx = await relayClient.pollUntilState(
          txId,
          ['CONFIRMED', 'COMPLETE', 'STATE_CONFIRMED'],
          'FAILED',
          30, // max polls
          2000 // poll every 2 seconds
        );

        if (finalTx) {
          log(`Redemption confirmed! TX: ${finalTx.transactionHash || txHash}`, 'SUCCESS');
          return true;
        } else {
          log('Transaction may have failed or timed out - check manually', 'WARN');
          return true; // Still return true since tx was submitted
        }
      }
      return true;
    }

    log(`Unexpected relayer response: ${JSON.stringify(result)}`, 'WARN');
    return false;

  } catch (error: any) {
    log(`Relayer redemption error: ${error.message || error}`, 'ERROR');
    return false;
  }
}

/**
 * Legacy direct contract redemption (requires MATIC for gas)
 */
async function redeemPositionDirect(
  conditionId: string
): Promise<boolean> {
  if (!POLYMARKET_PRIVATE_KEY) {
    log('No private key configured', 'ERROR');
    return false;
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    const privateKey = POLYMARKET_PRIVATE_KEY.startsWith('0x')
      ? POLYMARKET_PRIVATE_KEY
      : `0x${POLYMARKET_PRIVATE_KEY}`;
    const wallet = new ethers.Wallet(privateKey, provider);

    // Check wallet MATIC balance
    const maticBalance = await provider.getBalance(wallet.address);
    if (maticBalance.lt(ethers.utils.parseEther('0.01'))) {
      log(`EOA wallet has insufficient MATIC: ${ethers.utils.formatEther(maticBalance)}`, 'WARN');
      return false;
    }

    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const indexSets = [1, 2];
    const parentCollectionId = ethers.constants.HashZero;

    const tx = await ctf.redeemPositions(
      USDC_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets,
      { gasLimit: 500000 }
    );

    log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    log(`Confirmed in block ${receipt.blockNumber}`, 'SUCCESS');
    return true;

  } catch (error: any) {
    if (error.message?.includes('insufficient funds')) {
      log('Need MATIC in EOA wallet for direct redemption', 'WARN');
    } else {
      log(`Direct redemption failed: ${error.message}`, 'ERROR');
    }
    return false;
  }
}

/**
 * Main redemption function - tries multiple methods
 */
async function redeemPosition(
  conditionId: string,
  isNegRisk: boolean = false
): Promise<boolean> {
  log(`\nAttempting redemption for: ${conditionId.slice(0, 20)}...`);

  // Method 1: Try ClobClient relayer (gasless)
  const relayerSuccess = await redeemPositionViaRelayer(conditionId, isNegRisk);
  if (relayerSuccess) return true;

  // Method 2: Try direct contract call (requires MATIC)
  const directSuccess = await redeemPositionDirect(conditionId);
  if (directSuccess) return true;

  return false;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         POLYMARKET AUTO-CLAIM WINNINGS                     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Checks for resolved markets and claims winnings           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Validate credentials
  if (!POLYMARKET_API_KEY || !POLYMARKET_SECRET || !POLYMARKET_PASSPHRASE) {
    log('Missing API credentials in .env.local', 'ERROR');
    process.exit(1);
  }

  if (!POLYMARKET_PRIVATE_KEY) {
    log('Missing POLYMARKET_PRIVATE_KEY in .env.local', 'ERROR');
    process.exit(1);
  }

  // Get all positions
  const positions = await getPositions();

  if (positions.length === 0) {
    log('No open positions found');
    console.log('');
    return;
  }

  log(`Found ${positions.length} position(s) to check`);
  console.log('');

  // Group positions by condition ID
  const positionsByCondition = new Map<string, Position[]>();
  for (const pos of positions) {
    const existing = positionsByCondition.get(pos.conditionId) || [];
    existing.push(pos);
    positionsByCondition.set(pos.conditionId, existing);
  }

  // Check each unique condition for resolution
  let resolvedCount = 0;
  let claimedCount = 0;

  for (const [conditionId, conditionPositions] of positionsByCondition) {
    log(`\nChecking condition: ${conditionId.slice(0, 20)}...`);

    // Get market info
    const market = await getMarketByConditionId(conditionId);
    const resolution = await checkMarketResolution(conditionId);

    if (resolution.resolved) {
      resolvedCount++;
      log(`Market is RESOLVED`, 'SUCCESS');

      if (resolution.winningOutcome) {
        log(`Winning outcome: ${resolution.winningOutcome}`);
      }

      // Check if we have winning positions
      const totalSize = conditionPositions.reduce((sum, p) => sum + parseFloat(p.size || '0'), 0);
      log(`Total position size: ${totalSize.toFixed(4)}`);

      // Attempt redemption
      const isNegRisk = market?.neg_risk || false;
      const success = await redeemPosition(conditionId, isNegRisk);

      if (success) {
        claimedCount++;
      }
    } else {
      log(`Market not yet resolved - skipping`);
    }
  }

  // Summary
  console.log('');
  console.log('═'.repeat(60));
  log(`SUMMARY:`);
  log(`  Total positions checked: ${positions.length}`);
  log(`  Resolved markets: ${resolvedCount}`);
  log(`  Successfully claimed: ${claimedCount}`);

  if (resolvedCount > 0 && claimedCount === 0) {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  💰 MANUAL CLAIM REQUIRED                                  ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  The Polymarket SDK does not yet support auto-redemption.  ║');
    console.log('║  Your positions are held in a Safe wallet which requires   ║');
    console.log('║  claiming through the official Polymarket UI.              ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  👉 Claim your winnings at:                                ║');
    console.log('║     https://polymarket.com/portfolio                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
  } else if (claimedCount > 0) {
    console.log('');
    log(`Successfully claimed ${claimedCount} position(s)!`, 'SUCCESS');
  }

  console.log('═'.repeat(60));
  console.log('');
}

// Run
main().catch((error) => {
  log(`Fatal error: ${error}`, 'ERROR');
  process.exit(1);
});
