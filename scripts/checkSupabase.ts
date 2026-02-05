import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function check() {
  const result = await pool.query('SELECT COUNT(*) as count FROM mean_reversion_positions');
  console.log('Supabase position count:', result.rows[0].count);
  
  const sample = await pool.query('SELECT id FROM mean_reversion_positions LIMIT 5');
  console.log('Sample IDs:', sample.rows.map(r => r.id));
  
  await pool.end();
}

check().catch(console.error);
