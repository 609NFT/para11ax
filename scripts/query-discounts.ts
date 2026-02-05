import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.TRADES_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function query() {
  // Query since midnight UTC today
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const result = await pool.query(`
    SELECT * FROM discount_history
    WHERE created_at >= $1
    ORDER BY created_at ASC
    LIMIT 10000
  `, [todayStart.getTime()]);

  const data = result.rows;
  console.log('Records since midnight UTC:', data.length);
  if (data.length > 0) {
    console.log('First:', new Date(Number(data[0].created_at)).toISOString());
    console.log('Last:', new Date(Number(data[data.length-1].created_at)).toISOString());
  }

  // Hourly counts
  const hourlyCount: Record<number, number> = {};
  const byToken: Record<string, { discounts: number[]; maxDiscount: number; minDiscount: number; count: number; maxTime: string }> = {};

  for (const row of data) {
    const hour = new Date(Number(row.created_at)).getUTCHours();
    hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;

    const sym = row.token_a_symbol;
    const discount = row.token_a_discount_vs_stock;
    if (!byToken[sym]) {
      byToken[sym] = { discounts: [], maxDiscount: -Infinity, minDiscount: Infinity, count: 0, maxTime: '' };
    }
    byToken[sym].discounts.push(discount);
    byToken[sym].count++;
    if (discount > byToken[sym].maxDiscount) {
      byToken[sym].maxDiscount = discount;
      byToken[sym].maxTime = row.created_at;
    }
    if (discount < byToken[sym].minDiscount) {
      byToken[sym].minDiscount = discount;
    }
  }

  console.log('\n=== Hourly sample counts ===');
  for (const h of Object.keys(hourlyCount).map(Number).sort((a,b) => a-b)) {
    console.log(`Hour ${h.toString().padStart(2, '0')} UTC: ${hourlyCount[h]} samples`);
  }

  // Sort by max discount (most positive = premium, most negative = discount)
  const sorted = Object.entries(byToken)
    .map(([sym, d]) => ({ symbol: sym, ...d }))
    .sort((a, b) => b.maxDiscount - a.maxDiscount);

  console.log('\n=== Discount Summary (today) - sorted by max ===');
  console.log('Symbol'.padEnd(10) + 'Max%'.padStart(8) + 'Min%'.padStart(8) + 'Samples'.padStart(8));
  for (const t of sorted) {
    console.log(
      t.symbol.padEnd(10) +
      t.maxDiscount.toFixed(2).padStart(8) +
      t.minDiscount.toFixed(2).padStart(8) +
      t.count.toString().padStart(8)
    );
  }

  // Show tokens with biggest discounts (best entry opportunities)
  console.log('\n=== Best discount opportunities (sorted by min, i.e. biggest discount) ===');
  const sortedByDiscount = [...sorted].sort((a, b) => a.minDiscount - b.minDiscount);
  for (const t of sortedByDiscount.slice(0, 15)) {
    console.log(
      t.symbol.padEnd(10) +
      'min: ' + t.minDiscount.toFixed(2).padStart(6) + '%' +
      ', max: ' + t.maxDiscount.toFixed(2).padStart(6) + '%' +
      ' (' + t.count + ' samples)'
    );
  }
}

query().then(() => pool.end()).catch(e => { console.error(e); pool.end(); });
