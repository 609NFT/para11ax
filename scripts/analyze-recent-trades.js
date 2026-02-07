#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function analyzeRecentTrades() {
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
    
    console.log('🔍 DEEP ANALYSIS: Last 6 Hours');
    console.log('Since:', new Date(sixHoursAgo).toISOString());
    console.log('Current time:', new Date().toISOString());
    
    try {
        // Query recent trades
        const tradesQuery = `
            SELECT 
                id, stock_ticker, buy_symbol, entry_spread_pct, exit_reason, 
                pnl_usd, pnl_pct, 
                to_timestamp(entry_timestamp / 1000) as entry_time,
                to_timestamp(exit_timestamp / 1000) as exit_time,
                size_usd, buy_amount,
                (exit_timestamp - entry_timestamp) as duration_ms,
                status
            FROM mean_reversion_positions 
            WHERE entry_timestamp >= $1
            ORDER BY entry_timestamp DESC
        `;
        
        const result = await pool.query(tradesQuery, [sixHoursAgo]);
        const trades = result.rows;

        console.log(`\n📊 Found ${trades.length} trades in last 6 hours`);
        
        if (trades.length === 0) {
            console.log('❌ No trades in the last 6 hours');
            console.log('ℹ️  This could indicate:');
            console.log('   - All spreads below 4.0% threshold (normal with quality-first strategy)');
            console.log('   - Bot stuck (check logs for "Trading loop already running")');
            console.log('   - Market conditions not favorable');
            return;
        }

        // Group by symbol
        const bySymbol = {};
        let totalPnL = 0;
        let openTrades = 0;
        let closedTrades = 0;

        trades.forEach(trade => {
            if (!bySymbol[trade.stock_ticker]) {
                bySymbol[trade.stock_ticker] = { trades: [], pnl: 0 };
            }
            bySymbol[trade.stock_ticker].trades.push(trade);
            
            if (trade.status === 'closed') {
                closedTrades++;
                const pnl = parseFloat(trade.pnl_usd) || 0;
                totalPnL += pnl;
                bySymbol[trade.stock_ticker].pnl += pnl;
            } else {
                openTrades++;
            }
        });

        // Analyze by symbol
        console.log('\n📈 Performance by Symbol:');
        Object.entries(bySymbol).forEach(([symbol, data]) => {
            const closed = data.trades.filter(t => t.status === 'closed');
            const wins = closed.filter(t => (parseFloat(t.pnl_usd) || 0) > 0);
            const winRate = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 'N/A';
            
            console.log(`${symbol}: ${data.trades.length} trades, ${closed.length} closed, ${winRate}% WR, PnL: $${data.pnl.toFixed(2)}`);
        });

        // Analyze entry thresholds
        console.log('\n🎯 Entry Analysis:');
        const entryDiscounts = trades.map(t => parseFloat(t.entry_spread_pct)).filter(Boolean);
        if (entryDiscounts.length > 0) {
            const avgEntry = (entryDiscounts.reduce((a, b) => a + b, 0) / entryDiscounts.length).toFixed(2);
            const minEntry = Math.min(...entryDiscounts).toFixed(2);
            const maxEntry = Math.max(...entryDiscounts).toFixed(2);
            console.log(`Entry spreads: ${minEntry}% - ${maxEntry}%, avg: ${avgEntry}%`);
            
            const above4pct = entryDiscounts.filter(d => d >= 4.0).length;
            console.log(`Entries ≥4.0%: ${above4pct}/${entryDiscounts.length} (${(above4pct/entryDiscounts.length*100).toFixed(1)}%)`);
            
            // Check volatility adjustment working
            const above3_4pct = entryDiscounts.filter(d => d >= 3.4).length;
            console.log(`Entries ≥3.4% (vol-adjusted floor): ${above3_4pct}/${entryDiscounts.length}`);
        }

        // Analyze exit reasons
        console.log('\n🚪 Exit Analysis:');
        const closedWithReasons = trades.filter(t => t.status === 'closed' && t.exit_reason);
        const exitReasons = {};
        closedWithReasons.forEach(t => {
            const reason = t.exit_reason;
            if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
            exitReasons[reason].count++;
            exitReasons[reason].pnl += parseFloat(t.pnl_usd) || 0;
        });

        Object.entries(exitReasons).forEach(([reason, data]) => {
            console.log(`${reason}: ${data.count} trades, PnL: $${data.pnl.toFixed(2)}`);
        });

        // Check if hitting 60min max hold vs 2.5% profit target
        const maxHoldExits = closedWithReasons.filter(t => t.exit_reason === 'max_hold').length;
        const profitTargetExits = closedWithReasons.filter(t => t.exit_reason === 'profit_target').length;
        console.log(`\n⏱️  Exit Timing: ${profitTargetExits} profit targets vs ${maxHoldExits} max holds`);

        // Duration analysis
        const durations = trades
            .filter(t => t.status === 'closed' && t.duration_ms)
            .map(t => parseInt(t.duration_ms));
        
        if (durations.length > 0) {
            const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
            const maxDuration = Math.max(...durations);
            console.log(`⌛ Avg duration: ${(avgDuration / 60000).toFixed(1)}min, Max: ${(maxDuration / 60000).toFixed(1)}min`);
        }

        console.log(`\n💰 Summary:`);
        console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
        console.log(`Open: ${openTrades}, Closed: ${closedTrades}`);
        
        const wins = trades.filter(t => t.status === 'closed' && (parseFloat(t.pnl_usd) || 0) > 0).length;
        console.log(`Overall WR: ${closedTrades > 0 ? ((wins / closedTrades * 100).toFixed(1)) : 'N/A'}%`);

    } catch (error) {
        console.error('❌ Error analyzing trades:', error.message);
    } finally {
        await pool.end();
    }
}

analyzeRecentTrades();