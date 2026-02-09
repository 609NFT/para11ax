const { getTradesPool } = require('../dist/db/supabaseClient.js');

async function analyzeRecentTrades() {
  const pool = getTradesPool();
  
  // Get last 20 trades  
  const result = await pool.query(`
    SELECT * FROM mean_reversion_positions 
    ORDER BY entry_timestamp DESC 
    LIMIT 20
  `);
  const trades = result.rows;
    
  console.log('Recent Trades Analysis:');
  console.log('======================');
  
  let totalPnL = 0;
  let profitableCount = 0;
  const exitReasons = {};
  const holdTimes = [];
  
  trades.forEach((trade, i) => {
    const entryTime = new Date(Number(trade.entry_timestamp)).toISOString();
    const exitTime = trade.exit_timestamp ? new Date(Number(trade.exit_timestamp)).toISOString() : 'OPEN';
    const holdTime = trade.exit_timestamp ? (Number(trade.exit_timestamp) - Number(trade.entry_timestamp)) / 1000 / 60 : null;
    
    console.log(`\n${i+1}. ${trade.stock_ticker} | ${trade.id}`);
    console.log(`   Entry: ${entryTime} @ ${trade.entry_spread_pct}%`);
    console.log(`   Exit: ${exitTime} ${holdTime ? `(${holdTime.toFixed(1)} min)` : ''}`);
    console.log(`   Reason: ${trade.exit_reason || 'N/A'}`);
    console.log(`   PnL: $${trade.pnl_usd || 'N/A'} (${trade.pnl_pct || 'N/A'}%)`);
    console.log(`   Size: $${trade.size_usd}`);
    console.log(`   Status: ${trade.status}`);
    
    if (trade.pnl_usd) {
      totalPnL += parseFloat(trade.pnl_usd);
      if (parseFloat(trade.pnl_usd) > 0) profitableCount++;
    }
    
    if (trade.exit_reason) {
      exitReasons[trade.exit_reason] = (exitReasons[trade.exit_reason] || 0) + 1;
    }
    
    if (holdTime) holdTimes.push(holdTime);
  });
  
  console.log('\n\nSUMMARY:');
  console.log('========');
  console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
  console.log(`Win Rate: ${profitableCount}/${trades.length} (${(profitableCount/trades.length*100).toFixed(1)}%)`);
  console.log(`Avg Hold Time: ${holdTimes.length ? (holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length).toFixed(1) : 'N/A'} min`);
  
  console.log('\nExit Reasons:');
  Object.entries(exitReasons).forEach(([reason, count]) => {
    console.log(`  ${reason}: ${count}`);
  });
}

analyzeRecentTrades().catch(console.error);