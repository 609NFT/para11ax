require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function getCurrentStatus() {
  try {
    // Check open positions
    const openResult = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE status = 'open'
      ORDER BY entry_timestamp DESC
    `);
    
    console.log('=== OPEN POSITIONS ===');
    if (openResult.rows.length === 0) {
      console.log('No open positions');
    } else {
      console.log('Symbol | Entry% | Age | Size | PnL');
      console.log('-------|--------|-----|------|----');
      openResult.rows.forEach(pos => {
        const entryPct = parseFloat(pos.entry_spread_pct || 0).toFixed(2);
        const ageMin = Math.round((Date.now() - pos.entry_timestamp) / 1000 / 60);
        const size = parseFloat(pos.size_usd || 0).toFixed(0);
        const pnl = parseFloat(pos.pnl_usd || 0).toFixed(2);
        console.log(`${pos.buy_symbol.padEnd(6)} | ${entryPct.padStart(6)}% | ${ageMin.toString().padStart(3)}m | $${size.padStart(3)} | $${pnl.padStart(5)}`);
      });
    }
    
    // Check recent positions (last 24 hours)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    const recentResult = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 
      ORDER BY entry_timestamp DESC
      LIMIT 20
    `, [oneDayAgo]);
    
    console.log('\n=== RECENT POSITIONS (24h) ===');
    if (recentResult.rows.length === 0) {
      console.log('No positions in last 24 hours');
    } else {
      console.log(`Found ${recentResult.rows.length} positions in last 24 hours:`);
      console.log('Symbol | Status | Entry% | Exit Reason | Hold | PnL | Entry Time');
      console.log('-------|--------|---------|-------------|------|-----|----------');
      
      recentResult.rows.forEach(pos => {
        const entryPct = parseFloat(pos.entry_spread_pct || 0).toFixed(2);
        const exitReason = (pos.exit_reason || 'open').substring(0, 11);
        const holdTimeMin = pos.exit_timestamp ? 
          Math.round((pos.exit_timestamp - pos.entry_timestamp) / 1000 / 60) : 
          Math.round((Date.now() - pos.entry_timestamp) / 1000 / 60);
        const pnl = parseFloat(pos.pnl_usd || 0).toFixed(2);
        const status = pos.status;
        const entryTime = new Date(pos.entry_timestamp).toLocaleTimeString('en-US', { 
          hour12: false, 
          timeZone: 'UTC',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        console.log(`${pos.buy_symbol.padEnd(6)} | ${status.padEnd(6)} | ${entryPct.padStart(6)}% | ${exitReason.padEnd(11)} | ${holdTimeMin.toString().padStart(3)}m | $${pnl.padStart(4)} | ${entryTime}`);
      });
      
      // Summary stats
      const totalPnl = recentResult.rows.reduce((sum, pos) => sum + parseFloat(pos.pnl_usd || 0), 0);
      const profitableTrades = recentResult.rows.filter(pos => parseFloat(pos.pnl_usd || 0) > 0).length;
      const winRate = ((profitableTrades / recentResult.rows.length) * 100).toFixed(1);
      
      console.log(`\nSummary: ${recentResult.rows.length} trades, ${winRate}% win rate, $${totalPnl.toFixed(2)} PnL`);
    }
    
    // Check current spreads
    const spreadsResult = await pool.query(`
      SELECT DISTINCT ON (token_a_symbol) 
        token_a_symbol, token_a_discount_vs_stock, timestamp
      FROM discount_history 
      WHERE timestamp >= $1
      ORDER BY token_a_symbol, timestamp DESC
    `, [Date.now() - 60 * 60 * 1000]); // Last hour
    
    console.log('\n=== CURRENT SPREADS (Last Hour) ===');
    if (spreadsResult.rows.length > 0) {
      const sortedSpreads = spreadsResult.rows
        .filter(s => s.token_a_discount_vs_stock !== null)
        .sort((a, b) => Math.abs(b.token_a_discount_vs_stock) - Math.abs(a.token_a_discount_vs_stock))
        .slice(0, 20);
        
      console.log('Symbol | Spread% | Last Update');
      console.log('-------|---------|------------');
      sortedSpreads.forEach(s => {
        const spread = parseFloat(s.token_a_discount_vs_stock).toFixed(2);
        const timeAgo = Math.round((Date.now() - s.timestamp) / 1000 / 60);
        console.log(`${s.token_a_symbol.padEnd(6)} | ${spread.padStart(6)}% | ${timeAgo}min ago`);
      });
    } else {
      console.log('No recent spread data');
    }
    
    // Check for any positions approaching max hold
    if (openResult.rows.length > 0) {
      console.log('\n=== POSITION ALERTS ===');
      openResult.rows.forEach(pos => {
        const ageMin = Math.round((Date.now() - pos.entry_timestamp) / 1000 / 60);
        if (ageMin >= 50) {
          console.log(`⚠️  ${pos.buy_symbol}: ${ageMin}min old (approaching 60min max hold)`);
        }
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

getCurrentStatus();