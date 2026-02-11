/**
 * Predict Positions Database
 * Supabase storage for prediction market trades
 */

import { getTradesPool } from '../db/supabaseClient';
import { PredictPosition } from '../dflow/types';
import logger from '../logger';

// Table name
const TABLE = 'predict_positions';

/**
 * Initialize the predict_positions table if it doesn't exist
 */
export async function initPredictTable(): Promise<void> {
  const pool = getTradesPool();
  
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      market_ticker TEXT NOT NULL,
      event_ticker TEXT NOT NULL,
      series_ticker TEXT,
      title TEXT,
      outcome TEXT CHECK (outcome IN ('yes', 'no')),
      
      entry_price DECIMAL(10, 6),
      entry_timestamp BIGINT,
      size_usd DECIMAL(10, 4),
      tokens_held DECIMAL(20, 9),
      token_mint TEXT,
      collateral_mint TEXT,
      entry_tx_signature TEXT,
      
      data_source TEXT,
      data_value TEXT,
      data_timestamp BIGINT,
      data_confidence DECIMAL(5, 4),
      market_implied_prob DECIMAL(5, 4),
      edge_pct DECIMAL(5, 4),
      
      expiration_time BIGINT,
      status TEXT DEFAULT 'open' CHECK (status IN ('open', 'settled', 'expired', 'sold')),
      settlement_result TEXT CHECK (settlement_result IN ('win', 'loss') OR settlement_result IS NULL),
      pnl_usd DECIMAL(10, 4),
      pnl_pct DECIMAL(10, 4),
      exit_timestamp BIGINT,
      exit_tx_signature TEXT,
      
      created_at BIGINT,
      updated_at BIGINT
    );

    CREATE INDEX IF NOT EXISTS idx_predict_status ON ${TABLE}(status);

    -- Fee tracking columns (added later, nullable)
    ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS entry_fee_usd DECIMAL(10, 6);
    ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS network_fee_sol DECIMAL(10, 9);
    ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS price_impact_pct DECIMAL(10, 6);
    CREATE INDEX IF NOT EXISTS idx_predict_market ON ${TABLE}(market_ticker);
    CREATE INDEX IF NOT EXISTS idx_predict_created ON ${TABLE}(created_at DESC);
  `;

  try {
    await pool.query(createTableSQL);
    logger.info('predict_positions table initialized');
  } catch (e) {
    logger.error({ error: e }, 'Failed to initialize predict_positions table');
    throw e;
  }
}

/**
 * Save a new predict position
 */
export async function savePredictPosition(position: PredictPosition): Promise<void> {
  const pool = getTradesPool();

  const sql = `
    INSERT INTO ${TABLE} (
      id, market_ticker, event_ticker, series_ticker, title, outcome,
      entry_price, entry_timestamp, size_usd, tokens_held, token_mint, collateral_mint, entry_tx_signature,
      data_source, data_value, data_timestamp, data_confidence, market_implied_prob, edge_pct,
      expiration_time, status, created_at, updated_at,
      entry_fee_usd, network_fee_sol, price_impact_pct
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19,
      $20, $21, $22, $23,
      $24, $25, $26
    )
  `;

  const values = [
    position.id,
    position.marketTicker,
    position.eventTicker,
    position.seriesTicker,
    position.title,
    position.outcome,
    position.entryPrice,
    position.entryTimestamp,
    position.sizeUsd,
    position.tokensHeld,
    position.tokenMint,
    position.collateralMint,
    position.entryTxSignature,
    position.dataSource,
    position.dataValue,
    position.dataTimestamp,
    position.dataConfidence,
    position.marketImpliedProb,
    position.edgePct,
    position.expirationTime,
    position.status,
    position.createdAt,
    position.updatedAt,
    position.entryFeeUsd || null,
    position.networkFeeSol || null,
    position.priceImpactPct || null,
  ];

  try {
    await pool.query(sql, values);
    logger.debug({ id: position.id, ticker: position.marketTicker }, 'Saved predict position');
  } catch (e) {
    logger.error({ error: e, position }, 'Failed to save predict position');
    throw e;
  }
}

/**
 * Update a predict position
 */
export async function updatePredictPosition(
  id: string,
  updates: Partial<PredictPosition>
): Promise<void> {
  const pool = getTradesPool();

  // Build SET clause dynamically
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const columnMap: Record<string, string> = {
    status: 'status',
    settlementResult: 'settlement_result',
    pnlUsd: 'pnl_usd',
    pnlPct: 'pnl_pct',
    exitTimestamp: 'exit_timestamp',
    exitTxSignature: 'exit_tx_signature',
    updatedAt: 'updated_at',
  };

  for (const [key, column] of Object.entries(columnMap)) {
    if (key in updates) {
      setClauses.push(`${column} = $${paramIndex}`);
      values.push((updates as Record<string, unknown>)[key]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const sql = `UPDATE ${TABLE} SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;

  try {
    await pool.query(sql, values);
    logger.debug({ id, updates }, 'Updated predict position');
  } catch (e) {
    logger.error({ error: e, id, updates }, 'Failed to update predict position');
    throw e;
  }
}

/**
 * Get all open predict positions
 */
export async function getOpenPredictPositions(): Promise<PredictPosition[]> {
  const pool = getTradesPool();

  const sql = `SELECT * FROM ${TABLE} WHERE status = 'open' AND (entry_tx_signature IS NULL OR entry_tx_signature NOT LIKE 'paper_%') ORDER BY created_at DESC`;

  try {
    const result = await pool.query(sql);
    return result.rows.map(rowToPosition);
  } catch (e) {
    // Table might not exist yet
    if ((e as Error).message.includes('does not exist')) {
      return [];
    }
    logger.error({ error: e }, 'Failed to get open predict positions');
    return [];
  }
}

/**
 * Get recent predict positions (for dashboard)
 */
export async function getRecentPredictPositions(limit: number = 50): Promise<PredictPosition[]> {
  const pool = getTradesPool();

  const sql = `SELECT * FROM ${TABLE} WHERE (entry_tx_signature IS NULL OR entry_tx_signature NOT LIKE 'paper_%') ORDER BY created_at DESC LIMIT $1`;

  try {
    const result = await pool.query(sql, [limit]);
    return result.rows.map(rowToPosition);
  } catch (e) {
    if ((e as Error).message.includes('does not exist')) {
      return [];
    }
    logger.error({ error: e }, 'Failed to get recent predict positions');
    return [];
  }
}

/**
 * Get predict trading statistics
 */
export async function getPredictStats(): Promise<{
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  avgEdge: number;
  openPositions: number;
  totalFees: number;
}> {
  const pool = getTradesPool();

  const sql = `
    SELECT 
      COUNT(*) FILTER (WHERE status IN ('settled', 'expired')) as total_trades,
      COUNT(*) FILTER (WHERE settlement_result = 'win') as wins,
      COUNT(*) FILTER (WHERE settlement_result = 'loss') as losses,
      COALESCE(SUM(pnl_usd) FILTER (WHERE status = 'settled'), 0) as total_pnl,
      COALESCE(AVG(pnl_usd) FILTER (WHERE status = 'settled'), 0) as avg_pnl,
      COALESCE(AVG(edge_pct), 0) as avg_edge,
      COUNT(*) FILTER (WHERE status = 'open') as open_positions,
      COALESCE(SUM(entry_fee_usd), 0) as total_fees
    FROM ${TABLE}
    WHERE (entry_tx_signature IS NULL OR entry_tx_signature NOT LIKE 'paper_%')
  `;

  try {
    const result = await pool.query(sql);
    const row = result.rows[0];

    const totalTrades = parseInt(row.total_trades) || 0;
    const wins = parseInt(row.wins) || 0;
    const losses = parseInt(row.losses) || 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      totalPnL: parseFloat(row.total_pnl) || 0,
      avgPnL: parseFloat(row.avg_pnl) || 0,
      avgEdge: parseFloat(row.avg_edge) || 0,
      openPositions: parseInt(row.open_positions) || 0,
      totalFees: parseFloat(row.total_fees) || 0,
    };
  } catch (e) {
    if ((e as Error).message.includes('does not exist')) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnL: 0,
        avgPnL: 0,
        avgEdge: 0,
        openPositions: 0,
        totalFees: 0,
      };
    }
    logger.error({ error: e }, 'Failed to get predict stats');
    throw e;
  }
}

/**
 * Convert database row to PredictPosition
 */
function rowToPosition(row: Record<string, unknown>): PredictPosition {
  return {
    id: row.id as string,
    marketTicker: row.market_ticker as string,
    eventTicker: row.event_ticker as string,
    seriesTicker: row.series_ticker as string,
    title: row.title as string,
    outcome: row.outcome as 'yes' | 'no',
    
    entryPrice: parseFloat(row.entry_price as string),
    entryTimestamp: parseInt(row.entry_timestamp as string),
    sizeUsd: parseFloat(row.size_usd as string),
    tokensHeld: parseFloat(row.tokens_held as string),
    tokenMint: row.token_mint as string,
    collateralMint: row.collateral_mint as string,
    entryTxSignature: row.entry_tx_signature as string | undefined,
    entryFeeUsd: row.entry_fee_usd ? parseFloat(row.entry_fee_usd as string) : undefined,
    networkFeeSol: row.network_fee_sol ? parseFloat(row.network_fee_sol as string) : undefined,
    priceImpactPct: row.price_impact_pct ? parseFloat(row.price_impact_pct as string) : undefined,
    
    dataSource: row.data_source as string,
    dataValue: row.data_value as string,
    dataTimestamp: parseInt(row.data_timestamp as string),
    dataConfidence: parseFloat(row.data_confidence as string),
    marketImpliedProb: parseFloat(row.market_implied_prob as string),
    edgePct: parseFloat(row.edge_pct as string),
    
    expirationTime: parseInt(row.expiration_time as string),
    status: row.status as PredictPosition['status'],
    settlementResult: row.settlement_result as 'win' | 'loss' | undefined,
    pnlUsd: row.pnl_usd ? parseFloat(row.pnl_usd as string) : undefined,
    pnlPct: row.pnl_pct ? parseFloat(row.pnl_pct as string) : undefined,
    exitTimestamp: row.exit_timestamp ? parseInt(row.exit_timestamp as string) : undefined,
    exitTxSignature: row.exit_tx_signature as string | undefined,
    
    createdAt: parseInt(row.created_at as string),
    updatedAt: parseInt(row.updated_at as string),
  };
}
