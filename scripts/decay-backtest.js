#!/usr/bin/env node
/**
 * Decay timing backtest - test different decay start times
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Exit threshold constants (from current system)
const BASE_EXIT_THRESHOLD_PCT = 2.5;  // Typical exit threshold
const MIN_EXIT_THRESHOLD_PCT = 1.0;   // Final decayed value
const DECAY_DURATION_MS = 20 * 60 * 1000;  // 20 minutes decay period (like current 30->50)

// Function to calculate decayed exit threshold
function getExitThreshold(holdTimeMs, decayStartMs) {
  const decayEndMs = decayStartMs + DECAY_DURATION_MS;
  
  if (holdTimeMs <= decayStartMs) {
    return BASE_EXIT_THRESHOLD_PCT;
  }
  
  if (holdTimeMs >= decayEndMs) {
    return MIN_EXIT_THRESHOLD_PCT;
  }
  
  const decayProgress = (holdTimeMs - decayStartMs) / DECAY_DURATION_MS;
  return BASE_EXIT_THRESHOLD_PCT - (BASE_EXIT_THRESHOLD_PCT - MIN_EXIT_THRESHOLD_PCT) * decayProgress;
}

// Config
const CONFIG = {
  minEntrySpread: 4.0,  // Current baseline
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: 60 * 60 * 1000,  // Current 60min max hold
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: 3,
  decayStartMs: parseFloat(process.argv[2]) * 60 * 1000 || 30 * 60 * 1000, // minutes to ms
};

async function run() {
  const decayStartMinutes = CONFIG.decayStartMs / 60000;
  const decayEndMinutes = (CONFIG.decayStartMs + DECAY_DURATION_MS) / 60000;
  console.log(`\nBacktest: Decay ${decayStartMinutes}min→${decayEndMinutes}min (${BASE_EXIT_THRESHOLD_PCT}%→${MIN_EXIT_THRESHOLD_PCT}%)\n`);
  
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000;
  
  // Fetch data
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
      
      // Dynamic exit threshold with decay
      const currentExitThreshold = getExitThreshold(holdTime, CONFIG.decayStartMs);
      
      if (holdTime >= CONFIG.minHoldMs) {
        if (spreadPct <= currentExitThreshold) {
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
          exitThreshold: currentExitThreshold,
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
  
  // Decay exit analysis
  const targetExits = trades.filter(t => t.exitReason === 'target');
  const decayExits = targetExits.filter(t => t.exitThreshold < BASE_EXIT_THRESHOLD_PCT);
  
  console.log('='.repeat(50));
  console.log(`Entry: ${CONFIG.minEntrySpread}% | Decay: ${decayStartMinutes}min→${decayEndMinutes}min`);
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
  
  // Decay impact analysis
  console.log(`\nDecay Impact:`);
  console.log(`  Target exits using decay threshold: ${decayExits.length}/${targetExits.length}`);
  if (decayExits.length > 0) {
    const decayPnl = decayExits.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const avgDecayThreshold = decayExits.reduce((sum, t) => sum + t.exitThreshold, 0) / decayExits.length;
    console.log(`  Decay exits PnL: ${decayPnl >= 0 ? '+' : ''}$${decayPnl.toFixed(2)}`);
    console.log(`  Avg decay threshold: ${avgDecayThreshold.toFixed(2)}%`);
  }
  
  // By token
  const byToken = {};
  trades.forEach(t => {
    if (!byToken[t.token]) byToken[t.token] = { trades: 0, wins: 0, pnl: 0 };
    byToken[t.token].trades++;
    if (t.netPnlUsd > 0) byToken[t.token].wins++;
    byToken[t.token].pnl += t.netPnlUsd;
  });
  
  const sortedTokens = Object.entries(byToken).sort((a, b) => b[1].pnl - a[1].pnl);
  
  console.log('\nTop 5 Tokens:');
  sortedTokens.slice(0, 5).forEach(([token, stats]) => {
    const wr = ((stats.wins / stats.trades) * 100).toFixed(0);
    console.log(`  ${token}: ${stats.trades} trades, ${wr}% WR, ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  });
  
  console.log('='.repeat(50));
  console.log('');
  
  await pool.end();
  
  // Return results for JSON logging
  return {
    trades: trades.length,
    winRate: ((wins.length / trades.length) * 100 || 0),
    netPnL: totalPnl,
    avgHold: avgHold,
    decayExits: decayExits.length,
    decayImpact: decayExits.length > 0 ? decayExits.reduce((sum, t) => sum + t.netPnlUsd, 0) : 0
  };
}

if (require.main === module) {
  run().catch(e => {
    console.error(e);
    pool.end();
    process.exit(1);
  });
} else {
  module.exports = { run };
}