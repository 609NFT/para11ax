#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function checkTables() {
  try {
    // Get all tables
    const tablesQuery = `
      SELECT schemaname, tablename 
      FROM pg_tables 
      WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
      ORDER BY schemaname, tablename;
    `;
    
    const result = await pool.query(tablesQuery);
    
    console.log('=== AVAILABLE TABLES ===');
    result.rows.forEach(row => {
      console.log(`${row.schemaname}.${row.tablename}`);
    });
    
    // Check specific table patterns
    const tradePattern = `
      SELECT schemaname, tablename 
      FROM pg_tables 
      WHERE tablename ILIKE '%trade%'
      ORDER BY schemaname, tablename;
    `;
    
    const tradeResult = await pool.query(tradePattern);
    console.log('\n=== TRADE-RELATED TABLES ===');
    tradeResult.rows.forEach(row => {
      console.log(`${row.schemaname}.${row.tablename}`);
    });
    
  } catch (error) {
    console.error('Query error:', error);
  } finally {
    await pool.end();
  }
}

checkTables();