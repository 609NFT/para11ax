#!/usr/bin/env node
/**
 * Parameter sweep backtest — tests combinations of exit target and max hold time
 * Uses NEW volatility params
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

const TOKEN_ATR = {
  QQQ: 1.2, SPY: 1.2, AAPL: 1.3, META: 1.3,
  NVDA: 1.8, AMZN: 2.2, GOLD: 2.4, GOOGL: 2.6,
  TSLA: 2.9, GLD: 3.1, COIN: 3.1, HOOD: 3.5,
  MCD: 3.6, CRCL: 4.1, MSTR: 5.1, SLV: 11.6,
};

function getThreshold(token) {
  const ticker = token.replace(/[rx]$/, '').replace(/x$/, '');
  const atr = TOKEN_ATR[ticker];
  if (!atr) return 4.0;
  const raw = 1 + (atr - 2.7) * 0.15;
  const mult = Math.max(0.85, Math.min(raw, 1.30));
  return 4.0 * mult;
}

function simulate(rows, config) {
  const openPositions = new Map();
  const trades = [];
  
  for (const row of rows) {
    const { token, ts, spread } = row;
    const timestamp = Number(ts);
    const spreadPct = Number(spread);
    
    const position = openPositions.get(token);
    if (position) {
      const holdTime = timestamp - position.entryTime;
      let shouldExit = false;
      let exitReason = '';
      
      // Stop loss
      if (spreadPct <= -config.stopLossPct) {
        shouldExit = true; exitReason = 'stop_loss';
      }
      // Target exit
      else if (holdTime >= config.minHoldMs && spreadPct <= config.targetSpread) {
        shouldExit = true; exitReason = 'target';
      }
      // Max hold
      else if (holdTime >= config.maxHoldMs) {
        shouldExit = true; exitReason = 'max_hold';
      }
      
      if (shouldExit) {
        const grossPnlPct = position.entrySpread - spreadPct;
        const netPnlPct = grossPnlPct - config.entryFeePct - config.exitFeePct;
        const netPnlUsd = (netPnlPct / 100) * config.positionSizeUsd;
        trades.push({ token, entrySpread: position.entrySpread, exitSpread: spreadPct, exitReason, netPnlUsd, holdTimeMs: holdTime });
        openPositions.delete(token);
      }
    }
    
    if (!openPositions.has(token) && openPositions.size < config.maxConcurrentPositions) {
      const threshold = getThreshold(token);
      if (spreadPct >= threshold) {
        openPositions.set(token, { entryTime: timestamp, entrySpread: spreadPct });
      }
    }
  }
  return trades;
}

async function run() {
  const BUCKET_MS = 5 * 60 * 1000;
  const lookbackDays = parseFloat(process.argv[2]) || 7;
  const startTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  
  console.log(`Parameter Sweep: ${lookbackDays} days, NEW volatility params\n`);
  
  console.log('Fetching data...');
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
  
  console.log(`Loaded ${result.rows.length} data points\n`);

  // Sweep parameters
  const exitTargets = [0.5, 1.0, 1.5, 2.0, 2.5];
  const maxHolds = [1, 2, 4, 8, 12, 24]; // hours
  const minHolds = [5]; // minutes — keep constant
  
  const results = [];
  
  for (const target of exitTargets) {
    for (const maxH of maxHolds) {
      const config = {
        targetSpread: target,
        minHoldMs: 5 * 60 * 1000,
        maxHoldMs: maxH * 60 * 60 * 1000,
        positionSizeUsd: 10,
        maxConcurrentPositions: 3,
        entryFeePct: 0.3,
        exitFeePct: 0.3,
        stopLossPct: 5,
      };
      
      const trades = simulate(result.rows, config);
      const wins = trades.filter(t => t.netPnlUsd > 0).length;
      const pnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
      const targets = trades.filter(t => t.exitReason === 'target').length;
      const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdTimeMs, 0) / trades.length / 60000 : 0;
      
      results.push({
        target, maxH,
        trades: trades.length,
        wr: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : '0',
        pnl: pnl.toFixed(2),
        targetExits: targets,
        avgHold: avgHold.toFixed(0),
      });
    }
  }
  
  // Print as table
  console.log('Exit%  MaxH  Trades  WR%    P&L     Targets  AvgHold');
  console.log('-'.repeat(60));
  
  // Sort by PnL descending
  results.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  
  for (const r of results) {
    const pnlStr = parseFloat(r.pnl) >= 0 ? `+$${r.pnl}` : `-$${Math.abs(parseFloat(r.pnl)).toFixed(2)}`;
    console.log(`${r.target.toFixed(1)}%   ${String(r.maxH).padStart(3)}h   ${String(r.trades).padStart(4)}    ${r.wr.padStart(5)}%  ${pnlStr.padStart(7)}  ${String(r.targetExits).padStart(5)}     ${r.avgHold}m`);
  }
  
  console.log(`\nTop 5 combos by P&L ↑`);
  
  await pool.end();
}

run().catch(e => { console.error(e); pool.end(); process.exit(1); });
