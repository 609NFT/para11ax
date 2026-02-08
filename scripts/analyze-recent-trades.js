const { Client } = require('pg');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const creds = require('/home/ec2-user/.parallax-secrets/supabase-db.json');
const client = new Client(creds);

(async () => {
  try {
    await client.connect();
    
    console.log('📊 RECENT TRADES ANALYSIS\n');
    
    // Last 20 closed positions
    const recentTrades = await client.query(`
      SELECT 
        symbol, entry_time, exit_time, entry_spread_pct, exit_spread_pct,
        entry_amount_usd, exit_amount_usd, realized_pnl_usd, exit_reason,
        hold_time_minutes, size_usd,
        (exit_time - entry_time) / 60000 as hold_minutes
      FROM positions 
      WHERE exit_time IS NOT NULL 
      ORDER BY exit_time DESC 
      LIMIT 20
    `);
    
    if (recentTrades.rows.length === 0) {
      console.log('❌ No recent closed trades found');
      return;
    }
    
    const trades = recentTrades.rows;
    const totalTrades = trades.length;
    const winners = trades.filter(t => parseFloat(t.realized_pnl_usd) > 0).length;
    const winRate = (winners / totalTrades * 100).toFixed(1);
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl_usd || 0), 0);
    const avgPnL = (totalPnL / totalTrades).toFixed(2);
    const avgHoldTime = (trades.reduce((sum, t) => sum + parseFloat(t.hold_minutes || 0), 0) / totalTrades).toFixed(1);
    
    console.log(`🎯 PERFORMANCE (Last ${totalTrades} trades):`);
    console.log(`   Win Rate: ${winRate}% (${winners}/${totalTrades})`);
    console.log(`   Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`   Avg PnL: $${avgPnL}`);
    console.log(`   Avg Hold: ${avgHoldTime} min`);
    
    // Exit reasons breakdown
    const exitReasons = {};
    trades.forEach(t => {
      const reason = t.exit_reason || 'unknown';
      exitReasons[reason] = (exitReasons[reason] || 0) + 1;
    });
    
    console.log('\n📤 EXIT REASONS:');
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`   ${reason}: ${count} trades (${(count/totalTrades*100).toFixed(1)}%)`);
    });
    
    // Recent trade details
    console.log('\n📈 RECENT TRADES:');
    trades.slice(0, 10).forEach(t => {
      const pnl = parseFloat(t.realized_pnl_usd || 0);
      const emoji = pnl > 0 ? '✅' : pnl < 0 ? '❌' : '➖';
      console.log(`${emoji} ${t.symbol}: $${pnl.toFixed(2)} | ${t.entry_spread_pct}%→${t.exit_spread_pct}% | ${parseFloat(t.hold_minutes || 0).toFixed(0)}m | ${t.exit_reason}`);
    });
    
    // Current open positions
    const openPositions = await client.query(`
      SELECT symbol, entry_time, entry_spread_pct, size_usd, 
             (EXTRACT(EPOCH FROM NOW()) * 1000 - entry_time) / 60000 as minutes_open
      FROM positions 
      WHERE exit_time IS NULL 
      ORDER BY entry_time DESC
    `);
    
    console.log(`\n🔄 OPEN POSITIONS: ${openPositions.rows.length}`);
    openPositions.rows.forEach(p => {
      console.log(`   ${p.symbol}: $${parseFloat(p.size_usd).toFixed(0)} | ${p.entry_spread_pct}% | ${parseFloat(p.minutes_open).toFixed(0)}m open`);
    });
    
  } catch (error) {
    console.error('Database error:', error.message);
  } finally {
    await client.end();
  }
})();