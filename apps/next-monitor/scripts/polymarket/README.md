# Polymarket Trading Scripts

Trading automation scripts for Polymarket.

## Setup

1. Add your credentials to `.env.local` in the project root:

```bash
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_api_secret
POLYMARKET_PASSPHRASE=your_passphrase
POLYMARKET_PRIVATE_KEY=0x_your_wallet_private_key
```

2. Make sure you have the Polymarket CLOB client installed:

```bash
npm install @polymarket/clob-client
```

## Scripts

### check-account.ts

Tests your API connection and shows current positions/orders.

```bash
npx tsx scripts/polymarket/check-account.ts
```

### buy-sell-sample.ts

Sample script that:
1. Buys $1 of YES shares on a market
2. Waits 10 minutes
3. Sells all shares

```bash
npx tsx scripts/polymarket/buy-sell-sample.ts
```

## Getting Your Private Key

To trade, you need your wallet's private key:

### MetaMask:
1. Click the three dots menu → Account Details
2. Click "Show Private Key"
3. Enter your password
4. Copy the key (starts with 0x)

### Important Security Notes

- Never share your private key
- Use a dedicated wallet with limited funds for bot trading
- Never commit `.env.local` to git
- The private key gives full access to your wallet funds
