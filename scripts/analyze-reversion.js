#!/usr/bin/env node
/**
 * Analyze reversion patterns by token for EMRT optimization
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyze() {
  console.log('Fetching trades...');
  
  const result = await pool.query(`
    SELECT buy_symbol as token, entry_spread_pct, exit_spread_pct, exit_reason, 
           entry_timestamp, exit_timestamp, pnl_usd
    FROM mean_reversion_positions
    WHERE entry_timestamp > $1
      AND exit_timestamp IS NOT NULL
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000]);
  
  const data = result.rows;
  if (!data || data.length === 0) { console.log('No trades found'); return; }
  
  console.log(`Loaded ${data.length} trades\n`);
  
  // Group by token
  const byToken = {};
  for (const t of data) {
    if (!byToken[t.token]) byToken[t.token] = [];
    byToken[t.token].push(t);
  }
  
  console.log('Token Reversion Patterns (30d):');
  console.log('Token     | Trades | Entry%  | Exit%  | Revert | TargetMin | MaxHoldMin | WR%');
  console.log('----------|--------|---------|--------|--------|-----------|------------|-----');
  
  const results = [];
  for (const [token, trades] of Object.entries(byToken)) {
    if (trades.length < 3) continue;
    
    const avgEntry = trades.reduce((s,t) => s + (t.entry_spread_pct || 0), 0) / trades.length;
    const avgExit = trades.reduce((s,t) => s + (t.exit_spread_pct || 0), 0) / trades.length;
    const reversion = avgEntry - avgExit;
    
    const targetTrades = trades.filter(t => t.exit_reason === 'target');
    const avgTargetMin = targetTrades.length > 0 
      ? targetTrades.reduce((s,t) => s + (t.exit_timestamp - t.entry_timestamp)/60000, 0) / targetTrades.length
      : null;
    
    const maxHoldTrades = trades.filter(t => t.exit_reason === 'max_hold');
    const avgMaxHoldMin = maxHoldTrades.length > 0
      ? maxHoldTrades.reduce((s,t) => s + (t.exit_timestamp - t.entry_timestamp)/60000, 0) / maxHoldTrades.length
      : null;
    
    const winRate = trades.filter(t => t.pnl_usd > 0).length / trades.length * 100;
    
    results.push({ 
      token, 
      trades: trades.length, 
      avgEntry, 
      avgExit, 
      reversion, 
      avgTargetMin, 
      avgMaxHoldMin,
      winRate,
      targetCount: targetTrades.length,
      maxHoldCount: maxHoldTrades.length
    });
  }
  
  results.sort((a,b) => b.reversion - a.reversion);
  
  for (const r of results) {
    console.log(
      r.token.padEnd(10) + '| ' +
      String(r.trades).padEnd(7) + '| ' +
      r.avgEntry.toFixed(1).padStart(7) + ' | ' +
      r.avgExit.toFixed(1).padStart(6) + ' | ' +
      r.reversion.toFixed(2).padStart(6) + ' | ' +
      (r.avgTargetMin ? r.avgTargetMin.toFixed(0).padStart(9) : '      N/A') + ' | ' +
      (r.avgMaxHoldMin ? r.avgMaxHoldMin.toFixed(0).padStart(10) : '       N/A') + ' | ' +
      r.winRate.toFixed(0).padStart(3)
    );
  }
  
  // Summary stats
  console.log('\n--- EMRT Insights ---');
  const fastRevert = results.filter(r => r.avgTargetMin && r.avgTargetMin < 30);
  const slowRevert = results.filter(r => r.avgTargetMin && r.avgTargetMin > 60);
  const noTarget = results.filter(r => !r.avgTargetMin);
  
  console.log(`Fast reverters (<30min): ${fastRevert.map(r => r.token).join(', ') || 'none'}`);
  console.log(`Slow reverters (>60min): ${slowRevert.map(r => r.token).join(', ') || 'none'}`);
  console.log(`No target exits: ${noTarget.map(r => r.token).join(', ') || 'none'}`);
  
  // Token-specific recommendations
  console.log('\n--- Token-Specific Hold Time Recommendations ---');
  for (const r of results) {
    if (r.targetCount >= 2 && r.avgTargetMin) {
      // Recommend hold time = 1.5x average target time
      const recommendedHold = Math.round(r.avgTargetMin * 1.5);
      console.log(`${r.token}: ${recommendedHold}min (based on ${r.targetCount} target exits @ avg ${r.avgTargetMin.toFixed(0)}min)`);
    } else if (r.winRate > 30) {
      console.log(`${r.token}: Use default 240min (${r.trades} trades, ${r.winRate.toFixed(0)}% WR, but few target exits)`);
    }
  }
}

analyze().catch(console.error);
