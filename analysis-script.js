require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.TRADES_DB_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function analyzeTrades() {
  try {
    console.log("Connected to Supabase PostgreSQL");

    // Get trades from last 6 hours (using Unix timestamp in milliseconds)
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    
    const tradesQuery = `
      SELECT * FROM mean_reversion_positions 
      WHERE entry_timestamp >= $1 
      ORDER BY entry_timestamp DESC
    `;
    
    const tradesResult = await pool.query(tradesQuery, [sixHoursAgo]);
    const recentTrades = tradesResult.rows;
    
    console.log(`\n=== TRADES ANALYSIS (Last 6 hours) ===`);
    console.log(`Total positions: ${recentTrades.length}`);
    
    if (recentTrades.length === 0) {
      console.log("No positions in the last 6 hours");
      
      // Check if there are any recent positions at all
      const todayQuery = `
        SELECT * FROM mean_reversion_positions 
        WHERE entry_timestamp >= $1 
        ORDER BY entry_timestamp DESC
        LIMIT 5
      `;
      
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const todayResult = await pool.query(todayQuery, [oneDayAgo]);
      
      if (todayResult.rows.length > 0) {
        console.log(`\n=== MOST RECENT POSITIONS (Last 24h) ===`);
        todayResult.rows.forEach(t => {
          const status = t.exit_timestamp ? 'CLOSED' : 'OPEN';
          const pnl = t.exit_timestamp ? `$${(parseFloat(t.pnl_usd) || 0).toFixed(2)}` : 'N/A';
          const timeAgo = Math.round((Date.now() - parseInt(t.entry_timestamp)) / (1000 * 60));
          console.log(`${t.buy_symbol} ${status} | Entry: ${(parseFloat(t.entry_spread_pct) || 0).toFixed(2)}% | ${timeAgo}min ago | PnL: ${pnl}`);
        });
      }
      return;
    }

    // Analyze entry spreads
    const entrySpreads = recentTrades.map(t => Math.abs(parseFloat(t.entry_spread_pct) || 0)).filter(s => s !== 0);
    const avgEntrySpread = entrySpreads.reduce((a, b) => a + b, 0) / entrySpreads.length;
    const minEntrySpread = Math.min(...entrySpreads);
    const maxEntrySpread = Math.max(...entrySpreads);
    
    console.log(`\nEntry Spreads:`);
    console.log(`  Average: ${avgEntrySpread.toFixed(2)}%`);
    console.log(`  Range: ${minEntrySpread.toFixed(2)}% to ${maxEntrySpread.toFixed(2)}%`);
    console.log(`  Below 4%: ${entrySpreads.filter(s => s < 4).length} trades`);
    
    // Analyze symbols
    const symbolCounts = {};
    recentTrades.forEach(t => {
      symbolCounts[t.buy_symbol] = (symbolCounts[t.buy_symbol] || 0) + 1;
    });
    console.log(`\nSymbol distribution:`, symbolCounts);
    
    // Analyze exit reasons for closed positions
    const closedTrades = recentTrades.filter(t => t.exit_timestamp);
    const exitReasons = {};
    closedTrades.forEach(t => {
      exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
    });
    
    console.log(`\nExit Reasons (${closedTrades.length} closed):`, exitReasons);
    
    // Check PnL
    const totalPnL = closedTrades.reduce((sum, t) => sum + (parseFloat(t.pnl_usd) || 0), 0);
    console.log(`\nNet PnL: $${totalPnL.toFixed(2)}`);
    
    // Analyze hold times for closed trades
    if (closedTrades.length > 0) {
      const holdTimes = closedTrades.map(t => {
        const entry = parseInt(t.entry_timestamp);
        const exit = parseInt(t.exit_timestamp);
        return (exit - entry) / (1000 * 60); // minutes
      });
      
      const avgHoldTime = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
      console.log(`\nHold Times:`);
      console.log(`  Average: ${avgHoldTime.toFixed(1)} minutes`);
      console.log(`  Range: ${Math.min(...holdTimes).toFixed(1)} to ${Math.max(...holdTimes).toFixed(1)} minutes`);
    }
    
    // Show recent trades details
    console.log(`\n=== RECENT POSITION DETAILS ===`);
    recentTrades.slice(0, 10).forEach(t => {
      const status = t.exit_timestamp ? 'CLOSED' : 'OPEN';
      const pnl = t.exit_timestamp ? `$${(parseFloat(t.pnl_usd) || 0).toFixed(2)}` : 'N/A';
      console.log(`${t.buy_symbol} ${status} | Entry: ${Math.abs(parseFloat(t.entry_spread_pct) || 0).toFixed(2)}% | Exit: ${t.exit_reason || 'N/A'} | PnL: ${pnl}`);
    });

    // Check for any positions that might be stuck
    const openTrades = recentTrades.filter(t => !t.exit_timestamp);
    if (openTrades.length > 0) {
      console.log(`\n=== OPEN POSITIONS (${openTrades.length}) ===`);
      openTrades.forEach(t => {
        const entryTime = parseInt(t.entry_timestamp);
        const minutesOpen = (Date.now() - entryTime) / (1000 * 60);
        console.log(`${t.buy_symbol}: Open ${minutesOpen.toFixed(0)}min | Entry: ${Math.abs(parseFloat(t.entry_spread_pct) || 0).toFixed(2)}%`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

analyzeTrades();