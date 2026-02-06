const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeRecentTrades() {
  try {    
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const result = await pool.query(`
      SELECT 
        id, stock_ticker, buy_symbol, buy_mint,
        entry_timestamp, exit_timestamp, status,
        size_usd, entry_spread_pct, exit_spread_pct,
        pnl_usd as net_pnl, pnl_pct,
        entry_fees_usd, exit_fees_usd, total_fees_usd,
        exit_reason, entry_tx_signature
      FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 
      ORDER BY entry_timestamp DESC
    `, [sevenDaysAgoMs]);

    const data = result.rows;

  console.log('\n=== RECENT 7-DAY TRADE ANALYSIS ===');
  console.log('Total trades:', data.length);

  if (data.length === 0) {
    console.log('No trades in last 7 days');
    return;
  }

  // Profitable vs losing trades
  const profitable = data.filter(t => (t.net_pnl || 0) > 0);
  const losing = data.filter(t => (t.net_pnl || 0) <= 0);
  console.log('Profitable:', profitable.length, '| Losing:', losing.length, '| Win Rate:', (profitable.length/data.length*100).toFixed(1) + '%');

  // PnL summary
  const totalPnL = data.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
  console.log('Total PnL: $' + totalPnL.toFixed(2));

  // By token
  const byToken = data.reduce((acc, t) => {
    const key = t.buy_symbol;
    if (!acc[key]) acc[key] = { trades: 0, pnl: 0, winRate: 0 };
    acc[key].trades++;
    acc[key].pnl += t.net_pnl || 0;
    return acc;
  }, {});

  Object.keys(byToken).forEach(token => {
    const wins = data.filter(t => t.buy_symbol === token && (t.net_pnl || 0) > 0).length;
    byToken[token].winRate = (wins / byToken[token].trades * 100);
  });

  console.log('\n=== BY TOKEN (Top 10) ===');
  Object.entries(byToken)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 10)
    .forEach(([token, stats]) => {
      console.log(token + ':', stats.trades + 'T', '$' + stats.pnl.toFixed(2), stats.winRate.toFixed(1) + '%WR');
    });

  // By entry spread
  const bySpread = data.reduce((acc, t) => {
    const spread = Math.floor((t.entry_spread_pct || 0));
    if (!acc[spread]) acc[spread] = { trades: 0, pnl: 0, wins: 0 };
    acc[spread].trades++;
    acc[spread].pnl += t.net_pnl || 0;
    if ((t.net_pnl || 0) > 0) acc[spread].wins++;
    return acc;
  }, {});

  console.log('\n=== BY ENTRY SPREAD ===');
  Object.entries(bySpread)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .forEach(([spread, stats]) => {
      const wr = (stats.wins / stats.trades * 100).toFixed(1);
      if (stats.trades > 0) {
        console.log(spread + '%:', stats.trades + 'T', '$' + stats.pnl.toFixed(2), wr + '%WR');
      }
    });

  // Exit reasons
  const byExitReason = data.reduce((acc, t) => {
    const reason = t.exit_reason || 'unknown';
    if (!acc[reason]) acc[reason] = { trades: 0, pnl: 0 };
    acc[reason].trades++;
    acc[reason].pnl += t.net_pnl || 0;
    return acc;
  }, {});

  console.log('\n=== BY EXIT REASON ===');
  Object.entries(byExitReason)
    .sort((a, b) => b[1].trades - a[1].trades)
    .forEach(([reason, stats]) => {
      console.log(reason + ':', stats.trades + 'T', '$' + stats.pnl.toFixed(2));
    });

  // Recent patterns
  const last24hMs = Date.now() - 24 * 60 * 60 * 1000;
  const last24h = data.filter(t => t.entry_timestamp > last24hMs);
  console.log('\n=== LAST 24H ===');
  console.log('Trades:', last24h.length);
  if (last24h.length > 0) {
    const last24hPnL = last24h.reduce((sum, t) => sum + (t.net_pnl || 0), 0);
    const last24hWins = last24h.filter(t => (t.net_pnl || 0) > 0).length;
    console.log('PnL: $' + last24hPnL.toFixed(2));
    console.log('Win Rate:', (last24hWins/last24h.length*100).toFixed(1) + '%');
  }

  } catch (error) {
    console.log('Error:', error);
  } finally {
    await pool.end();
  }
}

analyzeRecentTrades().catch(console.error);