require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeRecentTrades() {
  const QUERY_START = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago in ms
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE status = 'closed' AND exit_timestamp > $1 
      ORDER BY exit_timestamp DESC
    `, [QUERY_START]);

    const trades = result.rows;

  console.log('=== RECENT 7-DAY TRADE ANALYSIS ===');
  console.log(`Total trades: ${trades.length}`);

  if (trades.length === 0) {
    console.log('No trades found in the last 7 days');
    return;
  }

  // Performance stats
  const profitable = trades.filter(t => t.pnl_usd > 0).length;
  const totalPnL = trades.reduce((sum, t) => sum + (t.pnl_usd || 0), 0);
  const avgSize = trades.reduce((sum, t) => sum + (t.size_usd || 0), 0) / trades.length;

  console.log(`Win rate: ${profitable}/${trades.length} = ${(profitable/trades.length*100).toFixed(1)}%`);
  console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
  console.log(`Avg size: $${avgSize.toFixed(2)}`);

  // By token analysis
  const byToken = {};
  trades.forEach(t => {
    const token = t.buy_symbol || 'unknown';
    if (!byToken[token]) {
      byToken[token] = { count: 0, pnl: 0, wins: 0, totalVolume: 0 };
    }
    byToken[token].count++;
    byToken[token].pnl += t.pnl_usd || 0;
    byToken[token].totalVolume += t.size_usd || 0;
    if (t.pnl_usd > 0) byToken[token].wins++;
  });

  console.log('\n=== BY TOKEN (Top 10 by volume) ===');
  Object.entries(byToken)
    .sort(([,a], [,b]) => b.totalVolume - a.totalVolume)
    .slice(0, 10)
    .forEach(([token, stats]) => {
      const wr = stats.count > 0 ? (stats.wins / stats.count * 100).toFixed(0) : '0';
      console.log(`${token}: ${stats.count} trades, ${wr}% WR, $${stats.pnl.toFixed(2)} PnL, $${stats.totalVolume.toFixed(0)} vol`);
    });

  // By exit reason
  const byReason = {};
  trades.forEach(t => {
    const reason = t.exit_reason || 'unknown';
    if (!byReason[reason]) {
      byReason[reason] = { count: 0, pnl: 0, wins: 0 };
    }
    byReason[reason].count++;
    byReason[reason].pnl += t.pnl_usd || 0;
    if (t.pnl_usd > 0) byReason[reason].wins++;
  });

  console.log('\n=== BY EXIT REASON ===');
  Object.entries(byReason)
    .sort(([,a], [,b]) => b.count - a.count)
    .forEach(([reason, stats]) => {
      const wr = stats.count > 0 ? (stats.wins / stats.count * 100).toFixed(0) : '0';
      console.log(`${reason}: ${stats.count} trades, ${wr}% WR, $${stats.pnl.toFixed(2)} PnL`);
    });

  // Entry spread analysis
  const spreadBuckets = {
    '0-3%': { min: 0, max: 3, trades: [] },
    '3-4%': { min: 3, max: 4, trades: [] },
    '4-5%': { min: 4, max: 5, trades: [] },
    '5-7%': { min: 5, max: 7, trades: [] },
    '7%+': { min: 7, max: 100, trades: [] }
  };

  trades.forEach(t => {
    const entrySpread = Math.abs(t.entry_spread_pct || 0);
    for (const [bucket, config] of Object.entries(spreadBuckets)) {
      if (entrySpread >= config.min && entrySpread < config.max) {
        config.trades.push(t);
        break;
      }
    }
  });

  console.log('\n=== BY ENTRY SPREAD ===');
  Object.entries(spreadBuckets).forEach(([bucket, config]) => {
    if (config.trades.length > 0) {
      const wins = config.trades.filter(t => t.pnl_usd > 0).length;
      const pnl = config.trades.reduce((sum, t) => sum + (t.pnl_usd || 0), 0);
      const wr = (wins / config.trades.length * 100).toFixed(0);
      console.log(`${bucket}: ${config.trades.length} trades, ${wr}% WR, $${pnl.toFixed(2)} PnL`);
    }
  });

  // Time patterns
  console.log('\n=== TRADING HOURS (UTC) ===');
  const hourCounts = {};
  const hourPnL = {};
  trades.forEach(t => {
    const hour = new Date(t.entry_timestamp).getUTCHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    hourPnL[hour] = (hourPnL[hour] || 0) + (t.pnl_usd || 0);
  });

  Object.entries(hourCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 8)
    .forEach(([hour, count]) => {
      const pnl = hourPnL[hour] || 0;
      console.log(`${hour}:00 UTC: ${count} trades, $${pnl.toFixed(2)} PnL`);
    });

  // Hold time analysis
  console.log('\n=== HOLD TIME ANALYSIS ===');
  const holdTimeBuckets = {
    '<5min': { max: 5, trades: [] },
    '5-15min': { min: 5, max: 15, trades: [] },
    '15-30min': { min: 15, max: 30, trades: [] },
    '30-60min': { min: 30, max: 60, trades: [] },
    '>60min': { min: 60, trades: [] }
  };

  trades.forEach(t => {
    if (t.exit_timestamp && t.entry_timestamp) {
      const holdMin = (t.exit_timestamp - t.entry_timestamp) / 60000;
      for (const [bucket, config] of Object.entries(holdTimeBuckets)) {
        const inRange = config.min ? holdMin >= config.min : true;
        const belowMax = config.max ? holdMin < config.max : true;
        if (inRange && belowMax) {
          config.trades.push(t);
          break;
        }
      }
    }
  });

  Object.entries(holdTimeBuckets).forEach(([bucket, config]) => {
    if (config.trades.length > 0) {
      const wins = config.trades.filter(t => t.pnl_usd > 0).length;
      const pnl = config.trades.reduce((sum, t) => sum + (t.pnl_usd || 0), 0);
      const wr = (wins / config.trades.length * 100).toFixed(0);
      console.log(`${bucket}: ${config.trades.length} trades, ${wr}% WR, $${pnl.toFixed(2)} PnL`);
    }
  });

  } finally {
    client.release();
    await pool.end();
  }
}

analyzeRecentTrades().catch(console.error);