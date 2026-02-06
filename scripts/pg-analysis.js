const { Client } = require('pg');
const fs = require('fs');
const dns = require('dns');

// Force IPv4
dns.setDefaultResultOrder('ipv4first');

// PostgreSQL connection
const secrets = JSON.parse(fs.readFileSync(process.env.HOME + '/.parallax-secrets/supabase-db.json'));
const client = new Client({
  connectionString: secrets.connectionString,
  ssl: { rejectUnauthorized: false }
});

async function analyze() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL');
    
    const sixHoursAgo = new Date(Date.now() - 6*60*60*1000).toISOString();
    
    // Get recent trades
    const tradesQuery = `
      SELECT symbol, entry_spread_pct, exit_spread_pct, pnl_usd, exit_reason, 
             entry_timestamp, exit_timestamp
      FROM trades 
      WHERE timestamp >= $1 
      ORDER BY timestamp DESC;
    `;
    
    const tradesResult = await client.query(tradesQuery, [sixHoursAgo]);
    const trades = tradesResult.rows;
    
    console.log('=== RECENT TRADES (Last 6 Hours) ===');
    console.log(`Found ${trades.length} trades`);
    
    if (trades.length > 0) {
      let totalPnl = 0;
      let entryThresholds = [];
      let exitReasons = {};
      let holdTimes = [];
      
      trades.forEach(trade => {
        totalPnl += parseFloat(trade.pnl_usd || 0);
        entryThresholds.push(parseFloat(trade.entry_spread_pct || 0));
        const exitReason = trade.exit_reason || 'unknown';
        exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;
        
        if (trade.exit_timestamp) {
          const holdMinutes = Math.round((new Date(trade.exit_timestamp) - new Date(trade.entry_timestamp))/60000);
          holdTimes.push(holdMinutes);
          console.log(`${trade.symbol}: Entry ${trade.entry_spread_pct}%, Exit ${trade.exit_spread_pct}%, PnL $${trade.pnl_usd}, Reason: ${trade.exit_reason}, Hold: ${holdMinutes}min`);
        }
      });
      
      console.log(`\nTotal PnL: $${totalPnl.toFixed(2)}`);
      console.log(`Entry thresholds: ${entryThresholds.map(x => x.toFixed(1)).join('%, ')}%`);
      console.log('Exit reasons:', exitReasons);
      
      if (holdTimes.length > 0) {
        const avgHold = holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length;
        console.log(`Hold times: avg ${avgHold.toFixed(1)}min, range ${Math.min(...holdTimes)}-${Math.max(...holdTimes)}min`);
      }
      
      // Check if entries are meeting 4%+ threshold
      const belowThreshold = entryThresholds.filter(x => x < 4.0);
      if (belowThreshold.length > 0) {
        console.log(`⚠️  ${belowThreshold.length}/${trades.length} trades entered below 4% threshold`);
      }
    }
    
    // Check current spreads
    console.log('\n=== CURRENT SPREAD LEVELS ===');
    const spreadsQuery = `
      SELECT DISTINCT ON (symbol) symbol, spread_pct, timestamp
      FROM discount_history 
      WHERE timestamp >= $1
      ORDER BY symbol, timestamp DESC;
    `;
    
    const spreadsResult = await client.query(spreadsQuery, [new Date(Date.now() - 30*60*1000).toISOString()]);
    const spreads = spreadsResult.rows;
    
    if (spreads.length > 0) {
      console.log('Latest spreads:');
      spreads.forEach(s => {
        const signal = Math.abs(s.spread_pct) >= 4.0 ? '🟢' : '⚪';
        console.log(`${signal} ${s.symbol}: ${parseFloat(s.spread_pct).toFixed(2)}%`);
      });
    }
    
    // Check active positions
    console.log('\n=== ACTIVE POSITIONS ===');
    const positionsQuery = `
      SELECT symbol, side, size_usd, entry_price, entry_spread_pct, entry_timestamp
      FROM positions 
      WHERE status = 'open'
      ORDER BY entry_timestamp DESC;
    `;
    
    const positionsResult = await client.query(positionsQuery);
    const positions = positionsResult.rows;
    
    if (positions.length > 0) {
      positions.forEach(pos => {
        const age = Math.round((Date.now() - new Date(pos.entry_timestamp).getTime())/60000);
        console.log(`${pos.symbol} ${pos.side}: $${pos.size_usd} at ${pos.entry_spread_pct}%, held ${age}min`);
      });
    } else {
      console.log('No active positions');
    }
    
  } catch (err) {
    console.error('Analysis error:', err);
  } finally {
    await client.end();
  }
}

analyze();