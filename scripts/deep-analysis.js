const { Client } = require('pg');
const dns = require('dns');

// Set IPv4 first for Supabase pooler
dns.setDefaultResultOrder('ipv4first');

async function analyzeRecentTrades() {
    // Load Supabase credentials from secrets file
    const fs = require('fs');
    const path = require('path');
    const credentialsPath = path.join(process.env.HOME, '.parallax-secrets', 'supabase-db.json');
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    
    const client = new Client({
        host: "aws-0-us-west-2.pooler.supabase.com", // Use pooler for better connection handling
        port: 5432,
        database: credentials.database,
        user: credentials.user,
        password: credentials.password
    });

    try {
        await client.connect();
        console.log('Connected to Supabase');

        // First, let's see what tables exist
        const tablesQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `;
        
        const tables = await client.query(tablesQuery);
        console.log('Available tables:', tables.rows.map(r => r.table_name));

        // Get trades from last 48 hours with detailed analysis
        const tradesQuery = `
            SELECT 
                id,
                stock_ticker,
                buy_symbol,
                TO_TIMESTAMP(entry_timestamp/1000) as entry_time,
                TO_TIMESTAMP(exit_timestamp/1000) as exit_time,
                pnl_usd,
                entry_spread_pct,
                exit_spread_pct,
                exit_reason,
                size_usd,
                ROUND(((exit_timestamp - entry_timestamp)/1000/60)::numeric, 1) as hold_minutes,
                ROUND((pnl_usd / size_usd * 100)::numeric, 3) as roi_pct,
                status
            FROM mean_reversion_positions 
            WHERE TO_TIMESTAMP(entry_timestamp/1000) > NOW() - INTERVAL '48 HOURS'
            AND status = 'closed'
            ORDER BY entry_timestamp DESC
            LIMIT 50
        `;

        const trades = await client.query(tradesQuery);
        console.log(`\n📊 RECENT COMPLETED TRADES ANALYSIS (${trades.rows.length} trades in 48h)`);
        console.log('='.repeat(80));

        if (trades.rows.length === 0) {
            console.log('❌ NO COMPLETED TRADES in last 48 hours');
            
            // Check if there are any trades at all in last week
            const weekQuery = `SELECT COUNT(*) as count FROM mean_reversion_positions WHERE status = 'closed' AND TO_TIMESTAMP(entry_timestamp/1000) > NOW() - INTERVAL '7 DAYS'`;
            const weekResult = await client.query(weekQuery);
            console.log(`📈 Trades in last 7 days: ${weekResult.rows[0].count}`);
            return;
        }

        // Basic stats
        const totalPnL = trades.rows.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const profitable = trades.rows.filter(t => parseFloat(t.pnl_usd || 0) > 0);
        const winRate = (profitable.length / trades.rows.length * 100).toFixed(1);
        
        console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
        console.log(`Win Rate: ${winRate}% (${profitable.length}/${trades.rows.length})`);
        console.log(`Avg Hold Time: ${(trades.rows.reduce((sum, t) => sum + parseFloat(t.hold_minutes || 0), 0) / trades.rows.length).toFixed(1)} min`);

        // Exit reason breakdown
        const exitReasons = {};
        trades.rows.forEach(t => {
            const reason = t.exit_reason || 'unknown';
            exitReasons[reason] = (exitReasons[reason] || 0) + 1;
        });
        console.log('\n🚪 EXIT REASONS:');
        Object.entries(exitReasons).forEach(([reason, count]) => {
            const pnl = trades.rows.filter(t => (t.exit_reason || 'unknown') === reason)
                .reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
            console.log(`  ${reason}: ${count} trades, $${pnl.toFixed(2)} PnL`);
        });

        // Symbol performance
        const symbolStats = {};
        trades.rows.forEach(t => {
            const symbol = t.buy_symbol;
            if (!symbolStats[symbol]) {
                symbolStats[symbol] = { count: 0, pnl: 0, winRate: 0, wins: 0 };
            }
            symbolStats[symbol].count++;
            symbolStats[symbol].pnl += parseFloat(t.pnl_usd || 0);
            if (parseFloat(t.pnl_usd || 0) > 0) symbolStats[symbol].wins++;
        });

        console.log('\n📈 SYMBOL PERFORMANCE:');
        Object.entries(symbolStats).forEach(([symbol, stats]) => {
            stats.winRate = (stats.wins / stats.count * 100).toFixed(1);
            console.log(`  ${symbol}: ${stats.count} trades, ${stats.winRate}% WR, $${stats.pnl.toFixed(2)} PnL`);
        });

        // Entry spread analysis
        const entryStats = {
            '4.0-4.5%': trades.rows.filter(t => Math.abs(t.entry_spread_pct) >= 4.0 && Math.abs(t.entry_spread_pct) < 4.5),
            '4.5-5.0%': trades.rows.filter(t => Math.abs(t.entry_spread_pct) >= 4.5 && Math.abs(t.entry_spread_pct) < 5.0),
            '5.0-6.0%': trades.rows.filter(t => Math.abs(t.entry_spread_pct) >= 5.0 && Math.abs(t.entry_spread_pct) < 6.0),
            '6.0%+': trades.rows.filter(t => Math.abs(t.entry_spread_pct) >= 6.0)
        };

        console.log('\n🎯 ENTRY SPREAD ANALYSIS:');
        Object.entries(entryStats).forEach(([range, tradList]) => {
            if (tradList.length > 0) {
                const pnl = tradList.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
                const winRate = (tradList.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / tradList.length * 100).toFixed(1);
                console.log(`  ${range}: ${tradList.length} trades, ${winRate}% WR, $${pnl.toFixed(2)} PnL`);
            }
        });

        // Recent losing trades analysis
        const recentLosers = trades.rows.filter(t => parseFloat(t.pnl_usd || 0) < 0).slice(0, 10);
        if (recentLosers.length > 0) {
            console.log('\n❌ RECENT LOSING TRADES:');
            recentLosers.forEach(t => {
                console.log(`  ${t.buy_symbol} ${t.entry_time.toISOString().substr(0,16)} | Entry: ${t.entry_spread_pct}% | Exit: ${t.exit_reason} | PnL: $${parseFloat(t.pnl_usd || 0).toFixed(2)} | Hold: ${t.hold_minutes}min`);
            });
        }

        // Check current active positions
        const positionsQuery = `
            SELECT buy_symbol, TO_TIMESTAMP(entry_timestamp/1000) as entry_time, 
                   size_usd, entry_spread_pct,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(entry_timestamp/1000)))/60) as hold_minutes
            FROM mean_reversion_positions 
            WHERE status = 'open'
        `;
        
        const positions = await client.query(positionsQuery);
        if (positions.rows.length > 0) {
            console.log('\n🔄 ACTIVE POSITIONS:');
            positions.rows.forEach(p => {
                console.log(`  ${p.buy_symbol}: $${parseFloat(p.size_usd).toFixed(0)}, ${p.entry_spread_pct}% entry, ${p.hold_minutes}min hold`);
            });
        } else {
            console.log('\n✅ No active positions');
        }

        // Check discount_history table structure first
        const columnsQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'discount_history' 
            ORDER BY ordinal_position
        `;
        const columns = await client.query(columnsQuery);
        console.log('\n📋 discount_history columns:', columns.rows.map(r => r.column_name));

        // Check if bot is seeing opportunities
        const opportunitiesQuery = `
            SELECT 
                more_discounted as symbol,
                CASE 
                    WHEN more_discounted = token_a_symbol THEN token_a_discount_vs_stock
                    WHEN more_discounted = token_b_symbol THEN token_b_discount_vs_stock
                    ELSE 0
                END as discount_pct,
                created_at
            FROM discount_history 
            WHERE created_at > NOW() - INTERVAL '6 HOURS'
            AND ABS(CASE 
                WHEN more_discounted = token_a_symbol THEN token_a_discount_vs_stock
                WHEN more_discounted = token_b_symbol THEN token_b_discount_vs_stock
                ELSE 0
            END) >= 4.3
            ORDER BY created_at DESC
            LIMIT 20
        `;

        try {
            const opps = await client.query(opportunitiesQuery);
            console.log(`\n🎯 RECENT OPPORTUNITIES (>4.3%, last 6h): ${opps.rows.length}`);
            if (opps.rows.length > 0) {
                opps.rows.slice(0, 5).forEach(o => {
                    console.log(`  ${o.symbol}: ${o.discount_pct}% @ ${new Date(o.created_at).toISOString().substr(11,8)}`);
                });
            } else {
                console.log('❌ NO opportunities above 4.3% in last 6 hours - market may be tight or bot issue');
            }
        } catch (error) {
            console.error('Error checking opportunities:', error.message);
        }
        
        // Add bot health check
        const systemStateQuery = `SELECT * FROM system_state ORDER BY updated_at DESC LIMIT 1`;
        const systemState = await client.query(systemStateQuery);
        if (systemState.rows.length > 0) {
            const state = systemState.rows[0];
            const lastUpdate = new Date(state.updated_at);
            const minutesAgo = Math.round((Date.now() - lastUpdate.getTime()) / 1000 / 60);
            console.log(`\n🤖 BOT HEALTH:`);
            console.log(`  Last update: ${minutesAgo} minutes ago`);
            console.log(`  Status: ${state.status || 'unknown'}`);
            if (minutesAgo > 15) {
                console.log(`  ⚠️  WARNING: Bot hasn't updated system state in ${minutesAgo} minutes`);
            }
        }

    } catch (error) {
        console.error('Database error:', error.message);
    } finally {
        await client.end();
    }
}

analyzeRecentTrades().catch(console.error);