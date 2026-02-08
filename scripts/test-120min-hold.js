#!/usr/bin/env node
/**
 * Quick backtest with 120min max hold (vs default 240min)
 * Modified from quick-backtest.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Config - 120min max hold vs current 240min deployment  
const CONFIG = {
  minEntrySpread: 4.0,  
  targetSpread: 0.5,
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: 120 * 60 * 1000,  // 120 minutes vs 240 current
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: 3,
};

async function run() {
  console.log(`\\nBacktest: 4.0% entry, 120min max hold, 3 days lookback\\n`);
  
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000;

  console.log('Fetching data...');
  
  // Use discount_heatmap_summary which has time series data
  const { rows } = await pool.query(`
    SELECT 
      bucket_timestamp as time,
      symbol,
      avg_discount as discount_pct
    FROM discount_heatmap_summary 
    WHERE bucket_timestamp >= $1
      AND avg_discount IS NOT NULL
      AND avg_discount > 0.5
    ORDER BY bucket_timestamp, symbol
  `, [new Date(startTime)]);
  
  console.log(`Loaded ${rows.length} data points`);
  
  if (rows.length === 0) {
    console.log('No heatmap data found, cannot run backtest');
    process.exit(1);
  }
  
  const trades = [];
  const openPositions = {};
  
  // Process each time bucket
  const buckets = [...new Set(rows.map(r => new Date(r.time).getTime()))].sort();
  
  for (const bucketTime of buckets) {
    const bucketData = rows.filter(r => new Date(r.time).getTime() === bucketTime);
    
    // Check exits first
    for (const [token, pos] of Object.entries(openPositions)) {
      const currentData = bucketData.find(d => d.symbol === token);
      const holdTime = bucketTime - pos.entryTime;
      
      let exitReason = null;
      if (!currentData) {
        exitReason = 'no_data';
      } else if (currentData.discount_pct <= CONFIG.targetSpread) {
        exitReason = 'target';
      } else if (holdTime >= CONFIG.maxHoldMs) {
        exitReason = 'max_hold';
      }
      
      if (exitReason) {
        const exitDiscount = currentData ? currentData.discount_pct : pos.entryDiscount;
        const grossPnl = (pos.entryDiscount - exitDiscount) / 100 * CONFIG.positionSizeUsd;
        const fees = (CONFIG.entryFeePct + CONFIG.exitFeePct) / 100 * CONFIG.positionSizeUsd;
        const netPnl = grossPnl - fees;
        
        trades.push({
          token,
          entryTime: pos.entryTime,
          exitTime: bucketTime,
          entryDiscount: pos.entryDiscount,
          exitDiscount,
          holdTimeMs: holdTime,
          grossPnlUsd: grossPnl,
          netPnlUsd: netPnl,
          exitReason
        });
        
        delete openPositions[token];
      }
    }
    
    // Check for new entries
    if (Object.keys(openPositions).length < CONFIG.maxConcurrentPositions) {
      const entryOpportunities = bucketData
        .filter(d => d.discount_pct >= CONFIG.minEntrySpread)
        .filter(d => !openPositions[d.symbol])
        .sort((a, b) => b.discount_pct - a.discount_pct);
      
      for (const opp of entryOpportunities.slice(0, CONFIG.maxConcurrentPositions - Object.keys(openPositions).length)) {
        if (bucketTime > Date.now() - CONFIG.minHoldMs) continue;
        
        openPositions[opp.symbol] = {
          entryTime: bucketTime,
          entryDiscount: opp.discount_pct
        };
      }
    }
  }
  
  // Close remaining positions
  for (const [token, pos] of Object.entries(openPositions)) {
    const lastBucket = buckets[buckets.length - 1];
    const lastData = rows.filter(r => new Date(r.time).getTime() === lastBucket).find(d => d.symbol === token);
    const exitDiscount = lastData ? lastData.discount_pct : pos.entryDiscount;
    const holdTime = lastBucket - pos.entryTime;
    
    const grossPnl = (pos.entryDiscount - exitDiscount) / 100 * CONFIG.positionSizeUsd;
    const fees = (CONFIG.entryFeePct + CONFIG.exitFeePct) / 100 * CONFIG.positionSizeUsd;
    const netPnl = grossPnl - fees;
    
    trades.push({
      token,
      entryTime: pos.entryTime,
      exitTime: lastBucket,
      entryDiscount: pos.entryDiscount,
      exitDiscount,
      holdTimeMs: holdTime,
      grossPnlUsd: grossPnl,
      netPnlUsd: netPnl,
      exitReason: 'end_of_data'
    });
  }
  
  // Results
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const avgHold = trades.length > 0 
    ? trades.reduce((sum, t) => sum + t.holdTimeMs, 0) / trades.length / 60000
    : 0;
  
  console.log('='.repeat(50));
  console.log(`Entry: 4.0% | Max Hold: 120min | Days: 3`);
  console.log('='.repeat(50));
  console.log(`Trades: ${trades.length}`);
  console.log(`Win Rate: ${((wins.length / trades.length) * 100 || 0).toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`Net P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`Avg Hold: ${avgHold.toFixed(1)} min`);
  
  // Exit reason breakdown
  const byReason = {};
  trades.forEach(t => { byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1; });
  console.log('\\nExit Reasons:');
  Object.entries(byReason).forEach(([reason, count]) => {
    console.log(`  ${reason}: ${count}`);
  });
  
  // By token
  const byToken = {};
  trades.forEach(t => {
    if (!byToken[t.token]) byToken[t.token] = { trades: 0, wins: 0, pnl: 0 };
    byToken[t.token].trades++;
    if (t.netPnlUsd > 0) byToken[t.token].wins++;
    byToken[t.token].pnl += t.netPnlUsd;
  });
  
  const sortedTokens = Object.entries(byToken)
    .sort((a, b) => b[1].pnl - a[1].pnl);
  
  console.log('\\nTop 5 Tokens:');
  sortedTokens.slice(0, 5).forEach(([token, stats]) => {
    const wr = ((stats.wins / stats.trades) * 100).toFixed(0);
    console.log(`  ${token}: ${stats.trades} trades, ${wr}% WR, ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  });
  
  console.log('='.repeat(50));
  
  await pool.end();
}

run().catch(console.error);