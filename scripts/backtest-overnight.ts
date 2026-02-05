/**
 * Backtest overnight trades with different parameters
 * Uses actual spread history from the database
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '../data/parallax.db');

interface SpreadRecord {
  timestamp: number;
  stock_ticker: string;
  token_a_symbol: string;
  token_a_price: number;
  stock_price: number;
  token_a_discount_vs_stock: number;
}

interface SimulatedTrade {
  ticker: string;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  entryDiscount: number;
  exitDiscount: number;
  holdTimeMin: number;
  tokenAppreciation: number;
  pnlPct: number;
  pnlUsd: number;
  exitReason: string;
}

interface SimulationParams {
  entryThreshold: number;      // Min discount to enter (e.g., 1.5%)
  exitAppreciation: number;    // Min token appreciation to exit (e.g., 0.3%)
  minHoldTimeMin: number;      // Min hold time before profit exit (e.g., 5)
  stopLoss: number;            // Stop loss discount threshold (e.g., -1%)
  maxHoldTimeHours: number;    // Max hold time (e.g., 24)
  executionCostPct: number;    // Actual execution cost (e.g., 0.5%)
  positionSize: number;        // USD per trade (e.g., 10)
}

function runSimulation(
  spreads: SpreadRecord[],
  params: SimulationParams
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  const openPositions: Map<string, { entryTime: number; entryPrice: number; entryDiscount: number }> = new Map();

  // Sort by timestamp
  spreads.sort((a, b) => a.timestamp - b.timestamp);

  for (const spread of spreads) {
    const ticker = spread.stock_ticker;
    const discount = spread.token_a_discount_vs_stock;
    const tokenPrice = spread.token_a_price;

    // Skip invalid data
    if (!tokenPrice || tokenPrice <= 0 || !isFinite(discount)) continue;
    if (Math.abs(discount) > 20) continue; // Skip extreme values

    const position = openPositions.get(ticker);

    if (position) {
      // Check exit conditions
      const holdTimeMs = spread.timestamp - position.entryTime;
      const holdTimeMin = holdTimeMs / 60000;
      const tokenAppreciation = ((tokenPrice - position.entryPrice) / position.entryPrice) * 100;

      let shouldExit = false;
      let exitReason = '';

      // 1. Profit target (with min hold time)
      if (tokenAppreciation >= params.exitAppreciation && holdTimeMin >= params.minHoldTimeMin) {
        shouldExit = true;
        exitReason = 'profit_target';
      }

      // 2. Stop loss
      if (discount <= params.stopLoss && holdTimeMin >= 1) {
        shouldExit = true;
        exitReason = 'stop_loss';
      }

      // 3. Max hold time
      if (holdTimeMin >= params.maxHoldTimeHours * 60) {
        shouldExit = true;
        exitReason = 'max_hold_time';
      }

      if (shouldExit) {
        // Calculate PnL accounting for execution costs
        const grossPnlPct = tokenAppreciation;
        const netPnlPct = grossPnlPct - params.executionCostPct;
        const pnlUsd = params.positionSize * (netPnlPct / 100);

        trades.push({
          ticker,
          entryTime: new Date(position.entryTime),
          exitTime: new Date(spread.timestamp),
          entryPrice: position.entryPrice,
          exitPrice: tokenPrice,
          entryDiscount: position.entryDiscount,
          exitDiscount: discount,
          holdTimeMin,
          tokenAppreciation,
          pnlPct: netPnlPct,
          pnlUsd,
          exitReason,
        });

        openPositions.delete(ticker);
      }
    } else {
      // Check entry conditions
      if (discount >= params.entryThreshold) {
        openPositions.set(ticker, {
          entryTime: spread.timestamp,
          entryPrice: tokenPrice,
          entryDiscount: discount,
        });
      }
    }
  }

  return trades;
}

function printResults(name: string, trades: SimulatedTrade[], params: SimulationParams) {
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const winners = trades.filter(t => t.pnlUsd > 0).length;
  const losers = trades.filter(t => t.pnlUsd <= 0).length;
  const avgHoldTime = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.holdTimeMin, 0) / trades.length
    : 0;

  console.log('\n' + '='.repeat(70));
  console.log(`SCENARIO: ${name}`);
  console.log('='.repeat(70));
  console.log(`Parameters:`);
  console.log(`  Entry threshold:    ${params.entryThreshold}% discount`);
  console.log(`  Exit appreciation:  ${params.exitAppreciation}%`);
  console.log(`  Min hold time:      ${params.minHoldTimeMin} min`);
  console.log(`  Execution cost:     ${params.executionCostPct}%`);
  console.log('-'.repeat(70));
  console.log(`Results:`);
  console.log(`  Total trades:       ${trades.length}`);
  console.log(`  Winners:            ${winners}`);
  console.log(`  Losers:             ${losers}`);
  console.log(`  Win rate:           ${trades.length > 0 ? ((winners / trades.length) * 100).toFixed(1) : 0}%`);
  console.log(`  Total PnL:          $${totalPnl.toFixed(2)}`);
  console.log(`  Avg PnL/trade:      $${trades.length > 0 ? (totalPnl / trades.length).toFixed(3) : 0}`);
  console.log(`  Avg hold time:      ${avgHoldTime.toFixed(1)} min`);

  // By exit reason
  const byReason = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const curr = byReason.get(t.exitReason) || { count: 0, pnl: 0 };
    curr.count++;
    curr.pnl += t.pnlUsd;
    byReason.set(t.exitReason, curr);
  }

  if (byReason.size > 0) {
    console.log('-'.repeat(70));
    console.log('By exit reason:');
    for (const [reason, stats] of byReason) {
      console.log(`  ${reason.padEnd(20)} ${stats.count} trades, $${stats.pnl.toFixed(2)}`);
    }
  }

  // Show sample trades
  if (trades.length > 0) {
    console.log('-'.repeat(70));
    console.log('Sample trades:');
    const sample = trades.slice(0, 5);
    for (const t of sample) {
      const sign = t.pnlUsd >= 0 ? '+' : '';
      console.log(`  ${t.ticker.padEnd(6)} ${t.entryTime.toLocaleTimeString()} → ${t.exitTime.toLocaleTimeString()} | ` +
        `hold: ${t.holdTimeMin.toFixed(0)}m | apprec: ${t.tokenAppreciation.toFixed(2)}% | ${sign}$${t.pnlUsd.toFixed(3)}`);
    }
  }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get last 24 hours of spread data
  const startTime = Date.now() - 24 * 60 * 60 * 1000;

  const spreads = db.prepare(`
    SELECT timestamp, stock_ticker, token_a_symbol, token_a_price, stock_price, token_a_discount_vs_stock
    FROM discount_history
    WHERE timestamp > ?
    ORDER BY timestamp
  `).all(startTime) as SpreadRecord[];

  console.log(`\nLoaded ${spreads.length} spread records from last 24 hours`);
  console.log(`Time range: ${new Date(startTime).toLocaleString()} to ${new Date().toLocaleString()}`);

  // Scenario 1: Current parameters (what you actually ran)
  const currentParams: SimulationParams = {
    entryThreshold: 1.5,
    exitAppreciation: 0.3,
    minHoldTimeMin: 0.5,  // 30 seconds
    stopLoss: -1.0,
    maxHoldTimeHours: 24,
    executionCostPct: 0.5,  // Actual observed cost from your trades
    positionSize: 10,
  };

  // Scenario 2: Fix A - Just increase exit threshold to 0.8%
  const fixA: SimulationParams = {
    ...currentParams,
    exitAppreciation: 0.8,
  };

  // Scenario 3: Fix B - 0.8% exit + 5 min minimum hold
  const fixB: SimulationParams = {
    ...currentParams,
    exitAppreciation: 0.8,
    minHoldTimeMin: 5,
  };

  // Scenario 4: Fix C - 1.0% exit threshold (more conservative)
  const fixC: SimulationParams = {
    ...currentParams,
    exitAppreciation: 1.0,
    minHoldTimeMin: 5,
  };

  // Scenario 5: Fix D - Higher entry (2%) + 1% exit
  const fixD: SimulationParams = {
    ...currentParams,
    entryThreshold: 2.0,
    exitAppreciation: 1.0,
    minHoldTimeMin: 5,
  };

  // Scenario 6: Fix E - Very safe: 2% entry, 1.2% exit, 10 min hold
  const fixE: SimulationParams = {
    ...currentParams,
    entryThreshold: 2.0,
    exitAppreciation: 1.2,
    minHoldTimeMin: 10,
  };

  // Run simulations
  const scenarios = [
    { name: 'CURRENT (0.3% exit) - YOUR ACTUAL SETTINGS', params: currentParams },
    { name: 'FIX A: 0.8% exit threshold', params: fixA },
    { name: 'FIX B: 0.8% exit + 5 min hold', params: fixB },
    { name: 'FIX C: 1.0% exit + 5 min hold', params: fixC },
    { name: 'FIX D: 2% entry + 1.0% exit + 5 min hold', params: fixD },
    { name: 'FIX E: 2% entry + 1.2% exit + 10 min hold (safest)', params: fixE },
  ];

  for (const { name, params } of scenarios) {
    const trades = runSimulation(spreads, params);
    printResults(name, trades, params);
  }

  db.close();
}

main().catch(console.error);
