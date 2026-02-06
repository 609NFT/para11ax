require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function checkPositions() {
  try {
    // Check position table structure
    const columnsResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'mean_reversion_positions'
      ORDER BY ordinal_position
    `);
    
    console.log('mean_reversion_positions columns:');
    columnsResult.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    });
    
    // Get recent positions from last 6 hours
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    
    const positionsResult = await pool.query(`
      SELECT * FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 
      ORDER BY entry_timestamp DESC
      LIMIT 20
    `, [sixHoursAgo]);
    
    console.log(`\nFound ${positionsResult.rows.length} positions in last 6 hours:`);
    
    if (positionsResult.rows.length > 0) {
      console.log('\nRecent positions:');
      console.log('Symbol | Status | Entry% | Exit Reason | Hold Time | PnL');
      console.log('-------|--------|---------|-------------|-----------|----');
      
      positionsResult.rows.forEach(pos => {
        const entryPct = parseFloat(pos.entry_spread_pct || 0).toFixed(2);
        const exitReason = pos.exit_reason || 'open';
        const holdTimeMin = pos.exit_timestamp ? 
          Math.round((pos.exit_timestamp - pos.entry_timestamp) / 1000 / 60) : 
          Math.round((Date.now() - pos.entry_timestamp) / 1000 / 60);
        const pnl = parseFloat(pos.pnl_usd || 0).toFixed(2);
        const status = pos.status;
        
        console.log(`${pos.buy_symbol.padEnd(6)} | ${status.padEnd(6)} | ${entryPct.padStart(6)}% | ${exitReason.padEnd(11)} | ${holdTimeMin.toString().padStart(8)}m | $${pnl.padStart(5)}`);
      });
    } else {
      // Check current spreads
      const spreadsResult = await pool.query(`
        SELECT * FROM discount_history 
        WHERE timestamp >= $1 
        ORDER BY timestamp DESC 
        LIMIT 20
      `, [sixHoursAgo]);
      
      if (spreadsResult.rows.length > 0) {
        console.log('\nRecent spreads (max discount per symbol):');
        const symbolSpreads = {};
        spreadsResult.rows.forEach(s => {
          if (!symbolSpreads[s.token_a_symbol] || Math.abs(s.token_a_discount_vs_stock) > Math.abs(symbolSpreads[s.token_a_symbol].token_a_discount_vs_stock)) {
            symbolSpreads[s.token_a_symbol] = s;
          }
        });
        
        Object.values(symbolSpreads).forEach(s => {
          const discount = parseFloat(s.token_a_discount_vs_stock || 0).toFixed(2);
          const timestamp = new Date(s.timestamp).toLocaleTimeString();
          console.log(`${s.token_a_symbol}: ${discount}% (${timestamp})`);
        });
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkPositions();