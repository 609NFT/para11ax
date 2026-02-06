const { Pool } = require('pg');

// Read the .env file to get TRADES_DB_URL
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

(async () => {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000); // Unix timestamp 7 days ago
  
  const result = await db.query(`
    SELECT * FROM mean_reversion_positions 
    WHERE entry_timestamp >= $1 
    ORDER BY entry_timestamp DESC
  `, [sevenDaysAgo]);
  
  const data = result.rows;
  
  console.log('=== Last 7 Days Trade Analysis ===');
  console.log('Total trades:', data.length);
  
  // Analyze by token
  const byToken = {};
  data.forEach(t => {
    if (!byToken[t.buy_symbol]) byToken[t.buy_symbol] = [];
    byToken[t.buy_symbol].push(t);
  });
  
  console.log('\n=== By Token Performance ===');
  Object.entries(byToken).forEach(([token, trades]) => {
    const wins = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const avgEntry = trades.reduce((sum, t) => sum + Math.abs(parseFloat(t.entry_spread_pct || 0)), 0) / trades.length;
    const winRate = (100 * wins / trades.length).toFixed(1);
    console.log(token + ': ' + trades.length + ' trades, ' + wins + '/' + trades.length + ' wins (' + winRate + '%), $' + totalPnl.toFixed(2) + ' PnL, avg entry ' + avgEntry.toFixed(2) + '%');
  });
  
  // Time patterns
  const byHour = {};
  data.forEach(t => {
    const hour = new Date(t.entry_timestamp).getUTCHours();
    if (!byHour[hour]) byHour[hour] = [];
    byHour[hour].push(t);
  });
  
  console.log('\n=== By Hour (UTC) Performance ===');
  Object.entries(byHour).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([hour, trades]) => {
    if (trades.length < 3) return; // Skip low-volume hours
    const wins = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const winRate = (100 * wins / trades.length).toFixed(1);
    console.log(hour + ':00 UTC: ' + trades.length + ' trades, ' + wins + '/' + trades.length + ' wins (' + winRate + '%), $' + totalPnl.toFixed(2) + ' PnL');
  });
  
  // Spread size analysis
  const bySpread = { '0-2%': [], '2-4%': [], '4-6%': [], '6%+': [] };
  data.forEach(t => {
    const spread = Math.abs(parseFloat(t.entry_spread_pct || 0));
    if (spread < 2) bySpread['0-2%'].push(t);
    else if (spread < 4) bySpread['2-4%'].push(t);
    else if (spread < 6) bySpread['4-6%'].push(t);
    else bySpread['6%+'].push(t);
  });
  
  console.log('\n=== By Entry Spread Performance ===');
  Object.entries(bySpread).forEach(([range, trades]) => {
    if (trades.length === 0) return;
    const wins = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const winRate = (100 * wins / trades.length).toFixed(1);
    console.log(range + ': ' + trades.length + ' trades, ' + wins + '/' + trades.length + ' wins (' + winRate + '%), $' + totalPnl.toFixed(2) + ' PnL');
  });
  
  // Exit reason analysis
  const exitReasons = {};
  data.forEach(t => {
    const reason = t.exit_reason || 'unknown';
    if (!exitReasons[reason]) exitReasons[reason] = [];
    exitReasons[reason].push(t);
  });
  
  console.log('\n=== By Exit Reason ===');
  Object.entries(exitReasons).forEach(([reason, trades]) => {
    if (trades.length === 0) return;
    const wins = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const winRate = (100 * wins / trades.length).toFixed(1);
    console.log(reason + ': ' + trades.length + ' trades, ' + wins + '/' + trades.length + ' wins (' + winRate + '%), $' + totalPnl.toFixed(2) + ' PnL');
  });
  
  process.exit(0);
})().catch(console.error);