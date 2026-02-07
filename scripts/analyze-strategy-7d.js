#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function analyzeStrategy() {
  try {
    // Get trades from last 7 days (convert to milliseconds timestamp)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    
    const tradesQuery = `
      SELECT 
        id, stock_ticker, buy_symbol, entry_spread_pct, exit_spread_pct, exit_reason, 
        pnl_usd, pnl_pct, 
        to_timestamp(entry_timestamp / 1000) as entry_time,
        to_timestamp(exit_timestamp / 1000) as exit_time,
        size_usd, buy_amount,
        (exit_timestamp - entry_timestamp) as duration_ms,
        status
      FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 AND status = 'closed'
      ORDER BY entry_timestamp DESC
    `;
    
    const result = await pool.query(tradesQuery, [sevenDaysAgo]);
    
    console.log(`=== STRATEGY ANALYSIS (Last 7 Days) ===`);
    console.log(`Since: ${new Date(sevenDaysAgo).toISOString()}`);
    console.log(`Total trades: ${result.rows.length}`);
    
    if (result.rows.length === 0) {
      console.log('No trades in the last 7 days for analysis.');
      return { trades: [], insights: ['No recent trade data available'] };
    }
    
    const trades = result.rows;
    
    // Core performance metrics
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const avgPnL = totalPnL / trades.length;
    const winRate = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / trades.length;
    const avgDuration = trades.reduce((sum, t) => sum + parseInt(t.duration_ms || 0), 0) / trades.length;
    
    console.log(`\n=== PERFORMANCE METRICS ===`);
    console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`Average PnL per trade: $${avgPnL.toFixed(2)}`);
    console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`Average Hold Time: ${(avgDuration / 1000 / 60).toFixed(1)} minutes`);
    
    // Symbol analysis
    const symbolStats = {};
    trades.forEach(trade => {
      const sym = trade.stock_ticker;
      if (!symbolStats[sym]) {
        symbolStats[sym] = { 
          count: 0, 
          pnl: 0, 
          wins: 0,
          avgSpread: 0,
          avgHold: 0,
          sumHold: 0
        };
      }
      symbolStats[sym].count++;
      symbolStats[sym].pnl += parseFloat(trade.pnl_usd || 0);
      symbolStats[sym].avgSpread += Math.abs(parseFloat(trade.entry_spread_pct || 0));
      symbolStats[sym].sumHold += parseInt(trade.duration_ms || 0);
      if (parseFloat(trade.pnl_usd || 0) > 0) symbolStats[sym].wins++;
    });
    
    console.log(`\n=== SYMBOL PERFORMANCE ===`);
    Object.entries(symbolStats).forEach(([sym, stats]) => {
      const winRate = (stats.wins / stats.count * 100).toFixed(1);
      const avgSpread = (stats.avgSpread / stats.count).toFixed(2);
      const avgHold = (stats.sumHold / stats.count / 1000 / 60).toFixed(1);
      console.log(`${sym}: ${stats.count} trades | $${stats.pnl.toFixed(2)} PnL | ${winRate}% WR | ${avgSpread}% avg spread | ${avgHold}min hold`);
    });
    
    // Entry threshold analysis
    const spreadBuckets = {};
    trades.forEach(trade => {
      const spread = Math.abs(parseFloat(trade.entry_spread_pct || 0));
      const bucket = Math.floor(spread * 2) / 2; // 0.5% buckets
      const bucketKey = `${bucket.toFixed(1)}%`;
      
      if (!spreadBuckets[bucketKey]) {
        spreadBuckets[bucketKey] = { count: 0, totalPnL: 0, wins: 0 };
      }
      spreadBuckets[bucketKey].count++;
      spreadBuckets[bucketKey].totalPnL += parseFloat(trade.pnl_usd || 0);
      if (parseFloat(trade.pnl_usd || 0) > 0) spreadBuckets[bucketKey].wins++;
    });
    
    console.log(`\n=== ENTRY THRESHOLD ANALYSIS ===`);
    Object.entries(spreadBuckets).forEach(([bucket, stats]) => {
      const avgPnL = stats.totalPnL / stats.count;
      const winRate = (stats.wins / stats.count * 100).toFixed(1);
      console.log(`${bucket}: ${stats.count} trades | $${avgPnL.toFixed(2)} avg PnL | ${winRate}% WR`);
    });
    
    // Exit reason analysis
    const exitReasons = {};
    trades.forEach(trade => {
      const reason = trade.exit_reason || 'unknown';
      if (!exitReasons[reason]) {
        exitReasons[reason] = { count: 0, totalPnL: 0, avgHoldTime: 0 };
      }
      exitReasons[reason].count++;
      exitReasons[reason].totalPnL += parseFloat(trade.pnl_usd || 0);
      exitReasons[reason].avgHoldTime += parseInt(trade.duration_ms || 0);
    });
    
    console.log(`\n=== EXIT REASON ANALYSIS ===`);
    Object.entries(exitReasons).forEach(([reason, stats]) => {
      const avgPnL = stats.totalPnL / stats.count;
      const avgHoldMin = (stats.avgHoldTime / stats.count / 1000 / 60).toFixed(1);
      console.log(`${reason}: ${stats.count} trades | $${avgPnL.toFixed(2)} avg PnL | ${avgHoldMin}min avg hold`);
    });
    
    // Recent activity pattern
    console.log(`\n=== RECENT TRADES (Last 5) ===`);
    trades.slice(0, 5).forEach(trade => {
      const duration = Math.round(trade.duration_ms / 1000 / 60);
      const entryTime = new Date(trade.entry_time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      console.log(`${trade.stock_ticker}: ${trade.entry_spread_pct}% → ${trade.exit_spread_pct || 'N/A'}% | $${trade.pnl_usd} | ${trade.exit_reason} | ${duration}min | ${entryTime} PST`);
    });
    
    // Check for current market opportunities
    const currentOppsQuery = `
      SELECT DISTINCT ON (symbol) 
        symbol, discount_pct, created_at
      FROM discount_history 
      WHERE created_at >= NOW() - INTERVAL '2 hours'
      AND ABS(discount_pct) > 3.0
      ORDER BY symbol, created_at DESC
    `;
    
    const currentOppResult = await pool.query(currentOppsQuery);
    
    console.log(`\n=== CURRENT MARKET OPPORTUNITIES ===`);
    if (currentOppResult.rows.length > 0) {
      currentOppResult.rows.forEach(opp => {
        const direction = parseFloat(opp.discount_pct) > 0 ? 'PREMIUM' : 'DISCOUNT';
        console.log(`${opp.symbol}: ${opp.discount_pct}% ${direction} | ${new Date(opp.created_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PST`);
      });
    } else {
      console.log('No significant opportunities (>3%) in last 2 hours.');
    }
    
    return {
      summary: {
        totalPnL,
        avgPnL,
        winRate,
        avgDuration: avgDuration / 1000 / 60, // minutes
        tradeCount: trades.length
      },
      symbolStats,
      spreadBuckets,
      exitReasons,
      recentTrades: trades.slice(0, 10),
      currentOpportunities: currentOppResult.rows
    };
    
  } catch (error) {
    console.error('Database error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  analyzeStrategy()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Analysis failed:', error);
      process.exit(1);
    });
}

module.exports = { analyzeStrategy };