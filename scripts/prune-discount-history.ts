#!/usr/bin/env npx ts-node
/**
 * Prune discount_history older than 30 days from Supabase
 * Run manually or via cron: 0 0 * * * cd ~/parallax && npx ts-node -r dotenv/config scripts/prune-discount-history.ts
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const RETENTION_DAYS = 30;

const connectionString = process.env.TRADES_DB_URL;

if (!connectionString) {
  console.error('Error: TRADES_DB_URL environment variable not set');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const cutoffMs = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs).toISOString();

  console.log(`Pruning discount_history older than ${RETENTION_DAYS} days (before ${cutoffDate})`);

  try {
    // Get count before
    const beforeResult = await pool.query('SELECT COUNT(*) as count FROM discount_history');
    const beforeCount = parseInt(beforeResult.rows[0].count, 10);

    // Delete old records
    const deleteResult = await pool.query(
      'DELETE FROM discount_history WHERE timestamp < $1',
      [cutoffMs]
    );

    const deletedCount = deleteResult.rowCount || 0;

    // Get count after
    const afterResult = await pool.query('SELECT COUNT(*) as count FROM discount_history');
    const afterCount = parseInt(afterResult.rows[0].count, 10);

    console.log(`Before: ${beforeCount.toLocaleString()} rows`);
    console.log(`Deleted: ${deletedCount.toLocaleString()} rows`);
    console.log(`After: ${afterCount.toLocaleString()} rows`);

    // Estimate storage saved (rough estimate: ~150 bytes per row)
    const mbSaved = (deletedCount * 150) / (1024 * 1024);
    console.log(`Estimated storage freed: ${mbSaved.toFixed(1)} MB`);

  } catch (error) {
    console.error('Error pruning discount_history:', (error as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
