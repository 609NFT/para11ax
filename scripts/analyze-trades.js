const { getTradesPool } = require('../dist/db/supabaseClient.js');

(async () => {
  try {
    // Get the trades database connection
    const pool = getTradesPool();
    
    // Query recent trades (last 48 hours) - timestamps are in milliseconds
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const result = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1
      ORDER BY entry_timestamp DESC
    `, [cutoffMs]);
    
    const trades = result.rows;
    
    console.log('=== RECENT TRADES ANALYSIS ===');
    console.log(`Total trades (48h): ${trades.length}`);
    
    if (trades.length === 0) {
      console.log('No trades in last 48 hours');
      return;
    }
    
    // Group by exit reason
    const exitReasons = {};
    const symbols = {};
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    
    trades.forEach(trade => {
      const reason = trade.exit_reason || 'open';
      if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
      exitReasons[reason].count++;
      exitReasons[reason].pnl += parseFloat(trade.pnl_usd || 0);
      
      const symbol = trade.buy_symbol || trade.stock_ticker;
      if (!symbols[symbol]) symbols[symbol] = { count: 0, pnl: 0 };
      symbols[symbol].count++;
      symbols[symbol].pnl += parseFloat(trade.pnl_usd || 0);
      
      totalPnl += parseFloat(trade.pnl_usd || 0);
      if (parseFloat(trade.pnl_usd || 0) > 0) wins++;
      else losses++;
    });
    
    console.log(`\nWin Rate: ${wins}/${trades.length} (${(wins/trades.length*100).toFixed(1)}%)`);
    console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
    
    console.log('\n=== EXIT REASONS ===');
    Object.entries(exitReasons)
      .sort(([,a], [,b]) => b.count - a.count)
      .forEach(([reason, data]) => {
        console.log(`${reason}: ${data.count} trades, $${data.pnl.toFixed(2)} PnL`);
      });
    
    console.log('\n=== BY SYMBOL ===');
    Object.entries(symbols)
      .sort(([,a], [,b]) => b.count - a.count)
      .forEach(([symbol, data]) => {
        console.log(`${symbol}: ${data.count} trades, $${data.pnl.toFixed(2)} PnL`);
      });
    
    // Look for concerning patterns
    console.log('\n=== PATTERN ANALYSIS ===');
    
    // Check for consistent losses on any symbol
    const losingSym = Object.entries(symbols).filter(([,data]) => data.pnl < -2 && data.count >= 3);
    if (losingSym.length > 0) {
      console.log('⚠️  CONSISTENT LOSERS:');
      losingSym.forEach(([sym, data]) => {
        console.log(`  ${sym}: ${data.count} trades, $${data.pnl.toFixed(2)} PnL`);
      });
    }
    
    // Check for high stop loss rate
    const stopLossRate = exitReasons['stop_loss'] ? exitReasons['stop_loss'].count / trades.length : 0;
    if (stopLossRate > 0.3) {
      console.log(`⚠️  HIGH STOP LOSS RATE: ${(stopLossRate*100).toFixed(1)}%`);
    }
    
    // Check recent entry thresholds
    const recentEntries = trades.slice(0, 10).map(t => ({
      symbol: t.buy_symbol || t.stock_ticker,
      entry_discount: parseFloat(t.entry_spread_pct || 0),
      pnl: parseFloat(t.pnl_usd || 0),
      exit_reason: t.exit_reason || 'open',
      status: t.status
    }));
    
    console.log('\n=== RECENT ENTRY THRESHOLDS ===');
    recentEntries.forEach(t => {
      const status = t.status === 'open' ? '(OPEN)' : `(${t.exit_reason})`;
      console.log(`${t.symbol}: ${t.entry_discount.toFixed(2)}% entry → $${t.pnl.toFixed(2)} ${status}`);
    });
    
    // Check for potential threshold issues - only closed positions
    const closedTrades = trades.filter(t => t.status !== 'open');
    const lowEntries = closedTrades
      .slice(0, 10)
      .filter(t => Math.abs(parseFloat(t.entry_spread_pct || 0)) < 4.5 && parseFloat(t.pnl_usd || 0) < 0);
    if (lowEntries.length >= 3) {
      console.log('\n⚠️  POTENTIAL THRESHOLD TOO LOW:');
      lowEntries.forEach(t => {
        console.log(`  ${t.buy_symbol}: ${parseFloat(t.entry_spread_pct).toFixed(2)}% → $${parseFloat(t.pnl_usd).toFixed(2)}`);
      });
    }
    
    // Check average hold times for closed positions
    const validHoldTimes = closedTrades
      .filter(t => t.entry_timestamp && t.exit_timestamp)
      .map(t => {
        const entryTime = parseInt(t.entry_timestamp);
        const exitTime = parseInt(t.exit_timestamp);
        const holdMs = exitTime - entryTime;
        return { 
          symbol: t.buy_symbol || t.stock_ticker, 
          holdMinutes: holdMs / (1000 * 60), 
          pnl: parseFloat(t.pnl_usd || 0) 
        };
      });
    
    if (validHoldTimes.length > 0) {
      const avgHold = validHoldTimes.reduce((sum, t) => sum + t.holdMinutes, 0) / validHoldTimes.length;
      console.log(`\nAverage Hold Time: ${avgHold.toFixed(1)} minutes`);
      
      const longHolds = validHoldTimes.filter(t => t.holdMinutes > 45);
      if (longHolds.length > 0) {
        console.log(`Long holds (>45min): ${longHolds.length}/${validHoldTimes.length}`);
        const longHoldPnl = longHolds.reduce((sum, t) => sum + t.pnl, 0);
        console.log(`Long hold total PnL: $${longHoldPnl.toFixed(2)}`);
      }
    }
    
    // Look for unusual patterns in losing trades
    const losers = closedTrades.filter(t => parseFloat(t.pnl_usd || 0) < -0.50);
    if (losers.length > 0) {
      console.log(`\n=== BIG LOSERS (>$0.50) ===`);
      console.log(`Count: ${losers.length}/${closedTrades.length} closed positions`);
      
      const bigLossReasons = {};
      losers.forEach(t => {
        const reason = t.exit_reason || 'unknown';
        if (!bigLossReasons[reason]) bigLossReasons[reason] = 0;
        bigLossReasons[reason]++;
      });
      
      Object.entries(bigLossReasons)
        .sort(([,a], [,b]) => b - a)
        .forEach(([reason, count]) => {
          console.log(`  ${reason}: ${count} trades`);
        });
    }
    
    // Check open positions
    const openPositions = trades.filter(t => t.status === 'open');
    if (openPositions.length > 0) {
      console.log(`\n=== OPEN POSITIONS ===`);
      console.log(`Count: ${openPositions.length}`);
      openPositions.forEach(pos => {
        const entryTime = new Date(parseInt(pos.entry_timestamp));
        const holdMinutes = (Date.now() - parseInt(pos.entry_timestamp)) / (1000 * 60);
        console.log(`${pos.buy_symbol}: ${parseFloat(pos.entry_spread_pct).toFixed(2)}% entry, ${holdMinutes.toFixed(0)}min ago, $${parseFloat(pos.size_usd).toFixed(0)} size`);
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    process.exit(0);
  }
})();