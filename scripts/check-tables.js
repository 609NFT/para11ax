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
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Tables:', result.rows.map(r => r.table_name));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
