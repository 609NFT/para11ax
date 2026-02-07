const { getTradesPool } = require('../dist/db/supabaseClient');
const dns = require('dns');

// Required for Supabase pooler
dns.setDefaultResultOrder('ipv4first');

async function analyze() {
  const pool = getTradesPool();
  
  try {
    console.log('=== RECENT TRADES ANALYSIS (48h) ===\n');
    
    // Get recent completed positions (last 48 hours)
    const cutoffMs = Date.now() - (48 * 60 * 60 * 1000);
    const { rows: trades } = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE status = 'closed' 
      AND updated_at >= $1
      ORDER BY updated_at DESC
    `, [cutoffMs]);
    
    console.log(`Total trades: ${trades.length}`);
    
    if (trades.length === 0) {
      console.log('No trades in last 48 hours');
      return;
    }
    
    // Overall stats
    let totalPnl = 0;
    let winCount = 0;
    let lossCount = 0;
    
    const bySymbol = {};
    const exitReasons = {};
    const spreadBuckets = { '4.0-5.0%': 0, '5.0-6.0%': 0, '6.0-7.0%': 0, '7.0%+': 0 };
    
    trades.forEach(trade => {
      const pnl = parseFloat(trade.pnl_usd || 0);
      totalPnl += pnl;
      
      if (pnl > 0) winCount++;
      else lossCount++;
      
      // By symbol
      const symbol = trade.buy_symbol;
      if (!bySymbol[symbol]) {
        bySymbol[symbol] = { count: 0, pnl: 0, entries: [] };
      }
      bySymbol[symbol].count++;
      bySymbol[symbol].pnl += pnl;
      bySymbol[symbol].entries.push(parseFloat(trade.entry_spread_pct || 0));
      
      // Exit reasons
      const reason = trade.exit_reason || 'unknown';
      exitReasons[reason] = (exitReasons[reason] || 0) + 1;
      
      // Spread distribution
      const spread = Math.abs(parseFloat(trade.entry_spread_pct || 0));
      if (spread >= 4.0 && spread < 5.0) spreadBuckets['4.0-5.0%']++;
      else if (spread >= 5.0 && spread < 6.0) spreadBuckets['5.0-6.0%']++;
      else if (spread >= 6.0 && spread < 7.0) spreadBuckets['6.0-7.0%']++;
      else if (spread >= 7.0) spreadBuckets['7.0%+']++;
    });
    
    const winRate = (winCount / (winCount + lossCount) * 100).toFixed(1);
    console.log(`Overall PnL: $${totalPnl.toFixed(2)}`);
    console.log(`Win rate: ${winRate}% (${winCount}W / ${lossCount}L)`);
    console.log('');
    
    // By symbol analysis
    console.log('By Symbol:');
    Object.entries(bySymbol)
      .sort(([,a], [,b]) => b.count - a.count)
      .forEach(([symbol, data]) => {
        const avgEntry = data.entries.reduce((a, b) => a + b, 0) / data.entries.length;
        console.log(`${symbol}: ${data.count} trades, $${data.pnl.toFixed(2)} PnL, avg entry: ${avgEntry.toFixed(2)}%`);
      });
    console.log('');
    
    // Exit reasons
    console.log('Exit reasons:');
    Object.entries(exitReasons)
      .sort(([,a], [,b]) => b - a)
      .forEach(([reason, count]) => {
        console.log(`${reason}: ${count}`);
      });
    console.log('');
    
    // Spread distribution
    console.log('Entry spread distribution:');
    Object.entries(spreadBuckets).forEach(([bucket, count]) => {
      console.log(`${bucket}: ${count} trades`);
    });
    console.log('');
    
    // Check for patterns requiring investigation
    console.log('=== PATTERN ANALYSIS ===');
    
    // Check for poor performance on specific symbols
    const poorPerformers = Object.entries(bySymbol)
      .filter(([, data]) => data.count >= 3 && data.pnl < -1.0)
      .sort(([,a], [,b]) => a.pnl - b.pnl);
      
    if (poorPerformers.length > 0) {
      console.log('❌ Poor performing symbols (3+ trades, <-$1 PnL):');
      poorPerformers.forEach(([symbol, data]) => {
        console.log(`  ${symbol}: ${data.count} trades, $${data.pnl.toFixed(2)}`);
      });
      console.log('');
    }
    
    // Check exit reason effectiveness
    if (exitReasons.profit_target && exitReasons.stop_loss) {
      const profitTargetRatio = exitReasons.profit_target / (exitReasons.profit_target + exitReasons.stop_loss);
      console.log(`Profit target ratio: ${(profitTargetRatio * 100).toFixed(1)}%`);
      if (profitTargetRatio < 0.5) {
        console.log('⚠️  More stop losses than profit targets - consider reviewing thresholds');
      }
    }
    
    // Check spread effectiveness
    const highSpreadTrades = trades.filter(t => Math.abs(parseFloat(t.entry_spread_pct || 0)) >= 6.0);
    if (highSpreadTrades.length >= 5) {
      const highSpreadPnl = highSpreadTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
      const highSpreadWins = highSpreadTrades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
      console.log(`High spread (6%+) performance: $${highSpreadPnl.toFixed(2)}, ${(highSpreadWins/highSpreadTrades.length*100).toFixed(1)}% WR`);
    }
    
    console.log('Analysis complete.');
    
  } catch (error) {
    console.error('Error analyzing trades:', error);
  } finally {
    await pool.end();
  }
}

analyze().catch(console.error);