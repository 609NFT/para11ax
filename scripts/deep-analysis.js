const { Pool } = require('pg');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// Fix IPv6 issues
dns.setDefaultResultOrder('ipv4first');

// Use the pooler connection from .env (more reliable than direct)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeTrades() {
  console.log('🔍 PARALLAX DEEP ANALYSIS - Recent Trades');
  console.log('='.repeat(50));
  
  try {
    // Get recent trades (last 7 days)
    const recentTrades = await pool.query(`
      SELECT 
        symbol,
        entry_timestamp,
        exit_timestamp,
        entry_spread_pct,
        exit_spread_pct,
        exit_reason,
        pnl_usd,
        duration_minutes,
        entry_amount_usd
      FROM trades 
      WHERE entry_timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY entry_timestamp DESC
    `);
    
    console.log(`\n📊 TRADE SUMMARY (Last 7 Days)`);
    console.log(`Total trades: ${recentTrades.rows.length}`);
    
    if (recentTrades.rows.length === 0) {
      console.log('No recent trades found');
      return;
    }
    
    // Calculate metrics
    const totalPnl = recentTrades.rows.reduce((sum, trade) => sum + parseFloat(trade.pnl_usd || 0), 0);
    const winningTrades = recentTrades.rows.filter(t => parseFloat(t.pnl_usd || 0) > 0);
    const losingTrades = recentTrades.rows.filter(t => parseFloat(t.pnl_usd || 0) < 0);
    const winRate = (winningTrades.length / recentTrades.rows.length * 100).toFixed(1);
    
    console.log(`Net PnL: $${totalPnl.toFixed(2)}`);
    console.log(`Win Rate: ${winRate}% (${winningTrades.length}W / ${losingTrades.length}L)`);
    
    // Analyze by symbol
    const bySymbol = {};
    recentTrades.rows.forEach(trade => {
      if (!bySymbol[trade.symbol]) {
        bySymbol[trade.symbol] = { trades: [], pnl: 0, wins: 0 };
      }
      bySymbol[trade.symbol].trades.push(trade);
      bySymbol[trade.symbol].pnl += parseFloat(trade.pnl_usd || 0);
      if (parseFloat(trade.pnl_usd || 0) > 0) bySymbol[trade.symbol].wins++;
    });
    
    console.log(`\n📈 BY SYMBOL:`);
    Object.entries(bySymbol).forEach(([symbol, data]) => {
      const wr = (data.wins / data.trades.length * 100).toFixed(1);
      console.log(`${symbol}: ${data.trades.length} trades, $${data.pnl.toFixed(2)} PnL, ${wr}% WR`);
    });
    
    // Exit reasons analysis
    const exitReasons = {};
    recentTrades.rows.forEach(trade => {
      const reason = trade.exit_reason || 'unknown';
      if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
      exitReasons[reason].count++;
      exitReasons[reason].pnl += parseFloat(trade.pnl_usd || 0);
    });
    
    console.log(`\n🚪 EXIT REASONS:`);
    Object.entries(exitReasons).forEach(([reason, data]) => {
      console.log(`${reason}: ${data.count} trades, $${data.pnl.toFixed(2)} avg PnL`);
    });
    
    // Entry threshold analysis
    console.log(`\n📊 ENTRY THRESHOLDS:`);
    const thresholdBuckets = {
      '4.0-4.5%': [],
      '4.5-5.0%': [],
      '5.0-5.5%': [],
      '5.5%+': []
    };
    
    recentTrades.rows.forEach(trade => {
      const spread = Math.abs(parseFloat(trade.entry_spread_pct || 0));
      if (spread >= 4.0 && spread < 4.5) thresholdBuckets['4.0-4.5%'].push(trade);
      else if (spread >= 4.5 && spread < 5.0) thresholdBuckets['4.5-5.0%'].push(trade);
      else if (spread >= 5.0 && spread < 5.5) thresholdBuckets['5.0-5.5%'].push(trade);
      else if (spread >= 5.5) thresholdBuckets['5.5%+'].push(trade);
    });
    
    Object.entries(thresholdBuckets).forEach(([bucket, trades]) => {
      if (trades.length > 0) {
        const wins = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
        const wr = (wins / trades.length * 100).toFixed(1);
        const avgPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0) / trades.length;
        console.log(`${bucket}: ${trades.length} trades, ${wr}% WR, $${avgPnl.toFixed(2)} avg PnL`);
      }
    });
    
    // Duration analysis
    const avgDuration = recentTrades.rows
      .filter(t => t.duration_minutes)
      .reduce((sum, t) => sum + parseInt(t.duration_minutes), 0) / 
      recentTrades.rows.filter(t => t.duration_minutes).length;
    
    console.log(`\n⏱️  DURATION: Avg ${avgDuration.toFixed(1)} minutes`);
    
    // Check for recent issues
    console.log(`\n🚨 ISSUE DETECTION:`);
    
    // Last 24h trades
    const last24h = await pool.query(`
      SELECT COUNT(*) as count 
      FROM trades 
      WHERE entry_timestamp >= NOW() - INTERVAL '24 hours'
    `);
    
    console.log(`Last 24h trades: ${last24h.rows[0].count}`);
    
    if (parseInt(last24h.rows[0].count) === 0) {
      console.log('⚠️  NO TRADES in last 24h - check if bot is trading');
    }
    
    // Check for consecutive losses
    const recentSorted = recentTrades.rows
      .sort((a, b) => new Date(b.entry_timestamp) - new Date(a.entry_timestamp))
      .slice(0, 10);
    
    let consecutiveLosses = 0;
    for (const trade of recentSorted) {
      if (parseFloat(trade.pnl_usd || 0) <= 0) {
        consecutiveLosses++;
      } else {
        break;
      }
    }
    
    if (consecutiveLosses >= 5) {
      console.log(`⚠️  ${consecutiveLosses} consecutive losses detected`);
    }
    
    console.log('\n✅ Analysis complete');
    
  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    await pool.end();
  }
}

analyzeTrades();