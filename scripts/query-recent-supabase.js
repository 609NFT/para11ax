#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function queryRecentTrades() {
  try {
    // Get trades from last 6 hours (convert to milliseconds timestamp)
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    
    const tradesQuery = `
      SELECT 
        id, stock_ticker, buy_symbol, entry_spread_pct, exit_reason, 
        pnl_usd, pnl_pct, 
        to_timestamp(entry_timestamp / 1000) as entry_time,
        to_timestamp(exit_timestamp / 1000) as exit_time,
        size_usd, buy_amount,
        (exit_timestamp - entry_timestamp) as duration_ms,
        status
      FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 AND status = 'closed'
      ORDER BY entry_timestamp DESC
    `;
    
    const result = await pool.query(tradesQuery, [sixHoursAgo]);
    
    console.log(`=== TRADES ANALYSIS (Last 6 Hours) ===`);
    console.log(`Since: ${new Date(sixHoursAgo).toISOString()}`);
    console.log(`Total trades: ${result.rows.length}`);
    
    if (result.rows.length === 0) {
      console.log('No trades in the last 6 hours.');
      return;
    }
    
    // Analyze patterns
    const trades = result.rows;
    const exitReasons = trades.reduce((acc, t) => {
      acc[t.exit_reason || 'unknown'] = (acc[t.exit_reason || 'unknown'] || 0) + 1;
      return acc;
    }, {});
    
    const avgEntry = trades.reduce((sum, t) => sum + parseFloat(t.entry_spread_pct || 0), 0) / trades.length;
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const avgDuration = trades.reduce((sum, t) => sum + parseInt(t.duration_ms || 0), 0) / trades.length;
    
    console.log('\n--- SUMMARY ---');
    console.log(`Average entry spread: ${avgEntry.toFixed(2)}%`);
    console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`Average duration: ${(avgDuration / 1000 / 60).toFixed(1)} minutes`);
    
    console.log('\n--- EXIT REASONS ---');
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`${reason}: ${count} trades`);
    });
    
    console.log('\n--- RECENT TRADES ---');
    trades.slice(0, 10).forEach(trade => {
      const duration = Math.round(trade.duration_ms/1000/60);
      console.log(`${trade.stock_ticker} (${trade.buy_symbol}) | Entry: ${trade.entry_spread_pct}% | Exit: ${trade.exit_reason || 'unknown'} | PnL: $${trade.pnl_usd || '0.00'} | Duration: ${duration}min`);
    });
    
  } catch (error) {
    console.error('Query error:', error);
  } finally {
    await pool.end();
  }
}

queryRecentTrades();