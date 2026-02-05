#!/usr/bin/env npx ts-node
/**
 * CLI tool to query the Supabase trades database
 * Usage: npx ts-node -r dotenv/config scripts/query-supabase.ts "SELECT * FROM mean_reversion_positions LIMIT 5"
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.TRADES_DB_URL;

if (!connectionString) {
  console.error('Error: TRADES_DB_URL environment variable not set');
  process.exit(1);
}

const query = process.argv[2];

if (!query) {
  console.error('Usage: npx ts-node -r dotenv/config scripts/query-supabase.ts "SQL QUERY"');
  console.error('');
  console.error('Available tables:');
  console.error('  - mean_reversion_positions (id, stock_ticker, buy_symbol, status, pnl_usd, etc.)');
  console.error('  - short_positions (id, ticker, rstock_symbol, status, pnl_usd, etc.)');
  console.error('  - discount_history (stock_ticker, token_a_symbol, token_a_discount_vs_stock, timestamp, etc.)');
  console.error('  - system_state (key, value, updated_at)');
  process.exit(1);
}

// Safety check - only allow SELECT queries
const normalizedQuery = query.trim().toUpperCase();
if (!normalizedQuery.startsWith('SELECT')) {
  console.error('Error: Only SELECT queries are allowed for safety');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(query);

    if (result.rows.length === 0) {
      console.log('No results found');
    } else {
      // Output as JSON for easy parsing
      console.log(JSON.stringify(result.rows, null, 2));
    }
  } catch (error) {
    console.error('Query error:', (error as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
