const { Client } = require('pg');
const fs = require('fs');

// Force IPv4 for Supabase connection (required)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

async function analyzeRecentTrades() {
    const credentials = JSON.parse(fs.readFileSync('/home/ec2-user/.parallax-secrets/supabase-db.json', 'utf8'));
    
    const client = new Client(credentials);
    await client.connect();
    
    console.log('=== RECENT TRADE ANALYSIS (Last 7 Days) ===\n');
    
    // 1. Most profitable tokens
    const profitableTokens = await client.query(`
        SELECT 
            buy_symbol,
            COUNT(*) as trades,
            AVG(entry_spread_pct) as avg_entry_spread,
            AVG(exit_spread_pct) as avg_exit_spread,
            AVG(pnl_usd) as avg_pnl,
            SUM(pnl_usd) as total_pnl,
            COUNT(*) FILTER (WHERE pnl_usd > 0) as wins,
            ROUND(COUNT(*) FILTER (WHERE pnl_usd > 0) * 100.0 / COUNT(*), 1) as win_rate_pct
        FROM trades 
        WHERE entry_timestamp > NOW() - INTERVAL '7 days'
        AND exit_timestamp IS NOT NULL
        GROUP BY buy_symbol
        HAVING COUNT(*) >= 3
        ORDER BY total_pnl DESC
        LIMIT 10;
    `);

    console.log('📊 TOKEN PERFORMANCE (3+ trades):');
    profitableTokens.rows.forEach(row => {
        console.log(`${row.buy_symbol.padEnd(8)} ${row.trades.toString().padStart(2)} trades | ${row.win_rate_pct.toString().padStart(4)}% WR | $${row.total_pnl.toFixed(2).padStart(6)} total | Avg: ${row.avg_entry_spread.toFixed(1)}%→${row.avg_exit_spread ? row.avg_exit_spread.toFixed(1) : 'N/A'}%`);
    });
    
    // 2. Time pattern analysis
    const timePatterns = await client.query(`
        SELECT 
            EXTRACT(hour FROM entry_timestamp AT TIME ZONE 'UTC') as hour_utc,
            COUNT(*) as trades,
            AVG(pnl_usd) as avg_pnl,
            COUNT(*) FILTER (WHERE pnl_usd > 0) as wins,
            ROUND(COUNT(*) FILTER (WHERE pnl_usd > 0) * 100.0 / COUNT(*), 1) as win_rate_pct
        FROM trades 
        WHERE entry_timestamp > NOW() - INTERVAL '7 days'
        AND exit_timestamp IS NOT NULL
        GROUP BY EXTRACT(hour FROM entry_timestamp AT TIME ZONE 'UTC')
        HAVING COUNT(*) >= 2
        ORDER BY hour_utc;
    `);

    console.log('\n🕐 HOURLY PATTERNS (UTC, 2+ trades):');
    timePatterns.rows.forEach(row => {
        const hour = row.hour_utc.toString().padStart(2, '0');
        console.log(`${hour}:00 | ${row.trades.toString().padStart(2)} trades | ${row.win_rate_pct.toString().padStart(4)}% WR | Avg PnL: $${row.avg_pnl.toFixed(2).padStart(5)}`);
    });
    
    // 3. Spread size vs success correlation
    const spreadAnalysis = await client.query(`
        SELECT 
            CASE 
                WHEN entry_spread_pct < 3.0 THEN '0-3%'
                WHEN entry_spread_pct < 4.0 THEN '3-4%'
                WHEN entry_spread_pct < 5.0 THEN '4-5%'
                WHEN entry_spread_pct < 6.0 THEN '5-6%'
                ELSE '6%+'
            END as spread_range,
            COUNT(*) as trades,
            AVG(entry_spread_pct) as avg_entry,
            AVG(pnl_usd) as avg_pnl,
            COUNT(*) FILTER (WHERE pnl_usd > 0) as wins,
            ROUND(COUNT(*) FILTER (WHERE pnl_usd > 0) * 100.0 / COUNT(*), 1) as win_rate_pct,
            SUM(pnl_usd) as total_pnl
        FROM trades 
        WHERE entry_timestamp > NOW() - INTERVAL '7 days'
        AND exit_timestamp IS NOT NULL
        GROUP BY 
            CASE 
                WHEN entry_spread_pct < 3.0 THEN '0-3%'
                WHEN entry_spread_pct < 4.0 THEN '3-4%'
                WHEN entry_spread_pct < 5.0 THEN '4-5%'
                WHEN entry_spread_pct < 6.0 THEN '5-6%'
                ELSE '6%+'
            END
        ORDER BY avg_entry;
    `);

    console.log('\n📈 ENTRY SPREAD vs SUCCESS:');
    spreadAnalysis.rows.forEach(row => {
        console.log(`${row.spread_range.padEnd(6)} | ${row.trades.toString().padStart(2)} trades | ${row.win_rate_pct.toString().padStart(4)}% WR | $${row.total_pnl.toFixed(2).padStart(6)} total | Avg: ${row.avg_entry.toFixed(1)}%`);
    });
    
    // 4. Symbols we should consider excluding
    const underperformers = await client.query(`
        SELECT 
            buy_symbol,
            COUNT(*) as trades,
            AVG(pnl_usd) as avg_pnl,
            SUM(pnl_usd) as total_pnl,
            COUNT(*) FILTER (WHERE pnl_usd > 0) as wins,
            ROUND(COUNT(*) FILTER (WHERE pnl_usd > 0) * 100.0 / COUNT(*), 1) as win_rate_pct,
            AVG(entry_spread_pct) as avg_entry_spread
        FROM trades 
        WHERE entry_timestamp > NOW() - INTERVAL '7 days'
        AND exit_timestamp IS NOT NULL
        GROUP BY buy_symbol
        HAVING COUNT(*) >= 3 AND SUM(pnl_usd) < -0.50
        ORDER BY total_pnl ASC;
    `);

    if (underperformers.rows.length > 0) {
        console.log('\n❌ UNDERPERFORMING TOKENS (3+ trades, <-$0.50 total):');
        underperformers.rows.forEach(row => {
            console.log(`${row.buy_symbol.padEnd(8)} ${row.trades.toString().padStart(2)} trades | ${row.win_rate_pct.toString().padStart(4)}% WR | $${row.total_pnl.toFixed(2).padStart(6)} loss | Avg entry: ${row.avg_entry_spread.toFixed(1)}%`);
        });
    } else {
        console.log('\n✅ No significantly underperforming tokens in last 7 days');
    }
    
    // 5. Overall stats
    const overallStats = await client.query(`
        SELECT 
            COUNT(*) as total_trades,
            AVG(pnl_usd) as avg_pnl_per_trade,
            SUM(pnl_usd) as total_pnl,
            COUNT(*) FILTER (WHERE pnl_usd > 0) as total_wins,
            ROUND(COUNT(*) FILTER (WHERE pnl_usd > 0) * 100.0 / COUNT(*), 1) as overall_win_rate,
            AVG(entry_spread_pct) as avg_entry_spread,
            AVG(EXTRACT(epoch FROM (exit_timestamp - entry_timestamp)) / 60) as avg_hold_minutes
        FROM trades 
        WHERE entry_timestamp > NOW() - INTERVAL '7 days'
        AND exit_timestamp IS NOT NULL;
    `);

    console.log('\n📊 OVERALL 7-DAY STATS:');
    const stats = overallStats.rows[0];
    console.log(`Total Trades: ${stats.total_trades}`);
    console.log(`Win Rate: ${stats.overall_win_rate}%`);
    console.log(`Total PnL: $${stats.total_pnl.toFixed(2)}`);
    console.log(`Avg PnL/Trade: $${stats.avg_pnl_per_trade.toFixed(2)}`);
    console.log(`Avg Entry Spread: ${stats.avg_entry_spread.toFixed(1)}%`);
    console.log(`Avg Hold Time: ${stats.avg_hold_minutes.toFixed(1)} minutes`);
    
    await client.end();
}

analyzeRecentTrades().catch(console.error);