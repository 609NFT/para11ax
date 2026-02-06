const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');
const path = require('path');

// Load environment variables
config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const sixHoursAgo = new Date(Date.now() - 6*60*60*1000).toISOString();

async function analyze() {
  try {
    // Get recent trades
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .gte('timestamp', sixHoursAgo)
      .order('timestamp', { ascending: false });
    
    if (error) {
      console.error('Supabase error:', error);
      return;
    }
    
    console.log('=== RECENT TRADES (Last 6 Hours) ===');
    console.log(`Found ${trades?.length || 0} trades`);
    
    if (trades && trades.length > 0) {
      let totalPnl = 0;
      let entryThresholds = [];
      let exitReasons = {};
      let holdTimes = [];
      
      trades.forEach(trade => {
        totalPnl += parseFloat(trade.pnl_usd || 0);
        entryThresholds.push(parseFloat(trade.entry_spread_pct || 0));
        const exitReason = trade.exit_reason || 'unknown';
        exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
        
        if (trade.exit_timestamp) {
          const holdMinutes = Math.round((new Date(trade.exit_timestamp) - new Date(trade.entry_timestamp))/60000);
          holdTimes.push(holdMinutes);
          console.log(`${trade.symbol}: Entry ${trade.entry_spread_pct}%, Exit ${trade.exit_spread_pct}%, PnL $${trade.pnl_usd}, Reason: ${trade.exit_reason}, Hold: ${holdMinutes}min`);
        }
      });
      
      console.log(`\nTotal PnL: $${totalPnl.toFixed(2)}`);
      console.log(`Entry thresholds: ${entryThresholds.map(x => x.toFixed(1)).join('%, ')}%`);
      console.log('Exit reasons:', exitReasons);
      
      if (holdTimes.length > 0) {
        const avgHold = holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length;
        console.log(`Hold times: avg ${avgHold.toFixed(1)}min, range ${Math.min(...holdTimes)}-${Math.max(...holdTimes)}min`);
      }
      
      // Check if entries are meeting 4%+ threshold
      const belowThreshold = entryThresholds.filter(x => x < 4.0);
      if (belowThreshold.length > 0) {
        console.log(`⚠️  ${belowThreshold.length}/${trades.length} trades entered below 4% threshold`);
      }
    }
    
    // Check recent spreads
    console.log('\n=== CURRENT SPREAD LEVELS ===');
    const { data: spreads } = await supabase
      .from('discount_history')
      .select('symbol, spread_pct, timestamp')
      .gt('timestamp', new Date(Date.now() - 30*60*1000).toISOString()) // Last 30min
      .order('timestamp', { ascending: false })
      .limit(20);
      
    if (spreads) {
      const latestSpreads = {};
      spreads.forEach(s => {
        if (!latestSpreads[s.symbol]) {
          latestSpreads[s.symbol] = s.spread_pct;
        }
      });
      
      console.log('Latest spreads:');
      Object.entries(latestSpreads).forEach(([symbol, spread]) => {
        const signal = Math.abs(spread) >= 4.0 ? '🟢' : '⚪';
        console.log(`${signal} ${symbol}: ${spread.toFixed(2)}%`);
      });
    }
    
  } catch (err) {
    console.error('Analysis error:', err);
  }
}

analyze();