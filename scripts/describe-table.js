#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function describeTable() {
  try {
    const schemaQuery = `
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'mean_reversion_positions' AND table_schema = 'public'
      ORDER BY ordinal_position;
    `;
    
    const result = await pool.query(schemaQuery);
    
    console.log('=== MEAN_REVERSION_POSITIONS SCHEMA ===');
    result.rows.forEach(row => {
      console.log(`${row.column_name} (${row.data_type}) ${row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });
    
  } catch (error) {
    console.error('Query error:', error);
  } finally {
    await pool.end();
  }
}

describeTable();