const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const secrets = JSON.parse(fs.readFileSync('/home/ec2-user/.parallax-secrets/supabase-db.json'));
const supabase = createClient(secrets.url, secrets.anon_key);

(async () => {
  // Last 7 days of trades
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const { data: trades, error } = await supabase
    .from('trades')
    .select('*')
    .gte('entry_timestamp', sevenDaysAgo)
    .order('entry_timestamp', { ascending: false });
    
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.log('=== RECENT TRADES ANALYSIS (Last 7 Days) ===');
  console.log('Total trades:', trades.length);
  
  if (trades.length > 0) {
    const pnl = trades.map(t => parseFloat(t.pnl_usd) || 0);
    const totalPnl = pnl.reduce((a, b) => a + b, 0);
    const avgPnl = totalPnl / trades.length;
    const winRate = pnl.filter(p => p > 0).length / trades.length * 100;
    
    console.log('Total PnL: $' + totalPnl.toFixed(2));
    console.log('Average PnL: $' + avgPnl.toFixed(2));
    console.log('Win rate:', winRate.toFixed(1) + '%');
    
    // Symbol breakdown
    const symbols = {};
    trades.forEach(t => {
      const sym = t.token_symbol;
      if (!symbols[sym]) symbols[sym] = { count: 0, pnl: 0 };
      symbols[sym].count++;
      symbols[sym].pnl += parseFloat(t.pnl_usd) || 0;
    });
    
    console.log('\\nBy symbol:');
    Object.entries(symbols).forEach(([sym, data]) => {
      console.log(sym + ':', data.count, 'trades, $' + data.pnl.toFixed(2), 'PnL');
    });
    
    // Entry thresholds
    const entryPcts = trades.map(t => Math.abs(parseFloat(t.entry_spread_pct) || 0)).sort((a,b) => a-b);
    console.log('\\nEntry spread range:', entryPcts[0]?.toFixed(2) + '% to ' + entryPcts[entryPcts.length-1]?.toFixed(2) + '%');
    console.log('Median entry:', entryPcts[Math.floor(entryPcts.length/2)]?.toFixed(2) + '%');
    
    // Hold times
    const holdTimes = trades.filter(t => t.exit_timestamp).map(t => {
      const entry = new Date(t.entry_timestamp);
      const exit = new Date(t.exit_timestamp);
      return (exit - entry) / 1000 / 60; // minutes
    });
    
    if (holdTimes.length > 0) {
      const avgHold = holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length;
      console.log('\\nAverage hold time:', avgHold.toFixed(1), 'minutes');
      console.log('Hold time range:', Math.min(...holdTimes).toFixed(1), 'to', Math.max(...holdTimes).toFixed(1), 'minutes');
    }
  }
})();
