const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Force IPv4 for Supabase connection
dns.setDefaultResultOrder('ipv4first');

// Use the pooler connection from .env (more reliable than direct)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeTrades() {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  
  console.log(`=== DEEP ANALYSIS: Last 6 Hours ===`);
  console.log(`From: ${sixHoursAgo}`);
  console.log(`To: ${now}`);
  
  // Get recent trades
  const tradesResult = await pool.query(`
    SELECT * FROM trades 
    WHERE entry_timestamp >= $1 
    ORDER BY entry_timestamp DESC
  `, [sixHoursAgo]);
  
  const trades = tradesResult.rows;
  
  console.log(`\nTrades in last 6 hours: ${trades.length}\n`);
  
  if (trades.length === 0) {
    console.log('❌ No trades in last 6 hours');
    console.log('Checking bot health...\n');
    
    // Check last trade to see if system is working
    const lastTradeResult = await pool.query(`
      SELECT entry_timestamp, token_symbol, entry_spread_pct, exit_reason
      FROM trades 
      ORDER BY entry_timestamp DESC 
      LIMIT 1
    `);
    
    const lastTrade = lastTradeResult.rows;
      
    if (lastTrade?.length > 0) {
      const lastTradeTime = new Date(lastTrade[0].entry_timestamp);
      const hoursAgo = ((Date.now() - lastTradeTime.getTime()) / (1000 * 60 * 60)).toFixed(1);
      console.log(`Last trade: ${hoursAgo}h ago (${lastTrade[0].token_symbol} at ${lastTrade[0].entry_spread_pct}%)`);
    }
    return;
  }
  
  // Analyze patterns
  let totalPnl = 0;
  const exitReasons = {};
  const entrySpreadThresholds = [];
  
  trades.forEach(trade => {
    totalPnl += parseFloat(trade.net_pnl_usd || 0);
    
    const exitReason = trade.exit_reason || 'unknown';
    exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
    
    entrySpreadThresholds.push(Math.abs(parseFloat(trade.entry_spread_pct || 0)));
  });
  
  console.log(`📊 Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`🎯 Exit reasons:`, exitReasons);
  console.log(`📈 Entry spreads: ${entrySpreadThresholds.map(s => s.toFixed(2) + '%').join(', ')}`);
  
  // Check if all entries are 4%+
  const below4Pct = entrySpreadThresholds.filter(s => s < 4.0);
  console.log(`✅ Entries below 4%: ${below4Pct.length}/${entrySpreadThresholds.length} (should be 0)`);
  
  // Check for max_hold exits (should hit 2.5% target, not timeout)
  const maxHoldExits = trades.filter(t => t.exit_reason === 'max_hold').length;
  console.log(`⏱️  Max hold exits: ${maxHoldExits}/${trades.length} (prefer profit_target)`);
  
  // Show individual trades for detailed analysis
  console.log(`\n=== INDIVIDUAL TRADES ===`);
  trades.slice(0, 10).forEach((trade, i) => {
    const holdTimeMin = trade.hold_time_ms ? Math.round(trade.hold_time_ms / 60000) : '?';
    console.log(`${i+1}. ${trade.token_symbol}: ${trade.entry_spread_pct}% → ${trade.exit_spread_pct}% (${holdTimeMin}min, ${trade.exit_reason}) = $${trade.net_pnl_usd}`);
  });
}

// Check current spread conditions
async function checkCurrentSpreads() {
  console.log(`\n=== CURRENT MARKET CONDITIONS ===`);
  
  // Get latest spreads (within last 15 minutes)
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  
  const spreadsResult = await pool.query(`
    SELECT token_symbol, spread_pct, timestamp
    FROM discount_history 
    WHERE timestamp >= $1
    ORDER BY timestamp DESC
    LIMIT 50
  `, [fifteenMinAgo]);
  
  const spreads = spreadsResult.rows;
    
  if (spreads?.length > 0) {
    // Group by token, take latest for each
    const latestSpreads = {};
    spreads.forEach(s => {
      if (!latestSpreads[s.token_symbol] || s.timestamp > latestSpreads[s.token_symbol].timestamp) {
        latestSpreads[s.token_symbol] = s;
      }
    });
    
    const above4Pct = Object.values(latestSpreads).filter(s => Math.abs(s.spread_pct) >= 4.0);
    const above3Pct = Object.values(latestSpreads).filter(s => Math.abs(s.spread_pct) >= 3.0);
    
    console.log(`Current spreads ≥4%: ${above4Pct.length} tokens`);
    console.log(`Current spreads ≥3%: ${above3Pct.length} tokens`);
    
    if (above4Pct.length > 0) {
      console.log(`Spreads ≥4% (should trigger entries):`);
      above4Pct.forEach(s => console.log(`  ${s.token_symbol}: ${s.spread_pct.toFixed(2)}%`));
    }
    
    // Show top 10 current spreads
    const sortedSpreads = Object.values(latestSpreads)
      .sort((a, b) => Math.abs(b.spread_pct) - Math.abs(a.spread_pct))
      .slice(0, 10);
    
    console.log(`\nTop 10 current spreads:`);
    sortedSpreads.forEach(s => {
      const age = Math.round((Date.now() - new Date(s.timestamp).getTime()) / 60000);
      console.log(`  ${s.token_symbol}: ${s.spread_pct.toFixed(2)}% (${age}min ago)`);
    });
  }
}

async function main() {
  try {
    await analyzeTrades();
    await checkCurrentSpreads();
  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    await pool.end();
  }
}

main();