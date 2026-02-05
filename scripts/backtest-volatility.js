#!/usr/bin/env node
/**
 * Backtest comparing old vs new volatility entry multipliers
 * Tests per-token adjusted thresholds against discount_history
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// ATR data from live system (as of Feb 4 2026)
const TOKEN_ATR = {
  QQQ: 1.2, SPY: 1.2, AAPL: 1.3, META: 1.3,
  NVDA: 1.8, AMZN: 2.2, GOLD: 2.4, GOOGL: 2.6,
  TSLA: 2.9, GLD: 3.1, COIN: 3.1, HOOD: 3.5,
  MCD: 3.6, CRCL: 4.1, MSTR: 5.1, SLV: 11.6,
};

function getMultiplier(symbol, baseAtr, sensitivity, minMult, maxMult) {
  // Strip r/x suffix to match ATR keys
  const ticker = symbol.replace(/[rx]$/, '').replace(/x$/, '');
  const atr = TOKEN_ATR[ticker];
  if (!atr) return 1.0;
  const raw = 1 + (atr - baseAtr) * sensitivity;
  return Math.max(minMult, Math.min(raw, maxMult));
}

const OLD_PARAMS = { baseAtr: 1.5, sensitivity: 0.6, minMult: 0.8, maxMult: 3.0, label: 'OLD' };
const NEW_PARAMS = { baseAtr: 2.7, sensitivity: 0.15, minMult: 0.85, maxMult: 1.30, label: 'NEW' };
const FLAT_4PCT = { label: 'FLAT 4%' };

const BASE_THRESHOLD = 4.0;
const CONFIG = {
  targetSpread: 0.5,
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: 4 * 60 * 60 * 1000,
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: parseFloat(process.argv[2]) || 7,
};

function simulate(rows, getThreshold) {
  const openPositions = new Map();
  const trades = [];
  
  for (const row of rows) {
    const { token, ts, spread } = row;
    const timestamp = Number(ts);
    const spreadPct = Number(spread);
    
    // Check exits
    const position = openPositions.get(token);
    if (position) {
      const holdTime = timestamp - position.entryTime;
      let shouldExit = false;
      let exitReason = 'target';
      
      if (holdTime >= CONFIG.minHoldMs && spreadPct <= CONFIG.targetSpread) {
        shouldExit = true; exitReason = 'target';
      }
      if (holdTime >= CONFIG.maxHoldMs) {
        shouldExit = true; exitReason = 'max_hold';
      }
      
      if (shouldExit) {
        const grossPnlPct = position.entrySpread - spreadPct;
        const netPnlPct = grossPnlPct - CONFIG.entryFeePct - CONFIG.exitFeePct;
        const netPnlUsd = (netPnlPct / 100) * CONFIG.positionSizeUsd;
        trades.push({ token, entrySpread: position.entrySpread, exitSpread: spreadPct, exitReason, netPnlUsd, holdTimeMs: holdTime });
        openPositions.delete(token);
      }
    }
    
    // Check entry
    if (!openPositions.has(token) && openPositions.size < CONFIG.maxConcurrentPositions) {
      const threshold = getThreshold(token);
      if (spreadPct >= threshold) {
        openPositions.set(token, { entryTime: timestamp, entrySpread: spreadPct });
      }
    }
  }
  return trades;
}

function printResults(label, trades) {
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const avgHold = trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdTimeMs, 0) / trades.length / 60000 : 0;
  const targets = trades.filter(t => t.exitReason === 'target').length;
  const maxHolds = trades.filter(t => t.exitReason === 'max_hold').length;
  
  console.log(`\n${'='.repeat(55)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(55)}`);
  console.log(`  Trades: ${trades.length}  |  Win Rate: ${((wins.length / (trades.length || 1)) * 100).toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  Net P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}  |  Avg Hold: ${avgHold.toFixed(1)} min`);
  console.log(`  Exits: ${targets} target, ${maxHolds} max_hold`);
  
  // By token (top 5)
  const byToken = {};
  trades.forEach(t => {
    if (!byToken[t.token]) byToken[t.token] = { trades: 0, wins: 0, pnl: 0 };
    byToken[t.token].trades++;
    if (t.netPnlUsd > 0) byToken[t.token].wins++;
    byToken[t.token].pnl += t.netPnlUsd;
  });
  const sorted = Object.entries(byToken).sort((a, b) => b[1].pnl - a[1].pnl);
  if (sorted.length > 0) {
    console.log(`  Top tokens:`);
    sorted.slice(0, 5).forEach(([tok, s]) => {
      console.log(`    ${tok}: ${s.trades}t, ${((s.wins/s.trades)*100).toFixed(0)}% WR, ${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`);
    });
  }
}

async function run() {
  const BUCKET_MS = 5 * 60 * 1000;
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  
  console.log(`\nVolatility Backtest: ${CONFIG.lookbackDays} days lookback`);
  console.log(`Base threshold: ${BASE_THRESHOLD}%\n`);
  
  // Show per-token thresholds
  console.log('Per-token thresholds:');
  console.log('   Token    ATR     OLD     NEW    FLAT');
  for (const [ticker, atr] of Object.entries(TOKEN_ATR).sort((a,b) => a[1]-b[1])) {
    const oldM = getMultiplier(ticker, OLD_PARAMS.baseAtr, OLD_PARAMS.sensitivity, OLD_PARAMS.minMult, OLD_PARAMS.maxMult);
    const newM = getMultiplier(ticker, NEW_PARAMS.baseAtr, NEW_PARAMS.sensitivity, NEW_PARAMS.minMult, NEW_PARAMS.maxMult);
    console.log(`${ticker.padStart(8)}  ${atr.toFixed(1)}%  ${(BASE_THRESHOLD*oldM).toFixed(1)}%  ${(BASE_THRESHOLD*newM).toFixed(1)}%  ${BASE_THRESHOLD.toFixed(1)}%`);
  }
  
  console.log('\nFetching data...');
  const result = await pool.query(`
    SELECT 
      token_a_symbol as token,
      (FLOOR(timestamp / ${BUCKET_MS}) * ${BUCKET_MS})::bigint as ts,
      AVG(COALESCE(token_a_discount_vs_stock, 0)) as spread
    FROM discount_history
    WHERE timestamp >= $1
      AND COALESCE(token_a_discount_vs_stock, 0) BETWEEN 0 AND 50
    GROUP BY token_a_symbol, FLOOR(timestamp / ${BUCKET_MS})
    ORDER BY ts ASC
  `, [startTime]);
  
  console.log(`Loaded ${result.rows.length} data points`);
  
  // Run all three scenarios
  const oldTrades = simulate(result.rows, (token) => {
    const m = getMultiplier(token, OLD_PARAMS.baseAtr, OLD_PARAMS.sensitivity, OLD_PARAMS.minMult, OLD_PARAMS.maxMult);
    return BASE_THRESHOLD * m;
  });
  
  const newTrades = simulate(result.rows, (token) => {
    const m = getMultiplier(token, NEW_PARAMS.baseAtr, NEW_PARAMS.sensitivity, NEW_PARAMS.minMult, NEW_PARAMS.maxMult);
    return BASE_THRESHOLD * m;
  });
  
  const flatTrades = simulate(result.rows, () => BASE_THRESHOLD);
  
  printResults('OLD volatility (BASE=1.5, SENS=0.6, MAX=3.0)', oldTrades);
  printResults('NEW volatility (BASE=2.7, SENS=0.15, MAX=1.3)', newTrades);
  printResults('FLAT 4% (no volatility adjustment)', flatTrades);
  
  console.log('\n');
  await pool.end();
}

run().catch(e => { console.error(e); pool.end(); process.exit(1); });
