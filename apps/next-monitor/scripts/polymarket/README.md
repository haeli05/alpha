Droplet 138.197.132.207

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


#### VPS Setup:


⏺ Here's how to set it up on your Ubuntu droplet, master:

  1. SSH into your droplet:
  ssh root@YOUR_DROPLET_IP

  2. Install Node.js 20:
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  apt-get install -y nodejs

  3. Install pm2 (keeps script running):
  npm install -g pm2

  4. Clone your repo:
  cd /root
  git clone YOUR_REPO_URL alpha
  cd alpha/apps/next-monitor

  5. Create .env.local:
  nano .env.local
  Add:
  POLYMARKET_API_KEY=your_key
  POLYMARKET_SECRET=your_secret
  POLYMARKET_PASSPHRASE=your_passphrase
  POLYMARKET_PRIVATE_KEY=your_private_key

  6. Install dependencies:
  npm install

  7. Run with pm2:
  pm2 start "npx tsx scripts/polymarket/copy-trade.ts" --name copy-trade

  Useful pm2 commands:
  pm2 logs copy-trade     # View logs
  pm2 status              # Check status
  pm2 restart copy-trade  # Restart
  pm2 stop copy-trade     # Stop
  pm2 save                # Save for reboot
  pm2 startup             # Auto-start on reboot

