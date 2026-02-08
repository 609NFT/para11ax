const { Client } = require('pg');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// IPv4 first for Supabase
dns.setDefaultResultOrder('ipv4first');

async function analyzeRecentTrades() {
    // Load database credentials from secrets file
    const secretsPath = path.join(process.env.HOME, '.parallax-secrets', 'supabase-db.json');
    let credentials;
    
    try {
        credentials = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    } catch (error) {
        console.error('❌ Could not load database credentials from:', secretsPath);
        console.error('Error:', error.message);
        return;
    }

    const client = new Client({
        connectionString: credentials.connectionString
    });

    try {
        await client.connect();
        console.log('📊 PARALLAX TRADE ANALYSIS - Last 48 Hours');
        console.log('='.repeat(50));

        // First check what tables exist
        const tablesQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `;
        const tablesResult = await client.query(tablesQuery);
        console.log('Available tables:', tablesResult.rows.map(r => r.table_name).join(', '));

        // Check schema of mean_reversion_positions
        const schemaQuery = `
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'mean_reversion_positions' 
            ORDER BY ordinal_position;
        `;
        const schemaResult = await client.query(schemaQuery);
        console.log('\nMean reversion positions columns:');
        schemaResult.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));

        // Get recent trades from mean_reversion_positions (last 48 hours)
        const tradesQuery = `
            SELECT 
                id, stock_ticker, buy_symbol, entry_spread_pct, exit_spread_pct,
                pnl_usd, 
                to_timestamp(entry_timestamp / 1000) as entry_time,
                to_timestamp(exit_timestamp / 1000) as exit_time, 
                exit_reason, size_usd, slippage_usd, status, pnl_pct,
                (exit_timestamp - entry_timestamp) as hold_time_ms,
                total_fees_usd, entry_fees_usd, exit_fees_usd
            FROM mean_reversion_positions 
            WHERE entry_timestamp >= (EXTRACT(EPOCH FROM NOW() - INTERVAL '48 hours') * 1000)
              AND status IN ('closed', 'exited')
            ORDER BY entry_timestamp DESC
        `;
        
        const tradesResult = await client.query(tradesQuery);
        const trades = tradesResult.rows;

        console.log(`\n📈 RECENT TRADES: ${trades.length} trades in last 48h\n`);

        if (trades.length === 0) {
            console.log('❌ No trades in last 48 hours');
            return;
        }

        // Trade summary
        const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const avgPnL = totalPnL / trades.length;
        const winners = trades.filter(t => parseFloat(t.pnl_usd || 0) > 0).length;
        const losers = trades.filter(t => parseFloat(t.pnl_usd || 0) < 0).length;
        const winRate = (winners / trades.length * 100).toFixed(1);

        console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
        console.log(`Avg PnL: $${avgPnL.toFixed(2)}`);
        console.log(`Win Rate: ${winRate}% (${winners}W / ${losers}L)`);

        // Symbol breakdown
        console.log('\n📊 BY SYMBOL:');
        const bySymbol = {};
        trades.forEach(t => {
            const symbol = t.buy_symbol || t.stock_ticker;
            if (!bySymbol[symbol]) {
                bySymbol[symbol] = { count: 0, pnl: 0, entries: [], exits: [] };
            }
            bySymbol[symbol].count++;
            bySymbol[symbol].pnl += parseFloat(t.pnl_usd || 0);
            if (t.entry_spread_pct) bySymbol[symbol].entries.push(parseFloat(t.entry_spread_pct));
            if (t.exit_spread_pct) bySymbol[symbol].exits.push(parseFloat(t.exit_spread_pct));
        });

        Object.entries(bySymbol).forEach(([symbol, data]) => {
            const avgEntry = data.entries.length > 0 ? 
                (data.entries.reduce((a, b) => a + b, 0) / data.entries.length).toFixed(2) : 'N/A';
            const avgExit = data.exits.length > 0 ? 
                (data.exits.reduce((a, b) => a + b, 0) / data.exits.length).toFixed(2) : 'N/A';
            console.log(`  ${symbol}: ${data.count} trades, $${data.pnl.toFixed(2)} PnL, ${avgEntry}% avg entry, ${avgExit}% avg exit`);
        });

        // Exit reasons analysis
        console.log('\n🚪 EXIT REASONS:');
        const exitReasons = {};
        trades.forEach(t => {
            const reason = t.exit_reason || 'unknown';
            if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
            exitReasons[reason].count++;
            exitReasons[reason].pnl += parseFloat(t.pnl_usd || 0);
        });

        Object.entries(exitReasons).forEach(([reason, data]) => {
            const avgPnL = (data.pnl / data.count).toFixed(2);
            console.log(`  ${reason}: ${data.count} trades, $${avgPnL} avg PnL`);
        });

        // Threshold effectiveness
        console.log('\n🎯 THRESHOLD ANALYSIS:');
        const entryThresholds = trades.map(t => parseFloat(t.entry_spread_pct || 0)).filter(x => x !== 0);
        if (entryThresholds.length > 0) {
            const minEntry = Math.min(...entryThresholds);
            const maxEntry = Math.max(...entryThresholds);
            const avgEntry = entryThresholds.reduce((a, b) => a + b, 0) / entryThresholds.length;
            console.log(`Entry spreads: ${minEntry.toFixed(2)}% min, ${maxEntry.toFixed(2)}% max, ${avgEntry.toFixed(2)}% avg`);
        }

        // Hold time analysis
        console.log('\n⏰ HOLD TIME ANALYSIS:');
        const holdTimes = trades.map(t => parseInt(t.hold_time_ms || 0)).filter(x => x > 0);
        if (holdTimes.length > 0) {
            const avgHoldMin = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length / 60000;
            const minHoldMin = Math.min(...holdTimes) / 60000;
            const maxHoldMin = Math.max(...holdTimes) / 60000;
            console.log(`Hold times: ${avgHoldMin.toFixed(1)} min avg, ${minHoldMin.toFixed(1)}-${maxHoldMin.toFixed(1)} min range`);
        }

        // Individual trade details
        console.log('\n📋 INDIVIDUAL TRADES:');
        trades.slice(0, 10).forEach(t => {
            const holdMin = t.hold_time_ms ? (parseInt(t.hold_time_ms) / 60000).toFixed(1) : 'N/A';
            const entryTime = new Date(t.entry_time).toISOString().slice(0, 16).replace('T', ' ');
            const symbol = t.buy_symbol || t.stock_ticker;
            console.log(`${symbol} LONG: ${(t.entry_spread_pct || 0).toFixed(2)}% → ${(t.exit_spread_pct || 0).toFixed(2)}% | $${(parseFloat(t.pnl_usd || 0)).toFixed(2)} | ${holdMin}min | ${t.exit_reason} | ${entryTime}`);
        });

        // Check for potential issues
        console.log('\n🔍 POTENTIAL ISSUES:');
        
        // Check for negative PnL on profit_target exits
        const badProfitTargets = trades.filter(t => 
            t.exit_reason === 'profit_target' && parseFloat(t.pnl_usd || 0) < 0
        );
        if (badProfitTargets.length > 0) {
            console.log(`❌ ${badProfitTargets.length} profit_target exits with negative PnL - strategy bug!`);
        }

        // Check for very quick exits
        const quickExits = trades.filter(t => 
            t.hold_time_ms && parseInt(t.hold_time_ms) < 300000 // < 5 min
        );
        if (quickExits.length > 0) {
            console.log(`⚡ ${quickExits.length} exits under 5 minutes - potential churning`);
        }

        // Check for spread widening stops
        const spreadStops = trades.filter(t => t.exit_reason === 'spread_widening_stop');
        if (spreadStops.length > 0) {
            console.log(`📈 ${spreadStops.length} spread_widening_stop exits - spread protection working`);
        }

    } catch (error) {
        console.error('Database error:', error.message);
    } finally {
        await client.end();
    }
}

analyzeRecentTrades();