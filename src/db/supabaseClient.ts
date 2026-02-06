/**
 * Supabase PostgreSQL client for fetching token data and syncing trade data
 */

import { Pool } from 'pg';
import { TokenConfig } from '../types';
import logger from '../logger';

// Pool for token data (DIRECT_URL - existing database)
let tokenPool: Pool | null = null;

// Pool for trade data (TRADES_DB_URL - new Parallax database)
let tradesPool: Pool | null = null;

function getTokenPool(): Pool {
  if (!tokenPool) {
    const connectionString = process.env.DIRECT_URL;
    if (!connectionString) {
      throw new Error('DIRECT_URL environment variable not set');
    }
    tokenPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Add error handler
    tokenPool.on('error', (err) => {
      logger.error({ error: err }, 'Unexpected error on token pool client');
    });
  }
  return tokenPool;
}

export function getTradesPool(): Pool {
  if (!tradesPool) {
    const connectionString = process.env.TRADES_DB_URL;
    if (!connectionString) {
      throw new Error('TRADES_DB_URL environment variable not set');
    }
    tradesPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,  // Reduced from 20 - Supabase free tier limit
      min: 1,  // Reduced from 5 - save connections
      idleTimeoutMillis: 10000,  // Close idle faster
      connectionTimeoutMillis: 10000,
    });

    // Add error handler
    tradesPool.on('error', (err) => {
      logger.error({ error: err }, 'Unexpected error on trades pool client');
    });
  }
  return tradesPool;
}

/**
 * Validates that both database connections are working
 * Throws an error if either connection fails
 */
export async function validateDatabaseConnections(): Promise<void> {
  const errors: string[] = [];

  // Test token pool connection
  try {
    const tokenPool = getTokenPool();
    await tokenPool.query('SELECT 1');
    logger.info('Token database connection validated');
  } catch (error) {
    const err = error as Error;
    errors.push(`Token DB (DIRECT_URL): ${err.message}`);
  }

  // Test trades pool connection
  try {
    const tradesPool = getTradesPool();
    await tradesPool.query('SELECT 1');
    logger.info('Trades database connection validated');
  } catch (error) {
    const err = error as Error;
    errors.push(`Trades DB (TRADES_DB_URL): ${err.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Database validation failed:\n${errors.join('\n')}`);
  }
}

// ==================== Mean Reversion Positions ====================

export interface MeanReversionPositionRow {
  id: string;
  stock_ticker: string;
  buy_symbol: string;
  buy_mint: string;
  sell_symbol: string;
  sell_mint: string;
  entry_spread_pct: number;
  entry_timestamp: number;
  size_usd: number;
  buy_amount: number;
  sell_amount: number;
  status: string;
  exit_spread_pct?: number | null;
  exit_timestamp?: number | null;
  exit_reason?: string | null;
  pnl_usd?: number | null;
  pnl_pct?: number | null;
  buy_pool_address?: string | null;
  buy_decimals?: number | null;
  buy_dex_id?: string | null;
  entry_tx_signature?: string | null;
  exit_tx_signature?: string | null;
  total_fees_usd?: number | null;
  entry_fees_usd?: number | null;
  exit_fees_usd?: number | null;
  priority_fees_usd?: number | null;
  network_fees_usd?: number | null;
  slippage_usd?: number | null;
  platform_fees_usd?: number | null;
  entry_tvl_usd?: number | null;
  entry_route?: string | null;
  exit_route?: string | null;
  entry_stock_price?: number | null;
}

/**
 * Convert Postgres bigint string columns to JS numbers.
 * pg returns bigint columns as strings to avoid precision loss,
 * but our timestamps and numeric fields need to be actual numbers.
 */
function coercePositionRow(row: Record<string, unknown>): MeanReversionPositionRow {
  const numericFields = [
    'entry_spread_pct', 'entry_timestamp', 'size_usd', 'buy_amount', 'sell_amount',
    'exit_spread_pct', 'exit_timestamp', 'pnl_usd', 'pnl_pct',
    'buy_decimals', 'total_fees_usd', 'entry_fees_usd', 'exit_fees_usd',
    'priority_fees_usd', 'network_fees_usd', 'slippage_usd',
    'platform_fees_usd', 'entry_tvl_usd', 'entry_stock_price'
  ];
  const result = { ...row };
  for (const field of numericFields) {
    if (result[field] !== null && result[field] !== undefined) {
      result[field] = Number(result[field]);
    }
  }
  return result as unknown as MeanReversionPositionRow;
}

export async function upsertMeanReversionPosition(position: MeanReversionPositionRow): Promise<void> {
  const pool = getTradesPool();
  if (!pool) return;

  try {
    await pool.query(`
      INSERT INTO mean_reversion_positions (
        id, stock_ticker, buy_symbol, buy_mint, sell_symbol, sell_mint,
        entry_spread_pct, entry_timestamp, size_usd, buy_amount, sell_amount,
        status, exit_spread_pct, exit_timestamp, exit_reason, pnl_usd, pnl_pct,
        buy_pool_address, buy_decimals, buy_dex_id, entry_tx_signature, exit_tx_signature,
        total_fees_usd, entry_fees_usd, exit_fees_usd, priority_fees_usd, network_fees_usd, slippage_usd,
        platform_fees_usd, entry_tvl_usd, entry_route, exit_route, entry_stock_price, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        exit_spread_pct = EXCLUDED.exit_spread_pct,
        exit_timestamp = EXCLUDED.exit_timestamp,
        exit_reason = EXCLUDED.exit_reason,
        pnl_usd = EXCLUDED.pnl_usd,
        pnl_pct = EXCLUDED.pnl_pct,
        exit_tx_signature = EXCLUDED.exit_tx_signature,
        total_fees_usd = EXCLUDED.total_fees_usd,
        entry_fees_usd = EXCLUDED.entry_fees_usd,
        exit_fees_usd = EXCLUDED.exit_fees_usd,
        priority_fees_usd = EXCLUDED.priority_fees_usd,
        network_fees_usd = EXCLUDED.network_fees_usd,
        slippage_usd = EXCLUDED.slippage_usd,
        platform_fees_usd = EXCLUDED.platform_fees_usd,
        entry_tvl_usd = EXCLUDED.entry_tvl_usd,
        entry_route = EXCLUDED.entry_route,
        exit_route = EXCLUDED.exit_route,
        entry_stock_price = EXCLUDED.entry_stock_price,
        updated_at = EXCLUDED.updated_at
    `, [
      position.id, position.stock_ticker, position.buy_symbol, position.buy_mint,
      position.sell_symbol, position.sell_mint, position.entry_spread_pct, position.entry_timestamp,
      position.size_usd, position.buy_amount, position.sell_amount, position.status,
      position.exit_spread_pct, position.exit_timestamp, position.exit_reason,
      position.pnl_usd, position.pnl_pct, position.buy_pool_address, position.buy_decimals,
      position.buy_dex_id, position.entry_tx_signature, position.exit_tx_signature,
      position.total_fees_usd, position.entry_fees_usd, position.exit_fees_usd,
      position.priority_fees_usd, position.network_fees_usd, position.slippage_usd,
      position.platform_fees_usd, position.entry_tvl_usd, position.entry_route, position.exit_route,
      position.entry_stock_price, Date.now()
    ]);
  } catch (error) {
    logger.error({ error, positionId: position.id }, 'Failed to sync mean reversion position to Supabase');
  }
}

/**
 * Fetch recent closed mean reversion positions from Supabase
 * Used by dashboard to show recent trades with correct exit reasons
 */
export async function fetchRecentClosedPositions(limit: number = 10, withinMs: number = 24 * 60 * 60 * 1000): Promise<MeanReversionPositionRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const cutoffTime = Date.now() - withinMs;
    const result = await pool.query(`
      SELECT id, stock_ticker, buy_symbol, buy_mint, sell_symbol, sell_mint,
             entry_spread_pct, entry_timestamp, size_usd, buy_amount, sell_amount,
             status, exit_spread_pct, exit_timestamp, exit_reason, pnl_usd, pnl_pct,
             buy_pool_address, buy_decimals, buy_dex_id, entry_tx_signature, exit_tx_signature,
             total_fees_usd, entry_fees_usd, exit_fees_usd, priority_fees_usd, network_fees_usd, slippage_usd,
             platform_fees_usd, entry_tvl_usd, entry_route, exit_route, entry_stock_price
      FROM mean_reversion_positions
      WHERE status = 'closed'
        AND exit_timestamp > $1
      ORDER BY exit_timestamp DESC
      LIMIT $2
    `, [cutoffTime, limit]);

    return result.rows.map(coercePositionRow);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch recent closed positions from Supabase');
    return [];
  }
}

/**
 * Fetch open mean reversion positions
 * HOT PATH: Called every 10-30s in trading loop
 * CRITICAL for SQLite sunset migration
 */
export async function fetchOpenPositions(): Promise<MeanReversionPositionRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const result = await pool.query(`
      SELECT id, stock_ticker, buy_symbol, buy_mint, sell_symbol, sell_mint,
             entry_spread_pct, entry_timestamp, size_usd, buy_amount, sell_amount,
             status, exit_spread_pct, exit_timestamp, exit_reason, pnl_usd, pnl_pct,
             buy_pool_address, buy_decimals, buy_dex_id, entry_tx_signature, exit_tx_signature,
             total_fees_usd, entry_fees_usd, exit_fees_usd, priority_fees_usd, network_fees_usd, slippage_usd,
             platform_fees_usd, entry_tvl_usd, entry_route, exit_route, entry_stock_price
      FROM mean_reversion_positions
      WHERE status = 'open'
      ORDER BY entry_timestamp DESC
    `);

    return result.rows.map(coercePositionRow);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch open positions from Supabase');
    return [];
  }
}

/**
 * Fetch closed mean reversion positions
 * @param limit Maximum number of positions to return
 */
export async function fetchClosedPositions(limit: number = 100): Promise<MeanReversionPositionRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const result = await pool.query(`
      SELECT id, stock_ticker, buy_symbol, buy_mint, sell_symbol, sell_mint,
             entry_spread_pct, entry_timestamp, size_usd, buy_amount, sell_amount,
             status, exit_spread_pct, exit_timestamp, exit_reason, pnl_usd, pnl_pct,
             buy_pool_address, buy_decimals, buy_dex_id, entry_tx_signature, exit_tx_signature,
             total_fees_usd, entry_fees_usd, exit_fees_usd, priority_fees_usd, network_fees_usd, slippage_usd,
             platform_fees_usd, entry_tvl_usd, entry_route, exit_route, entry_stock_price
      FROM mean_reversion_positions
      WHERE status = 'closed'
      ORDER BY exit_timestamp DESC
      LIMIT $1
    `, [limit]);

    return result.rows.map(coercePositionRow);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch closed positions from Supabase');
    return [];
  }
}

// ==================== Short Positions ====================

export interface ShortPositionRow {
  id: string;
  ticker: string;
  rstock_symbol: string;
  token_symbol?: string | null;  // Which token's premium triggered this position
  token_mint?: string | null;    // Mint address for precise matching
  entry_premium_pct: number;
  entry_stock_price: number;
  entry_timestamp: number;
  collateral_usd: number;
  leverage: number;
  status: string;
  entry_tx_signature?: string | null;
  exit_premium_pct?: number | null;
  exit_timestamp?: number | null;
  exit_reason?: string | null;
  exit_tx_signature?: string | null;
  pnl_usd?: number | null;
  pnl_pct?: number | null;
}

export async function upsertShortPosition(position: ShortPositionRow): Promise<void> {
  const pool = getTradesPool();
  if (!pool) return;

  try {
    await pool.query(`
      INSERT INTO short_positions (
        id, ticker, rstock_symbol, token_symbol, token_mint,
        entry_premium_pct, entry_stock_price,
        entry_timestamp, collateral_usd, leverage, status, entry_tx_signature,
        exit_premium_pct, exit_timestamp, exit_reason, exit_tx_signature, pnl_usd, pnl_pct,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        token_symbol = COALESCE(EXCLUDED.token_symbol, short_positions.token_symbol),
        token_mint = COALESCE(EXCLUDED.token_mint, short_positions.token_mint),
        exit_premium_pct = EXCLUDED.exit_premium_pct,
        exit_timestamp = EXCLUDED.exit_timestamp,
        exit_reason = EXCLUDED.exit_reason,
        exit_tx_signature = EXCLUDED.exit_tx_signature,
        pnl_usd = EXCLUDED.pnl_usd,
        pnl_pct = EXCLUDED.pnl_pct,
        updated_at = EXCLUDED.updated_at
    `, [
      position.id, position.ticker, position.rstock_symbol,
      position.token_symbol, position.token_mint,
      position.entry_premium_pct,
      position.entry_stock_price, position.entry_timestamp, position.collateral_usd,
      position.leverage, position.status, position.entry_tx_signature,
      position.exit_premium_pct, position.exit_timestamp, position.exit_reason,
      position.exit_tx_signature, position.pnl_usd, position.pnl_pct, Date.now()
    ]);
  } catch (error) {
    logger.error({ error, positionId: position.id }, 'Failed to sync short position to Supabase');
  }
}

/**
 * Fetch open short positions
 * HOT PATH: Called every 10-30s in shorting loop
 */
export async function fetchOpenShortPositions(): Promise<ShortPositionRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const result = await pool.query(`
      SELECT id, ticker, rstock_symbol, token_symbol, token_mint,
             entry_premium_pct, entry_stock_price, entry_timestamp,
             collateral_usd, leverage, status, entry_tx_signature,
             exit_premium_pct, exit_timestamp, exit_reason, exit_tx_signature,
             pnl_usd, pnl_pct
      FROM short_positions
      WHERE status = 'open'
      ORDER BY entry_timestamp DESC
    `);

    return result.rows as ShortPositionRow[];
  } catch (error) {
    logger.error({ error }, 'Failed to fetch open short positions from Supabase');
    return [];
  }
}

/**
 * Fetch closed short positions
 */
export async function fetchClosedShortPositions(limit: number = 100): Promise<ShortPositionRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const result = await pool.query(`
      SELECT id, ticker, rstock_symbol, token_symbol, token_mint,
             entry_premium_pct, entry_stock_price, entry_timestamp,
             collateral_usd, leverage, status, entry_tx_signature,
             exit_premium_pct, exit_timestamp, exit_reason, exit_tx_signature,
             pnl_usd, pnl_pct
      FROM short_positions
      WHERE status = 'closed'
      ORDER BY exit_timestamp DESC
      LIMIT $1
    `, [limit]);

    return result.rows as ShortPositionRow[];
  } catch (error) {
    logger.error({ error }, 'Failed to fetch closed short positions from Supabase');
    return [];
  }
}

// ==================== Discount History ====================

export interface DiscountHistoryRow {
  stock_ticker: string;
  token_a_symbol: string;
  token_a_price: number;
  token_a_discount_vs_stock?: number | null;
  token_b_symbol: string;
  token_b_price: number;
  token_b_discount_vs_stock?: number | null;
  spread_pct: number;
  spread_absolute: number;
  stock_price?: number | null;
  more_discounted?: string | null;
  timestamp: number;
}

// Batch insert for discount history (more efficient)
let discountHistoryBatch: DiscountHistoryRow[] = [];
let batchTimeout: ReturnType<typeof setTimeout> | null = null;
const BATCH_SIZE = 100;  // Larger batches = fewer writes
const BATCH_INTERVAL_MS = 15000;  // 15s instead of 5s

export async function insertDiscountHistory(row: DiscountHistoryRow): Promise<void> {
  discountHistoryBatch.push(row);

  // Flush if batch is full
  if (discountHistoryBatch.length >= BATCH_SIZE) {
    await flushDiscountHistoryBatch();
  } else if (!batchTimeout) {
    // Set timer to flush after interval
    batchTimeout = setTimeout(() => flushDiscountHistoryBatch(), BATCH_INTERVAL_MS);
  }
}

async function flushDiscountHistoryBatch(): Promise<void> {
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }

  if (discountHistoryBatch.length === 0) return;

  const pool = getTradesPool();
  if (!pool) {
    discountHistoryBatch = [];
    return;
  }

  const batch = discountHistoryBatch;
  discountHistoryBatch = [];

  try {
    // Build bulk insert
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const row of batch) {
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11})`);
      values.push(
        row.stock_ticker, row.token_a_symbol, row.token_a_price, row.token_a_discount_vs_stock,
        row.token_b_symbol, row.token_b_price, row.token_b_discount_vs_stock,
        row.spread_pct, row.spread_absolute, row.stock_price, row.more_discounted, row.timestamp
      );
      paramIndex += 12;
    }

    await pool.query(`
      INSERT INTO discount_history (
        stock_ticker, token_a_symbol, token_a_price, token_a_discount_vs_stock,
        token_b_symbol, token_b_price, token_b_discount_vs_stock,
        spread_pct, spread_absolute, stock_price, more_discounted, timestamp
      ) VALUES ${placeholders.join(', ')}
    `, values);
  } catch (error) {
    logger.error({ error, batchSize: batch.length }, 'Failed to sync discount history batch to Supabase');
  }
}

// ==================== Discount History Pruning ====================

const RETENTION_DAYS = 30;  // Extended from 7 to 30 days for backtesting — need historical data for parameter validation

/**
 * Prune discount_history older than RETENTION_DAYS
 * Called automatically on startup and daily
 */
export async function pruneOldDiscountHistory(): Promise<{ deleted: number }> {
  const pool = getTradesPool();
  if (!pool) return { deleted: 0 };

  const cutoffMs = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const result = await pool.query(
      'DELETE FROM discount_history WHERE timestamp < $1',
      [cutoffMs]
    );

    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      logger.info({ deleted, retentionDays: RETENTION_DAYS }, 'Pruned old discount history from Supabase');
    }
    return { deleted };
  } catch (error) {
    logger.error({ error }, 'Failed to prune discount history from Supabase');
    return { deleted: 0 };
  }
}

/**
 * Fetch latest discount for a specific ticker
 * CRITICAL BUG FIX: Replaces SQLite read from empty table
 * This is why NAV was showing wrong values - discount_history writes to Supabase only
 * but DatabaseManager was reading from empty SQLite table
 */
export async function fetchLatestDiscount(
  stockTicker: string,
  tokenSymbol?: string
): Promise<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number } | null> {
  const pool = getTradesPool();
  if (!pool) return null;

  try {
    if (tokenSymbol) {
      const result = await pool.query(`
        SELECT
          COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount,
          token_a_price as "tokenPrice",
          stock_price as "stockPrice",
          timestamp
        FROM discount_history
        WHERE stock_ticker = $1 AND token_a_symbol = $2
        ORDER BY timestamp DESC
        LIMIT 1
      `, [stockTicker, tokenSymbol]);
      return result.rows[0] || null;
    }

    // Fallback to stock ticker only
    const result = await pool.query(`
      SELECT
        COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount,
        token_a_price as "tokenPrice",
        stock_price as "stockPrice",
        timestamp
      FROM discount_history
      WHERE stock_ticker = $1
      ORDER BY timestamp DESC
      LIMIT 1
    `, [stockTicker]);
    return result.rows[0] || null;
  } catch (error) {
    logger.error({ error, stockTicker, tokenSymbol }, 'Failed to fetch latest discount from Supabase');
    return null;
  }
}

/**
 * Fetch discount at a specific timestamp (for historical NAV calculations)
 */
export async function fetchDiscountAtTimestamp(
  stockTicker: string,
  tokenSymbol: string,
  timestamp: number
): Promise<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number } | null> {
  const pool = getTradesPool();
  if (!pool) return null;

  try {
    const result = await pool.query(`
      SELECT
        COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount,
        token_a_price as "tokenPrice",
        stock_price as "stockPrice",
        timestamp
      FROM discount_history
      WHERE stock_ticker = $1 AND token_a_symbol = $2 AND timestamp <= $3
      ORDER BY timestamp DESC
      LIMIT 1
    `, [stockTicker, tokenSymbol, timestamp]);
    return result.rows[0] || null;
  } catch (error) {
    logger.error({ error, stockTicker, tokenSymbol, timestamp }, 'Failed to fetch discount at timestamp from Supabase');
    return null;
  }
}

/**
 * Fetch latest discounts for all tokens (for watchlist)
 */
export async function fetchLatestDiscounts(): Promise<Map<string, number>> {
  const pool = getTradesPool();
  if (!pool) return new Map();

  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (token_a_symbol)
        token_a_symbol,
        COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount
      FROM discount_history
      ORDER BY token_a_symbol, timestamp DESC
    `);

    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.token_a_symbol, row.discount);
    }
    return map;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch latest discounts from Supabase');
    return new Map();
  }
}

/**
 * Fetch rolling discount history for volatility/percentile calculations
 */
export async function fetchRollingDiscountHistory(
  tokenSymbol: string,
  windowMs: number
): Promise<Array<{ discount: number; timestamp: number }>> {
  const pool = getTradesPool();
  if (!pool) return [];

  try {
    const cutoffTime = Date.now() - windowMs;
    const result = await pool.query(`
      SELECT
        COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount,
        timestamp
      FROM discount_history
      WHERE token_a_symbol = $1 AND timestamp > $2
      ORDER BY timestamp ASC
    `, [tokenSymbol, cutoffTime]);

    return result.rows;
  } catch (error) {
    logger.error({ error, tokenSymbol, windowMs }, 'Failed to fetch rolling discount history from Supabase');
    return [];
  }
}

/**
 * Fetch rolling discount history for all tokens (batch version)
 * @deprecated Use fetchAllPercentileThresholds instead for memory efficiency
 */
export async function fetchAllRollingDiscountHistory(
  windowMs: number
): Promise<Map<string, Array<{ discount: number; timestamp: number }>>> {
  const pool = getTradesPool();
  if (!pool) return new Map();

  try {
    const cutoffTime = Date.now() - windowMs;
    const result = await pool.query(`
      SELECT
        token_a_symbol,
        COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0) as discount,
        timestamp
      FROM discount_history
      WHERE timestamp > $1
      ORDER BY token_a_symbol, timestamp ASC
    `, [cutoffTime]);

    const map = new Map<string, Array<{ discount: number; timestamp: number }>>();
    for (const row of result.rows) {
      const existing = map.get(row.token_a_symbol) || [];
      existing.push({ discount: row.discount, timestamp: row.timestamp });
      map.set(row.token_a_symbol, existing);
    }
    return map;
  } catch (error) {
    logger.error({ error, windowMs }, 'Failed to fetch all rolling discount history from Supabase');
    return new Map();
  }
}

/**
 * Calculate percentile thresholds directly in PostgreSQL (memory efficient)
 * Requires index: idx_discount_history_time_symbol (timestamp DESC, token_a_symbol)
 * Returns Map of token symbol -> { percentile, sampleCount }
 */
export async function fetchAllPercentileThresholds(
  windowMs: number,
  percentile: number
): Promise<Map<string, { percentileValue: number; sampleCount: number }>> {
  const pool = getTradesPool();
  if (!pool) return new Map();

  try {
    const cutoffTime = Date.now() - windowMs;
    const percentileFraction = percentile / 100; // PostgreSQL uses 0-1 scale
    
    const result = await pool.query(`
      SELECT
        token_a_symbol,
        percentile_cont($1) WITHIN GROUP (ORDER BY COALESCE(token_a_discount_vs_stock, token_b_discount_vs_stock, 0)) as percentile_value,
        COUNT(*) as sample_count
      FROM discount_history
      WHERE timestamp > $2
      GROUP BY token_a_symbol
    `, [percentileFraction, cutoffTime]);

    const map = new Map<string, { percentileValue: number; sampleCount: number }>();
    for (const row of result.rows) {
      map.set(row.token_a_symbol, {
        percentileValue: parseFloat(row.percentile_value) || 0,
        sampleCount: parseInt(row.sample_count) || 0,
      });
    }
    
    logger.info({ 
      tokens: map.size, 
      percentile, 
      windowHours: windowMs / (60 * 60 * 1000) 
    }, 'Fetched percentile thresholds from PostgreSQL');
    
    return map;
  } catch (error) {
    logger.error({ error, windowMs, percentile }, 'Failed to fetch percentile thresholds from Supabase');
    return new Map();
  }
}

// ==================== System State ====================

export async function upsertSystemState(key: string, value: string): Promise<void> {
  const pool = getTradesPool();
  if (!pool) return;

  try {
    await pool.query(`
      INSERT INTO system_state (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
    `, [key, value, Date.now()]);
  } catch (error) {
    logger.error({ error, key }, 'Failed to sync system state to Supabase');
  }
}

interface DbToken {
  symbol: string;
  address: string;
  decimals: number;
}

// ==================== Heatmap Summary (Pre-aggregated for fast 7d queries) ====================

interface HeatmapSummaryRow {
  symbol: string;
  bucket_timestamp: number;
  avg_discount: number;
  sample_count: number;
}

/**
 * Aggregate discount_history from Supabase into hourly buckets
 * Returns data ready to be pushed to discount_heatmap_summary table
 */
export async function getHourlySummaryFromSupabase(sinceTimestamp?: number): Promise<HeatmapSummaryRow[]> {
  const pool = getTradesPool();
  if (!pool) return [];

  // Default to last 25 hours (overlap for safety)
  const since = sinceTimestamp || Date.now() - 25 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  try {
    const result = await pool.query<{
      symbol: string;
      bucket_timestamp: string;
      avg_discount: number;
      sample_count: string;
    }>(`
      SELECT
        token_a_symbol as symbol,
        (FLOOR(timestamp / $1) * $1)::bigint as bucket_timestamp,
        AVG(token_a_discount_vs_stock) as avg_discount,
        COUNT(*) as sample_count
      FROM discount_history
      WHERE timestamp >= $2 AND token_a_discount_vs_stock IS NOT NULL
      GROUP BY token_a_symbol, bucket_timestamp
      ORDER BY bucket_timestamp ASC
    `, [HOUR_MS, since]);

    return result.rows.map(row => ({
      symbol: row.symbol,
      bucket_timestamp: parseInt(row.bucket_timestamp, 10),
      avg_discount: row.avg_discount,
      sample_count: parseInt(row.sample_count, 10),
    }));
  } catch (error) {
    logger.error({ error }, 'Failed to get hourly summary from Supabase');
    return [];
  }
}

/**
 * Upsert hourly heatmap summary data to Supabase
 * Called periodically to aggregate discount_history into hourly buckets
 */
export async function upsertHeatmapSummary(rows: HeatmapSummaryRow[]): Promise<void> {
  const pool = getTradesPool();
  if (!pool || rows.length === 0) return;

  try {
    // Build bulk upsert
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const row of rows) {
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`);
      values.push(row.symbol, row.bucket_timestamp, row.avg_discount, row.sample_count);
      paramIndex += 4;
    }

    await pool.query(`
      INSERT INTO discount_heatmap_summary (symbol, bucket_timestamp, avg_discount, sample_count)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (symbol, bucket_timestamp) DO UPDATE SET
        avg_discount = EXCLUDED.avg_discount,
        sample_count = EXCLUDED.sample_count
    `, values);

    logger.debug({ rows: rows.length }, 'Upserted heatmap summary to Supabase');
  } catch (error) {
    logger.error({ error, rows: rows.length }, 'Failed to upsert heatmap summary to Supabase');
  }
}

/**
 * Fetch pre-aggregated heatmap data from Supabase
 * Much faster than querying raw discount_history for large time ranges
 */
export async function fetchHeatmapSummary(sinceTimestamp: number): Promise<{
  symbols: string[];
  timestamps: number[];
  data: (number | null)[][];
}> {
  const pool = getTradesPool();
  if (!pool) {
    return { symbols: [], timestamps: [], data: [] };
  }

  try {
    const result = await pool.query<{ symbol: string; bucket_timestamp: string; avg_discount: number }>(
      `SELECT symbol, bucket_timestamp, avg_discount
       FROM discount_heatmap_summary
       WHERE bucket_timestamp >= $1
       ORDER BY symbol, bucket_timestamp`,
      [sinceTimestamp]
    );

    // Group by symbol
    const symbolData = new Map<string, Map<number, number>>();
    const allTimestamps = new Set<number>();

    for (const row of result.rows) {
      const ts = parseInt(row.bucket_timestamp, 10);
      if (!symbolData.has(row.symbol)) {
        symbolData.set(row.symbol, new Map());
      }
      symbolData.get(row.symbol)!.set(ts, row.avg_discount);
      allTimestamps.add(ts);
    }

    const symbols = Array.from(symbolData.keys()).sort();
    const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    // Build 2D array
    const data: (number | null)[][] = [];
    for (const symbol of symbols) {
      const symbolMap = symbolData.get(symbol)!;
      const row: (number | null)[] = [];
      for (const ts of timestamps) {
        row.push(symbolMap.has(ts) ? symbolMap.get(ts)! : null);
      }
      data.push(row);
    }

    return { symbols, timestamps, data };
  } catch (error) {
    logger.error({ error }, 'Failed to fetch heatmap summary from Supabase');
    return { symbols: [], timestamps: [], data: [] };
  }
}

/**
 * Fetch discount heatmap data directly from discount_history with custom bucket size
 * Used for short time ranges (1h, 4h) that need finer granularity than hourly
 */
export async function fetchDiscountHeatmapFromSupabase(
  sinceTimestamp: number,
  bucketMinutes: number
): Promise<{
  symbols: string[];
  timestamps: number[];
  data: (number | null)[][];
}> {
  const pool = getTradesPool();
  if (!pool) {
    return { symbols: [], timestamps: [], data: [] };
  }

  const bucketMs = bucketMinutes * 60 * 1000;

  try {
    const result = await pool.query<{
      symbol: string;
      bucket_timestamp: string;
      avg_discount: number;
    }>(`
      SELECT
        token_a_symbol as symbol,
        (FLOOR(timestamp / $1) * $1)::bigint as bucket_timestamp,
        AVG(token_a_discount_vs_stock) as avg_discount
      FROM discount_history
      WHERE timestamp >= $2 AND token_a_discount_vs_stock IS NOT NULL
      GROUP BY token_a_symbol, bucket_timestamp
      ORDER BY token_a_symbol, bucket_timestamp
    `, [bucketMs, sinceTimestamp]);

    // Group by symbol
    const symbolData = new Map<string, Map<number, number>>();
    const allTimestamps = new Set<number>();

    for (const row of result.rows) {
      const ts = parseInt(row.bucket_timestamp, 10);
      if (!symbolData.has(row.symbol)) {
        symbolData.set(row.symbol, new Map());
      }
      symbolData.get(row.symbol)!.set(ts, row.avg_discount);
      allTimestamps.add(ts);
    }

    const symbols = Array.from(symbolData.keys()).sort();
    const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    // Build 2D array
    const data: (number | null)[][] = [];
    for (const symbol of symbols) {
      const symbolMap = symbolData.get(symbol)!;
      const row: (number | null)[] = [];
      for (const ts of timestamps) {
        row.push(symbolMap.has(ts) ? symbolMap.get(ts)! : null);
      }
      data.push(row);
    }

    return { symbols, timestamps, data };
  } catch (error) {
    logger.error({ error, sinceTimestamp, bucketMinutes }, 'Failed to fetch discount heatmap from Supabase');
    return { symbols: [], timestamps: [], data: [] };
  }
}

/**
 * Fetch all stock tokens from Supabase
 */
export async function fetchTokensFromDb(): Promise<TokenConfig[]> {
  const client = getTokenPool();

  const result = await client.query<DbToken>(`
    SELECT symbol, address, decimals
    FROM "Token"
    WHERE "indexId" = 'stocks'
    ORDER BY symbol
  `);

  return result.rows.map((row) => {
    // Use the shared tokenSymbolToStockTicker function for consistent mapping
    const stockTicker = tokenSymbolToStockTicker(row.symbol);

    return {
      symbol: row.symbol,
      mint: row.address,
      stockTicker,
      enabled: true,  // All DB tokens start enabled, liquidity check will disable
      poolAddress: '', // Will be discovered via DexScreener/GeckoTerminal
      decimals: row.decimals,
    };
  });
}

// ==================== Stats from Supabase ====================

import { TradeStats } from '../types';

/**
 * Fetch trading statistics from Supabase (production source of truth)
 */
export async function fetchStatsFromSupabase(sinceTimestamp?: number): Promise<TradeStats> {
  const pool = getTradesPool();
  if (!pool) {
    return getEmptyStats();
  }

  try {
    const whereClause = sinceTimestamp
      ? `WHERE status = 'closed' AND exit_timestamp >= $1`
      : `WHERE status = 'closed'`;
    const params = sinceTimestamp ? [sinceTimestamp] : [];

    // Get stats from long positions
    const longResult = await pool.query(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losing_trades,
        COALESCE(SUM(pnl_usd), 0) as total_pnl_usd,
        COALESCE(SUM(size_usd), 0) as total_invested_usd,
        COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct,
        COALESCE(AVG(exit_timestamp - entry_timestamp), 0) as avg_hold_time,
        COALESCE(MAX(pnl_usd), 0) as largest_win,
        COALESCE(MIN(pnl_usd), 0) as largest_loss,
        COALESCE(SUM(total_fees_usd), 0) as total_fees_usd,
        COALESCE(SUM(priority_fees_usd), 0) as total_priority_fees_usd,
        COALESCE(SUM(network_fees_usd), 0) as total_network_fees_usd,
        COALESCE(SUM(slippage_usd), 0) as total_slippage_usd
      FROM mean_reversion_positions
      ${whereClause}
    `, params);

    const longStats = longResult.rows[0];

    // Get stats from short positions
    const shortResult = await pool.query(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losing_trades,
        COALESCE(SUM(pnl_usd), 0) as total_pnl_usd,
        COALESCE(SUM(collateral_usd), 0) as total_invested_usd,
        COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct,
        COALESCE(AVG(exit_timestamp - entry_timestamp), 0) as avg_hold_time,
        COALESCE(MAX(pnl_usd), 0) as largest_win,
        COALESCE(MIN(pnl_usd), 0) as largest_loss
      FROM short_positions
      ${whereClause}
    `, params);

    const shortStats = shortResult.rows[0];

    // Combine stats
    const totalTrades = Number(longStats?.total_trades || 0) + Number(shortStats?.total_trades || 0);
    const winningTrades = Number(longStats?.winning_trades || 0) + Number(shortStats?.winning_trades || 0);
    const losingTrades = Number(longStats?.losing_trades || 0) + Number(shortStats?.losing_trades || 0);
    const totalPnlUsd = Number(longStats?.total_pnl_usd || 0) + Number(shortStats?.total_pnl_usd || 0);
    const totalInvestedUsd = Number(longStats?.total_invested_usd || 0) + Number(shortStats?.total_invested_usd || 0);
    const totalFeesUsd = Number(longStats?.total_fees_usd || 0);

    // Calculate today's trades
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();

    const todayResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM mean_reversion_positions WHERE status = 'closed' AND exit_timestamp >= $1) +
        (SELECT COUNT(*) FROM short_positions WHERE status = 'closed' AND exit_timestamp >= $1) as today_trades
    `, [todayTimestamp]);

    const todayTrades = Number(todayResult.rows[0]?.today_trades || 0);

    // Calculate daily average
    const dailyResult = await pool.query(`
      SELECT COUNT(DISTINCT exit_date) as trading_days, SUM(trade_count) as total_closed
      FROM (
        SELECT DATE(TO_TIMESTAMP(exit_timestamp / 1000)) as exit_date, COUNT(*) as trade_count
        FROM mean_reversion_positions WHERE status = 'closed' GROUP BY exit_date
        UNION ALL
        SELECT DATE(TO_TIMESTAMP(exit_timestamp / 1000)) as exit_date, COUNT(*) as trade_count
        FROM short_positions WHERE status = 'closed' GROUP BY exit_date
      ) combined
    `);

    const tradingDays = Number(dailyResult.rows[0]?.trading_days || 0);
    const totalClosed = Number(dailyResult.rows[0]?.total_closed || 0);
    const avgDailyTrades = tradingDays > 0 ? totalClosed / tradingDays : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      totalPnlUsd,
      totalInvestedUsd,
      averagePnlPct: totalTrades > 0
        ? (Number(longStats?.avg_pnl_pct || 0) * Number(longStats?.total_trades || 0) +
           Number(shortStats?.avg_pnl_pct || 0) * Number(shortStats?.total_trades || 0)) / totalTrades
        : 0,
      averageHoldTime: totalTrades > 0
        ? (Number(longStats?.avg_hold_time || 0) * Number(longStats?.total_trades || 0) +
           Number(shortStats?.avg_hold_time || 0) * Number(shortStats?.total_trades || 0)) / totalTrades
        : 0,
      largestWin: Math.max(Number(longStats?.largest_win || 0), Number(shortStats?.largest_win || 0)),
      largestLoss: Math.min(Number(longStats?.largest_loss || 0), Number(shortStats?.largest_loss || 0)),
      winRate: totalTrades > 0 ? winningTrades / totalTrades : 0,
      avgDailyTrades,
      todayTrades,
      totalFeesUsd,
      avgFeePerTradeUsd: totalTrades > 0 ? totalFeesUsd / totalTrades : 0,
      totalPriorityFeesUsd: Number(longStats?.total_priority_fees_usd || 0),
      totalNetworkFeesUsd: Number(longStats?.total_network_fees_usd || 0),
      totalSlippageUsd: Number(longStats?.total_slippage_usd || 0),
      grossPnlUsd: totalPnlUsd + totalFeesUsd,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to fetch stats from Supabase');
    return getEmptyStats();
  }
}

/**
 * Fetch PnL history from Supabase for chart display
 */
export async function fetchPnlHistoryFromSupabase(sinceTimestamp?: number): Promise<Array<{ timestamp: number; cumulativePnl: number }>> {
  const pool = getTradesPool();
  if (!pool) {
    return [];
  }

  try {
    const whereClause = sinceTimestamp
      ? `WHERE status = 'closed' AND exit_timestamp IS NOT NULL AND exit_timestamp >= $1`
      : `WHERE status = 'closed' AND exit_timestamp IS NOT NULL`;
    const params = sinceTimestamp ? [sinceTimestamp] : [];

    // Get all closed trades from both tables
    const longResult = await pool.query(`
      SELECT exit_timestamp, pnl_usd FROM mean_reversion_positions ${whereClause}
    `, params);

    const shortResult = await pool.query(`
      SELECT exit_timestamp, pnl_usd FROM short_positions ${whereClause}
    `, params);

    // Combine and sort by timestamp
    const allRows = [
      ...longResult.rows.map(r => ({ exit_timestamp: Number(r.exit_timestamp), pnl_usd: Number(r.pnl_usd || 0) })),
      ...shortResult.rows.map(r => ({ exit_timestamp: Number(r.exit_timestamp), pnl_usd: Number(r.pnl_usd || 0) })),
    ].sort((a, b) => a.exit_timestamp - b.exit_timestamp);

    // Calculate cumulative PnL
    let cumulative = 0;
    return allRows.map(row => {
      cumulative += row.pnl_usd;
      return {
        timestamp: row.exit_timestamp,
        cumulativePnl: cumulative,
      };
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch PnL history from Supabase');
    return [];
  }
}

function getEmptyStats(): TradeStats {
  return {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnlUsd: 0,
    totalInvestedUsd: 0,
    averagePnlPct: 0,
    averageHoldTime: 0,
    largestWin: 0,
    largestLoss: 0,
    winRate: 0,
    avgDailyTrades: 0,
    todayTrades: 0,
    totalFeesUsd: 0,
    avgFeePerTradeUsd: 0,
    totalPriorityFeesUsd: 0,
    totalNetworkFeesUsd: 0,
    totalSlippageUsd: 0,
    grossPnlUsd: 0,
  };
}

/**
 * Convert token symbol to stock ticker (e.g., TSLAx -> TSLA, rNVDA -> NVDA)
 * 
 * Strategy: explicit overrides first, then vendor suffix/prefix stripping.
 * Validated against real stock tickers to avoid garbage like "INTCo".
 */

// Explicit overrides for tokens that don't follow simple prefix/suffix rules
const TICKER_OVERRIDES: Record<string, string> = {
  'INTCon': 'INTC',    // Ondo format: INTC + "on" suffix
  'Vx': 'V',           // Visa — single-letter ticker edge case
  'BRK.Bx': 'BRK.B',  // Berkshire Hathaway — dot in ticker
};

// Known valid stock/ETF tickers for validation
const KNOWN_TICKERS = new Set([
  'AAPL', 'ABT', 'AMZN', 'AZN', 'BRK.B', 'COIN', 'CPER', 'CRCL',
  'DFDV', 'GLD', 'GOOGL', 'HOOD', 'INTC', 'JNJ', 'KO', 'LIN',
  'LLY', 'MCD', 'META', 'MSFT', 'MSTR', 'NFLX', 'NVDA', 'ORCL',
  'PALL', 'PG', 'PPLT', 'QQQ', 'SLV', 'SPY', 'TQQQ', 'TSLA',
  'UNH', 'V', 'XOM', 'AMBR',
]);

function tokenSymbolToStockTicker(symbol: string): string {
  // 1. Check explicit overrides first
  if (TICKER_OVERRIDES[symbol]) {
    return TICKER_OVERRIDES[symbol];
  }

  let stockTicker = symbol;

  // 2. Handle known vendor suffixes (case-insensitive): "on", "ON" (Ondo format)
  const knownSuffixes = ['on', 'ON'];
  for (const suffix of knownSuffixes) {
    if (stockTicker.endsWith(suffix) && stockTicker.length > suffix.length) {
      const base = stockTicker.slice(0, -suffix.length);
      if (/^[A-Z][A-Z.]+$/.test(base)) {
        stockTicker = base;
        if (KNOWN_TICKERS.has(stockTicker)) return stockTicker;
        // If not known, continue to other stripping methods
      }
    }
  }

  // 3. Handle lowercase suffix: AAPLx, SPYr, GOOGLz -> AAPL, SPY, GOOGL
  const lastChar = stockTicker.slice(-1);
  if (lastChar >= 'a' && lastChar <= 'z') {
    const candidate = stockTicker.slice(0, -1);
    if (KNOWN_TICKERS.has(candidate)) return candidate;
    // If single lowercase suffix didn't work, try stripping more
    // e.g., "INTCon" after failing "on" suffix -> "INTCo" -> strip "o" -> "INTC"
    const lastChar2 = candidate.slice(-1);
    if (lastChar2 >= 'a' && lastChar2 <= 'z') {
      const candidate2 = candidate.slice(0, -1);
      if (KNOWN_TICKERS.has(candidate2)) return candidate2;
    }
    return candidate; // Return best guess even if not in known list
  }

  // 4. Handle lowercase prefix: xSPY, rNVDA -> SPY, NVDA
  const firstChar = stockTicker.charAt(0);
  if (firstChar >= 'a' && firstChar <= 'z') {
    return stockTicker.slice(1);
  }

  return stockTicker;
}

/**
 * Fetch historical volatility for all tokens from Supabase
 * Returns Map keyed by STOCK TICKER (not token symbol) for consistency
 * Used for prewarm at startup - replaces SQLite-based volatility calculation
 */
export async function fetchAllHistoricalVolatilityFromSupabase(windowDays: number = 7): Promise<Map<string, number>> {
  const pool = getTradesPool();
  if (!pool) {
    return new Map();
  }

  const cutoffTimestamp = Date.now() - (windowDays * 24 * 60 * 60 * 1000);
  const HOUR_MS = 60 * 60 * 1000;

  try {
    // Get hourly price samples for all tokens
    const result = await pool.query(`
      SELECT
        token_a_symbol,
        FLOOR(timestamp / $1) * $1 as hour_bucket,
        AVG(token_a_price) as avg_price
      FROM discount_history
      WHERE timestamp >= $2
        AND token_a_price > 0
      GROUP BY token_a_symbol, hour_bucket
      ORDER BY token_a_symbol, hour_bucket ASC
    `, [HOUR_MS, cutoffTimestamp]);

    // Group by STOCK TICKER (not token symbol)
    const tickerPrices = new Map<string, { hour_bucket: number; avg_price: number }[]>();
    for (const r of result.rows) {
      const stockTicker = tokenSymbolToStockTicker(r.token_a_symbol);
      const arr = tickerPrices.get(stockTicker) || [];
      arr.push({ hour_bucket: Number(r.hour_bucket), avg_price: Number(r.avg_price) });
      tickerPrices.set(stockTicker, arr);
    }

    // Calculate volatility for each stock ticker
    const volatilityMap = new Map<string, number>();
    for (const [ticker, prices] of tickerPrices) {
      if (prices.length < 24) continue;

      // Sort by hour bucket and dedupe (take average if multiple tokens have same bucket)
      const bucketMap = new Map<number, number[]>();
      for (const p of prices) {
        const arr = bucketMap.get(p.hour_bucket) || [];
        arr.push(p.avg_price);
        bucketMap.set(p.hour_bucket, arr);
      }
      const sortedPrices = Array.from(bucketMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, priceArr]) => priceArr.reduce((a, b) => a + b, 0) / priceArr.length);

      if (sortedPrices.length < 24) continue;

      // Calculate returns
      const returns: number[] = [];
      for (let i = 1; i < sortedPrices.length; i++) {
        const prevPrice = sortedPrices[i - 1];
        const currPrice = sortedPrices[i];
        if (prevPrice > 0) {
          returns.push((currPrice - prevPrice) / prevPrice);
        }
      }

      if (returns.length < 20) continue;

      // Standard deviation
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.map(r => Math.pow(r - mean, 2)).reduce((a, b) => a + b, 0) / returns.length;
      const hourlyStdDev = Math.sqrt(variance);

      // Convert to daily percentage
      const dailyVolatilityPct = hourlyStdDev * Math.sqrt(24) * 100;
      volatilityMap.set(ticker, dailyVolatilityPct);
    }

    return volatilityMap;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch historical volatility from Supabase');
    return new Map();
  }
}

