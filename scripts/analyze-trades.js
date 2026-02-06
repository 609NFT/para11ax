const { connectSupabase } = require('../dist/db/supabaseClient');

(async () => {
  const supabase = await connectSupabase();
  const { data: trades } = await supabase
    .from('trades')
    .select('*')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });
    
  console.log('=== LAST 7 DAYS ANALYSIS ===');
  console.log('Total trades:', trades.length);
  
  // Token performance
  const byToken = {};
  trades.forEach(t => {
    if (!byToken[t.token_symbol]) byToken[t.token_symbol] = { count: 0, pnl: 0, wins: 0 };
    byToken[t.token_symbol].count++;
    byToken[t.token_symbol].pnl += parseFloat(t.net_pnl || 0);
    if (parseFloat(t.net_pnl || 0) > 0) byToken[t.token_symbol].wins++;
  });
  
  console.log('\n=== TOKEN PERFORMANCE ===');
  Object.entries(byToken).sort((a,b) => b[1].pnl - a[1].pnl).forEach(([token, stats]) => {
    const wr = (stats.wins / stats.count * 100).toFixed(1);
    console.log(`${token}: ${stats.count} trades, ${wr}% WR, $${stats.pnl.toFixed(2)} PnL`);
  });
  
  // Time pattern analysis
  const hourly = {};
  trades.forEach(t => {
    const hour = new Date(t.created_at).getUTCHours();
    if (!hourly[hour]) hourly[hour] = { count: 0, pnl: 0, wins: 0 };
    hourly[hour].count++;
    hourly[hour].pnl += parseFloat(t.net_pnl || 0);
    if (parseFloat(t.net_pnl || 0) > 0) hourly[hour].wins++;
  });
  
  console.log('\n=== TIME PATTERNS (UTC) ===');
  Object.entries(hourly).sort((a,b) => a[0] - b[0]).forEach(([hour, stats]) => {
    if (stats.count > 2) {
      const wr = (stats.wins / stats.count * 100).toFixed(1);
      console.log(`${hour.padStart(2,'0')}:00: ${stats.count} trades, ${wr}% WR, $${stats.pnl.toFixed(2)}`);
    }
  });
  
  // Entry spread analysis
  const spreadBuckets = { '0-2%': [], '2-4%': [], '4-6%': [], '6%+': [] };
  trades.forEach(t => {
    const spread = Math.abs(parseFloat(t.entry_spread_pct || 0));
    if (spread < 2) spreadBuckets['0-2%'].push(t);
    else if (spread < 4) spreadBuckets['2-4%'].push(t);
    else if (spread < 6) spreadBuckets['4-6%'].push(t);
    else spreadBuckets['6%+'].push(t);
  });
  
  console.log('\n=== ENTRY SPREAD ANALYSIS ===');
  Object.entries(spreadBuckets).forEach(([range, trades]) => {
    if (trades.length > 0) {
      const wins = trades.filter(t => parseFloat(t.net_pnl || 0) > 0).length;
      const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.net_pnl || 0), 0);
      const wr = (wins / trades.length * 100).toFixed(1);
      console.log(`${range}: ${trades.length} trades, ${wr}% WR, $${totalPnl.toFixed(2)} PnL`);
    }
  });
  
  process.exit(0);
})();