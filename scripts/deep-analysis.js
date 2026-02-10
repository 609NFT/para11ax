#!/usr/bin/env node

const { Client } = require('pg');
const dns = require('dns');
const fs = require('fs');

// Set IPv4 first for Supabase
dns.setDefaultResultOrder('ipv4first');

async function analyzeRecentTrades() {
    const secrets = JSON.parse(fs.readFileSync(process.env.HOME + '/.parallax-secrets/supabase-db.json', 'utf8'));
    
    const client = new Client({
        host: 'postgres.tixpkokukqccehbnpkpf.pooler.supabase.com',
        port: 5432,
        database: secrets.database,
        user: secrets.user,
        password: secrets.password,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log('📊 PARALLAX DEEP ANALYSIS - Feb 9, 2026\n');

        // Get trades from last 48 hours
        const tradesResult = await client.query(`
            SELECT 
                id, symbol, entry_time, exit_time, entry_reason, exit_reason,
                entry_spread_pct, exit_spread_pct, hold_time_ms, realized_pnl_usd,
                entry_price_usd, exit_price_usd, amount_usd, size_tokens,
                created_at, updated_at
            FROM trades 
            WHERE entry_time >= NOW() - INTERVAL '48 hours'
            ORDER BY entry_time DESC
            LIMIT 50
        `);

        const trades = tradesResult.rows;
        console.log(`📈 Found ${trades.length} trades in last 48 hours\n`);

        if (trades.length === 0) {
            console.log('🔍 No recent trades found - checking bot status and opportunities...\n');
            
            // Check recent discount history for missed opportunities
            const discountResult = await client.query(`
                SELECT symbol, discount_pct, created_at 
                FROM discount_history 
                WHERE created_at >= NOW() - INTERVAL '24 hours'
                AND discount_pct > 3.0
                ORDER BY discount_pct DESC
                LIMIT 20
            `);

            console.log(`💰 Recent discount opportunities > 3.0%:`);
            discountResult.rows.forEach(row => {
                console.log(`  ${row.symbol}: ${row.discount_pct.toFixed(2)}% at ${new Date(row.created_at).toLocaleString()}`);
            });

            console.log('\n⚠️  No trades in 48h - possible issues:');
            console.log('  - Trading loop stuck?');
            console.log('  - Thresholds too high for current market?');
            console.log('  - Wallet issues?');
            console.log('  - Check PM2 logs for errors');
            
            return;
        }

        // Analyze exit reasons
        const exitReasons = {};
        trades.forEach(trade => {
            const reason = trade.exit_reason || 'unknown';
            exitReasons[reason] = (exitReasons[reason] || 0) + 1;
        });

        console.log(`📊 Exit Reason Distribution:`);
        Object.entries(exitReasons)
            .sort(([,a], [,b]) => b - a)
            .forEach(([reason, count]) => {
                const pct = (count / trades.length * 100).toFixed(1);
                console.log(`  ${reason}: ${count} (${pct}%)`);
            });

        // Analyze profitability by exit reason
        console.log(`\n💰 PnL by Exit Reason:`);
        const pnlByReason = {};
        trades.forEach(trade => {
            const reason = trade.exit_reason || 'unknown';
            if (!pnlByReason[reason]) pnlByReason[reason] = [];
            pnlByReason[reason].push(parseFloat(trade.realized_pnl_usd || 0));
        });

        Object.entries(pnlByReason).forEach(([reason, pnls]) => {
            const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
            const winRate = pnls.filter(p => p > 0).length / pnls.length * 100;
            console.log(`  ${reason}: avg $${avgPnl.toFixed(2)}, WR ${winRate.toFixed(1)}%`);
        });

        // Analyze hold times
        const holdTimes = trades
            .filter(t => t.hold_time_ms)
            .map(t => parseInt(t.hold_time_ms));
        
        if (holdTimes.length > 0) {
            const avgHold = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
            const medianHold = holdTimes.sort((a, b) => a - b)[Math.floor(holdTimes.length / 2)];
            
            console.log(`\n⏱️  Hold Time Analysis:`);
            console.log(`  Average: ${(avgHold / 60000).toFixed(1)} minutes`);
            console.log(`  Median: ${(medianHold / 60000).toFixed(1)} minutes`);
            console.log(`  Range: ${(Math.min(...holdTimes) / 60000).toFixed(1)} - ${(Math.max(...holdTimes) / 60000).toFixed(1)} min`);
        }

        // Analyze entry spreads vs profitability
        const profitableTrades = trades.filter(t => parseFloat(t.realized_pnl_usd || 0) > 0);
        const losingTrades = trades.filter(t => parseFloat(t.realized_pnl_usd || 0) <= 0);

        if (profitableTrades.length > 0 && losingTrades.length > 0) {
            const avgProfitableSpread = profitableTrades.reduce((sum, t) => sum + parseFloat(t.entry_spread_pct || 0), 0) / profitableTrades.length;
            const avgLosingSpread = losingTrades.reduce((sum, t) => sum + parseFloat(t.entry_spread_pct || 0), 0) / losingTrades.length;
            
            console.log(`\n📊 Entry Spread Analysis:`);
            console.log(`  Profitable trades avg spread: ${avgProfitableSpread.toFixed(2)}%`);
            console.log(`  Losing trades avg spread: ${avgLosingSpread.toFixed(2)}%`);
            console.log(`  Spread quality gap: ${(avgProfitableSpread - avgLosingSpread).toFixed(2)}%`);
        }

        // Overall performance
        const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl_usd || 0), 0);
        const winRate = trades.filter(t => parseFloat(t.realized_pnl_usd || 0) > 0).length / trades.length * 100;
        const totalVolume = trades.reduce((sum, t) => sum + parseFloat(t.amount_usd || 0), 0);

        console.log(`\n🎯 48h Performance Summary:`);
        console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
        console.log(`  Win Rate: ${winRate.toFixed(1)}%`);
        console.log(`  Total Volume: $${totalVolume.toFixed(0)}`);
        console.log(`  Trade Count: ${trades.length}`);

        // Check for concerning patterns
        console.log(`\n🔍 Pattern Analysis:`);
        
        // Check for spread widening stops
        const spreadWideningStops = trades.filter(t => t.exit_reason === 'spread_widening_stop').length;
        if (spreadWideningStops > 0) {
            console.log(`  ⚠️  ${spreadWideningStops} spread widening stops - check volatility`);
        }

        // Check for max hold time exits
        const maxHoldExits = trades.filter(t => t.exit_reason === 'max_hold_time').length;
        if (maxHoldExits > trades.length * 0.3) {
            console.log(`  ⚠️  High max hold exits (${maxHoldExits}) - spreads not reverting?`);
        }

        // Check recent profitable vs losing streaks
        const recentTrades = trades.slice(0, 10);
        const recentLosses = recentTrades.filter(t => parseFloat(t.realized_pnl_usd || 0) <= 0).length;
        if (recentLosses >= 7) {
            console.log(`  🚨 ${recentLosses}/10 recent trades losing - possible threshold issue`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
    }
}

analyzeRecentTrades().catch(console.error);