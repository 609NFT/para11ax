const fs = require('fs');
const { getTradesPool } = require('../dist/db/supabaseClient.js');

async function analyzeTrades() {
  const pool = getTradesPool();
  
  const result = await pool.query(
    'SELECT * FROM mean_reversion_positions ORDER BY entry_timestamp DESC LIMIT 50'
  );
  
  const trades = result.rows;
  
  console.log(`\n=== LAST 50 TRADES ANALYSIS ===`);
  console.log(`Total trades: ${trades.length}`);
  
  if (trades.length === 0) {
    console.log('No recent trades found');
    return;
  }
  
  // Filter only closed trades
  const closedTrades = trades.filter(t => t.status === 'closed');
  console.log(`Closed trades: ${closedTrades.length}`);
  
  if (closedTrades.length === 0) {
    console.log('No closed trades found');
    return;
  }
  
  // Calculate basic stats
  const profitable = closedTrades.filter(t => t.pnl_usd > 0);
  const winRate = (profitable.length / closedTrades.length * 100).toFixed(1);
  const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl_usd, 0);
  const avgPnl = (totalPnl / closedTrades.length).toFixed(2);
  
  console.log(`Win rate: ${winRate}% (${profitable.length}/${closedTrades.length})`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Avg PnL: $${avgPnl}`);
  
  // Analyze by symbol
  const bySymbol = {};
  closedTrades.forEach(t => {
    if (!bySymbol[t.stock_ticker]) {
      bySymbol[t.stock_ticker] = { trades: [], pnl: 0, wins: 0 };
    }
    bySymbol[t.stock_ticker].trades.push(t);
    bySymbol[t.stock_ticker].pnl += t.pnl_usd;
    if (t.pnl_usd > 0) bySymbol[t.stock_ticker].wins++;
  });
  
  console.log('\n=== BY SYMBOL ===');
  Object.entries(bySymbol).forEach(([symbol, data]) => {
    const winRate = (data.wins / data.trades.length * 100).toFixed(1);
    console.log(`${symbol}: ${data.trades.length} trades, ${winRate}% WR, $${data.pnl.toFixed(2)} PnL`);
  });
  
  // Analyze exit reasons
  const exitReasons = {};
  closedTrades.forEach(t => {
    const reason = t.exit_reason || 'unknown';
    if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
    exitReasons[reason].count++;
    exitReasons[reason].pnl += t.pnl_usd;
  });
  
  console.log('\n=== EXIT REASONS ===');
  Object.entries(exitReasons).forEach(([reason, data]) => {
    const avgPnl = (data.pnl / data.count).toFixed(2);
    console.log(`${reason}: ${data.count} trades, avg $${avgPnl}`);
  });
  
  // Check for concerning patterns
  console.log('\n=== PATTERN ANALYSIS ===');
  
  // Recent performance (last 10 closed trades)
  const recent10 = closedTrades.slice(0, 10);
  const recent10Wins = recent10.filter(t => t.pnl_usd > 0).length;
  const recent10Pnl = recent10.reduce((sum, t) => sum + t.pnl_usd, 0);
  console.log(`Last 10 trades: ${recent10Wins}/10 wins, $${recent10Pnl.toFixed(2)} PnL`);
  
  // Check for entry discount effectiveness
  const avgEntryDiscount = closedTrades.reduce((sum, t) => sum + Math.abs(t.entry_spread_pct), 0) / closedTrades.length;
  console.log(`Avg entry discount: ${avgEntryDiscount.toFixed(2)}%`);
  
  // Check hold times - handle bigint timestamps
  const avgHoldTime = closedTrades.reduce((sum, t) => {
    const entryMs = typeof t.entry_timestamp === 'string' ? parseInt(t.entry_timestamp) : t.entry_timestamp;
    const exitMs = typeof t.exit_timestamp === 'string' ? parseInt(t.exit_timestamp) : t.exit_timestamp;
    const hold = exitMs - entryMs;
    return sum + hold;
  }, 0) / closedTrades.length;
  console.log(`Avg hold time: ${(avgHoldTime / 1000 / 60).toFixed(1)} minutes`);
  
  // Look for losses with profit_target exit (indicates bugs)
  const profitTargetLosses = closedTrades.filter(t => t.exit_reason === 'profit_target' && t.pnl_usd < 0);
  if (profitTargetLosses.length > 0) {
    console.log(`\n🚨 PROFIT TARGET LOSSES: ${profitTargetLosses.length} trades`);
    profitTargetLosses.slice(0, 3).forEach(t => {
      console.log(`  ${t.stock_ticker}: entry ${t.entry_spread_pct.toFixed(2)}%, exit ${(t.exit_spread_pct || 0).toFixed(2)}%, PnL $${t.pnl_usd.toFixed(2)}`);
    });
  }
  
  // Check for patterns in losses
  const losses = closedTrades.filter(t => t.pnl_usd < 0);
  if (losses.length > 0) {
    console.log(`\n=== LOSS ANALYSIS ===`);
    console.log(`Total losses: ${losses.length}`);
    
    // Group losses by exit reason
    const lossReasons = {};
    losses.forEach(t => {
      const reason = t.exit_reason || 'unknown';
      if (!lossReasons[reason]) lossReasons[reason] = 0;
      lossReasons[reason]++;
    });
    
    Object.entries(lossReasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count} losses`);
    });
  }
  
  // Check for open positions
  const openTrades = trades.filter(t => t.status === 'open');
  if (openTrades.length > 0) {
    console.log(`\n=== OPEN POSITIONS ===`);
    console.log(`Open positions: ${openTrades.length}`);
    openTrades.forEach(t => {
      const ageMs = Date.now() - (typeof t.entry_timestamp === 'string' ? parseInt(t.entry_timestamp) : t.entry_timestamp);
      const ageMin = (ageMs / 1000 / 60).toFixed(1);
      console.log(`  ${t.stock_ticker}: ${t.entry_spread_pct.toFixed(2)}% spread, ${ageMin}min old, $${t.size_usd.toFixed(0)}`);
    });
  }
}

analyzeTrades().catch(console.error);