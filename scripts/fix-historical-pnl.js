const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixHistoricalPnl(dryRun = true) {
  try {
    // Find dust trades with entry TX that have wrong PnL
    const dustTrades = await pool.query(`
      SELECT
        id, stock_ticker, buy_symbol,
        size_usd, pnl_usd, pnl_pct,
        entry_tx_signature, entry_fees_usd,
        exit_timestamp
      FROM mean_reversion_positions
      WHERE status = 'closed'
        AND exit_reason = 'dust'
        AND pnl_pct < -50
        AND entry_tx_signature IS NOT NULL
      ORDER BY exit_timestamp DESC
    `);

    console.log(`=== ${dryRun ? 'DRY RUN:' : 'FIXING'} HISTORICAL DUST TRADE PNL ===\n`);
    console.log(`Found ${dustTrades.rows.length} dust trades to fix\n`);

    let updatedCount = 0;
    let totalAdjustment = 0;

    for (const trade of dustTrades.rows) {
      const oldPnlUsd = Number(trade.pnl_usd || 0);
      const oldPnlPct = Number(trade.pnl_pct || 0);

      // Correct PnL: Only entry fees lost (not entire position)
      const newPnlUsd = -(Number(trade.entry_fees_usd || 0) || 0.01);
      const newPnlPct = Number(trade.size_usd) > 0
        ? (newPnlUsd / Number(trade.size_usd)) * 100
        : 0;

      const adjustment = newPnlUsd - oldPnlUsd;
      totalAdjustment += adjustment;

      const exitDate = new Date(Number(trade.exit_timestamp));
      console.log(`[${trade.stock_ticker}] ${exitDate.toISOString().slice(0, 10)} - ${trade.id}`);
      console.log(`  Old: $${oldPnlUsd.toFixed(2)} (${oldPnlPct.toFixed(1)}%)`);
      console.log(`  New: $${newPnlUsd.toFixed(4)} (${newPnlPct.toFixed(2)}%)`);
      console.log(`  Adjustment: +$${adjustment.toFixed(2)}`);

      if (!dryRun) {
        await pool.query(
          `UPDATE mean_reversion_positions
           SET pnl_usd = $1, pnl_pct = $2
           WHERE id = $3`,
          [newPnlUsd, newPnlPct, trade.id]
        );
        console.log(`  ✓ Updated`);
        updatedCount++;
      } else {
        console.log(`  [DRY RUN - would update]`);
      }
      console.log('');
    }

    console.log('=== SUMMARY ===');
    console.log(`Trades ${dryRun ? 'to fix' : 'fixed'}: ${dustTrades.rows.length}`);
    if (!dryRun) {
      console.log(`Successfully updated: ${updatedCount}`);
    }
    console.log(`Total PnL adjustment: +$${totalAdjustment.toFixed(2)}`);
    console.log('');

    if (dryRun) {
      console.log('🚨 DRY RUN MODE - No changes made');
      console.log('To apply fixes, run: node scripts/fix-historical-pnl.js --apply');
    } else {
      console.log('✅ Historical PnL corrections applied');
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await pool.end();
    process.exit(1);
  }
}

// Check if --apply flag is passed
const applyMode = process.argv.includes('--apply');
fixHistoricalPnl(!applyMode);
