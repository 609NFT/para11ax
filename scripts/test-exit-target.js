#!/usr/bin/env node
/**
 * Test exit target variations (modified from quick-backtest.js)
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
  targetSpread: parseFloat(process.argv[2]) || 1.8,  // Exit target from argument
  minHoldMs: 5 * 60 * 1000,
  maxHoldMs: 4 * 60 * 60 * 1000,  // 240 minutes (current deployment)
  positionSizeUsd: 10,
  maxConcurrentPositions: 3,
  entryFeePct: 0.3,
  exitFeePct: 0.3,
  lookbackDays: 3,
};

async function run() {
  console.log(`\nBacktest: 4.0% entry, ${CONFIG.targetSpread}% exit target, 3 days lookback\n`);
  
  const startTime = Date.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const BUCKET_MS = 5 * 60 * 1000;

  console.log('Fetching data...');
  
  // Get bucketed data from discount_heatmap_summary (which should have time series data)
  let query;
  try {
    const testQuery = await pool.query('SELECT * FROM discount_heatmap_summary LIMIT 1');
    console.log('Available columns:', Object.keys(testQuery.rows[0]));
    
    // Use actual column structure
    const { rows } = await pool.query(`
      SELECT 
        created_at as time,
        token_symbol as symbol,
        discount_pct
      FROM discount_heatmap_summary 
      WHERE created_at >= $1
        AND discount_pct IS NOT NULL
        AND discount_pct > 0.5
      ORDER BY created_at, token_symbol
    `, [new Date(startTime)]);
    
    console.log(`Loaded ${rows.length} data points`);
    
    if (rows.length === 0) {
      console.log('No data found, trying mean_reversion_positions...');
      // Alternative: use completed trades and simulate different exit targets
      const tradesQuery = await pool.query(`
        SELECT 
          buy_symbol as symbol,
          entry_spread_pct,
          exit_spread_pct,
          entry_timestamp,
          exit_timestamp,
          pnl_usd,
          exit_reason
        FROM mean_reversion_positions 
        WHERE entry_timestamp >= $1
          AND status = 'closed'
          AND entry_spread_pct >= $2
        ORDER BY entry_timestamp
      `, [new Date(startTime), CONFIG.minEntrySpread]);
      
      console.log(`Found ${tradesQuery.rows.length} completed trades for analysis`);
      
      if (tradesQuery.rows.length === 0) {
        console.log('No trades found in specified timeframe');
        process.exit(0);
      }
      
      // Analyze how many trades would have exited at different target
      const modifiedTrades = tradesQuery.rows.map(trade => {
        const wouldHitTarget = trade.exit_spread_pct <= CONFIG.targetSpread;
        const actualHoldMs = new Date(trade.exit_timestamp) - new Date(trade.entry_timestamp);
        
        // Estimate if trade would have been profitable with different exit target
        let newPnl = trade.pnl_usd;
        let newExitReason = trade.exit_reason;
        
        if (wouldHitTarget && trade.exit_reason === 'max_hold') {
          // This trade hit max hold but could have exited at target
          const targetPnl = (trade.entry_spread_pct - CONFIG.targetSpread) / 100 * CONFIG.positionSizeUsd;
          const fees = (CONFIG.entryFeePct + CONFIG.exitFeePct) / 100 * CONFIG.positionSizeUsd;
          newPnl = targetPnl - fees;
          newExitReason = 'target';
        }
        
        return {
          ...trade,
          modified_pnl: newPnl,
          modified_exit_reason: newExitReason,
          would_hit_target: wouldHitTarget,
          hold_time_ms: actualHoldMs
        };
      });
      
      // Results
      const wins = modifiedTrades.filter(t => t.modified_pnl > 0);
      const totalPnl = modifiedTrades.reduce((sum, t) => sum + t.modified_pnl, 0);
      const avgHold = modifiedTrades.length > 0 
        ? modifiedTrades.reduce((sum, t) => sum + t.hold_time_ms, 0) / modifiedTrades.length / 60000
        : 0;
      
      console.log('='.repeat(50));
      console.log(`Analysis: 4.0% entry, ${CONFIG.targetSpread}% exit target`);
      console.log('='.repeat(50));
      console.log(`Trades: ${modifiedTrades.length}`);
      console.log(`Win Rate: ${((wins.length / modifiedTrades.length) * 100 || 0).toFixed(1)}% (${wins.length}W / ${modifiedTrades.length - wins.length}L)`);
      console.log(`Net P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
      console.log(`Avg Hold: ${avgHold.toFixed(1)} min`);
      
      // Modified exit reasons
      const byReason = {};
      modifiedTrades.forEach(t => { 
        byReason[t.modified_exit_reason] = (byReason[t.modified_exit_reason] || 0) + 1; 
      });
      console.log('\nModified Exit Reasons:');
      Object.entries(byReason).forEach(([reason, count]) => {
        console.log(`  ${reason}: ${count}`);
      });
      
      // Target hit analysis
      const targetHits = modifiedTrades.filter(t => t.would_hit_target).length;
      console.log(`\nWould hit ${CONFIG.targetSpread}% target: ${targetHits}/${modifiedTrades.length} trades (${(targetHits/modifiedTrades.length*100).toFixed(1)}%)`);
      
      console.log('='.repeat(50));
      process.exit(0);
    }
    
    // Continue with time series simulation if we have heatmap data...
    // [Rest of simulation code would go here]
    
  } catch (error) {
    console.error('Query error:', error.message);
    console.log('Falling back to simple analysis...');
    
    // Simple approach: analyze recent trades
    const { rows } = await pool.query(`
      SELECT 
        buy_symbol as symbol,
        entry_spread_pct,
        exit_spread_pct,
        pnl_usd,
        exit_reason,
        EXTRACT(EPOCH FROM (exit_timestamp - entry_timestamp))/60 as hold_minutes
      FROM mean_reversion_positions 
      WHERE status = 'closed'
        AND entry_timestamp >= NOW() - INTERVAL '7 days'
        AND entry_spread_pct >= 4.0
      ORDER BY entry_timestamp DESC
      LIMIT 50
    `);
    
    console.log(`Analyzing ${rows.length} recent trades...`);
    
    const modifiedTrades = rows.map(trade => {
      const wouldHitTarget = trade.exit_spread_pct <= CONFIG.targetSpread;
      let newPnl = trade.pnl_usd;
      let newExitReason = trade.exit_reason;
      
      if (wouldHitTarget && trade.exit_reason === 'max_hold') {
        const targetPnl = (trade.entry_spread_pct - CONFIG.targetSpread) / 100 * CONFIG.positionSizeUsd;
        const fees = 0.6; // Estimated fees
        newPnl = targetPnl - fees;
        newExitReason = 'target';
      }
      
      return {
        ...trade,
        modified_pnl: newPnl,
        modified_exit_reason: newExitReason,
        would_hit_target: wouldHitTarget
      };
    });
    
    const wins = modifiedTrades.filter(t => t.modified_pnl > 0);
    const totalPnl = modifiedTrades.reduce((sum, t) => sum + t.modified_pnl, 0);
    const avgHold = modifiedTrades.length > 0 
      ? modifiedTrades.reduce((sum, t) => sum + parseFloat(t.hold_minutes), 0) / modifiedTrades.length
      : 0;
    
    console.log('='.repeat(50));
    console.log(`Analysis: ${CONFIG.targetSpread}% exit target (last 7 days)`);
    console.log('='.repeat(50));
    console.log(`Trades: ${modifiedTrades.length}`);
    console.log(`Win Rate: ${((wins.length / modifiedTrades.length) * 100 || 0).toFixed(1)}% (${wins.length}W / ${modifiedTrades.length - wins.length}L)`);
    console.log(`Net P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Avg Hold: ${avgHold.toFixed(1)} min`);
    
    const byReason = {};
    modifiedTrades.forEach(t => { 
      byReason[t.modified_exit_reason] = (byReason[t.modified_exit_reason] || 0) + 1; 
    });
    console.log('\nExit Reasons:');
    Object.entries(byReason).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
    
    console.log('='.repeat(50));
  }
  
  await pool.end();
}

run().catch(console.error);