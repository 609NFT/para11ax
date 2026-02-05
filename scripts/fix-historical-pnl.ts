/**
 * Fix Historical PnL Data
 *
 * The bot had a bug where it would sell ALL tokens of a type when closing
 * one position, then attribute the full proceeds to that one position.
 * This caused massively inflated PnL (99-136% "profits").
 *
 * This script recalculates PnL based on spread change:
 * - pnl_pct = entry_spread - exit_spread - estimated_fees
 * - pnl_usd = size_usd * pnl_pct / 100
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const ESTIMATED_FEES_PCT = 0.28; // Typical total fees (slippage + network + priority)

interface Trade {
  id: string;
  buy_symbol: string;
  size_usd: number;
  entry_spread_pct: number;
  exit_spread_pct: number;
  pnl_usd: number;
  pnl_pct: number;
  total_fees_usd: number;
}

async function fixHistoricalPnl(dryRun = true) {
  const pool = new Pool({
    connectionString: process.env.TRADES_DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Get all closed trades
    const result = await pool.query<Trade>(`
      SELECT id, buy_symbol, size_usd, entry_spread_pct, exit_spread_pct,
             pnl_usd, pnl_pct, total_fees_usd
      FROM mean_reversion_positions
      WHERE status = 'closed'
      ORDER BY exit_timestamp DESC
    `);

    console.log(`Found ${result.rows.length} closed trades to analyze\n`);

    let fixedCount = 0;
    let totalOldPnl = 0;
    let totalNewPnl = 0;
    const suspiciousTrades: Array<{
      id: string;
      symbol: string;
      oldPnl: number;
      newPnl: number;
      oldPct: number;
      newPct: number;
    }> = [];

    for (const trade of result.rows) {
      const entrySpread = Number(trade.entry_spread_pct) || 0;
      const exitSpread = Number(trade.exit_spread_pct) || 0;
      const sizeUsd = Number(trade.size_usd) || 0;
      const oldPnlUsd = Number(trade.pnl_usd) || 0;
      const oldPnlPct = Number(trade.pnl_pct) || 0;
      const feesUsd = Number(trade.total_fees_usd) || 0;

      // Calculate what PnL should be based on spread change
      // For long positions: profit when discount narrows (entry > exit)
      const spreadChange = entrySpread - exitSpread;

      // Estimate fees as percentage of trade
      const feesPct = sizeUsd > 0 ? (feesUsd / sizeUsd) * 100 : ESTIMATED_FEES_PCT;

      // Net PnL percentage
      const newPnlPct = spreadChange - feesPct;
      const newPnlUsd = sizeUsd * (newPnlPct / 100);

      totalOldPnl += oldPnlUsd;
      totalNewPnl += newPnlUsd;

      // Check if this trade was affected by the bug
      // Bug signature: PnL% >> spread change (typically 50%+ vs expected 0-3%)
      const pnlDiff = Math.abs(oldPnlPct - newPnlPct);

      if (pnlDiff > 5) { // More than 5% difference suggests bug
        suspiciousTrades.push({
          id: trade.id,
          symbol: trade.buy_symbol,
          oldPnl: oldPnlUsd,
          newPnl: newPnlUsd,
          oldPct: oldPnlPct,
          newPct: newPnlPct,
        });

        if (!dryRun) {
          // Update the trade with corrected PnL
          await pool.query(`
            UPDATE mean_reversion_positions
            SET pnl_usd = $1, pnl_pct = $2
            WHERE id = $3
          `, [newPnlUsd, newPnlPct, trade.id]);
        }

        fixedCount++;
      }
    }

    console.log('=== SUMMARY ===');
    console.log(`Total trades: ${result.rows.length}`);
    console.log(`Suspicious trades: ${suspiciousTrades.length}`);
    console.log(`Old total PnL: $${totalOldPnl.toFixed(2)}`);
    console.log(`New total PnL: $${totalNewPnl.toFixed(2)}`);
    console.log(`Difference: $${(totalOldPnl - totalNewPnl).toFixed(2)}`);
    console.log('');

    if (suspiciousTrades.length > 0) {
      console.log('=== TOP 20 SUSPICIOUS TRADES ===');
      suspiciousTrades
        .sort((a, b) => Math.abs(b.oldPnl - b.newPnl) - Math.abs(a.oldPnl - a.newPnl))
        .slice(0, 20)
        .forEach(t => {
          console.log(`${t.symbol}: $${t.oldPnl.toFixed(2)} → $${t.newPnl.toFixed(2)} (${t.oldPct.toFixed(1)}% → ${t.newPct.toFixed(1)}%)`);
        });
    }

    if (dryRun) {
      console.log('\n⚠️  DRY RUN - No changes made. Run with --fix to apply changes.');
    } else {
      console.log(`\n✅ Fixed ${fixedCount} trades.`);
    }

  } finally {
    await pool.end();
  }
}

// Check for --fix flag
const shouldFix = process.argv.includes('--fix');
fixHistoricalPnl(!shouldFix);
