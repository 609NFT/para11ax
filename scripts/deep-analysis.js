const { Pool } = require('pg');
const dns = require('dns');
const fs = require('fs');

// Fix IPv6 DNS issues with Supabase
dns.setDefaultResultOrder('ipv4first');

// Read database URL from environment
const fs = require('fs');
const envContent = fs.readFileSync('.env', 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && !key.startsWith('#')) {
    envVars[key.trim()] = valueParts.join('=').trim();
  }
});

const TRADES_DB_URL = envVars.TRADES_DB_URL;
if (!TRADES_DB_URL) {
  console.error('TRADES_DB_URL not found in .env file');
  process.exit(1);
}

const pool = new Pool({
  connectionString: TRADES_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyzeRecentTrades() {
  try {
    console.log('🔍 PARALLAX DEEP ANALYSIS');
    console.log('='.repeat(50));
    
    // First, let's check what tables exist
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    
    const tablesResult = await pool.query(tablesQuery);
    console.log('Available tables:', tablesResult.rows.map(r => r.table_name));
    
    // Check schema of mean_reversion_positions
    const schemaQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'mean_reversion_positions'
    `;
    
    const schemaResult = await pool.query(schemaQuery);
    console.log('\nmean_reversion_positions schema:');
    schemaResult.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
    
    // Get recent positions (last 7 days) - timestamps are bigint (milliseconds since epoch)
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const tradesQuery = `
      SELECT 
        id, buy_symbol as symbol, entry_spread_pct, exit_spread_pct, pnl_usd, 
        exit_reason, entry_timestamp, exit_timestamp,
        (exit_timestamp - entry_timestamp) / (1000 * 60) as hold_minutes
      FROM mean_reversion_positions 
      WHERE exit_timestamp IS NOT NULL 
        AND entry_timestamp > ${sevenDaysAgo}
      ORDER BY entry_timestamp DESC
      LIMIT 50
    `;
    
    const tradesResult = await pool.query(tradesQuery);
    const trades = tradesResult.rows;
    
    console.log(`\n📊 RECENT TRADES ANALYSIS (Last 7 days): ${trades.length} trades`);
    
    if (trades.length === 0) {
      console.log('❌ No recent trades found in last 7 days');
      return;
    }
    
    // Basic stats
    const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
    const winningTrades = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0);
    const losingTrades = trades.filter(t => parseFloat(t.pnl_usd || 0) < 0);
    const winRate = (winningTrades.length / trades.length * 100).toFixed(1);
    
    console.log(`💰 Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`✅ Win Rate: ${winRate}% (${winningTrades.length}/${trades.length})`);
    console.log(`📈 Avg Win: $${winningTrades.length > 0 ? (winningTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd), 0) / winningTrades.length).toFixed(2) : '0'}`);
    console.log(`📉 Avg Loss: $${losingTrades.length > 0 ? (losingTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd), 0) / losingTrades.length).toFixed(2) : '0'}`);
    
    // Exit reason analysis
    console.log(`\n🚪 EXIT REASONS:`);
    const exitReasons = {};
    trades.forEach(t => {
      const reason = t.exit_reason || 'unknown';
      exitReasons[reason] = (exitReasons[reason] || 0) + 1;
    });
    
    Object.entries(exitReasons)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, count]) => {
        const reasonTrades = trades.filter(t => t.exit_reason === reason);
        const reasonPnL = reasonTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const reasonWinRate = (reasonTrades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / reasonTrades.length * 100).toFixed(1);
        console.log(`  ${reason}: ${count} trades, ${reasonWinRate}% WR, $${reasonPnL.toFixed(2)} PnL`);
      });
    
    // Symbol performance
    console.log(`\n🏷️  SYMBOL PERFORMANCE:`);
    const symbolStats = {};
    trades.forEach(t => {
      const symbol = t.symbol;
      if (!symbolStats[symbol]) {
        symbolStats[symbol] = { trades: [], pnl: 0, wins: 0 };
      }
      symbolStats[symbol].trades.push(t);
      symbolStats[symbol].pnl += parseFloat(t.pnl_usd || 0);
      if (parseFloat(t.pnl_usd || 0) > 0) symbolStats[symbol].wins++;
    });
    
    Object.entries(symbolStats)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .forEach(([symbol, stats]) => {
        const winRate = (stats.wins / stats.trades.length * 100).toFixed(1);
        const avgSpread = stats.trades.reduce((sum, t) => sum + parseFloat(t.entry_spread_pct || 0), 0) / stats.trades.length;
        console.log(`  ${symbol}: ${stats.trades.length} trades, ${winRate}% WR, $${stats.pnl.toFixed(2)} PnL, ${avgSpread.toFixed(2)}% avg entry`);
      });
    
    // Threshold effectiveness
    console.log(`\n🎯 THRESHOLD EFFECTIVENESS:`);
    const spreadRanges = [
      { min: 0, max: 3, label: '0-3%' },
      { min: 3, max: 4, label: '3-4%' },
      { min: 4, max: 5, label: '4-5%' },
      { min: 5, max: 6, label: '5-6%' },
      { min: 6, max: 100, label: '6%+' }
    ];
    
    spreadRanges.forEach(range => {
      const rangeTrades = trades.filter(t => {
        const spread = Math.abs(parseFloat(t.entry_spread_pct || 0));
        return spread >= range.min && spread < range.max;
      });
      
      if (rangeTrades.length > 0) {
        const rangeWinRate = (rangeTrades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / rangeTrades.length * 100).toFixed(1);
        const rangePnL = rangeTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const avgHold = rangeTrades.reduce((sum, t) => sum + parseFloat(t.hold_minutes || 0), 0) / rangeTrades.length;
        console.log(`  ${range.label}: ${rangeTrades.length} trades, ${rangeWinRate}% WR, $${rangePnL.toFixed(2)} PnL, ${avgHold.toFixed(1)}min avg hold`);
      }
    });
    
    // Hold time analysis
    console.log(`\n⏱️  HOLD TIME ANALYSIS:`);
    const holdRanges = [
      { min: 0, max: 15, label: '0-15min' },
      { min: 15, max: 30, label: '15-30min' },
      { min: 30, max: 60, label: '30-60min' },
      { min: 60, max: 120, label: '1-2hr' },
      { min: 120, max: 10000, label: '2hr+' }
    ];
    
    const tradesWithHoldTime = trades.filter(t => t.hold_minutes !== null && !isNaN(parseFloat(t.hold_minutes)));
    
    holdRanges.forEach(range => {
      const rangeTrades = tradesWithHoldTime.filter(t => {
        const holdTime = parseFloat(t.hold_minutes);
        return holdTime >= range.min && holdTime < range.max;
      });
      
      if (rangeTrades.length > 0) {
        const rangeWinRate = (rangeTrades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / rangeTrades.length * 100).toFixed(1);
        const rangePnL = rangeTrades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        console.log(`  ${range.label}: ${rangeTrades.length} trades, ${rangeWinRate}% WR, $${rangePnL.toFixed(2)} PnL`);
      }
    });
    
    // Recent concerning patterns
    console.log(`\n⚠️  CONCERNING PATTERNS:`);
    
    // Check for consecutive losses
    let maxConsecutiveLosses = 0;
    let currentStreak = 0;
    trades.reverse().forEach(t => {
      if (parseFloat(t.pnl_usd || 0) < 0) {
        currentStreak++;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak);
      } else {
        currentStreak = 0;
      }
    });
    trades.reverse(); // restore order
    
    if (maxConsecutiveLosses >= 5) {
      console.log(`  🔴 Max consecutive losses: ${maxConsecutiveLosses}`);
    }
    
    // Check for quick exits (might indicate poor entries)
    const quickExits = tradesWithHoldTime.filter(t => parseFloat(t.hold_minutes) < 10);
    if (quickExits.length > trades.length * 0.2) {
      console.log(`  🔴 ${quickExits.length}/${trades.length} trades exited in <10 minutes (possibly poor entries)`);
    }
    
    // Check for frequent max hold exits
    const maxHoldExits = trades.filter(t => t.exit_reason === 'max_hold_time');
    if (maxHoldExits.length > trades.length * 0.4) {
      console.log(`  🔴 ${maxHoldExits.length}/${trades.length} trades hit max hold time (may need adjustment)`);
    }
    
    // Check recent position data
    const positionsQuery = `
      SELECT buy_symbol as symbol, size_usd, entry_spread_pct
      FROM mean_reversion_positions 
      WHERE exit_timestamp IS NULL
      ORDER BY entry_timestamp DESC
    `;
    
    const positionsResult = await pool.query(positionsQuery);
    const positions = positionsResult.rows;
    
    if (positions.length > 0) {
      console.log(`\n📍 CURRENT POSITIONS: ${positions.length}`);
      positions.forEach(p => {
        const symbol = p.symbol;
        const size = parseFloat(p.size_usd || 0);
        const entrySpread = parseFloat(p.entry_spread_pct || 0);
        console.log(`  ${symbol}: $${size.toFixed(0)} position, ${entrySpread.toFixed(2)}% entry spread`);
      });
    } else {
      console.log(`\n📍 CURRENT POSITIONS: None`);
    }
    
    console.log(`\n✅ Analysis complete`);
    
  } catch (error) {
    console.error('Analysis failed:', error.message);
  } finally {
    await pool.end();
  }
}

analyzeRecentTrades();