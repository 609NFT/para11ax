// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  // Get recent discount history (last 6 hours)
  const { data, error } = await supabase
    .from('discount_history')
    .select('*')
    .gte('timestamp', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order('timestamp', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Error:', error);
    return;
  }

  // Group by token
  const byToken = {};
  for (const row of data) {
    if (!byToken[row.token_symbol]) {
      byToken[row.token_symbol] = [];
    }
    byToken[row.token_symbol].push(row);
  }

  // Show summary per token
  console.log('=== DISCOUNT HISTORY (Last 6 hours) ===\n');

  for (const symbol of Object.keys(byToken).sort()) {
    const rows = byToken[symbol];
    const discounts = rows.map(r => r.discount_percent);
    const avg = discounts.reduce((a, b) => a + b, 0) / discounts.length;
    const max = Math.max(...discounts);
    const min = Math.min(...discounts);
    const latest = rows[0];

    console.log(symbol + ':');
    console.log('  Latest: ' + latest.discount_percent.toFixed(3) + '% | Stock: $' + latest.stock_price.toFixed(2) + ' | Token: $' + latest.token_price.toFixed(2));
    console.log('  Range: ' + min.toFixed(3) + '% to ' + max.toFixed(3) + '% | Avg: ' + avg.toFixed(3) + '% | Samples: ' + rows.length);
    console.log('');
  }

  // Check for SLV specifically
  console.log('\n=== SLV / SLVR LOOKUP ===\n');
  const { data: slvData } = await supabase
    .from('Token')
    .select('*')
    .or('symbol.ilike.%slv%,symbol.ilike.%slvr%');

  if (slvData && slvData.length > 0) {
    console.log('Found in Token table:');
    for (const token of slvData) {
      console.log('  ' + token.symbol + ': ' + token.mint);
      console.log('    poolAddress: ' + (token.poolAddress || 'null'));
      console.log('    enabled: ' + token.enabled);
    }
  } else {
    console.log('No SLV/SLVR tokens found in Token table');
  }
}

main();
