/**
 * Algorithmic Entry Threshold Calculator
 * 
 * Calculates minimum profitable entry spread per token based on historical data.
 * Falls back to TVL-based calculation if insufficient data.
 */

import { Pool } from 'pg';
import logger from '../logger';

// Pool singleton (same pattern as supabaseClient.ts)
let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!pool && process.env.TRADES_DB_URL) {
    pool = new Pool({
      connectionString: process.env.TRADES_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

export interface TokenProfitableSpread {
  stockTicker: string;
  minProfitableSpread: number;  // Minimum spread where win rate >= threshold
  confidence: 'high' | 'medium' | 'low';  // Based on sample size
  sampleSize: number;
  winRateAtThreshold: number;
  lastUpdated: number;
}

// Minimum win rate to consider a spread level "profitable"
const MIN_WIN_RATE = 0.40;  // 40%
const MIN_SAMPLES_HIGH_CONFIDENCE = 10;
const MIN_SAMPLES_MEDIUM_CONFIDENCE = 5;
const LOOKBACK_DAYS = 14;

/**
 * Calculate minimum profitable spread for all tokens from historical data
 * Uses PostgreSQL to efficiently process trade history
 */
export async function calculateAllProfitableSpreads(): Promise<Map<string, TokenProfitableSpread>> {
  const db = getPool();
  if (!db) return new Map();

  try {
    const cutoffTime = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    
    // Find the minimum spread bucket with win rate >= MIN_WIN_RATE for each token
    const result = await db.query(`
      WITH spread_stats AS (
        SELECT 
          stock_ticker,
          FLOOR(entry_spread_pct * 2) / 2 as spread_bucket,  -- 0.5% buckets
          COUNT(*) as trades,
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate
        FROM mean_reversion_positions
        WHERE status = 'closed' 
          AND exit_timestamp >= $1
          AND entry_spread_pct IS NOT NULL
          AND entry_spread_pct > 0
        GROUP BY stock_ticker, FLOOR(entry_spread_pct * 2) / 2
        HAVING COUNT(*) >= $2
      ),
      profitable_spreads AS (
        SELECT 
          stock_ticker,
          spread_bucket,
          trades,
          win_rate,
          ROW_NUMBER() OVER (PARTITION BY stock_ticker ORDER BY spread_bucket ASC) as rn
        FROM spread_stats
        WHERE win_rate >= $3
      )
      SELECT 
        stock_ticker,
        spread_bucket as min_profitable_spread,
        trades as sample_size,
        win_rate
      FROM profitable_spreads
      WHERE rn = 1
      ORDER BY stock_ticker
    `, [cutoffTime, MIN_SAMPLES_MEDIUM_CONFIDENCE, MIN_WIN_RATE]);

    const map = new Map<string, TokenProfitableSpread>();
    
    for (const row of result.rows) {
      const confidence = row.sample_size >= MIN_SAMPLES_HIGH_CONFIDENCE ? 'high' 
        : row.sample_size >= MIN_SAMPLES_MEDIUM_CONFIDENCE ? 'medium' 
        : 'low';
      
      map.set(row.stock_ticker, {
        stockTicker: row.stock_ticker,
        minProfitableSpread: parseFloat(row.min_profitable_spread),
        confidence,
        sampleSize: parseInt(row.sample_size),
        winRateAtThreshold: parseFloat(row.win_rate),
        lastUpdated: Date.now(),
      });
    }

    logger.info({
      tokensWithData: map.size,
      lookbackDays: LOOKBACK_DAYS,
      minWinRate: MIN_WIN_RATE,
    }, 'Calculated profitable spreads from historical data');

    return map;
  } catch (error) {
    logger.error({ error }, 'Failed to calculate profitable spreads');
    return new Map();
  }
}

/**
 * Get dynamic entry threshold for a token
 * Priority: Historical profitable spread > Percentile > TVL-based minimum
 */
export function getDynamicEntryThreshold(
  stockTicker: string,
  profitableSpreads: Map<string, TokenProfitableSpread>,
  tvlBasedThreshold: number,
  percentileThreshold?: number
): { threshold: number; source: string } {
  
  const historicalData = profitableSpreads.get(stockTicker);
  
  // If we have high-confidence historical data, use it
  if (historicalData && historicalData.confidence === 'high') {
    // Add 0.5% buffer to historical minimum
    const threshold = Math.max(
      historicalData.minProfitableSpread + 0.5,
      tvlBasedThreshold  // Never go below TVL-based minimum
    );
    return { 
      threshold, 
      source: `historical (${historicalData.winRateAtThreshold.toFixed(0)}% WR at ${historicalData.minProfitableSpread}%)` 
    };
  }
  
  // If we have medium-confidence data, blend with percentile
  if (historicalData && historicalData.confidence === 'medium' && percentileThreshold) {
    const historicalWithBuffer = historicalData.minProfitableSpread + 0.5;
    const threshold = Math.max(
      (historicalWithBuffer + percentileThreshold) / 2,  // Average
      tvlBasedThreshold
    );
    return { threshold, source: 'blended (historical + percentile)' };
  }
  
  // Fall back to percentile or TVL-based
  if (percentileThreshold && percentileThreshold > tvlBasedThreshold) {
    return { threshold: percentileThreshold, source: 'percentile' };
  }
  
  return { threshold: tvlBasedThreshold, source: 'tvl-based' };
}
