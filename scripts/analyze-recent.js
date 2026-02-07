const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
});

async function analyzeTrades() {
  // Get trades from last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  
  const result = await pool.query(
    'SELECT * FROM mean_reversion_positions WHERE created_at >= $1 ORDER BY created_at DESC',
    [sevenDaysAgo]
  );
  const trades = result.rows;

  console.log('=== LAST 7 DAYS TRADE ANALYSIS ===');
  console.log('Total trades:', trades.length);
  
  if (trades.length === 0) {
    console.log('No trades in last 7 days');
    return;
  }

  // Analyze by symbol
  const bySymbol = trades.reduce((acc, t) => {
    acc[t.buy_symbol] = acc[t.buy_symbol] || { count: 0, totalPnl: 0, avgSpread: 0 };
    acc[t.buy_symbol].count++;
    acc[t.buy_symbol].totalPnl += parseFloat(t.pnl_usd || 0);
    acc[t.buy_symbol].avgSpread += Math.abs(parseFloat(t.entry_spread_pct || 0));
    return acc;
  }, {});

  Object.keys(bySymbol).forEach(symbol => {
    const data = bySymbol[symbol];
    data.avgSpread = data.avgSpread / data.count;
    console.log(`${symbol}: ${data.count} trades, $${data.totalPnl.toFixed(2)} PnL, ${data.avgSpread.toFixed(2)}% avg spread`);
  });

  // Analyze win rate and timing
  const winningTrades = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0);
  const winRate = (winningTrades.length / trades.length * 100).toFixed(1);
  console.log('Win Rate:', winRate + '%');

  // Analyze hold times
  const holdTimes = trades
    .filter(t => t.exit_timestamp && t.entry_timestamp)
    .map(t => {
      const hold = (new Date(t.exit_timestamp) - new Date(t.entry_timestamp)) / 1000 / 60; // minutes
      return { symbol: t.buy_symbol, holdMin: hold, pnl: parseFloat(t.pnl_usd || 0) };
    });

  if (holdTimes.length > 0) {
    const avgHold = holdTimes.reduce((sum, t) => sum + t.holdMin, 0) / holdTimes.length;
    console.log('Average hold time:', avgHold.toFixed(1), 'minutes');
    
    // Show distribution
    const under15 = holdTimes.filter(t => t.holdMin < 15);
    const between15_30 = holdTimes.filter(t => t.holdMin >= 15 && t.holdMin < 30);
    const over30 = holdTimes.filter(t => t.holdMin >= 30);
    
    console.log('Hold time distribution:');
    console.log('< 15min:', under15.length, 'trades, avg PnL:', (under15.reduce((sum, t) => sum + t.pnl, 0) / (under15.length || 1)).toFixed(2));
    console.log('15-30min:', between15_30.length, 'trades, avg PnL:', (between15_30.reduce((sum, t) => sum + t.pnl, 0) / (between15_30.length || 1)).toFixed(2));
    console.log('> 30min:', over30.length, 'trades, avg PnL:', (over30.reduce((sum, t) => sum + t.pnl, 0) / (over30.length || 1)).toFixed(2));
  }

  // Check recent spread activity
  const spreadsResult = await pool.query(
    'SELECT token_a_symbol, token_a_discount_vs_stock, timestamp FROM discount_history WHERE timestamp >= $1 ORDER BY timestamp DESC LIMIT 1000',
    [sevenDaysAgo]
  );
  const spreads = spreadsResult.rows;

  if (spreads && spreads.length > 0) {
    console.log('\n=== SPREAD ANALYSIS ===');
    const spreadsBySymbol = spreads.reduce((acc, s) => {
      acc[s.token_a_symbol] = acc[s.token_a_symbol] || [];
      acc[s.token_a_symbol].push(Math.abs(parseFloat(s.token_a_discount_vs_stock)));
      return acc;
    }, {});

    Object.keys(spreadsBySymbol).forEach(symbol => {
      const discounts = spreadsBySymbol[symbol];
      const max = Math.max(...discounts);
      const avg = discounts.reduce((sum, d) => sum + d, 0) / discounts.length;
      const above4pct = discounts.filter(d => d >= 4).length;
      console.log(`${symbol}: max ${max.toFixed(2)}%, avg ${avg.toFixed(2)}%, ${above4pct} observations ≥4%`);
    });
  }

  await pool.end();
}

analyzeTrades().catch(console.error);