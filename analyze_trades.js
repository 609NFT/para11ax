const { getSupabaseClient } = require('./dist/db/supabaseClient.js');

async function analyzeRecentTrades() {
  const supabase = getSupabaseClient();
  
  // Get recent trades (last 48 hours)
  const { data: trades, error } = await supabase
    .from('trades')
    .select('*')
    .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });
    
  if (error) {
    console.error('Error fetching trades:', error);
    return;
  }
  
  console.log('=== RECENT TRADES (48hrs) ===');
  console.log('Total trades:', trades.length);
  
  if (trades.length === 0) {
    console.log('No trades in the last 48 hours');
    return;
  }
  
  // Group by symbol
  const tradesBySymbol = {};
  let totalPnL = 0;
  let winCount = 0;
  let lossCount = 0;
  
  for (const trade of trades) {
    const symbol = trade.symbol;
    if (!tradesBySymbol[symbol]) {
      tradesBySymbol[symbol] = [];
    }
    tradesBySymbol[symbol].push(trade);
    
    if (trade.pnl_usd !== null) {
      totalPnL += parseFloat(trade.pnl_usd);
      if (parseFloat(trade.pnl_usd) > 0) winCount++;
      else lossCount++;
    }
  }
  
  console.log('Net PnL: $' + totalPnL.toFixed(2));
  console.log('Win rate: ' + ((winCount / (winCount + lossCount)) * 100).toFixed(1) + '%');
  console.log('');
  
  // Analyze by symbol
  for (const [symbol, symbolTrades] of Object.entries(tradesBySymbol)) {
    console.log(symbol + ': ' + symbolTrades.length + ' trades');
    
    const symbolPnL = symbolTrades.reduce((sum, t) => sum + (parseFloat(t.pnl_usd) || 0), 0);
    const avgEntryDiscount = symbolTrades.reduce((sum, t) => sum + Math.abs(parseFloat(t.entry_discount_pct)), 0) / symbolTrades.length;
    const avgHoldTime = symbolTrades.reduce((sum, t) => {
      if (t.exit_timestamp && t.entry_timestamp) {
        return sum + (new Date(t.exit_timestamp) - new Date(t.entry_timestamp)) / (1000 * 60);
      }
      return sum;
    }, 0) / symbolTrades.filter(t => t.exit_timestamp).length;
    
    console.log('  PnL: $' + symbolPnL.toFixed(2) + ', Avg Entry: ' + avgEntryDiscount.toFixed(2) + '%, Avg Hold: ' + (avgHoldTime || 0).toFixed(1) + 'min');
    
    // Exit reasons
    const exitReasons = {};
    for (const trade of symbolTrades.filter(t => t.exit_reason)) {
      exitReasons[trade.exit_reason] = (exitReasons[trade.exit_reason] || 0) + 1;
    }
    console.log('  Exit reasons:', JSON.stringify(exitReasons));
  }
  
  // Check for concerning patterns
  console.log('\n=== ANALYSIS ===');
  
  const recentLosses = trades.filter(t => t.pnl_usd && parseFloat(t.pnl_usd) < -0.50).length;
  if (recentLosses > 3) {
    console.log('🚨 CONCERN: ' + recentLosses + ' trades with losses >$0.50 in 48hrs');
  }
  
  const maxHoldTimes = trades.filter(t => t.exit_timestamp && t.entry_timestamp).map(t => 
    (new Date(t.exit_timestamp) - new Date(t.entry_timestamp)) / (1000 * 60)
  );
  const maxHold = Math.max(...maxHoldTimes);
  if (maxHold > 90) {
    console.log('⚠️ NOTICE: Maximum hold time was ' + maxHold.toFixed(1) + 'min (>90min threshold)');
  }
  
  // Check for trading frequency issues
  if (trades.length === 0) {
    console.log('🚨 CRITICAL: No trades in 48hrs - bot may not be executing');
  } else if (trades.length < 5) {
    console.log('⚠️ NOTICE: Low trading frequency: ' + trades.length + ' trades in 48hrs');
  }
}

analyzeRecentTrades().catch(console.error);