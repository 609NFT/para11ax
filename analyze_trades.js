const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const secretsPath = process.env.HOME + '/.parallax-secrets/supabase-db.json';
if (!fs.existsSync(secretsPath)) {
  console.log('❌ Database secrets not found');
  process.exit(1);
}

const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const url = 'https://tixpkokukqccehbnpkpf.supabase.co';
const client = createClient(url, secrets.service_role_key, {
  db: { schema: 'public' }
});

async function analyzeLast6Hours() {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  
  console.log('📊 LAST 6 HOURS ANALYSIS (since', sixHoursAgo, ')');
  console.log('');
  
  // Check trades
  const { data: trades, error } = await client
    .from('mean_reversion_positions')
    .select('*')
    .gte('created_at', sixHoursAgo)
    .order('created_at', { ascending: false });
    
  if (error) {
    console.log('❌ Error fetching trades:', error.message);
    return;
  }
  
  console.log('🔹 Trades in last 6 hours:', trades.length);
  
  if (trades.length > 0) {
    trades.forEach(trade => {
      const entrySpread = (trade.entry_spread_pct * 100).toFixed(2);
      const pnl = trade.pnl_usd ? trade.pnl_usd.toFixed(2) : 'pending';
      const status = trade.status;
      console.log(`  ${trade.token_symbol}: ${entrySpread}% entry, ${status}, $${pnl} PnL`);
    });
  } else {
    console.log('  No trades executed (expected with 4.0% threshold)');
  }
  
  console.log('');
  
  // Check current spreads
  const { data: spreads } = await client
    .from('discount_history')
    .select('token_symbol, spread_pct, updated_at')
    .gte('updated_at', new Date(Date.now() - 30 * 60 * 1000).toISOString()) // Last 30 min
    .order('updated_at', { ascending: false })
    .limit(50);
    
  if (spreads && spreads.length > 0) {
    console.log('📈 Current spreads (last 30 min):');
    const latest = {};
    spreads.forEach(s => {
      if (!latest[s.token_symbol]) {
        latest[s.token_symbol] = s.spread_pct * 100;
      }
    });
    
    Object.entries(latest)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .forEach(([symbol, spread]) => {
        const indicator = spread >= 4.0 ? '🟢' : spread >= 3.0 ? '🟡' : '🔴';
        console.log(`  ${indicator} ${symbol}: ${spread.toFixed(2)}%`);
      });
  }
  
  console.log('');
  
  // Check entry threshold effectiveness
  const { data: recentTrades } = await client
    .from('mean_reversion_positions')
    .select('token_symbol, entry_spread_pct, pnl_usd, status, created_at')
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Last 24h
    .order('created_at', { ascending: false });
    
  if (recentTrades && recentTrades.length > 0) {
    console.log('📊 Last 24h entry analysis:');
    const above4 = recentTrades.filter(t => t.entry_spread_pct >= 0.04);
    const below4 = recentTrades.filter(t => t.entry_spread_pct < 0.04);
    
    console.log(`  Entries ≥4.0%: ${above4.length} trades`);
    console.log(`  Entries <4.0%: ${below4.length} trades`);
    
    if (above4.length > 0) {
      const avgEntry = (above4.reduce((sum, t) => sum + t.entry_spread_pct, 0) / above4.length * 100).toFixed(2);
      const closed = above4.filter(t => t.status === 'closed');
      const avgPnL = closed.length > 0 ? (closed.reduce((sum, t) => sum + (t.pnl_usd || 0), 0) / closed.length).toFixed(2) : 'N/A';
      console.log(`    Avg entry: ${avgEntry}%, Avg PnL: $${avgPnL}`);
    }
  }
}

analyzeLast6Hours().catch(console.error);