#!/usr/bin/env node
/**
 * Backtest TVL tier configurations
 * Analyzes historical trade performance by spread and TVL buckets
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Tier configurations to test
const TIER_CONFIGS = {
  current: {
    name: 'Current (4% era)',
    tiers: [
      { maxSpread: 4.5, minTvl: 75000 },
      { maxSpread: 6.0, minTvl: 50000 },
      { maxSpread: Infinity, minTvl: 25000 },
    ]
  },
  proposed: {
    name: 'Proposed (2.5% era)',
    tiers: [
      { maxSpread: 3.5, minTvl: 75000 },
      { maxSpread: 5.0, minTvl: 50000 },
      { maxSpread: Infinity, minTvl: 25000 },
    ]
  },
  flat50k: {
    name: 'Flat $50K',
    tiers: [
      { maxSpread: Infinity, minTvl: 50000 },
    ]
  },
  aggressive: {
    name: 'Aggressive (lower TVL)',
    tiers: [
      { maxSpread: 3.0, minTvl: 50000 },
      { maxSpread: 4.0, minTvl: 40000 },
      { maxSpread: Infinity, minTvl: 25000 },
    ]
  }
};

function getMinTvl(spread, config) {
  for (const tier of config.tiers) {
    if (spread < tier.maxSpread) return tier.minTvl;
  }
  return config.tiers[config.tiers.length - 1].minTvl;
}

async function run() {
  console.log('\n=== TVL Tier Backtest ===\n');
  
  // Fetch all closed trades with entry spread and TVL data
  const result = await pool.query(`
    SELECT 
      id,
      buy_symbol as symbol,
      entry_spread_pct as entry_spread,
      exit_spread_pct as exit_spread,
      pnl_usd,
      pnl_pct,
      created_at,
      exit_timestamp,
      exit_reason,
      COALESCE(entry_tvl_usd, 50000) as tvl
    FROM mean_reversion_positions
    WHERE status = 'closed'
      AND entry_spread_pct IS NOT NULL
      AND pnl_usd IS NOT NULL
    ORDER BY created_at ASC
  `);
  
  const trades = result.rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    entrySpread: parseFloat(r.entry_spread),
    exitSpread: parseFloat(r.exit_spread || 0),
    pnl: parseFloat(r.pnl_usd),
    pnlPct: parseFloat(r.pnl_pct || 0),
    tvl: parseFloat(r.tvl),
    exitReason: r.exit_reason,
  }));
  
  console.log(`Total closed trades: ${trades.length}\n`);
  
  // Analyze each configuration
  for (const [key, config] of Object.entries(TIER_CONFIGS)) {
    const allowed = trades.filter(t => t.tvl >= getMinTvl(t.entrySpread, config));
    const blocked = trades.filter(t => t.tvl < getMinTvl(t.entrySpread, config));
    
    const wins = allowed.filter(t => t.pnl > 0);
    const losses = allowed.filter(t => t.pnl <= 0);
    const totalPnl = allowed.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = allowed.length > 0 ? totalPnl / allowed.length : 0;
    const winRate = allowed.length > 0 ? (wins.length / allowed.length * 100) : 0;
    
    // Blocked trade stats (what we would have missed)
    const blockedWins = blocked.filter(t => t.pnl > 0);
    const blockedPnl = blocked.reduce((sum, t) => sum + t.pnl, 0);
    
    console.log(`--- ${config.name} ---`);
    console.log(`Allowed: ${allowed.length} trades`);
    console.log(`  Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
    console.log(`  Avg PnL: $${avgPnl.toFixed(2)}`);
    console.log(`Blocked: ${blocked.length} trades`);
    console.log(`  Would-be wins: ${blockedWins.length}`);
    console.log(`  Missed PnL: $${blockedPnl.toFixed(2)}`);
    console.log('');
  }
  
  // Breakdown by spread bucket
  console.log('=== Performance by Spread Bucket ===\n');
  const buckets = [
    { min: 2.5, max: 3.5, label: '2.5-3.5%' },
    { min: 3.5, max: 4.5, label: '3.5-4.5%' },
    { min: 4.5, max: 6.0, label: '4.5-6.0%' },
    { min: 6.0, max: 100, label: '6.0%+' },
  ];
  
  for (const bucket of buckets) {
    const inBucket = trades.filter(t => t.entrySpread >= bucket.min && t.entrySpread < bucket.max);
    if (inBucket.length === 0) continue;
    
    const wins = inBucket.filter(t => t.pnl > 0);
    const totalPnl = inBucket.reduce((sum, t) => sum + t.pnl, 0);
    const avgTvl = inBucket.reduce((sum, t) => sum + t.tvl, 0) / inBucket.length;
    
    console.log(`${bucket.label}: ${inBucket.length} trades, ${(wins.length/inBucket.length*100).toFixed(0)}% WR, $${totalPnl.toFixed(2)} total, avg TVL $${(avgTvl/1000).toFixed(0)}K`);
  }
  
  // TVL bucket analysis
  console.log('\n=== Performance by TVL Bucket ===\n');
  const tvlBuckets = [
    { min: 25000, max: 50000, label: '$25-50K' },
    { min: 50000, max: 75000, label: '$50-75K' },
    { min: 75000, max: 150000, label: '$75-150K' },
    { min: 150000, max: Infinity, label: '$150K+' },
  ];
  
  for (const bucket of tvlBuckets) {
    const inBucket = trades.filter(t => t.tvl >= bucket.min && t.tvl < bucket.max);
    if (inBucket.length === 0) continue;
    
    const wins = inBucket.filter(t => t.pnl > 0);
    const totalPnl = inBucket.reduce((sum, t) => sum + t.pnl, 0);
    const avgSpread = inBucket.reduce((sum, t) => sum + t.entrySpread, 0) / inBucket.length;
    
    console.log(`${bucket.label}: ${inBucket.length} trades, ${(wins.length/inBucket.length*100).toFixed(0)}% WR, $${totalPnl.toFixed(2)} total, avg spread ${avgSpread.toFixed(1)}%`);
  }
  
  await pool.end();
}

run().catch(console.error);
