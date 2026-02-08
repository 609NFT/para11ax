const dns = require('dns');
const { Pool } = require('pg');
const fs = require('fs');
dns.setDefaultResultOrder('ipv4first');

// Read .env file manually
const envContent = fs.readFileSync('.env', 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && !key.startsWith('#')) {
    envVars[key.trim()] = valueParts.join('=').trim();
  }
});

// Use direct PostgreSQL connection
const dbUrl = envVars.TRADES_DB_URL;
if (!dbUrl) {
  console.error('TRADES_DB_URL not found in .env file');
  process.exit(1);
}

const db = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 2
});

async function analyze() {
  console.log('=== PARALLAX DEEP ANALYSIS ===');
  console.log('Time:', new Date().toISOString());
  
  try {
    // Check open positions  
    console.log('\n=== OPEN POSITIONS ===');
    const openPositionsResult = await db.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE status = 'open' 
      ORDER BY created_at DESC
    `);
    const openTrades = openPositionsResult.rows;
    
    if (openTrades && openTrades.length > 0) {
      console.log('Open positions:', openTrades.length);
      openTrades.forEach(t => {
        const entryTime = new Date(parseInt(t.created_at));
        const ageMinutes = Math.floor((Date.now() - entryTime.getTime()) / 60000);
        console.log(`${t.buy_symbol} | Entry: ${t.entry_spread_pct?.toFixed(2)}% | Size: $${t.size_usd?.toFixed(0)} | Age: ${ageMinutes}m`);
      });
    } else {
      console.log('No open positions');
    }
    
    // Check last 24h of completed trades
    console.log('\n=== LAST 24H COMPLETED TRADES ===');
    const yesterdayMs = Date.now() - 24*60*60*1000;
    const recentTradesResult = await db.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE status = 'closed' AND created_at >= $1
      ORDER BY created_at DESC 
      LIMIT 20
    `, [yesterdayMs.toString()]);
    const recentTrades = recentTradesResult.rows;
    
    if (recentTrades && recentTrades.length > 0) {
      console.log('Recent completed trades:', recentTrades.length);
      let totalPnL = 0;
      let wins = 0;
      
      recentTrades.forEach(t => {
        const pnl = t.pnl_usd || 0;
        totalPnL += pnl;
        if (pnl > 0) wins++;
        const entryTime = new Date(parseInt(t.created_at));
        console.log(`${t.buy_symbol} | Entry: ${t.entry_spread_pct?.toFixed(2)}% | Exit: ${t.exit_reason} | PnL: $${pnl.toFixed(2)} | ${entryTime.toLocaleString()}`);
      });
      
      const winRate = (wins / recentTrades.length * 100).toFixed(1);
      console.log(`\nSummary: $${totalPnL.toFixed(2)} PnL, ${winRate}% WR`);
      
      // Analyze exit reasons
      const exitReasons = {};
      recentTrades.forEach(t => {
        const reason = t.exit_reason || 'unknown';
        exitReasons[reason] = (exitReasons[reason] || 0) + 1;
      });
      
      console.log('\nExit reasons breakdown:');
      Object.entries(exitReasons).forEach(([reason, count]) => {
        console.log(`  ${reason}: ${count} (${(count/recentTrades.length*100).toFixed(1)}%)`);
      });
    } else {
      console.log('No completed trades in last 24h');
    }
    
    // Check recent opportunities (last 2h)
    console.log('\n=== CURRENT MARKET STATE ===');
    const twoHoursAgoMs = Date.now() - 2*60*60*1000;
    const recentOpportunitiesResult = await db.query(`
      SELECT * FROM discount_history 
      WHERE timestamp >= $1
      ORDER BY timestamp DESC 
      LIMIT 100
    `, [twoHoursAgoMs.toString()]);
    const recentOpportunities = recentOpportunitiesResult.rows;
    
    if (recentOpportunities && recentOpportunities.length > 0) {
      // Find best spreads by symbol in last 2h
      const bestSpreads = {};
      recentOpportunities.forEach(opp => {
        const symbol = opp.symbol;
        const spread = Math.abs(opp.spread_pct || 0);
        if (!bestSpreads[symbol] || spread > bestSpreads[symbol]) {
          bestSpreads[symbol] = spread;
        }
      });
      
      console.log('Best spreads seen in last 2h:');
      Object.entries(bestSpreads)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .forEach(([symbol, spread]) => {
          console.log(`  ${symbol}: ${spread.toFixed(2)}%`);
        });
        
      // Check if we're seeing any spreads above current thresholds
      const highSpreads = Object.entries(bestSpreads).filter(([,spread]) => spread >= 4.0);
      console.log(`\nSpreads >= 4.0% in last 2h: ${highSpreads.length}`);
    }
    
  } catch (error) {
    console.error('Analysis error:', error.message);
  }
}

analyze().catch(console.error);