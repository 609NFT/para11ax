const { Pool } = require('pg');
require('dotenv').config();

async function listTables() {
  const pool = new Pool({ connectionString: process.env.TRADES_DB_URL });
  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    console.log('Available tables:');
    result.rows.forEach(row => console.log('  ' + row.table_name));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

listTables();