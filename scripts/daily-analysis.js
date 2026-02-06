const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Pool } = require('pg');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.env.HOME + '/.parallax-secrets/supabase-db.json', 'utf8'));

const pool = new Pool({
  host: config.host,
  port: config.port,
  database: config.database,
  user: config.user,
  password: config.password,
  ssl: { rejectUnauthorized: false }
});

async function analyze24h() {
  try {
    // Get trades from last 24h
    const tradesResult = await pool.query(`
      SELECT 
        id,
        token_symbol,
        entry_timestamp,
        exit_timestamp,
        entry_spread_pct,
        exit_spread_pct,
        net_pnl,
        exit_reason,
        EXTRACT(EPOCH FROM (exit_timestamp - entry_timestamp)) * 1000 as hold_duration_ms
      FROM trades 
      WHERE entry_timestamp >= NOW() - INTERVAL '24 hours'
      ORDER BY entry_timestamp DESC
    `);
    
    // Get any open positions
    const positionsResult = await pool.query(`
      SELECT 
        id,
        token_symbol,
        position_type,
        entry_timestamp,
        entry_price,
        current_spread_pct,
        EXTRACT(EPOCH FROM (NOW() - entry_timestamp)) * 1000 as age_ms
      FROM active_positions
      WHERE is_open = true
    `);
    
    console.log('=== LAST 24H TRADES ===');
    console.log('Total trades:', tradesResult.rows.length);
    
    if (tradesResult.rows.length > 0) {
      const trades = tradesResult.rows;
      const winningTrades = trades.filter(t => parseFloat(t.net_pnl) > 0);
      const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.net_pnl), 0);
      
      console.log('Win rate:', (winningTrades.length / trades.length * 100).toFixed(1) + '%');
      console.log('Total PnL: $' + totalPnL.toFixed(2));
      
      // Break down by symbol
      const bySymbol = {};
      trades.forEach(t => {
        if (!bySymbol[t.token_symbol]) bySymbol[t.token_symbol] = { count: 0, pnl: 0, wins: 0 };
        bySymbol[t.token_symbol].count++;
        bySymbol[t.token_symbol].pnl += parseFloat(t.net_pnl);
        if (parseFloat(t.net_pnl) > 0) bySymbol[t.token_symbol].wins++;
      });
      
      console.log('\nBy Symbol:');
      Object.entries(bySymbol).forEach(([symbol, data]) => {
        console.log(`${symbol}: ${data.count} trades, ${(data.wins/data.count*100).toFixed(1)}% WR, $${data.pnl.toFixed(2)} PnL`);
      });
      
      // Exit reason distribution
      const exitReasons = {};
      trades.forEach(t => {
        exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
      });
      
      console.log('\nExit Reasons:');
      Object.entries(exitReasons).forEach(([reason, count]) => {
        console.log(`${reason}: ${count} (${(count/trades.length*100).toFixed(1)}%)`);
      });
      
      // Average hold time
      const avgHoldTime = trades.reduce((sum, t) => sum + parseInt(t.hold_duration_ms), 0) / trades.length;
      console.log('\nAverage hold time:', Math.round(avgHoldTime / 1000 / 60) + ' minutes');
      
      // Entry spread analysis
      const above4pct = trades.filter(t => parseFloat(t.entry_spread_pct) >= 4.0);
      console.log('\nEntry Spread Analysis:');
      console.log('>=4% entries:', above4pct.length + '/' + trades.length, `(${(above4pct.length/trades.length*100).toFixed(1)}%)`);
      if (above4pct.length > 0) {
        const above4WinRate = above4pct.filter(t => parseFloat(t.net_pnl) > 0).length / above4pct.length;
        const above4PnL = above4pct.reduce((sum, t) => sum + parseFloat(t.net_pnl), 0);
        console.log('>=4% win rate:', (above4WinRate * 100).toFixed(1) + '%');
        console.log('>=4% PnL: $' + above4PnL.toFixed(2));
      }
      
      // Recent trades detail (last 5)
      console.log('\nRecent Trades (last 5):');
      trades.slice(0, 5).forEach(t => {
        const holdMin = Math.round(parseInt(t.hold_duration_ms) / 1000 / 60);
        const pnl = parseFloat(t.net_pnl);
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        console.log(`${t.token_symbol}: ${parseFloat(t.entry_spread_pct).toFixed(2)}% entry → ${t.exit_reason} (${holdMin}min, ${pnlStr})`);
      });
    }
    
    console.log('\n=== OPEN POSITIONS ===');
    if (positionsResult.rows.length > 0) {
      positionsResult.rows.forEach(pos => {
        const ageMinutes = Math.round(parseInt(pos.age_ms) / 1000 / 60);
        console.log(`${pos.token_symbol} ${pos.position_type}: ${ageMinutes}min old, ${pos.current_spread_pct}% spread`);
        if (ageMinutes > 60) {
          console.log('⚠️ Position older than 60min max hold time!');
        }
      });
    } else {
      console.log('No open positions');
    }
    
    await pool.end();
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

analyze24h();