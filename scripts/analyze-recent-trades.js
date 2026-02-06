const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

// Load environment
require('dotenv').config();

// Use pooler connection from environment  
const connectionString = process.env.TRADES_DB_URL;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

async function analyzeRecentTrades() {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  
  console.log(`\n=== TRADES ANALYSIS (Last 6 Hours) ===`);
  console.log(`Since: ${sixHoursAgo}`);
  
  // Get recent trades
  const tradesResult = await pool.query(`
    SELECT * FROM trades 
    WHERE entry_time >= $1 
    ORDER BY entry_time DESC
  `, [sixHoursAgo]);
  
  const trades = tradesResult.rows;
  
  console.log(`\nFound ${trades.length} trades in last 6 hours:`);
  
  if (trades.length === 0) {
    console.log('No recent trades to analyze.');
    
    // Check current spreads
    const spreadsResult = await pool.query(`
      SELECT * FROM discount_history 
      WHERE timestamp >= $1 
      ORDER BY timestamp DESC 
      LIMIT 20
    `, [sixHoursAgo]);
    
    const spreads = spreadsResult.rows;
    
    if (spreads && spreads.length > 0) {
      console.log(`\nRecent spreads (showing max discount per symbol):`);
      const symbolSpreads = {};
      spreads.forEach(s => {
        if (!symbolSpreads[s.symbol] || Math.abs(s.spread_pct) > Math.abs(symbolSpreads[s.symbol].spread_pct)) {
          symbolSpreads[s.symbol] = s;
        }
      });
      
      Object.values(symbolSpreads).forEach(s => {
        console.log(`${s.symbol}: ${s.spread_pct.toFixed(2)}% (${new Date(s.timestamp).toLocaleTimeString()})`);
      });
    }
    return;
  }
  
  // Analyze patterns
  let entryThresholdSum = 0;
  let exitReasons = {};
  let profitableCount = 0;
  let totalPnl = 0;
  
  console.log('\nTrade Details:');
  console.log('Symbol | Entry% | Exit Reason | Hold Time | PnL | Status');
  console.log('-------|---------|-------------|-----------|-----|-------');
  
  trades.forEach(trade => {
    const entryPct = parseFloat(trade.entry_spread_pct) || 0;
    const exitReason = trade.exit_reason || 'unknown';
    const holdTimeMin = trade.exit_time ? 
      Math.round((new Date(trade.exit_time) - new Date(trade.entry_time)) / 1000 / 60) : 
      Math.round((Date.now() - new Date(trade.entry_time)) / 1000 / 60);
    const pnl = parseFloat(trade.realized_pnl_usd) || 0;
    const status = trade.status;
    
    entryThresholdSum += Math.abs(entryPct);
    exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
    if (pnl > 0) profitableCount++;
    totalPnl += pnl;
    
    console.log(`${trade.symbol.padEnd(6)} | ${entryPct.toFixed(2).padStart(6)}% | ${exitReason.padEnd(11)} | ${holdTimeMin.toString().padStart(8)}m | $${pnl.toFixed(2).padStart(5)} | ${status}`);
  });
  
  console.log('\n=== ANALYSIS ===');
  console.log(`Average entry threshold: ${(entryThresholdSum / trades.length).toFixed(2)}%`);
  console.log(`Win rate: ${(profitableCount / trades.length * 100).toFixed(1)}%`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  
  console.log('\nExit reasons:');
  Object.entries(exitReasons).forEach(([reason, count]) => {
    console.log(`  ${reason}: ${count} trades`);
  });
  
  // Check for any concerning patterns
  if (trades.some(t => Math.abs(parseFloat(t.entry_spread_pct)) < 3.4)) {
    console.log('\n⚠️  WARNING: Some entries below volatility-adjusted minimum (3.4%)');
  }
  
  if (exitReasons.max_hold_time > trades.length * 0.3) {
    console.log('\n⚠️  WARNING: High proportion of max_hold_time exits - consider adjusting exit thresholds');
  }
}

analyzeRecentTrades().catch(console.error);