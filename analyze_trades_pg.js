const { Pool } = require('pg');
const fs = require('fs');

const secretsPath = process.env.HOME + '/.parallax-secrets/supabase-db.json';
if (!fs.existsSync(secretsPath)) {
  console.log('❌ Database secrets not found');
  process.exit(1);
}

const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const pool = new Pool({
  host: secrets.host,
  port: secrets.port,
  database: secrets.database,
  user: secrets.user,
  password: secrets.password,
  ssl: { rejectUnauthorized: false }
});

async function analyzeLast6Hours() {
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    
    console.log('📊 LAST 6 HOURS ANALYSIS (since', sixHoursAgo, ')');
    console.log('');
    
    // Check trades
    const tradesQuery = `
      SELECT * FROM mean_reversion_positions 
      WHERE created_at >= $1 
      ORDER BY created_at DESC
    `;
    
    const tradesResult = await pool.query(tradesQuery, [sixHoursAgo]);
    const trades = tradesResult.rows;
    
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
    const spreadsQuery = `
      SELECT token_symbol, spread_pct, updated_at 
      FROM discount_history 
      WHERE updated_at >= $1 
      ORDER BY updated_at DESC 
      LIMIT 50
    `;
    
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const spreadsResult = await pool.query(spreadsQuery, [thirtyMinAgo]);
    const spreads = spreadsResult.rows;
    
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
    const recentTradesQuery = `
      SELECT token_symbol, entry_spread_pct, pnl_usd, status, created_at 
      FROM mean_reversion_positions 
      WHERE created_at >= $1 
      ORDER BY created_at DESC
    `;
    
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentTradesResult = await pool.query(recentTradesQuery, [twentyFourHoursAgo]);
    const recentTrades = recentTradesResult.rows;
    
    if (recentTrades && recentTrades.length > 0) {
      console.log('📊 Last 24h entry analysis:');
      const above4 = recentTrades.filter(t => t.entry_spread_pct >= 0.04);
      const below4 = recentTrades.filter(t => t.entry_spread_pct < 0.04);
      
      console.log(`  Entries ≥4.0%: ${above4.length} trades`);
      console.log(`  Entries <4.0%: ${below4.length} trades`);
      
      if (above4.length > 0) {
        const avgEntry = (above4.reduce((sum, t) => sum + parseFloat(t.entry_spread_pct), 0) / above4.length * 100).toFixed(2);
        const closed = above4.filter(t => t.status === 'closed');
        const avgPnL = closed.length > 0 ? (closed.reduce((sum, t) => sum + (parseFloat(t.pnl_usd) || 0), 0) / closed.length).toFixed(2) : 'N/A';
        console.log(`    Avg entry: ${avgEntry}%, Avg PnL: $${avgPnL}`);
      }
    }
    
    console.log('');
    
    // Check exit reasons
    const exitReasonsQuery = `
      SELECT exit_reason, COUNT(*) as count, AVG(pnl_usd) as avg_pnl
      FROM mean_reversion_positions 
      WHERE created_at >= $1 AND status = 'closed' AND exit_reason IS NOT NULL
      GROUP BY exit_reason
      ORDER BY count DESC
    `;
    
    const exitReasonsResult = await pool.query(exitReasonsQuery, [twentyFourHoursAgo]);
    const exitReasons = exitReasonsResult.rows;
    
    if (exitReasons && exitReasons.length > 0) {
      console.log('🎯 Exit reasons (last 24h):');
      exitReasons.forEach(reason => {
        const avgPnl = parseFloat(reason.avg_pnl).toFixed(2);
        console.log(`  ${reason.exit_reason}: ${reason.count} trades, avg $${avgPnl} PnL`);
      });
    }
    
  } catch (error) {
    console.error('❌ Database error:', error.message);
  } finally {
    await pool.end();
  }
}

analyzeLast6Hours().catch(console.error);