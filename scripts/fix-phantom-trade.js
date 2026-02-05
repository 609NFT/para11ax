#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    // Check mean_reversion_positions for phantom trades
    console.log('Checking mean_reversion_positions for bad trades...');
    const mrResult = await client.query(`
      SELECT id, stock_ticker, buy_symbol, pnl_usd, exit_reason, exit_timestamp
      FROM mean_reversion_positions 
      WHERE exit_reason = 'position_missing' OR pnl_usd < -15
      ORDER BY exit_timestamp DESC NULLS LAST
      LIMIT 10
    `);
    console.log('Found:', mrResult.rows.length, 'rows');
    for (const row of mrResult.rows) {
      const ts = row.exit_timestamp ? new Date(Number(row.exit_timestamp)).toISOString() : 'null';
      console.log(`  ${row.id.slice(0,8)}: ${row.stock_ticker || row.buy_symbol} | $${row.pnl_usd} | ${row.exit_reason} | ${ts}`);
    }

    // Delete phantom trades (position_missing with negative PnL)
    const phantomTrades = mrResult.rows.filter(r => r.exit_reason === 'position_missing');
    if (phantomTrades.length > 0) {
      console.log('\nDeleting phantom trades from mean_reversion_positions...');
      for (const trade of phantomTrades) {
        await client.query('DELETE FROM mean_reversion_positions WHERE id = $1', [trade.id]);
        console.log(`  Deleted ${trade.id.slice(0,8)} (${trade.stock_ticker}, $${trade.pnl_usd})`);
      }
    }

    // Also check short_positions
    console.log('\nChecking short_positions...');
    const spResult = await client.query(`
      SELECT id, ticker, pnl_usd, exit_reason, exit_timestamp, status
      FROM short_positions 
      WHERE exit_reason = 'position_missing' OR pnl_usd < -15
      ORDER BY exit_timestamp DESC NULLS LAST
      LIMIT 10
    `);
    console.log('Found:', spResult.rows.length, 'bad short positions');
    for (const row of spResult.rows) {
      const ts = row.exit_timestamp ? new Date(Number(row.exit_timestamp)).toISOString() : 'open';
      console.log(`  ${row.id.slice(0,8)}: ${row.ticker} | $${row.pnl_usd || 'null'} | ${row.exit_reason || row.status} | ${ts}`);
    }

    // Delete phantom short positions
    const phantomShorts = spResult.rows.filter(r => r.exit_reason === 'position_missing');
    if (phantomShorts.length > 0) {
      console.log('\nDeleting phantom trades from short_positions...');
      for (const trade of phantomShorts) {
        await client.query('DELETE FROM short_positions WHERE id = $1', [trade.id]);
        console.log(`  Deleted ${trade.id.slice(0,8)} (${trade.ticker}, $${trade.pnl_usd})`);
      }
    }

    console.log('\nDone!');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
