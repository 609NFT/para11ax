#!/usr/bin/env node
/**
 * Verify and fix PnL calculations by checking on-chain transaction data
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { Pool } = require('pg');

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const pool = new Pool({ connectionString: process.env.TRADES_DB_URL });

// USDC mint
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Parse a transaction to extract USDC flow
 */
async function getUSDCFlow(txSignature) {
  try {
    const tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      console.log(`  ⚠️  Transaction not found or no meta: ${txSignature}`);
      return null;
    }

    // Parse token balances to find USDC changes
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let usdcChange = 0;

    // Find USDC account changes
    for (const post of postBalances) {
      if (post.mint !== USDC_MINT) continue;

      const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
      if (!pre) continue;

      const preAmount = parseInt(pre.uiTokenAmount.amount);
      const postAmount = parseInt(post.uiTokenAmount.amount);
      const change = (postAmount - preAmount) / 1e6; // USDC has 6 decimals

      usdcChange += change;
    }

    return {
      usdcChange,
      fee: (tx.meta.fee || 0) / 1e9, // SOL fee in SOL
    };
  } catch (error) {
    console.log(`  ⚠️  Error fetching tx ${txSignature}:`, error.message);
    return null;
  }
}

/**
 * Verify and fix a single trade
 */
async function verifyTrade(trade) {
  console.log(`\n${trade.id} (${trade.stock_ticker}/${trade.buy_symbol}):`);
  console.log(`  Recorded PnL: $${trade.pnl_usd} (${trade.pnl_pct}%)`);

  if (!trade.entry_tx_signature || !trade.exit_tx_signature) {
    console.log(`  ⚠️  Missing tx signatures, skipping`);
    return null;
  }

  // Get entry transaction
  const entryData = await getUSDCFlow(trade.entry_tx_signature);
  if (!entryData) return null;

  // Get exit transaction
  const exitData = await getUSDCFlow(trade.exit_tx_signature);
  if (!exitData) return null;

  // Calculate actual PnL
  // Entry: negative USDC change (spent)
  // Exit: positive USDC change (received)
  const usdcSpent = Math.abs(entryData.usdcChange);
  const usdcReceived = exitData.usdcChange;
  const solFees = entryData.fee + exitData.fee;

  const actualGrossPnL = usdcReceived - usdcSpent;
  const actualNetPnL = actualGrossPnL; // Slippage already in USD flow, don't subtract SOL fees from USD PnL
  const actualPnLPct = (actualNetPnL / usdcSpent) * 100;

  console.log(`  On-chain: Spent $${usdcSpent.toFixed(2)}, Received $${usdcReceived.toFixed(2)}, SOL fees: ${solFees.toFixed(6)}`);
  console.log(`  Actual PnL: $${actualNetPnL.toFixed(2)} (${actualPnLPct.toFixed(2)}%)`);

  // Check if there's a significant discrepancy
  const discrepancy = Math.abs(actualNetPnL - trade.pnl_usd);
  if (discrepancy > 0.01) {
    console.log(`  ❌ DISCREPANCY: $${discrepancy.toFixed(2)} difference!`);
    return {
      id: trade.id,
      recordedPnL: trade.pnl_usd,
      actualPnL: actualNetPnL,
      actualPnLPct,
      discrepancy,
      usdcSpent,
      usdcReceived,
    };
  } else {
    console.log(`  ✓ PnL is correct`);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Fetching suspicious trades...\n');

  // Get all suspicious trades (price_stop_loss with -99% PnL and dust with -99% PnL)
  const result = await pool.query(`
    SELECT
      id, stock_ticker, buy_symbol,
      entry_tx_signature, exit_tx_signature,
      size_usd, pnl_usd, pnl_pct, exit_reason
    FROM mean_reversion_positions
    WHERE status = 'closed'
      AND pnl_pct < -90
      AND exit_tx_signature IS NOT NULL
      AND exit_timestamp >= $1
    ORDER BY exit_timestamp DESC
  `, [Date.now() - 7 * 24 * 60 * 60 * 1000]);

  console.log(`Found ${result.rows.length} suspicious trades to verify\n`);

  const fixes = [];
  for (const trade of result.rows) {
    const fix = await verifyTrade(trade);
    if (fix) {
      fixes.push(fix);
    }
    // Rate limit: wait 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (fixes.length === 0) {
    console.log('\n✅ All trades have correct PnL!');
    await pool.end();
    return;
  }

  console.log(`\n\n📊 SUMMARY: Found ${fixes.length} trades with incorrect PnL\n`);
  for (const fix of fixes) {
    console.log(`${fix.id}: Recorded $${fix.recordedPnL.toFixed(2)} → Actual $${fix.actualPnL.toFixed(2)} (diff: $${fix.discrepancy.toFixed(2)})`);
  }

  // Ask before updating
  console.log(`\n❓ Update these ${fixes.length} trades in Supabase? (This will modify the database)`);
  console.log('   Run with UPDATE=true to proceed\n');

  if (process.env.UPDATE === 'true') {
    console.log('Updating Supabase...\n');
    for (const fix of fixes) {
      await pool.query(`
        UPDATE mean_reversion_positions
        SET pnl_usd = $1, pnl_pct = $2
        WHERE id = $3
      `, [fix.actualPnL, fix.actualPnLPct, fix.id]);
      console.log(`✓ Updated ${fix.id}`);
    }
    console.log('\n✅ All trades updated!');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
