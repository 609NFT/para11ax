const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeHistoricalPnl() {
  try {
    // Find dust trades with suspicious PnL
    const dustTrades = await pool.query(`
      SELECT
        id, stock_ticker, buy_symbol,
        entry_timestamp, exit_timestamp,
        size_usd, pnl_usd, pnl_pct,
        entry_tx_signature, exit_tx_signature,
        entry_fees_usd, exit_fees_usd, total_fees_usd,
        exit_reason
      FROM mean_reversion_positions
      WHERE status = 'closed'
        AND exit_reason = 'dust'
        AND pnl_pct < -50
      ORDER BY exit_timestamp DESC
      LIMIT 50
    `);

    console.log('=== HISTORICAL DUST TRADES WITH SUSPICIOUS PNL ===\n');
    console.log(`Found ${dustTrades.rows.length} dust trades with >50% loss\n`);

    let totalWrongPnl = 0;
    let totalCorrectPnl = 0;
    let tradesWithEntryTx = 0;

    for (const trade of dustTrades.rows) {
      const hasEntryTx = !!trade.entry_tx_signature;
      if (hasEntryTx) tradesWithEntryTx++;

      const wrongPnl = Number(trade.pnl_usd || 0);

      // Correct PnL for live trades with entry TX: only entry fees lost
      const correctPnl = hasEntryTx
        ? -(Number(trade.entry_fees_usd || 0) || 0.01)
        : wrongPnl; // Keep paper trade calculation as-is

      const difference = correctPnl - wrongPnl;

      totalWrongPnl += wrongPnl;
      totalCorrectPnl += correctPnl;

      const exitDate = new Date(Number(trade.exit_timestamp));
      console.log(`[${trade.stock_ticker}] ${exitDate.toISOString().slice(0, 10)}`);
      console.log(`  ID: ${trade.id}`);
      console.log(`  Size: $${Number(trade.size_usd).toFixed(2)}`);
      console.log(`  Entry TX: ${hasEntryTx ? 'YES' : 'NO'}`);
      console.log(`  Wrong PnL: $${wrongPnl.toFixed(2)} (${Number(trade.pnl_pct).toFixed(1)}%)`);
      console.log(`  Correct PnL: $${correctPnl.toFixed(2)}`);
      console.log(`  Adjustment needed: +$${difference.toFixed(2)}\n`);
    }

    console.log('=== SUMMARY ===');
    console.log(`Dust trades analyzed: ${dustTrades.rows.length}`);
    console.log(`Trades with entry TX: ${tradesWithEntryTx}`);
    console.log(`Current total PnL: $${totalWrongPnl.toFixed(2)}`);
    console.log(`Correct total PnL: $${totalCorrectPnl.toFixed(2)}`);
    console.log(`Total adjustment: +$${(totalCorrectPnl - totalWrongPnl).toFixed(2)}`);

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

analyzeHistoricalPnl();
