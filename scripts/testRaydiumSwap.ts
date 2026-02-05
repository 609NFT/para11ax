/**
 * Test Raydium Direct Swap
 *
 * Tests a small USDC -> xSPY swap on Raydium CLMM
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getRaydiumClient } from '../src/execution/raydiumClient';

const XSPY_POOL = '7sHMnvE7WqP7vQFWJGEnMT4vZg6Za9K7PpddDoXJCqME';
const XSPY_MINT = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const TEST_AMOUNT_USDC = 0.50; // $0.50 test swap

async function main() {
  console.log('='.repeat(60));
  console.log('Raydium Direct Swap Test');
  console.log('='.repeat(60));

  // Load wallet
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: SOLANA_PRIVATE_KEY not set');
    process.exit(1);
  }

  let wallet: Keypair;
  try {
    if (privateKey.startsWith('[')) {
      wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(privateKey)));
    } else {
      wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    }
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  } catch (error) {
    console.error('Failed to load wallet:', error);
    process.exit(1);
  }

  // Initialize Raydium client
  console.log('\nInitializing Raydium client...');
  const raydium = getRaydiumClient();
  const initialized = await raydium.initialize(wallet);

  if (!initialized) {
    console.error('Failed to initialize Raydium client');
    process.exit(1);
  }
  console.log('Raydium client initialized');

  // Load pool
  console.log(`\nLoading pool: ${XSPY_POOL}`);
  const poolData = await raydium.loadPool(XSPY_POOL);
  if (!poolData) {
    console.error('Failed to load pool');
    process.exit(1);
  }
  console.log(`Pool loaded:`);
  console.log(`  MintA: ${poolData.poolInfo.mintA.symbol} (${poolData.poolInfo.mintA.address})`);
  console.log(`  MintB: ${poolData.poolInfo.mintB.symbol} (${poolData.poolInfo.mintB.address})`);
  console.log(`  Price: ${poolData.poolInfo.price}`);

  // Get quote first
  console.log(`\nGetting quote for $${TEST_AMOUNT_USDC} USDC -> xSPY...`);
  const quote = await raydium.getQuote(
    XSPY_POOL,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    TEST_AMOUNT_USDC,
    6 // USDC decimals
  );

  if (!quote) {
    console.error('Failed to get quote');
    process.exit(1);
  }

  console.log(`Quote:`);
  console.log(`  Input: $${TEST_AMOUNT_USDC} USDC`);
  console.log(`  Output: ${quote.amountOut.toFixed(8)} xSPY`);
  console.log(`  Min Output: ${quote.minAmountOut.toFixed(8)} xSPY`);
  console.log(`  Price Impact: ${quote.priceImpact.toFixed(4)}%`);
  console.log(`  Effective Price: $${(TEST_AMOUNT_USDC / quote.amountOut).toFixed(4)} per xSPY`);

  // Ask for confirmation
  console.log('\n' + '='.repeat(60));
  console.log(`Ready to swap $${TEST_AMOUNT_USDC} USDC for ~${quote.amountOut.toFixed(6)} xSPY`);
  console.log('='.repeat(60));

  // Check for --execute flag
  if (!process.argv.includes('--execute')) {
    console.log('\nDry run complete. Add --execute flag to perform the actual swap.');
    console.log('Example: npx ts-node scripts/testRaydiumSwap.ts --execute');
    process.exit(0);
  }

  // Execute swap
  console.log('\nExecuting swap...');
  const result = await raydium.buy(XSPY_POOL, XSPY_MINT, TEST_AMOUNT_USDC, 300); // 3% slippage

  if (result.success) {
    console.log('\n✅ SWAP SUCCESSFUL!');
    console.log(`  TX: ${result.txSignature}`);
    console.log(`  Input: ${result.inputAmount} USDC`);
    console.log(`  Output: ${result.outputAmount} xSPY`);
    console.log(`  Solscan: https://solscan.io/tx/${result.txSignature}`);
  } else {
    console.error('\n❌ SWAP FAILED');
    console.error(`  Error: ${result.error}`);
  }
}

main().catch(console.error);
