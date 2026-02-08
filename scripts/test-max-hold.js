#!/usr/bin/env node
/**
 * Test max hold time variations
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Config
const CONFIG = {
  minEntrySpread: 4.0,  // Current baseline
  targetSpread: 0.5,
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: parseInt(process.argv[2]) * 60 * 1000 || 120 * 60 * 1000,  // minutes from arg
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: 3,
};

async function run() {
  const maxHoldMin = CONFIG.maxHoldMs / 60 / 1000;
  console.log(`\nBacktest: 4.0% entry, ${maxHoldMin}min max hold, 3 days lookback\n`);
  
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000;

  console.log('Fetching data...');
  
  // Get bucketed data
  const { rows } = await pool.query(`
    SELECT 
      time_bucket($1, discount_time) as bucket,
      symbol,
      AVG(discount_pct) as avg_discount
    FROM discount_history 
    WHERE discount_time >= $2
      AND discount_pct IS NOT NULL
      AND discount_pct > 0.5
    GROUP BY bucket, symbol
    ORDER BY bucket, symbol
  `, [
    `${BUCKET_MS} milliseconds`,
    new Date(startTime)
  ]);
  
  console.log(`Loaded ${rows.length} data points`);
  
  const trades = [];
  const openPositions = {};
  
  // Process each bucket
  const buckets = [...new Set(rows.map(r => r.bucket.getTime()))].sort();
  
  for (const bucketTime of buckets) {
    const bucketData = rows.filter(r => r.bucket.getTime() === bucketTime);
    
    // Check exits first
    for (const [token, pos] of Object.entries(openPositions)) {
      const currentData = bucketData.find(d => d.symbol === token);
      const holdTime = bucketTime - pos.entryTime;
      
      let exitReason = null;
      if (!currentData) {
        exitReason = 'no_data';
      } else if (currentData.avg_discount <= CONFIG.targetSpread) {
        exitReason = 'target';
      } else if (holdTime >= CONFIG.maxHoldMs) {
        exitReason = 'max_hold';
      }
      
      if (exitReason) {
        const exitDiscount = currentData ? currentData.avg_discount : pos.entryDiscount;
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
        .filter(d => d.avg_discount >= CONFIG.minEntrySpread)
        .filter(d => !openPositions[d.symbol])
        .sort((a, b) => b.avg_discount - a.avg_discount);
      
      for (const opp of entryOpportunities.slice(0, CONFIG.maxConcurrentPositions - Object.keys(openPositions).length)) {
        if (bucketTime > Date.now() - CONFIG.minHoldMs) continue;
        
        openPositions[opp.symbol] = {
          entryTime: bucketTime,
          entryDiscount: opp.avg_discount
        };
      }
    }
  }
  
  // Close remaining positions
  for (const [token, pos] of Object.entries(openPositions)) {
    const lastBucket = buckets[buckets.length - 1];
    const lastData = rows.filter(r => r.bucket.getTime() === lastBucket).find(d => d.symbol === token);
    const exitDiscount = lastData ? lastData.avg_discount : pos.entryDiscount;
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
  console.log(`Entry: 4.0% | Max Hold: ${maxHoldMin}min | Days: 3`);
  console.log('='.repeat(50));
  console.log(`Trades: ${trades.length}`);
  console.log(`Win Rate: ${((wins.length / trades.length) * 100 || 0).toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`Net P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`Avg Hold: ${avgHold.toFixed(1)} min`);
  
  // Exit reason breakdown
  const byReason = {};
  trades.forEach(t => { byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1; });
  console.log('\nExit Reasons:');
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
  
  console.log('\nTop 5 Tokens:');
  sortedTokens.slice(0, 5).forEach(([token, stats]) => {
    const wr = ((stats.wins / stats.trades) * 100).toFixed(0);
    console.log(`  ${token}: ${stats.trades} trades, ${wr}% WR, ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  });
  
  console.log('='.repeat(50));
  
  await pool.end();
}

run().catch(console.error);