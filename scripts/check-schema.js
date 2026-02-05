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
    for (const table of ['mean_reversion_positions', 'short_positions']) {
      console.log(`\n=== ${table} ===`);
      const result = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      for (const row of result.rows) {
        console.log(`  ${row.column_name}: ${row.data_type}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
