const { Client } = require('pg');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// IPv4 first for Supabase
dns.setDefaultResultOrder('ipv4first');

async function checkCurrentState() {
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
        console.log('🔍 CURRENT TRADING STATE CHECK');
        console.log('='.repeat(40));

        // Check for open positions
        const openPositionsQuery = `
            SELECT 
                id, stock_ticker, buy_symbol, entry_spread_pct, size_usd,
                to_timestamp(entry_timestamp / 1000) as entry_time,
                (EXTRACT(EPOCH FROM NOW()) * 1000 - entry_timestamp) / 60000 as hold_time_min
            FROM mean_reversion_positions 
            WHERE status = 'open'
            ORDER BY entry_timestamp DESC
        `;
        
        const openPositions = await client.query(openPositionsQuery);
        console.log(`\n📈 OPEN POSITIONS: ${openPositions.rows.length}`);
        
        if (openPositions.rows.length > 0) {
            openPositions.rows.forEach(pos => {
                console.log(`  ${pos.buy_symbol}: ${pos.entry_spread_pct.toFixed(2)}% | $${pos.size_usd.toFixed(0)} | ${pos.hold_time_min.toFixed(1)}min ago`);
            });
        }

        // Check schema first
        const schemaQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'discount_history' 
            ORDER BY ordinal_position;
        `;
        const schemaResult = await client.query(schemaQuery);
        console.log('\nDiscount history columns:', schemaResult.rows.map(r => r.column_name).join(', '));

        // Check recent discount data for current spreads
        const currentSpreadsQuery = `
            SELECT 
                stock_ticker, more_discounted, spread_pct, 
                token_a_symbol, token_a_discount_vs_stock,
                token_b_symbol, token_b_discount_vs_stock,
                to_timestamp(timestamp / 1000) as timestamp_formatted,
                (EXTRACT(EPOCH FROM NOW()) * 1000 - timestamp) / 60000 as age_minutes
            FROM discount_history 
            WHERE timestamp >= (EXTRACT(EPOCH FROM NOW() - INTERVAL '10 minutes') * 1000)
            ORDER BY ABS(spread_pct) DESC
            LIMIT 15
        `;
        
        const spreadsResult = await client.query(currentSpreadsQuery);
        console.log(`\n📊 CURRENT SPREADS (last 10 min):`);
        
        if (spreadsResult.rows.length > 0) {
            spreadsResult.rows.forEach(row => {
                const ageMin = parseFloat(row.age_minutes || 0).toFixed(1);
                const moreDiscounted = row.more_discounted;
                const discountA = parseFloat(row.token_a_discount_vs_stock || 0).toFixed(2);
                const discountB = parseFloat(row.token_b_discount_vs_stock || 0).toFixed(2);
                console.log(`  ${row.stock_ticker}: ${parseFloat(row.spread_pct || 0).toFixed(2)}% | ${row.token_a_symbol} ${discountA}% vs ${row.token_b_symbol} ${discountB}% | ${moreDiscounted} cheaper | ${ageMin}min ago`);
            });
        } else {
            console.log('  No recent spread data found');
        }

        // Check system state
        const systemStateQuery = `
            SELECT key, value, last_updated
            FROM system_state 
            ORDER BY last_updated DESC
        `;
        
        const systemState = await client.query(systemStateQuery);
        console.log(`\n⚙️ SYSTEM STATE:`);
        systemState.rows.forEach(row => {
            console.log(`  ${row.key}: ${row.value}`);
        });

    } catch (error) {
        console.error('Database error:', error.message);
    } finally {
        await client.end();
    }
}

checkCurrentState();