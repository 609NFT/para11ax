#!/usr/bin/env node
/**
 * Comprehensive PnL fix script
 * Handles:
 * 1. Dust/balance_zero exits with null exit_tx_signature (should be PnL = 0)
 * 2. Failed exits with exit_tx but no actual USDC swap (should be PnL = 0)
 * 3. Successful exits with incorrect slippage values
 */

require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const { Pool } = require('pg');

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function getUSDCFlow(txSignature) {
  try {
    const tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      return null;
    }

    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let usdcChange = 0;
    for (const post of postBalances) {
      if (post.mint !== USDC_MINT) continue;
      const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
      if (!pre) continue;
      const preAmount = parseInt(pre.uiTokenAmount.amount);
      const postAmount = parseInt(post.uiTokenAmount.amount);
      usdcChange += (postAmount - preAmount) / 1e6;
    }

    return {
      usdcChange,
      fee: (tx.meta.fee || 0) / 1e9,
      success: !tx.meta.err,
    };
  } catch (error) {
    console.log(`  ⚠️  Error fetching tx ${txSignature}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Finding trades with incorrect PnL...\n');

  // Query recent trades (last 30 days) with issues
  const result = await pool.query(`
    SELECT
      id, stock_ticker, buy_symbol,
      entry_tx_signature, exit_tx_signature,
      size_usd, pnl_usd, pnl_pct, exit_reason,
      total_fees_usd, slippage_usd,
      entry_timestamp, exit_timestamp
    FROM mean_reversion_positions
    WHERE status = 'closed'
      AND exit_timestamp >= $1
      AND (
        -- Case 1: Null exit tx with -100% loss (dust/balance_zero)
        (exit_tx_signature IS NULL AND pnl_pct <= -99)
        -- Case 2: Exit tx exists with suspicious loss
        OR (exit_tx_signature IS NOT NULL AND pnl_pct < -90)
        -- Case 3: Insane slippage values
        OR (slippage_usd > size_usd * 10)
      )
    ORDER BY exit_timestamp DESC
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000]);

  console.log(`Found ${result.rows.length} suspicious trades\n`);

  const fixes = [];

  for (const trade of result.rows) {
    console.log(`\n${trade.id} (${trade.stock_ticker}/${trade.buy_symbol}):`);
    console.log(`  Recorded PnL: $${trade.pnl_usd?.toFixed(2)} (${trade.pnl_pct?.toFixed(2)}%)`);
    console.log(`  Exit reason: ${trade.exit_reason}`);
    console.log(`  Exit tx: ${trade.exit_tx_signature || 'NULL'}`);

    // Case 1: No exit transaction (dust/balance_zero)
    if (!trade.exit_tx_signature) {
      console.log(`  ❌ No exit transaction - setting PnL to $0`);
      fixes.push({
        id: trade.id,
        type: 'no_exit_tx',
        oldPnL: trade.pnl_usd,
        newPnL: 0,
        newPnLPct: 0,
      });
      continue;
    }

    // Case 2 & 3: Verify on-chain data
    const entryData = await getUSDCFlow(trade.entry_tx_signature);
    const exitData = await getUSDCFlow(trade.exit_tx_signature);

    if (!entryData || !exitData) {
      console.log(`  ⚠️  Cannot fetch transaction data, skipping`);
      continue;
    }

    const usdcSpent = Math.abs(entryData.usdcChange);
    const usdcReceived = exitData.usdcChange;
    const actualPnL = usdcReceived - usdcSpent;
    const actualPnLPct = (actualPnL / usdcSpent) * 100;

    console.log(`  On-chain: Spent $${usdcSpent.toFixed(2)}, Received $${usdcReceived.toFixed(2)}`);
    console.log(`  Actual PnL: $${actualPnL.toFixed(2)} (${actualPnLPct.toFixed(2)}%)`);

    const pnlDiscrepancy = Math.abs(actualPnL - (trade.pnl_usd || 0));

    // If there's a significant PnL discrepancy
    if (pnlDiscrepancy > 0.50) {
      console.log(`  ❌ PnL DISCREPANCY: $${pnlDiscrepancy.toFixed(2)} difference!`);
      fixes.push({
        id: trade.id,
        type: 'incorrect_pnl',
        oldPnL: trade.pnl_usd,
        newPnL: actualPnL,
        newPnLPct: actualPnLPct,
        usdcSpent,
        usdcReceived,
      });
    } else if ((trade.slippage_usd || 0) > usdcSpent * 10) {
      // Slippage is insanely high but PnL is correct
      console.log(`  ❌ SLIPPAGE ERROR: $${trade.slippage_usd?.toFixed(2)} (should be ~$${Math.abs(actualPnL).toFixed(2)})`);
      console.log(`  ℹ️  PnL is correct, only slippage value needs fixing`);
      // Don't fix - PnL is already correct, just slippage is wrong
    } else {
      console.log(`  ✓ PnL is correct`);
    }

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (fixes.length === 0) {
    console.log('\n✅ All trades have correct PnL!');
    await pool.end();
    return;
  }

  console.log(`\n\n📊 SUMMARY: Found ${fixes.length} trades to fix\n`);
  for (const fix of fixes) {
    console.log(`${fix.id} [${fix.type}]:`);
    console.log(`  Old: $${fix.oldPnL?.toFixed(2)} → New: $${fix.newPnL.toFixed(2)}`);
  }

  const totalLossRecovered = fixes.reduce((sum, f) => sum + ((f.oldPnL || 0) - f.newPnL), 0);
  console.log(`\nTotal incorrect losses: $${totalLossRecovered.toFixed(2)}\n`);

  console.log('❓ Update these trades in Supabase?');
  console.log('   Run with UPDATE=true to proceed\n');

  if (process.env.UPDATE === 'true') {
    console.log('Updating Supabase...\n');
    for (const fix of fixes) {
      await pool.query(`
        UPDATE mean_reversion_positions
        SET pnl_usd = $1, pnl_pct = $2
        WHERE id = $3
      `, [fix.newPnL, fix.newPnLPct, fix.id]);
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
