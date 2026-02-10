/**
 * Rolling Performance Tracker
 *
 * Tracks per-symbol win rate from recent trades and provides dynamic
 * threshold adjustments for underperformers.
 *
 * Strategy:
 * - Track trailing 20-trade win rate per symbol
 * - If WR < 30%, add +1% to entry threshold
 * - Recovers automatically when performance improves
 * - Caches results with 5-minute TTL to minimize DB load
 */

import { getTradesPool, MeanReversionPositionRow } from '../db/supabaseClient';
import loggerInstance from '../logger';
import { MS_PER_MINUTE, MS_PER_HOUR } from '../constants';

const logger = loggerInstance.child({ module: 'performanceTracker' });

// ==================== Configuration ====================

export const PERFORMANCE_CONFIG = {
  TRAILING_TRADES: 20,           // Number of recent trades to consider
  MIN_TRADES_REQUIRED: 5,        // Minimum trades before applying adjustment
  LOW_WR_THRESHOLD: 0.30,        // 30% - below this triggers penalty
  THRESHOLD_PENALTY_PCT: 1.0,    // +1% to entry threshold for poor performers
  CACHE_TTL_MS: 5 * MS_PER_MINUTE,   // 5 minute cache
  ENABLED: false,                // DISABLED - was blocking all entries (Feb 10)
} as const;

// ==================== Types ====================

interface SymbolPerformance {
  symbol: string;
  stockTicker: string;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  thresholdAdjustment: number;  // Additional % to add to entry threshold
  lastUpdated: number;
}

interface CacheEntry {
  data: SymbolPerformance;
  expiresAt: number;
}

// ==================== Cache ====================

const performanceCache = new Map<string, CacheEntry>();

// ==================== Core Functions ====================

/**
 * Get performance adjustment for a symbol.
 * Returns additional percentage points to add to entry threshold.
 *
 * @param symbol - Token symbol (e.g., 'xSPY', 'TSLAx')
 * @returns Additional threshold percentage (0 if performing well, 1.0 if poor)
 */
export async function getPerformanceAdjustment(symbol: string): Promise<number> {
  if (!PERFORMANCE_CONFIG.ENABLED) {
    return 0;
  }

  const perf = await getSymbolPerformance(symbol);
  return perf?.thresholdAdjustment ?? 0;
}

/**
 * Get performance adjustment synchronously from cache.
 * Returns 0 if not cached (safe default - no penalty).
 */
export function getPerformanceAdjustmentSync(symbol: string): number {
  if (!PERFORMANCE_CONFIG.ENABLED) {
    return 0;
  }

  const cached = performanceCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data.thresholdAdjustment;
  }

  // Trigger async refresh but return safe default
  getSymbolPerformance(symbol).catch(error => {
    logger.debug({ symbol, error }, 'Failed to refresh symbol performance (background)');
  });
  return 0;
}

/**
 * Get full performance data for a symbol.
 */
export async function getSymbolPerformance(symbol: string): Promise<SymbolPerformance | null> {
  // Check cache
  const cached = performanceCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Fetch fresh data
  try {
    const perf = await fetchSymbolPerformance(symbol);
    if (perf) {
      performanceCache.set(symbol, {
        data: perf,
        expiresAt: Date.now() + PERFORMANCE_CONFIG.CACHE_TTL_MS,
      });
    }
    return perf;
  } catch (error) {
    logger.error({ symbol, error }, 'Failed to fetch symbol performance');
    return cached?.data ?? null;  // Return stale data if available
  }
}

/**
 * Fetch performance data from Supabase.
 */
async function fetchSymbolPerformance(symbol: string): Promise<SymbolPerformance | null> {
  const pool = getTradesPool();
  if (!pool) {
    return null;
  }

  // Extract stock ticker from token symbol (xSPY -> SPY, TSLAx -> TSLA)
  const stockTicker = symbol.replace(/^[a-z]/, '').replace(/[a-z]+$/, '');

  try {
    // Query recent closed trades for this symbol
    const result = await pool.query(`
      SELECT
        buy_symbol,
        pnl_usd,
        exit_timestamp
      FROM mean_reversion_positions
      WHERE buy_symbol = $1
        AND status = 'closed'
        AND pnl_usd IS NOT NULL
      ORDER BY exit_timestamp DESC
      LIMIT $2
    `, [symbol, PERFORMANCE_CONFIG.TRAILING_TRADES]);

    const trades = result.rows;
    const totalTrades = trades.length;

    if (totalTrades < PERFORMANCE_CONFIG.MIN_TRADES_REQUIRED) {
      // Not enough data - no adjustment
      return {
        symbol,
        stockTicker,
        totalTrades,
        winningTrades: 0,
        winRate: 0,
        thresholdAdjustment: 0,
        lastUpdated: Date.now(),
      };
    }

    const winningTrades = trades.filter((t: MeanReversionPositionRow) => Number(t.pnl_usd) > 0).length;
    const winRate = winningTrades / totalTrades;

    // Calculate adjustment
    let thresholdAdjustment = 0;
    if (winRate < PERFORMANCE_CONFIG.LOW_WR_THRESHOLD) {
      thresholdAdjustment = PERFORMANCE_CONFIG.THRESHOLD_PENALTY_PCT;
      logger.info({
        symbol,
        stockTicker,
        winRate: (winRate * 100).toFixed(1) + '%',
        totalTrades,
        adjustment: `+${thresholdAdjustment}%`,
      }, 'Low win rate detected - applying threshold penalty');
    }

    return {
      symbol,
      stockTicker,
      totalTrades,
      winningTrades,
      winRate,
      thresholdAdjustment,
      lastUpdated: Date.now(),
    };

  } catch (error) {
    logger.error({ symbol, error }, 'Failed to query trade performance');
    return null;
  }
}

/**
 * Get performance data for all recently traded symbols.
 * Useful for dashboard display.
 */
export async function getAllSymbolPerformance(): Promise<SymbolPerformance[]> {
  const pool = getTradesPool();
  if (!pool) {
    return [];
  }

  try {
    // Get all symbols with recent trades
    const symbolsResult = await pool.query(`
      SELECT DISTINCT buy_symbol
      FROM mean_reversion_positions
      WHERE status = 'closed'
        AND exit_timestamp > $1
    `, [Date.now() - 7 * 24 * MS_PER_HOUR]); // Last 7 days

    const symbols = symbolsResult.rows.map((r: { buy_symbol: string }) => r.buy_symbol);

    // Fetch performance for each (uses cache)
    const performances = await Promise.all(
      symbols.map((s: string) => getSymbolPerformance(s))
    );

    return performances.filter((p): p is SymbolPerformance => p !== null);

  } catch (error) {
    logger.error({ error }, 'Failed to fetch all symbol performances');
    return [];
  }
}

/**
 * Clear the performance cache (useful for testing or forced refresh).
 */
export function clearPerformanceCache(): void {
  performanceCache.clear();
  logger.info('Performance cache cleared');
}

/**
 * Get cache stats for monitoring.
 */
export function getCacheStats(): { size: number; symbols: string[] } {
  return {
    size: performanceCache.size,
    symbols: Array.from(performanceCache.keys()),
  };
}
