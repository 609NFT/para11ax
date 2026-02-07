#!/usr/bin/env node
const { Client } = require('pg');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

dns.setDefaultResultOrder('ipv4first');

async function analyzeStrategyData() {
    // Load Supabase credentials
    const credentialsPath = path.join(process.env.HOME, '.parallax-secrets', 'supabase-db.json');
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    
    const client = new Client({
        connectionString: credentials.connectionString
    });

    try {
        await client.connect();
        
        // Get trades from last 7 days
        const tradesQuery = `
            SELECT 
                symbol,
                entry_spread_pct,
                exit_spread_pct,
                pnl_usd,
                hold_duration_ms,
                created_at,
                exit_reason,
                entry_price_usd,
                exit_price_usd
            FROM trades 
            WHERE created_at >= NOW() - INTERVAL '7 days'
            AND pnl_usd IS NOT NULL
            ORDER BY created_at DESC
        `;
        
        const { rows: trades } = await client.query(tradesQuery);
        
        // Get discount history for volatility analysis
        const volatilityQuery = `
            SELECT 
                symbol,
                discount_pct,
                created_at
            FROM discount_history 
            WHERE created_at >= NOW() - INTERVAL '7 days'
            ORDER BY symbol, created_at DESC
        `;
        
        const { rows: discountData } = await client.query(volatilityQuery);
        
        console.log('=== STRATEGY ANALYSIS (Last 7 Days) ===');
        console.log(`Total trades: ${trades.length}`);
        
        if (trades.length === 0) {
            console.log('No trades in the last 7 days for analysis.');
            return { trades: [], insights: ['No recent trade data available'] };
        }

        // Core metrics
        const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const avgPnL = totalPnL / trades.length;
        const winRate = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length / trades.length;
        const avgHoldTime = trades.reduce((sum, t) => sum + parseInt(t.hold_duration_ms || 0), 0) / trades.length / (1000 * 60); // minutes
        
        console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
        console.log(`Average PnL per trade: $${avgPnL.toFixed(2)}`);
        console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`);
        console.log(`Average Hold Time: ${avgHoldTime.toFixed(1)} minutes`);
        
        // Symbol performance analysis
        const symbolStats = {};
        trades.forEach(trade => {
            const sym = trade.symbol;
            if (!symbolStats[sym]) {
                symbolStats[sym] = { 
                    count: 0, 
                    pnl: 0, 
                    wins: 0,
                    avgSpread: 0,
                    avgHold: 0
                };
            }
            symbolStats[sym].count++;
            symbolStats[sym].pnl += parseFloat(trade.pnl_usd || 0);
            symbolStats[sym].avgSpread += Math.abs(parseFloat(trade.entry_spread_pct || 0));
            symbolStats[sym].avgHold += parseInt(trade.hold_duration_ms || 0) / (1000 * 60);
            if (parseFloat(trade.pnl_usd || 0) > 0) symbolStats[sym].wins++;
        });
        
        console.log('\n=== SYMBOL PERFORMANCE ===');
        Object.entries(symbolStats).forEach(([sym, stats]) => {
            stats.winRate = (stats.wins / stats.count * 100).toFixed(1);
            stats.avgSpread = (stats.avgSpread / stats.count).toFixed(2);
            stats.avgHold = (stats.avgHold / stats.count).toFixed(1);
            console.log(`${sym}: ${stats.count} trades | $${stats.pnl.toFixed(2)} PnL | ${stats.winRate}% WR | ${stats.avgSpread}% avg spread | ${stats.avgHold}min hold`);
        });
        
        // Entry threshold analysis
        const spreadPerformance = {};
        trades.forEach(trade => {
            const spread = Math.abs(parseFloat(trade.entry_spread_pct || 0));
            const bucket = Math.floor(spread * 2) / 2; // 0.5% buckets
            const bucketKey = `${bucket.toFixed(1)}%`;
            
            if (!spreadPerformance[bucketKey]) {
                spreadPerformance[bucketKey] = { count: 0, totalPnL: 0, wins: 0 };
            }
            spreadPerformance[bucketKey].count++;
            spreadPerformance[bucketKey].totalPnL += parseFloat(trade.pnl_usd || 0);
            if (parseFloat(trade.pnl_usd || 0) > 0) spreadPerformance[bucketKey].wins++;
        });
        
        console.log('\n=== ENTRY THRESHOLD ANALYSIS ===');
        Object.entries(spreadPerformance).forEach(([bucket, stats]) => {
            const avgPnL = stats.totalPnL / stats.count;
            const winRate = (stats.wins / stats.count * 100).toFixed(1);
            console.log(`${bucket}: ${stats.count} trades | $${avgPnL.toFixed(2)} avg PnL | ${winRate}% WR`);
        });
        
        // Exit reason analysis
        const exitReasons = {};
        trades.forEach(trade => {
            const reason = trade.exit_reason || 'unknown';
            if (!exitReasons[reason]) {
                exitReasons[reason] = { count: 0, totalPnL: 0, avgPnL: 0 };
            }
            exitReasons[reason].count++;
            exitReasons[reason].totalPnL += parseFloat(trade.pnl_usd || 0);
        });
        
        console.log('\n=== EXIT REASON ANALYSIS ===');
        Object.entries(exitReasons).forEach(([reason, stats]) => {
            stats.avgPnL = stats.totalPnL / stats.count;
            console.log(`${reason}: ${stats.count} trades | $${stats.avgPnL.toFixed(2)} avg PnL`);
        });
        
        // Calculate spread volatility for each symbol
        const volatilityStats = {};
        discountData.forEach(point => {
            const sym = point.symbol;
            if (!volatilityStats[sym]) {
                volatilityStats[sym] = [];
            }
            volatilityStats[sym].push(parseFloat(point.discount_pct || 0));
        });
        
        console.log('\n=== SPREAD VOLATILITY (7d) ===');
        Object.entries(volatilityStats).forEach(([sym, discounts]) => {
            if (discounts.length > 10) { // Only analyze symbols with sufficient data
                const mean = discounts.reduce((sum, d) => sum + d, 0) / discounts.length;
                const variance = discounts.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / discounts.length;
                const stdDev = Math.sqrt(variance);
                console.log(`${sym}: ${stdDev.toFixed(2)}% volatility | ${mean.toFixed(2)}% avg spread`);
            }
        });
        
        return {
            trades,
            symbolStats,
            spreadPerformance,
            exitReasons,
            volatilityStats,
            summary: {
                totalPnL,
                avgPnL,
                winRate,
                avgHoldTime,
                tradeCount: trades.length
            }
        };
        
    } catch (error) {
        console.error('Database error:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    analyzeStrategyData()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error('Analysis failed:', error);
            process.exit(1);
        });
}

module.exports = { analyzeStrategyData };