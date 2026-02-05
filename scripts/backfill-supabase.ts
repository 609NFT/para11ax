/**
 * Backfill Supabase with existing SQLite data
 * Run once after setting up the Supabase sync
 */

import { Pool } from 'pg';
import Database from 'better-sqlite3';
import * as path from 'path';

const TRADES_DB_URL = process.env.TRADES_DB_URL;
if (!TRADES_DB_URL) {
  console.error('TRADES_DB_URL environment variable not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const sqliteDb = new Database(path.join(process.cwd(), 'data', 'parallax.db'));

async function backfillPositions() {
  console.log('Backfilling mean_reversion_positions...');

  const positions = sqliteDb.prepare('SELECT * FROM mean_reversion_positions').all() as Record<string, unknown>[];
  console.log(`Found ${positions.length} positions`);

  let inserted = 0;
  for (const pos of positions) {
    try {
      await pool.query(`
        INSERT INTO mean_reversion_positions (
          id, stock_ticker, buy_symbol, buy_mint, sell_symbol, sell_mint,
          entry_spread_pct, entry_timestamp, size_usd, buy_amount, sell_amount,
          status, exit_spread_pct, exit_timestamp, exit_reason, pnl_usd, pnl_pct,
          buy_pool_address, buy_decimals, buy_dex_id, entry_tx_signature, exit_tx_signature,
          total_fees_usd, entry_fees_usd, exit_fees_usd, priority_fees_usd, network_fees_usd, slippage_usd,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
        ON CONFLICT (id) DO NOTHING
      `, [
        pos.id, pos.stock_ticker, pos.buy_symbol, pos.buy_mint,
        pos.sell_symbol, pos.sell_mint, pos.entry_spread_pct, pos.entry_timestamp,
        pos.size_usd, pos.buy_amount, pos.sell_amount, pos.status,
        pos.exit_spread_pct, pos.exit_timestamp, pos.exit_reason,
        pos.pnl_usd, pos.pnl_pct, pos.buy_pool_address, pos.buy_decimals,
        pos.buy_dex_id, pos.entry_tx_signature, pos.exit_tx_signature,
        pos.total_fees_usd, pos.entry_fees_usd, pos.exit_fees_usd,
        pos.priority_fees_usd, pos.network_fees_usd, pos.slippage_usd,
        pos.updated_at || Date.now()
      ]);
      inserted++;
    } catch (err) {
      console.error(`Failed to insert position ${pos.id}:`, err);
    }
  }
  console.log(`Inserted ${inserted} positions`);
}

async function backfillShortPositions() {
  console.log('Backfilling short_positions...');

  const positions = sqliteDb.prepare('SELECT * FROM short_positions').all() as Record<string, unknown>[];
  console.log(`Found ${positions.length} short positions`);

  let inserted = 0;
  for (const pos of positions) {
    try {
      await pool.query(`
        INSERT INTO short_positions (
          id, ticker, rstock_symbol, entry_premium_pct, entry_stock_price,
          entry_timestamp, collateral_usd, leverage, status, entry_tx_signature,
          exit_premium_pct, exit_timestamp, exit_reason, exit_tx_signature, pnl_usd, pnl_pct,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO NOTHING
      `, [
        pos.id, pos.ticker, pos.rstock_symbol, pos.entry_premium_pct,
        pos.entry_stock_price, pos.entry_timestamp, pos.collateral_usd,
        pos.leverage, pos.status, pos.entry_tx_signature,
        pos.exit_premium_pct, pos.exit_timestamp, pos.exit_reason,
        pos.exit_tx_signature, pos.pnl_usd, pos.pnl_pct, pos.updated_at || Date.now()
      ]);
      inserted++;
    } catch (err) {
      console.error(`Failed to insert short position ${pos.id}:`, err);
    }
  }
  console.log(`Inserted ${inserted} short positions`);
}

async function backfillDiscountHistory() {
  console.log('Backfilling discount_history...');

  // Get count first
  const countResult = sqliteDb.prepare('SELECT COUNT(*) as count FROM discount_history').get() as { count: number };
  console.log(`Found ${countResult.count} discount history records`);

  // Batch insert in chunks of 500
  const BATCH_SIZE = 500;
  let offset = 0;
  let totalInserted = 0;

  while (true) {
    const rows = sqliteDb.prepare(`
      SELECT * FROM discount_history
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `).all(BATCH_SIZE, offset) as Record<string, unknown>[];

    if (rows.length === 0) break;

    // Build bulk insert
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const row of rows) {
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11})`);
      values.push(
        row.stock_ticker, row.token_a_symbol, row.token_a_price, row.token_a_discount_vs_stock,
        row.token_b_symbol, row.token_b_price, row.token_b_discount_vs_stock,
        row.spread_pct, row.spread_absolute, row.stock_price, row.more_discounted, row.timestamp
      );
      paramIndex += 12;
    }

    try {
      await pool.query(`
        INSERT INTO discount_history (
          stock_ticker, token_a_symbol, token_a_price, token_a_discount_vs_stock,
          token_b_symbol, token_b_price, token_b_discount_vs_stock,
          spread_pct, spread_absolute, stock_price, more_discounted, timestamp
        ) VALUES ${placeholders.join(', ')}
      `, values);
      totalInserted += rows.length;
      console.log(`Inserted batch: ${totalInserted} / ${countResult.count}`);
    } catch (err) {
      console.error(`Failed to insert batch at offset ${offset}:`, err);
    }

    offset += BATCH_SIZE;
  }

  console.log(`Inserted ${totalInserted} discount history records`);
}

async function backfillSystemState() {
  console.log('Backfilling system_state...');

  const states = sqliteDb.prepare('SELECT * FROM system_state').all() as Record<string, unknown>[];
  console.log(`Found ${states.length} system state records`);

  let inserted = 0;
  for (const state of states) {
    try {
      await pool.query(`
        INSERT INTO system_state (key, value, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
      `, [state.key, state.value, state.updated_at || Date.now()]);
      inserted++;
    } catch (err) {
      console.error(`Failed to insert state ${state.key}:`, err);
    }
  }
  console.log(`Inserted ${inserted} system state records`);
}

async function main() {
  console.log('Starting Supabase backfill...\n');

  try {
    await backfillPositions();
    console.log('');

    await backfillShortPositions();
    console.log('');

    await backfillDiscountHistory();
    console.log('');

    await backfillSystemState();
    console.log('');

    console.log('Backfill complete!');
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    await pool.end();
    sqliteDb.close();
  }
}

main();
