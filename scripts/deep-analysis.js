const { Pool } = require('pg');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

const connectionString = process.env.TRADES_DB_URL;

if (!connectionString) {
  console.error('Error: TRADES_DB_URL environment variable not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });

(async () => {
  try {
    // Check last 6 hours of trades
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    
    const recentTrades = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE created_at >= $1 
      ORDER BY created_at DESC
    `, [sixHoursAgo]);
      
    console.log('=== LAST 6 HOURS TRADES ===');
    console.log('Total trades:', recentTrades.rows.length);
    
    if (recentTrades.rows.length > 0) {
      recentTrades.rows.forEach(trade => {
        const entrySpread = Math.abs(trade.entry_spread_pct || 0).toFixed(2);
        const pnl = trade.pnl_usd ? parseFloat(trade.pnl_usd).toFixed(2) : 'pending';
        const holdTime = trade.exit_timestamp ? 
          Math.round((parseInt(trade.exit_timestamp) - parseInt(trade.entry_timestamp)) / 60000) : 'open';
        
        console.log(`${trade.symbol} | Entry: ${entrySpread}% | PnL: $${pnl} | Hold: ${holdTime}min | Exit: ${trade.exit_reason || 'open'}`);
      });
      
      // Check entry thresholds
      const entries = recentTrades.rows.filter(t => t.entry_spread_pct);
      if (entries.length > 0) {
        const avgEntry = entries.reduce((sum, t) => sum + Math.abs(t.entry_spread_pct), 0) / entries.length;
        console.log(`\nAvg entry spread: ${avgEntry.toFixed(2)}%`);
        console.log('Min entry:', Math.min(...entries.map(t => Math.abs(t.entry_spread_pct))).toFixed(2) + '%');
        console.log('Max entry:', Math.max(...entries.map(t => Math.abs(t.entry_spread_pct))).toFixed(2) + '%');
      }
      
      // Exit reason breakdown
      const exitReasons = {};
      recentTrades.rows.filter(t => t.exit_reason).forEach(t => {
        exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
      });
      console.log('\nExit reasons:', exitReasons);
      
      // Check for forced exits blocked by anti-churning
      const forcedExits = recentTrades.rows.filter(t => 
        t.exit_reason && ['max_hold', 'stop_loss', 'spread_widening_stop'].includes(t.exit_reason)
      );
      console.log('\nForced exits (should bypass anti-churning):', forcedExits.length);
      
    } else {
      console.log('No trades in last 6 hours - checking recent activity...');
      
      // Check last 5 trades regardless of time
      const lastTrades = await pool.query(`
        SELECT * FROM mean_reversion_positions 
        ORDER BY created_at DESC 
        LIMIT 5
      `);
      
      if (lastTrades.rows.length > 0) {
        console.log('\n=== LAST 5 TRADES (ANY TIME) ===');
        lastTrades.rows.forEach(trade => {
          const entrySpread = Math.abs(trade.entry_spread_pct || 0).toFixed(2);
          const pnl = trade.pnl_usd ? parseFloat(trade.pnl_usd).toFixed(2) : 'pending';
          const age = Math.round((Date.now() - parseInt(trade.created_at)) / (60 * 60 * 1000));
          console.log(`${trade.symbol} | ${age}h ago | Entry: ${entrySpread}% | PnL: $${pnl} | Exit: ${trade.exit_reason || 'open'}`);
        });
        
        // Check if any are still open
        const openTrades = lastTrades.rows.filter(t => !t.exit_reason);
        if (openTrades.length > 0) {
          console.log(`\nOpen trades: ${openTrades.length}`);
          openTrades.forEach(trade => {
            const holdTime = Math.round((Date.now() - parseInt(trade.entry_timestamp)) / 60000);
            console.log(`${trade.symbol} | Open for: ${holdTime}min`);
          });
        }
      }
    }
    
    // Check daily PnL
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    
    const dailyPnl = await pool.query(`
      SELECT SUM(pnl_usd) as total_pnl, COUNT(*) as trades_count 
      FROM mean_reversion_positions 
      WHERE created_at >= $1 AND pnl_usd IS NOT NULL
    `, [todayStart.getTime()]);
    
    const pnl = dailyPnl.rows[0];
    if (pnl.total_pnl !== null) {
      console.log(`\n=== TODAY'S PERFORMANCE ===`);
      console.log(`PnL: $${parseFloat(pnl.total_pnl).toFixed(2)} (${pnl.trades_count} completed trades)`);
    }
    
  } catch (err) {
    console.error('Database Error:', err.message);
  } finally {
    await pool.end();
  }
})();