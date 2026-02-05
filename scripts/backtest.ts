#!/usr/bin/env npx ts-node
/**
 * Backtest CLI - Test parameter changes against historical data
 * 
 * Usage:
 *   npx ts-node scripts/backtest.ts                    # Run with defaults
 *   npx ts-node scripts/backtest.ts --entry 4.0       # Test 4% entry threshold
 *   npx ts-node scripts/backtest.ts --compare         # Compare multiple configs
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runBacktest, compareConfigs, BacktestConfig, BacktestResult } from '../src/backtest/backtester';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
  return value >= 0 ? `+$${value.toFixed(2)}` : `-$${Math.abs(value).toFixed(2)}`;
}

function printResult(result: BacktestResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(60));
  
  console.log('\n📊 Configuration:');
  console.log(`   Entry threshold: ${result.config.minEntrySpread}%`);
  console.log(`   Target spread: ${result.config.targetSpread}%`);
  console.log(`   Min hold: ${formatDuration(result.config.minHoldMs)}`);
  console.log(`   Max hold: ${formatDuration(result.config.maxHoldMs)}`);
  console.log(`   Position size: $${result.config.positionSizeUsd}`);
  console.log(`   Max concurrent: ${result.config.maxConcurrentPositions}`);
  console.log(`   Fees: ${result.config.entryFeePct + result.config.exitFeePct}% round-trip`);
  
  console.log('\n📈 Data Coverage:');
  console.log(`   Period: ${new Date(result.dataStartTime).toISOString().slice(0, 16)} → ${new Date(result.dataEndTime).toISOString().slice(0, 16)}`);
  console.log(`   Tokens: ${result.uniqueTokens.length} (${result.uniqueTokens.slice(0, 5).join(', ')}${result.uniqueTokens.length > 5 ? '...' : ''})`);
  
  console.log('\n💰 Performance:');
  console.log(`   Total trades: ${result.totalTrades}`);
  console.log(`   Win rate: ${formatPercent(result.winRate)} (${result.winningTrades}W / ${result.losingTrades}L)`);
  console.log(`   Net P&L: ${formatUsd(result.totalPnlUsd)}`);
  console.log(`   Gross P&L: ${formatUsd(result.grossPnlUsd)}`);
  console.log(`   Total fees: $${result.totalFeesUsd.toFixed(2)}`);
  console.log(`   Avg P&L/trade: ${formatUsd(result.avgPnlPerTrade)}`);
  console.log(`   Largest win: ${formatUsd(result.largestWin)}`);
  console.log(`   Largest loss: ${formatUsd(result.largestLoss)}`);
  console.log(`   Avg hold time: ${result.avgHoldTimeMin.toFixed(1)} min`);
  
  // Top tokens by P&L
  console.log('\n🏆 Top Tokens (by P&L):');
  const tokenStats = Array.from(result.byToken.entries())
    .filter(([, stats]) => stats.trades > 0)
    .sort((a, b) => b[1].pnlUsd - a[1].pnlUsd)
    .slice(0, 5);
  for (const [token, stats] of tokenStats) {
    console.log(`   ${token.padEnd(8)} ${stats.trades} trades, ${formatPercent(stats.winRate)} WR, ${formatUsd(stats.pnlUsd)}`);
  }
  
  // Worst tokens
  console.log('\n💀 Worst Tokens (by P&L):');
  const worstTokens = Array.from(result.byToken.entries())
    .filter(([, stats]) => stats.trades > 0)
    .sort((a, b) => a[1].pnlUsd - b[1].pnlUsd)
    .slice(0, 5);
  for (const [token, stats] of worstTokens) {
    console.log(`   ${token.padEnd(8)} ${stats.trades} trades, ${formatPercent(stats.winRate)} WR, ${formatUsd(stats.pnlUsd)}`);
  }
  
  // Best hours
  console.log('\n⏰ Best Hours (UTC):');
  const hourStats = Array.from(result.byHour.entries())
    .filter(([, stats]) => stats.trades >= 2)
    .sort((a, b) => b[1].winRate - a[1].winRate)
    .slice(0, 5);
  for (const [hour, stats] of hourStats) {
    console.log(`   ${hour.toString().padStart(2, '0')}:00  ${stats.trades} trades, ${formatPercent(stats.winRate)} WR, ${formatUsd(stats.pnlUsd)}`);
  }
  
  // Worst hours
  console.log('\n🚫 Worst Hours (UTC):');
  const worstHours = Array.from(result.byHour.entries())
    .filter(([, stats]) => stats.trades >= 2)
    .sort((a, b) => a[1].winRate - b[1].winRate)
    .slice(0, 5);
  for (const [hour, stats] of worstHours) {
    console.log(`   ${hour.toString().padStart(2, '0')}:00  ${stats.trades} trades, ${formatPercent(stats.winRate)} WR, ${formatUsd(stats.pnlUsd)}`);
  }
  
  // Exit reason breakdown
  console.log('\n🚪 Exit Reasons:');
  const exitReasons = new Map<string, number>();
  for (const trade of result.trades) {
    exitReasons.set(trade.exitReason, (exitReasons.get(trade.exitReason) || 0) + 1);
  }
  for (const [reason, count] of exitReasons) {
    console.log(`   ${reason.padEnd(12)} ${count} (${formatPercent(count / result.totalTrades)})`);
  }
  
  console.log('\n' + '='.repeat(60));
}

function printComparison(results: { config: Partial<BacktestConfig>; result: BacktestResult }[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('CONFIGURATION COMPARISON');
  console.log('='.repeat(80));
  
  console.log('\n' + 'Entry%'.padStart(8) + 'Target%'.padStart(10) + 'Trades'.padStart(10) + 
    'Win Rate'.padStart(12) + 'Net P&L'.padStart(12) + 'Avg/Trade'.padStart(12));
  console.log('-'.repeat(80));
  
  for (const { config, result } of results) {
    const entry = (config.minEntrySpread ?? 3.5).toFixed(1);
    const target = (config.targetSpread ?? 0.5).toFixed(1);
    console.log(
      entry.padStart(8) + 
      target.padStart(10) + 
      result.totalTrades.toString().padStart(10) + 
      formatPercent(result.winRate).padStart(12) + 
      formatUsd(result.totalPnlUsd).padStart(12) +
      formatUsd(result.avgPnlPerTrade).padStart(12)
    );
  }
  
  console.log('\n' + '='.repeat(80));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const configOverrides: Partial<BacktestConfig> = {};
  let compareMode = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    switch (arg) {
      case '--entry':
      case '-e':
        configOverrides.minEntrySpread = parseFloat(nextArg);
        i++;
        break;
      case '--target':
      case '-t':
        configOverrides.targetSpread = parseFloat(nextArg);
        i++;
        break;
      case '--min-hold':
        configOverrides.minHoldMs = parseFloat(nextArg) * 60 * 1000;
        i++;
        break;
      case '--max-hold':
        configOverrides.maxHoldMs = parseFloat(nextArg) * 60 * 1000;
        i++;
        break;
      case '--size':
        configOverrides.positionSizeUsd = parseFloat(nextArg);
        i++;
        break;
      case '--compare':
      case '-c':
        compareMode = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Parallax Backtester

Usage:
  npx ts-node scripts/backtest.ts [options]

Options:
  --entry, -e <pct>     Minimum entry spread % (default: 3.5)
  --target, -t <pct>    Target exit spread % (default: 0.5)
  --min-hold <min>      Minimum hold time in minutes (default: 5)
  --max-hold <min>      Maximum hold time in minutes (default: 240)
  --size <usd>          Position size in USD (default: 10)
  --compare, -c         Compare multiple entry thresholds
  --help, -h            Show this help

Examples:
  npx ts-node scripts/backtest.ts                     # Default config
  npx ts-node scripts/backtest.ts --entry 4.0        # Test 4% entry
  npx ts-node scripts/backtest.ts --compare          # Compare thresholds
`);
        process.exit(0);
    }
  }
  
  if (compareMode) {
    // Compare different entry thresholds
    console.log('Running comparison of entry thresholds...\n');
    const configs = [
      { minEntrySpread: 2.0 },
      { minEntrySpread: 2.5 },
      { minEntrySpread: 3.0 },
      { minEntrySpread: 3.5 },
      { minEntrySpread: 4.0 },
      { minEntrySpread: 4.5 },
      { minEntrySpread: 5.0 },
    ];
    
    const results = await compareConfigs(configs);
    printComparison(results);
    
    // Also show the best one in detail
    const best = results.sort((a, b) => b.result.totalPnlUsd - a.result.totalPnlUsd)[0];
    console.log(`\nBest configuration: ${best.config.minEntrySpread}% entry`);
    printResult(best.result);
  } else {
    // Single run
    console.log('Running backtest...\n');
    const result = await runBacktest(configOverrides);
    printResult(result);
  }
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
