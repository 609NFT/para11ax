#!/usr/bin/env node
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { Pool } = require('pg');
const fs = require('fs');

const supabaseConfig = JSON.parse(fs.readFileSync(`${process.env.HOME}/.parallax-secrets/supabase-db.json`, 'utf8'));

const pool = new Pool({
  host: supabaseConfig.host,
  port: supabaseConfig.port,
  database: supabaseConfig.database,
  user: supabaseConfig.username,
  password: supabaseConfig.password,
  ssl: { rejectUnauthorized: false },
});

async function queryRecentTrades() {
  try {
    // Get trades from last 6 hours
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    
    const tradesQuery = `
      SELECT 
        id, symbol, direction, entry_discount_pct, exit_reason, 
        pnl_usd, real_pnl_usd, created_at, closed_at,
        entry_amount_usd, exit_amount_usd, duration_ms
      FROM trades 
      WHERE created_at >= $1 
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(tradesQuery, [sixHoursAgo]);
    
    console.log(`=== TRADES ANALYSIS (Last 6 Hours) ===`);
    console.log(`Since: ${sixHoursAgo}`);
    console.log(`Total trades: ${result.rows.length}`);
    
    if (result.rows.length === 0) {
      console.log('No trades in the last 6 hours.');
      return;
    }
    
    // Analyze patterns
    const trades = result.rows;
    const exitReasons = trades.reduce((acc, t) => {
      acc[t.exit_reason] = (acc[t.exit_reason] || 0) + 1;
      return acc;
    }, {});
    
    const avgEntry = trades.reduce((sum, t) => sum + parseFloat(t.entry_discount_pct || 0), 0) / trades.length;
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.real_pnl_usd || 0), 0);
    const avgDuration = trades.reduce((sum, t) => sum + parseInt(t.duration_ms || 0), 0) / trades.length;
    
    console.log('\n--- SUMMARY ---');
    console.log(`Average entry discount: ${avgEntry.toFixed(2)}%`);
    console.log(`Total real PnL: $${totalPnL.toFixed(2)}`);
    console.log(`Average duration: ${(avgDuration / 1000 / 60).toFixed(1)} minutes`);
    
    console.log('\n--- EXIT REASONS ---');
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`${reason}: ${count} trades`);
    });
    
    console.log('\n--- RECENT TRADES ---');
    trades.slice(0, 5).forEach(trade => {
      console.log(`${trade.symbol} ${trade.direction} | Entry: ${trade.entry_discount_pct}% | Exit: ${trade.exit_reason} | PnL: $${trade.real_pnl_usd} | Duration: ${Math.round(trade.duration_ms/1000/60)}min`);
    });
    
  } catch (error) {
    console.error('Query error:', error);
  } finally {
    await pool.end();
  }
}

queryRecentTrades();