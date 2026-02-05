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
    console.log('=== SHORT POSITIONS ===');
    const shorts = await client.query(`SELECT * FROM short_positions ORDER BY entry_timestamp DESC LIMIT 5`);
    console.log('Count:', shorts.rows.length);
    for (const row of shorts.rows) {
      console.log(JSON.stringify(row, null, 2));
    }

    console.log('\n=== MEAN REVERSION POSITIONS (recent) ===');
    const longs = await client.query(`SELECT id, stock_ticker, status, pnl_usd, exit_reason FROM mean_reversion_positions ORDER BY entry_timestamp DESC LIMIT 5`);
    console.log('Count:', longs.rows.length);
    for (const row of longs.rows) {
      console.log(`  ${row.id.slice(0,8)}: ${row.stock_ticker} | ${row.status} | $${row.pnl_usd} | ${row.exit_reason || '-'}`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
