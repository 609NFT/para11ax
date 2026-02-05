const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function auditFees() {
  try {
    const result = await pool.query(`
      SELECT
        id, stock_ticker, buy_symbol,
        entry_spread_pct, exit_spread_pct, size_usd,
        pnl_usd, pnl_pct,
        entry_tx_signature, exit_tx_signature,
        total_fees_usd, entry_fees_usd, exit_fees_usd,
        priority_fees_usd, network_fees_usd, slippage_usd, platform_fees_usd,
        entry_route, exit_route, exit_reason,
        entry_timestamp, exit_timestamp
      FROM mean_reversion_positions
      WHERE status = 'closed'
        AND exit_timestamp IS NOT NULL
        AND exit_reason != 'dust'
        AND exit_timestamp > (EXTRACT(EPOCH FROM NOW()) * 1000 - 24 * 60 * 60 * 1000)
      ORDER BY exit_timestamp DESC
      LIMIT 10
    `);

    console.log('=== FEE & NAV AUDIT (Last 10 Non-Dust Trades) ===\n');

    let totalDbFees = 0;
    let totalPnl = 0;
    let totalNavDegradation = 0;
    let tradesWithTxSigs = 0;
    let tradesWithFees = 0;

    for (const trade of result.rows) {
      const entryFeesUsd = Number(trade.entry_fees_usd || 0);
      const exitFeesUsd = Number(trade.exit_fees_usd || 0);
      const totalFeesUsd = Number(trade.total_fees_usd || 0);
      const pnlUsd = Number(trade.pnl_usd || 0);
      const sizeUsd = Number(trade.size_usd || 0);

      totalDbFees += totalFeesUsd;
      totalPnl += pnlUsd;

      if (trade.entry_tx_signature) tradesWithTxSigs++;
      if (totalFeesUsd > 0) tradesWithFees++;

      const spreadCaptured = Number(trade.entry_spread_pct || 0) - Number(trade.exit_spread_pct || 0);
      const expectedPnl = sizeUsd * (spreadCaptured / 100);
      const navDegradation = expectedPnl - pnlUsd;
      totalNavDegradation += navDegradation;

      console.log(`\n[${trade.stock_ticker}] ${new Date(Number(trade.exit_timestamp)).toISOString().slice(0, 19)}`);
      console.log(`  Size: $${sizeUsd.toFixed(2)} | Route: ${trade.entry_route || '?'} → ${trade.exit_route || '?'}`);
      console.log(`  Spread: ${Number(trade.entry_spread_pct).toFixed(2)}% → ${Number(trade.exit_spread_pct || 0).toFixed(2)}% (captured ${spreadCaptured.toFixed(2)}%)`);
      console.log(`  Expected PnL: $${expectedPnl.toFixed(2)} | Actual: $${pnlUsd.toFixed(2)} | NAV Loss: $${navDegradation.toFixed(2)}`);
      console.log(`  Fees: $${totalFeesUsd.toFixed(4)} (entry: $${entryFeesUsd.toFixed(4)}, exit: $${exitFeesUsd.toFixed(4)})`);
      console.log(`  TXs: Entry=${trade.entry_tx_signature ? 'YES' : 'NO'}, Exit=${trade.exit_tx_signature ? 'YES' : 'NO'}`);
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Trades analyzed: ${result.rows.length}`);
    console.log(`Trades with TX signatures: ${tradesWithTxSigs}/${result.rows.length}`);
    console.log(`Trades with fees > $0: ${tradesWithFees}/${result.rows.length}`);
    console.log(`\nFinancials:`);
    console.log(`  Total DB-tracked fees: $${totalDbFees.toFixed(2)}`);
    console.log(`  Avg fees per trade: $${(totalDbFees / result.rows.length).toFixed(4)}`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
    console.log(`  Total NAV degradation: $${totalNavDegradation.toFixed(2)}`);
    console.log(`  Avg NAV degradation: $${(totalNavDegradation / result.rows.length).toFixed(2)}`);

    console.log(`\n🚨 RED FLAGS:`);
    if (totalDbFees < 0.50) {
      console.log(`  ⚠️  Fees are SUSPICIOUSLY LOW ($${totalDbFees.toFixed(2)} for ${result.rows.length} trades)`);
      console.log(`      Expected: ~$1.50-$3.00 for DEX swaps on Solana`);
    }
    if (totalNavDegradation > totalDbFees * 2) {
      console.log(`  ⚠️  NAV degradation ($${totalNavDegradation.toFixed(2)}) is much higher than tracked fees`);
      console.log(`      Missing costs: ~$${(totalNavDegradation - totalDbFees).toFixed(2)}`);
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await pool.end();
    process.exit(1);
  }
}

auditFees();
