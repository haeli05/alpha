import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

import { providers, Contract, Wallet } from 'ethers';

const POLYGON_RPC = 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
const WALLET_ADDRESS = process.env.POLYMARKET_WALLET_ADDRESS || '0x4c5b36351E6a90e5260D2b991C706008b6b10955';

// Polymarket CTF Exchange address (where allowance needs to be set)
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, -decimals) || '0';
  const decPart = str.slice(-decimals);
  return `${intPart}.${decPart}`;
}

async function main() {
  const provider = new providers.JsonRpcProvider(POLYGON_RPC);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
  
  const balance = await usdc.balanceOf(WALLET_ADDRESS);
  const decimals = await usdc.decimals();
  const allowance = await usdc.allowance(WALLET_ADDRESS, CTF_EXCHANGE);
  
  console.log('='.repeat(50));
  console.log('POLYMARKET WALLET CHECK');
  console.log('='.repeat(50));
  console.log(`Wallet:       ${WALLET_ADDRESS}`);
  console.log(`USDC Balance: $${formatUnits(BigInt(balance.toString()), decimals)}`);
  console.log(`CTF Allowance: $${formatUnits(BigInt(allowance.toString()), decimals)}`);
  console.log('='.repeat(50));
  
  if (balance.eq(0)) {
    console.log('⚠️  No USDC in this wallet!');
    console.log('   You need to deposit USDC to this address on Polygon.');
  }
  
  if (allowance.eq(0)) {
    console.log('⚠️  No allowance set for CTF Exchange!');
    console.log('   You need to approve USDC spending on Polymarket.');
  }
  
  // Also check the private key wallet if different
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (privateKey) {
    const wallet = new Wallet(privateKey);
    if (wallet.address.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
      console.log('\n' + '='.repeat(50));
      console.log('PRIVATE KEY WALLET (DIFFERENT FROM ENV WALLET!)');
      console.log('='.repeat(50));
      const pkBalance = await usdc.balanceOf(wallet.address);
      const pkAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
      console.log(`Wallet:       ${wallet.address}`);
      console.log(`USDC Balance: $${formatUnits(BigInt(pkBalance.toString()), decimals)}`);
      console.log(`CTF Allowance: $${formatUnits(BigInt(pkAllowance.toString()), decimals)}`);
      console.log('='.repeat(50));
    } else {
      console.log('\n✓ Private key matches POLYMARKET_WALLET_ADDRESS');
    }
  }

  // Check proxy wallet (where Polymarket holds trading funds)
  const PROXY_WALLET = '0x2163f00898fb58f47573e89940ff728a5e07ac09';
  console.log('\n' + '='.repeat(50));
  console.log('POLYMARKET PROXY WALLET (Trading Funds)');
  console.log('='.repeat(50));
  const proxyBalance = await usdc.balanceOf(PROXY_WALLET);
  const proxyAllowance = await usdc.allowance(PROXY_WALLET, CTF_EXCHANGE);
  console.log(`Proxy Wallet: ${PROXY_WALLET}`);
  console.log(`USDC Balance: $${formatUnits(BigInt(proxyBalance.toString()), decimals)}`);
  console.log(`CTF Allowance: $${formatUnits(BigInt(proxyAllowance.toString()), decimals)}`);
  console.log('='.repeat(50));

  if (proxyBalance.eq(0)) {
    console.log('⚠️  No USDC in proxy wallet!');
    console.log('   Deposit USDC at: https://polymarket.com/deposit');
  }
}

main().catch(console.error);
