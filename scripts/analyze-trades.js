const { Pool } = require('pg');
require('dotenv').config();

async function analyzeRecentTrades() {
  const pool = new Pool({
    connectionString: process.env.TRADES_DB_URL
  });
  
  try {
    // Get trades from last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    const result = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE created_at >= $1 AND status = 'closed'
      ORDER BY created_at DESC
    `, [oneDayAgo]);
    
    const trades = result.rows;
    
    console.log(`=== RECENT TRADES ANALYSIS (Last 24h) ===`);
    console.log(`Total trades: ${trades.length}`);
    
    if (trades.length === 0) {
      console.log('No trades found in last 24h');
      return;
    }
    
    let totalPnL = 0;
    let winCount = 0;
    let exitReasons = {};
    let symbols = {};
    
    trades.forEach(trade => {
      totalPnL += parseFloat(trade.pnl_usd) || 0;
      if (parseFloat(trade.pnl_usd) > 0) winCount++;
      
      // Note: mean_reversion_positions doesn't have entry_reason, skip this analysis
      
      const exitReason = trade.exit_reason || 'unknown';
      exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
      
      const symbol = trade.buy_symbol || trade.stock_ticker || 'unknown';
      symbols[symbol] = (symbols[symbol] || 0) + 1;
    });
    
    const winRate = ((winCount / trades.length) * 100).toFixed(1);
    
    console.log(`Win rate: ${winRate}% (${winCount}/${trades.length})`);
    console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
    
    console.log(`\nExit reasons:`);
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
    
    console.log(`\nSymbols traded:`);
    Object.entries(symbols).forEach(([symbol, count]) => {
      console.log(`  ${symbol}: ${count}`);
    });
    
    // Check for concerning patterns
    console.log(`\n=== PATTERN ANALYSIS ===`);
    
    // Check for entries followed immediately by exits (churning)
    const quickExits = trades.filter(trade => {
      const entryTime = parseInt(trade.entry_timestamp);
      const exitTime = parseInt(trade.exit_timestamp);
      const holdTimeMin = (exitTime - entryTime) / (1000 * 60);
      return holdTimeMin < 5;
    });
    
    if (quickExits.length > 0) {
      console.log(`⚠️ Quick exits (<5min): ${quickExits.length}`);
      quickExits.forEach(trade => {
        const entryTime = parseInt(trade.entry_timestamp);
        const exitTime = parseInt(trade.exit_timestamp);
        const holdTimeMin = ((exitTime - entryTime) / (1000 * 60)).toFixed(1);
        const symbol = trade.buy_symbol || trade.stock_ticker || 'unknown';
        console.log(`  ${symbol}: ${holdTimeMin}min, ${trade.exit_reason}, PnL: $${parseFloat(trade.pnl_usd || 0).toFixed(2)}`);
      });
    }
    
    // Check for repeated losing symbols
    const symbolPnL = {};
    trades.forEach(trade => {
      const symbol = trade.buy_symbol || trade.stock_ticker || 'unknown';
      if (!symbolPnL[symbol]) symbolPnL[symbol] = { pnl: 0, count: 0, wins: 0 };
      symbolPnL[symbol].pnl += parseFloat(trade.pnl_usd) || 0;
      symbolPnL[symbol].count++;
      if (parseFloat(trade.pnl_usd) > 0) symbolPnL[symbol].wins++;
    });
    
    console.log(`\nSymbol performance:`);
    Object.entries(symbolPnL).forEach(([symbol, stats]) => {
      const winRate = ((stats.wins / stats.count) * 100).toFixed(1);
      console.log(`  ${symbol}: $${stats.pnl.toFixed(2)} PnL, ${winRate}% WR (${stats.wins}/${stats.count})`);
      
      if (stats.count >= 3 && stats.wins === 0) {
        console.log(`    ⚠️ ${symbol}: 0% win rate with ${stats.count} trades`);
      }
    });

    // Check threshold effectiveness - get current thresholds
    const MIN_FLOOR = 4.3; // From memory
    const entrySpreadStats = trades.map(trade => trade.entry_spread_pct).filter(s => s);
    if (entrySpreadStats.length > 0) {
      const avgEntrySpread = entrySpreadStats.reduce((a, b) => a + b, 0) / entrySpreadStats.length;
      const minEntrySpread = Math.min(...entrySpreadStats);
      const maxEntrySpread = Math.max(...entrySpreadStats);
      
      console.log(`\n=== THRESHOLD ANALYSIS ===`);
      console.log(`Current MIN_FLOOR: ${MIN_FLOOR}%`);
      console.log(`Entry spreads - Avg: ${avgEntrySpread.toFixed(2)}%, Min: ${minEntrySpread.toFixed(2)}%, Max: ${maxEntrySpread.toFixed(2)}%`);
      
      if (minEntrySpread > MIN_FLOOR + 0.5) {
        console.log(`⚠️ No trades near MIN_FLOOR - consider lowering threshold`);
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

analyzeRecentTrades();