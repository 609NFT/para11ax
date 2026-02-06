#!/usr/bin/env node
/**
 * Quick backtest runner (no ts-node overhead)
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Config
const CONFIG = {
  minEntrySpread: parseFloat(process.argv[2]) || 3.5,
  targetSpread: 0.5,
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: 90 * 60 * 1000, // 90 minutes for test
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: parseFloat(process.argv[3]) || 3,
};

async function run() {
  console.log(`\nBacktest: ${CONFIG.minEntrySpread}% entry, ${CONFIG.lookbackDays} days lookback\n`);
  
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000;
  
  // Fetch downsampled data
  console.log('Fetching data...');
  const result = await pool.query(`
    SELECT 
      token_a_symbol as token,
      (FLOOR(timestamp / ${BUCKET_MS}) * ${BUCKET_MS})::bigint as ts,
      AVG(COALESCE(token_a_discount_vs_stock, 0)) as spread
    FROM discount_history
    WHERE timestamp >= $1
    GROUP BY token_a_symbol, FLOOR(timestamp / ${BUCKET_MS})
    ORDER BY ts ASC
  `, [startTime]);
  
  console.log(`Loaded ${result.rows.length} data points\n`);
  
  // Simulate
  const openPositions = new Map();
  const trades = [];
  
  for (const row of result.rows) {
    const { token, ts, spread } = row;
    const timestamp = Number(ts);
    const spreadPct = Number(spread);
    
    // Check exits
    const position = openPositions.get(token);
    if (position) {
      const holdTime = timestamp - position.entryTime;
      let shouldExit = false;
      let exitReason = 'target';
      
      if (holdTime >= CONFIG.minHoldMs) {
        if (spreadPct <= CONFIG.targetSpread) {
          shouldExit = true;
          exitReason = 'target';
        }
      }
      if (holdTime >= CONFIG.maxHoldMs) {
        shouldExit = true;
        exitReason = 'max_hold';
      }
      
      if (shouldExit) {
        const grossPnlPct = position.entrySpread - spreadPct;
        const netPnlPct = grossPnlPct - CONFIG.entryFeePct - CONFIG.exitFeePct;
        const netPnlUsd = (netPnlPct / 100) * CONFIG.positionSizeUsd;
        
        trades.push({
          token,
          entrySpread: position.entrySpread,
          exitSpread: spreadPct,
          exitReason,
          netPnlUsd,
          holdTimeMs: holdTime,
        });
        openPositions.delete(token);
      }
    }
    
    // Check entry
    if (!openPositions.has(token) && openPositions.size < CONFIG.maxConcurrentPositions) {
      if (spreadPct >= CONFIG.minEntrySpread) {
        openPositions.set(token, {
          entryTime: timestamp,
          entrySpread: spreadPct,
        });
      }
    }
  }
  
  // Results
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const avgHold = trades.length > 0 
    ? trades.reduce((sum, t) => sum + t.holdTimeMs, 0) / trades.length / 60000
    : 0;
  
  console.log('='.repeat(50));
  console.log(`Entry: ${CONFIG.minEntrySpread}% | Days: ${CONFIG.lookbackDays}`);
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
  
  console.log('\nWorst 5 Tokens:');
  sortedTokens.slice(-5).reverse().forEach(([token, stats]) => {
    const wr = ((stats.wins / stats.trades) * 100).toFixed(0);
    console.log(`  ${token}: ${stats.trades} trades, ${wr}% WR, ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  });
  
  console.log('='.repeat(50));
  
  await pool.end();
}

run().catch(e => {
  console.error(e);
  pool.end();
  process.exit(1);
});
