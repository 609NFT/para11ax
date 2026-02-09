/**
 * Test script for half-life filter
 * Calculates half-lives for major tokens and outputs results
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { calculateBatchHalfLives } from '../src/signals/halfLifeFilter';
import { getTradesPool } from '../src/db/supabaseClient';

// Major tokens to test
const TEST_SYMBOLS = [
  'TSLAx',
  'NVDAx',
  'SPYx',
  'MSTRx',
  'GLDx',
  'AAPLx',
  'GOOGLx',
  'METAx',
  'AMZNx',
  'MSFTx',
];

async function main() {
  console.log('=== Half-Life Filter Test ===\n');
  
  // Test database connection
  const pool = getTradesPool();
  if (!pool) {
    console.error('ERROR: No database connection. Check TRADES_DB_URL env var.');
    process.exit(1);
  }
  
  console.log('Database connected. Fetching half-lives...\n');
  
  // Calculate half-lives for test symbols
  const results = await calculateBatchHalfLives(TEST_SYMBOLS);
  
  console.log('Symbol       | Half-Life (hours) | Status');
  console.log('-------------|-------------------|--------');
  
  for (const symbol of TEST_SYMBOLS) {
    const halfLife = results.get(symbol) ?? Infinity;
    let status = '✓ OK';
    if (!isFinite(halfLife)) {
      status = '⚠ No data';
    } else if (halfLife > 4) {
      status = '❌ Slow';
    }
    
    const halfLifeStr = isFinite(halfLife) ? halfLife.toFixed(2).padStart(8) : '     N/A';
    console.log(`${symbol.padEnd(12)} | ${halfLifeStr}           | ${status}`);
  }
  
  // Also query to see what symbols have data
  console.log('\n--- Available symbols with data ---\n');
  
  try {
    const symbolResult = await pool.query(`
      SELECT token_a_symbol, COUNT(*) as sample_count,
             MIN(timestamp) as oldest, MAX(timestamp) as newest
      FROM discount_history
      WHERE timestamp > $1
      GROUP BY token_a_symbol
      HAVING COUNT(*) >= 50
      ORDER BY sample_count DESC
      LIMIT 20
    `, [Date.now() - 7 * 24 * 60 * 60 * 1000]); // 7 days
    
    console.log('Symbol       | Samples | Age (hours)');
    console.log('-------------|---------|------------');
    
    for (const row of symbolResult.rows) {
      const ageHours = (Date.now() - Number(row.oldest)) / (60 * 60 * 1000);
      console.log(`${row.token_a_symbol.padEnd(12)} | ${String(row.sample_count).padStart(7)} | ${ageHours.toFixed(1)}`);
    }
  } catch (error) {
    console.error('Failed to query available symbols:', error);
  }
  
  console.log('\n=== Test Complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
