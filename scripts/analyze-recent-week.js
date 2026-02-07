const { Pool } = require('pg');
require('dotenv').config();

async function analyzeRecentWeek() {
  const pool = new Pool({
    connectionString: process.env.TRADES_DB_URL
  });
  
  try {
    // Get trades from last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    
    const result = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE created_at >= $1 AND status = 'closed'
      ORDER BY created_at DESC
    `, [sevenDaysAgo]);
    
    const trades = result.rows;
    
    console.log(`=== WEEKLY TRADES ANALYSIS (Last 7 days) ===`);
    console.log(`Total trades: ${trades.length}`);
    
    if (trades.length === 0) {
      console.log('No trades found in last 7 days');
      return;
    }
    
    let totalPnL = 0;
    let winCount = 0;
    let exitReasons = {};
    let symbols = {};
    
    trades.forEach(trade => {
      totalPnL += parseFloat(trade.pnl_usd) || 0;
      if (parseFloat(trade.pnl_usd) > 0) winCount++;
      
      const exitReason = trade.exit_reason || 'unknown';
      exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
      
      const symbol = trade.buy_symbol || trade.stock_ticker || 'unknown';
      symbols[symbol] = (symbols[symbol] || 0) + 1;
    });
    
    const winRate = ((winCount / trades.length) * 100).toFixed(1);
    
    console.log(`Win rate: ${winRate}% (${winCount}/${trades.length})`);
    console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`Average PnL per trade: $${(totalPnL / trades.length).toFixed(3)}`);
    
    // Entry threshold analysis
    const entrySpreadStats = trades.map(trade => parseFloat(trade.entry_spread_pct)).filter(s => s);
    if (entrySpreadStats.length > 0) {
      const sortedSpreads = entrySpreadStats.sort((a, b) => a - b);
      const avgEntrySpread = entrySpreadStats.reduce((a, b) => a + b, 0) / entrySpreadStats.length;
      const medianSpread = sortedSpreads[Math.floor(sortedSpreads.length / 2)];
      const minEntrySpread = sortedSpreads[0];
      const maxEntrySpread = sortedSpreads[sortedSpreads.length - 1];
      
      console.log(`\\nEntry spread distribution:`);
      console.log(`  Min: ${minEntrySpread.toFixed(2)}%, Max: ${maxEntrySpread.toFixed(2)}%`);
      console.log(`  Avg: ${avgEntrySpread.toFixed(2)}%, Median: ${medianSpread.toFixed(2)}%`);
      
      // Count by threshold ranges
      const ranges = [
        [4.0, 4.5], [4.5, 5.0], [5.0, 5.5], [5.5, 6.0], [6.0, 7.0], [7.0, 10.0]
      ];
      
      console.log(`\\nTrades by entry threshold:`);
      ranges.forEach(([min, max]) => {
        const count = entrySpreadStats.filter(s => s >= min && s < max).length;
        if (count > 0) {
          console.log(`  ${min}% - ${max}%: ${count} trades`);
        }
      });
      
      // Profitability by threshold
      const thresholds = [4.0, 4.5, 5.0, 5.5, 6.0];
      console.log(`\\nProfitability if MIN_FLOOR was:`);
      thresholds.forEach(threshold => {
        const qualifyingTrades = trades.filter(t => parseFloat(t.entry_spread_pct) >= threshold);
        if (qualifyingTrades.length > 0) {
          const qualifyingPnL = qualifyingTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd), 0);
          const qualifyingWins = qualifyingTrades.filter(t => parseFloat(t.pnl_usd) > 0).length;
          const qualifyingWR = ((qualifyingWins / qualifyingTrades.length) * 100).toFixed(1);
          console.log(`  ${threshold}%: ${qualifyingTrades.length} trades, $${qualifyingPnL.toFixed(2)} PnL, ${qualifyingWR}% WR`);
        }
      });
    }
    
    console.log(`\\nSymbol performance:`);
    Object.entries(symbols).forEach(([symbol, count]) => {
      const symbolTrades = trades.filter(t => (t.buy_symbol || t.stock_ticker) === symbol);
      const symbolPnL = symbolTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd), 0);
      const symbolWins = symbolTrades.filter(t => parseFloat(t.pnl_usd) > 0).length;
      const symbolWR = ((symbolWins / count) * 100).toFixed(1);
      console.log(`  ${symbol}: ${count} trades, $${symbolPnL.toFixed(2)} PnL, ${symbolWR}% WR`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

analyzeRecentWeek();