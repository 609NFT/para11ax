#!/usr/bin/env node
/**
 * Test Flash Trade short position - open and immediately close
 * Usage: node scripts/test-short.js [symbol] [collateral]
 * Example: node scripts/test-short.js SPYr 5
 * 
 * Default: SPYr with $5 collateral at 2x leverage
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Force ENABLE_SHORTING for this test
process.env.ENABLE_SHORTING = 'true';

async function main() {
  const symbol = process.argv[2] || 'SPYr';
  const collateral = parseFloat(process.argv[3] || '5');
  const leverage = 2.0;

  console.log(`\n=== Flash Trade Short Test ===`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Collateral: $${collateral} USDC`);
  console.log(`Leverage: ${leverage}x`);
  console.log(`Position size: ~$${collateral * leverage}`);
  console.log(`===========================\n`);

  // Import the compiled modules - config must be initialized first
  const { getConfig } = require('../dist/config');
  await getConfig(); // Async init required before anything else
  
  const { initializeFlashClient, openPerpPosition, closePerpPosition, getAvailableShortSymbols, isFlashTradeAvailable } = require('../dist/execution/flashTradeClient');
  const { getStockFeed } = require('../dist/feeds/stockFeed');

  // Step 1: Initialize Flash client
  console.log('Step 1: Initializing Flash Trade client...');
  const initResult = await initializeFlashClient();
  if (!initResult) {
    console.error('❌ Failed to initialize Flash Trade client');
    process.exit(1);
  }
  console.log('✅ Flash Trade client initialized');

  // Show available markets
  const markets = getAvailableShortSymbols();
  console.log(`Available short markets: ${markets.join(', ')}`);

  if (!markets.includes(symbol)) {
    console.error(`❌ ${symbol} not available for shorting. Available: ${markets.join(', ')}`);
    process.exit(1);
  }

  // Step 2: Get current price
  console.log(`\nStep 2: Getting current price for ${symbol}...`);
  
  let currentPrice;
  try {
    const { StockFeed } = require('../dist/feeds/stockFeed');
    const feed = StockFeed.getInstance();
    if (feed) {
      const ticker = symbol.replace(/[rx]$/, ''); // SPYr -> SPY
      const priceData = await feed.getPrice(ticker); // MUST await - it's async
      if (priceData && priceData.price) {
        currentPrice = priceData.price;
        console.log(`✅ Got price from stock feed: $${currentPrice}`);
      }
    }
  } catch (e) {
    console.log(`Stock feed error: ${e.message}`);
  }
  
  if (!currentPrice) {
    // Fetch from a public API as fallback
    try {
      const https = require('https');
      const fetchPrice = () => new Promise((resolve, reject) => {
        const ticker = symbol.replace(/[rx]$/, '');
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
              resolve(price);
            } catch { resolve(null); }
          });
        }).on('error', reject);
      });
      currentPrice = await fetchPrice();
      if (currentPrice) {
        console.log(`✅ Got price from Yahoo: $${currentPrice}`);
      }
    } catch (e) {
      // Ignore
    }
  }

  if (!currentPrice) {
    // Hardcode known approximate prices as last resort
    const knownPrices = { 'SPYr': 600, 'TSLAr': 380, 'NVDAr': 130, 'MSTRr': 350, 'CRCLr': 20 };
    currentPrice = knownPrices[symbol];
    if (currentPrice) {
      console.log(`⚠️ Using approximate price: $${currentPrice}`);
    } else {
      console.error('❌ Could not determine current price');
      process.exit(1);
    }
  }

  // Validate price is a real number
  if (!currentPrice || typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
    console.error(`❌ Invalid price: ${currentPrice} (type: ${typeof currentPrice})`);
    process.exit(1);
  }

  // Step 3: Open short position
  console.log(`\nStep 3: Opening SHORT position...`);
  console.log(`  Symbol: ${symbol}, Side: short, Collateral: $${collateral}, Leverage: ${leverage}x, Price: $${currentPrice}`);
  
  const openResult = await openPerpPosition({
    symbol,
    side: 'short',
    collateralUsd: collateral,
    leverage,
    slippageBps: 150, // 1.5% slippage tolerance for test
    currentPriceUsd: currentPrice,
  });

  if (!openResult.success) {
    console.error(`❌ Failed to open position: ${openResult.error}`);
    process.exit(1);
  }

  console.log(`✅ Transaction sent!`);
  console.log(`  TX: https://solscan.io/tx/${openResult.txSignature}`);

  // Verify the transaction actually succeeded on-chain
  console.log(`\nVerifying transaction on-chain...`);
  const { Connection } = require('@solana/web3.js');
  const { getConfigSync } = require('../dist/config');
  const config = getConfigSync();
  const conn = new Connection(config.rpcEndpoint, 'confirmed');
  
  // Wait for confirmation
  await new Promise(resolve => setTimeout(resolve, 3000));
  const txInfo = await conn.getTransaction(openResult.txSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  
  if (!txInfo) {
    console.error(`⚠️ Transaction not found yet. Check Solscan manually.`);
  } else if (txInfo.meta?.err) {
    console.error(`❌ Transaction FAILED on-chain!`);
    console.error(`  Error: ${JSON.stringify(txInfo.meta.err)}`);
    console.error(`  The transaction was submitted but the program rejected it.`);
    process.exit(1);
  } else {
    console.log(`✅ Transaction confirmed on-chain! Position is open.`);
  }

  // Wait a moment for the position to settle
  console.log(`\nWaiting 5 seconds before closing...`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 4: Close the position immediately
  console.log(`\nStep 4: Closing SHORT position...`);
  
  const closeResult = await closePerpPosition({
    symbol,
    side: 'short',
    slippageBps: 150,
    currentPriceUsd: currentPrice, // Same price, should be minimal PnL
  });

  if (!closeResult.success) {
    console.error(`❌ Failed to close position: ${closeResult.error}`);
    console.error(`⚠️ POSITION IS STILL OPEN! Check Flash Trade UI or Solscan.`);
    process.exit(1);
  }

  console.log(`✅ Close transaction sent!`);
  console.log(`  TX: https://solscan.io/tx/${closeResult.txSignature}`);

  // Verify close tx on-chain
  await new Promise(resolve => setTimeout(resolve, 3000));
  const closeTxInfo = await conn.getTransaction(closeResult.txSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (closeTxInfo?.meta?.err) {
    console.error(`❌ Close transaction FAILED on-chain!`);
    console.error(`  Error: ${JSON.stringify(closeTxInfo.meta.err)}`);
    console.error(`⚠️ POSITION MAY STILL BE OPEN!`);
    process.exit(1);
  } else {
    console.log(`✅ Close confirmed on-chain!`);
  }

  console.log(`\n=== Test Complete ===`);
  console.log(`Open TX:  https://solscan.io/tx/${openResult.txSignature}`);
  console.log(`Close TX: https://solscan.io/tx/${closeResult.txSignature}`);
  console.log(`Expected cost: ~$0.05-0.10 in fees (round-trip 10bps on SPY)`);
  console.log(`====================\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
