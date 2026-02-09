/**
 * Database Layer
 * Uses Supabase for persistence via query cache and write queue
 * Stores mean reversion positions, trades, and discount history
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeStats, MeanReversionPosition, PairSpread } from '../types';
import { dbLogger } from '../logger';
import { MS_PER_DAY, MS_PER_WEEK } from '../utils/timeConstants';
import type { ShortPosition } from '../signals/premiumShortSignal';
import type { MeanReversionPositionRow, ShortPositionRow } from './supabaseClient';
import {
  upsertMeanReversionPosition,
  upsertShortPosition,
  insertDiscountHistory,
  upsertSystemState,
  fetchOpenPositions,
  fetchOpenShortPositions,
  fetchClosedPositions,
  fetchClosedShortPositions,
  fetchLatestDiscount,
  fetchDiscountAtTimestamp,
  fetchStatsFromSupabase,
  fetchLatestDiscounts,
  fetchRollingDiscountHistory,
  fetchAllRollingDiscountHistory,
  fetchAllPercentileThresholds,
  fetchAllHistoricalVolatilityFromSupabase,
  fetchDiscountHeatmapFromSupabase,
} from './supabaseClient';
import { getQueryCache } from './queryCache';
import { getWriteQueue } from './writeQueue';

type DiscountSnapshot = PairSpread;

// Cache TTL constants
const CACHE_TTL_SHORT = 30000;   // 30 seconds for frequently changing data
const CACHE_TTL_LONG = 600000;   // 10 minutes for analytics data
const CACHE_TTL_MEDIUM = 300000; // 5 minutes for stable data
const CACHE_TTL_PRICE = 10000;   // 10 seconds for price data that needs to be fresh

// Export constants
const DEFAULT_EXPORT_LIMIT = 1000; // Default number of closed positions to export

export class DatabaseManager {
  private initialized: boolean = false;
  private cache = getQueryCache();
  private writeQueue = getWriteQueue();

  constructor() {
    dbLogger.info('DatabaseManager initialized (Supabase mode)');
  }

  /**
   * Initialize database (no-op in Supabase mode)
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    dbLogger.info('DatabaseManager initialized (Supabase mode - no schema setup needed)');
  }


  // ==================== System State Operations ====================

  /**
   * Save system state
   * MIGRATED: Now uses write queue for Supabase (SQLite removed)
   */
  saveState(key: string, value: unknown): void {
    // Queue write with retry logic
    this.writeQueue.enqueue({
      id: `system_state:${key}`,
      operation: () => upsertSystemState(key, JSON.stringify(value)),
      retryCount: 0,
      maxRetries: 3,
      timestamp: Date.now(),
    });

    // Invalidate cache
    this.cache.invalidate(`state:${key}`);
  }

  // getState method removed - was unused dead code

  /**
   * Close database connection (no-op in Supabase mode)
   */
  close(): void {
    dbLogger.info('DatabaseManager close() called (no-op in Supabase mode)');
  }

  // ==================== Mean Reversion Position Operations ====================

  /**
   * Save a mean reversion position
   * MIGRATED: Now writes ONLY to Supabase via write queue (SQLite removed)
   * Replaces fire-and-forget with retry logic
   */
  savePosition(position: MeanReversionPosition): void {
    // Queue write with retry logic (no more fire-and-forget!)
    this.writeQueue.enqueue({
      id: `position:${position.id}`,
      operation: () => upsertMeanReversionPosition({
        id: position.id,
        stock_ticker: position.stockTicker,
        buy_symbol: position.buySymbol,
        buy_mint: position.buyMint,
        sell_symbol: position.sellSymbol,
        sell_mint: position.sellMint,
        entry_spread_pct: position.entrySpreadPct,
        entry_timestamp: position.entryTimestamp,
        size_usd: position.sizeUsd,
        buy_amount: position.buyAmount,
        sell_amount: position.sellAmount,
        status: position.status,
        exit_spread_pct: position.exitSpreadPct,
        exit_timestamp: position.exitTimestamp,
        exit_reason: position.exitReason,
        pnl_usd: position.pnlUsd,
        pnl_pct: position.pnlPct,
        buy_pool_address: position.buyPoolAddress,
        buy_decimals: position.buyDecimals,
        buy_dex_id: position.buyDexId,
        entry_tx_signature: position.entryTxSignature,
        exit_tx_signature: position.exitTxSignature,
        total_fees_usd: position.totalFeesUsd,
        entry_fees_usd: position.entryFeesUsd,
        exit_fees_usd: position.exitFeesUsd,
        priority_fees_usd: position.priorityFeesUsd,
        network_fees_usd: position.networkFeesUsd,
        slippage_usd: position.slippageUsd,
        entry_tvl_usd: position.entryTvlUsd,
        entry_route: position.entryRoute,
        exit_route: position.exitRoute,
        platform_fees_usd: position.platformFeesUsd,
        entry_stock_price: position.entryStockPrice,
      }),
      retryCount: 0,
      maxRetries: 3,
      timestamp: Date.now(),
    });

    // Invalidate position cache so next read gets fresh data
    this.cache.invalidate('positions:');
  }

  /**
   * Get open mean reversion positions
   * MIGRATED: Now reads from Supabase with 30s cache (was SQLite)
   */
  async getOpenPositions(): Promise<MeanReversionPosition[]> {
    const cacheKey = 'positions:open';
    const cached = this.cache.get<MeanReversionPosition[]>(cacheKey);
    if (cached) return cached;

    const rows = await fetchOpenPositions();
    const positions = rows.map((row) => this.rowToPosition(row));
    this.cache.set(cacheKey, positions, CACHE_TTL_SHORT); // 30s TTL
    return positions;
  }

  /**
   * Get closed mean reversion positions
   */
  async getClosedPositions(limit: number = 100, maxAgeMs?: number): Promise<MeanReversionPosition[]> {
    const cacheKey = `positions:closed:${limit}:${maxAgeMs || 'all'}`;
    const cached = this.cache.get<MeanReversionPositionRow[]>(cacheKey);
    if (cached) return cached.map(row => this.rowToPosition(row));

    // Note: maxAgeMs not yet supported by fetchClosedPositions - always returns most recent
    const rows = await fetchClosedPositions(limit);
    this.cache.set(cacheKey, rows, CACHE_TTL_MEDIUM); // 5min TTL
    return rows.map(row => this.rowToPosition(row));
  }

  /**
   * Convert row to Position
   */
  private rowToPosition(row: MeanReversionPositionRow): MeanReversionPosition {
    return {
      id: row.id as string,
      stockTicker: row.stock_ticker as string,
      buySymbol: row.buy_symbol as string,
      buyMint: row.buy_mint as string,
      buyPoolAddress: row.buy_pool_address as string | undefined,
      buyDexId: row.buy_dex_id as string | undefined,
      buyDecimals: row.buy_decimals as number | undefined,
      sellSymbol: row.sell_symbol as string,
      sellMint: row.sell_mint as string,
      entrySpreadPct: row.entry_spread_pct as number,
      entryTimestamp: row.entry_timestamp as number,
      sizeUsd: row.size_usd as number,
      buyAmount: row.buy_amount as number,
      sellAmount: row.sell_amount as number,
      status: row.status as 'open' | 'closed',
      exitSpreadPct: row.exit_spread_pct as number | undefined,
      exitTimestamp: row.exit_timestamp as number | undefined,
      exitReason: row.exit_reason as MeanReversionPosition['exitReason'],
      pnlUsd: row.pnl_usd as number | undefined,
      pnlPct: row.pnl_pct as number | undefined,
      entryTxSignature: row.entry_tx_signature as string | undefined,
      exitTxSignature: row.exit_tx_signature as string | undefined,
      totalFeesUsd: row.total_fees_usd as number | undefined,
      entryFeesUsd: row.entry_fees_usd as number | undefined,
      exitFeesUsd: row.exit_fees_usd as number | undefined,
      priorityFeesUsd: row.priority_fees_usd as number | undefined,
      networkFeesUsd: row.network_fees_usd as number | undefined,
      slippageUsd: row.slippage_usd as number | undefined,
      platformFeesUsd: row.platform_fees_usd as number | undefined,
      entryTvlUsd: row.entry_tvl_usd as number | undefined,
      entryRoute: row.entry_route as MeanReversionPosition['entryRoute'],
      exitRoute: row.exit_route as MeanReversionPosition['exitRoute'],
      entryStockPrice: row.entry_stock_price as number | undefined,
    };
  }

  /**
   * Save discount snapshot
   */
  saveDiscountSnapshot(snapshot: DiscountSnapshot): void {
    // Validate required fields before attempting insert
    if (!snapshot.stockTicker ||
        !snapshot.tokenA?.symbol || !isFinite(snapshot.tokenA?.price) ||
        !snapshot.tokenB?.symbol || !isFinite(snapshot.tokenB?.price) ||
        !isFinite(snapshot.spreadPct) || !isFinite(snapshot.spreadAbsolute) ||
        !snapshot.timestamp) {
      dbLogger.warn({
        ticker: snapshot.stockTicker,
        hasTokenA: !!snapshot.tokenA?.symbol,
        tokenAPrice: snapshot.tokenA?.price,
        hasTokenB: !!snapshot.tokenB?.symbol,
        tokenBPrice: snapshot.tokenB?.price,
      }, 'Skipping invalid discount data - missing required fields');
      return;
    }

    // Write to Supabase only (SQLite writes removed to save disk space)
    // Volatility calculations now read from Supabase at startup
    insertDiscountHistory({
      stock_ticker: snapshot.stockTicker,
      token_a_symbol: snapshot.tokenA.symbol,
      token_a_price: snapshot.tokenA.price,
      token_a_discount_vs_stock: snapshot.tokenA.discountVsStock,
      token_b_symbol: snapshot.tokenB.symbol,
      token_b_price: snapshot.tokenB.price,
      token_b_discount_vs_stock: snapshot.tokenB.discountVsStock,
      spread_pct: snapshot.spreadPct,
      spread_absolute: snapshot.spreadAbsolute,
      stock_price: snapshot.stockPrice,
      more_discounted: snapshot.moreDiscounted,
      timestamp: snapshot.timestamp,
    }).catch((err) => {
      dbLogger.error({ err, ticker: snapshot.stockTicker }, 'Failed to save discount snapshot');
    });
  }

  /**
   * Get the latest discount for a specific ticker
   */
  async getLatestDiscount(stockTicker: string, tokenSymbol?: string): Promise<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number } | null> {
    // CRITICAL BUG FIX: Now reads from Supabase with 10s cache
    // BEFORE: discount_history was written ONLY to Supabase (line 508-523)
    //         but this method read from EMPTY SQLite table
    // AFTER:  Reads from Supabase where the data actually is
    // This was causing wrong NAV calculations in dashboard!

    const cacheKey = `discount:latest:${stockTicker}:${tokenSymbol || 'any'}`;
    const cached = this.cache.get<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number }>(cacheKey);
    if (cached) return cached;

    const result = await fetchLatestDiscount(stockTicker, tokenSymbol);
    if (result) this.cache.set(cacheKey, result, CACHE_TTL_PRICE); // 10s TTL - price data needs to be fresh
    return result;
  }

  /**
   * Get discount data at or before a specific timestamp
   * Used to get the actual stock price at position entry time
   * MIGRATED: Now reads from Supabase with 5min cache (historical data)
   */
  async getDiscountAtTimestamp(stockTicker: string, tokenSymbol: string, timestamp: number): Promise<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number } | null> {
    const cacheKey = `discount:timestamp:${stockTicker}:${tokenSymbol}:${timestamp}`;
    const cached = this.cache.get<{ discount: number; tokenPrice: number; stockPrice: number; timestamp: number }>(cacheKey);
    if (cached) return cached;

    const result = await fetchDiscountAtTimestamp(stockTicker, tokenSymbol, timestamp);
    if (result) this.cache.set(cacheKey, result, CACHE_TTL_MEDIUM); // 5min TTL - historical data doesn't change
    return result;
  }

  /**
   * Prune old discount history to keep database size manageable
   * Keeps last 31 days of data (same as Supabase retention)
   * @returns Number of rows deleted
   * Note: Pruning handled by Supabase retention policies in production
   */
  pruneOldDiscountHistory(_retentionDays: number = 8): number {
    // No-op in Supabase mode - pruning handled by database retention policies
    return 0;
  }

  /**
   * Get rolling discount history for a token (for percentile calculation)
   * Returns array of positive discount values within the time window
   * Only includes positive discounts (buying opportunities)
   *
   * @param tokenSymbol - Token symbol (e.g., 'xSPY', 'SPYx')
   * @param windowMs - Rolling window in milliseconds (default 7 days)
   * @returns Array of discount values (positive only)
   */
  async getRollingDiscountHistory(tokenSymbol: string, windowMs: number = MS_PER_WEEK): Promise<number[]> {
    const cacheKey = `discount:rolling:${tokenSymbol}:${windowMs}`;
    const cached = this.cache.get<number[]>(cacheKey);
    if (cached) return cached;

    const rows = await fetchRollingDiscountHistory(tokenSymbol, windowMs);
    const discounts = rows.map(r => r.discount);
    this.cache.set(cacheKey, discounts, CACHE_TTL_MEDIUM); // 5min TTL
    return discounts;
  }

  /**
   * Get rolling discount history for all tokens at once (batch query)
   * More efficient than calling getRollingDiscountHistory for each token
   *
   * @param windowMs - Rolling window in milliseconds (default 7 days)
   * @returns Map of token symbol -> array of discount values
   */
  async getAllRollingDiscountHistory(windowMs: number = MS_PER_WEEK): Promise<Map<string, number[]>> {
    const cacheKey = `discount:rolling:all:${windowMs}`;
    const cached = this.cache.get<Map<string, number[]>>(cacheKey);
    if (cached) return cached;

    const rawMap = await fetchAllRollingDiscountHistory(windowMs);
    const map = new Map<string, number[]>();
    for (const [symbol, rows] of rawMap.entries()) {
      map.set(symbol, rows.map(r => r.discount));
    }
    this.cache.set(cacheKey, map, CACHE_TTL_MEDIUM); // 5min TTL
    return map;
  }

  /**
   * Get percentile thresholds for all tokens (memory efficient - calculated in PostgreSQL)
   */
  async getAllPercentileThresholds(
    windowMs: number = MS_PER_WEEK,
    percentile: number = 90
  ): Promise<Map<string, { percentileValue: number; sampleCount: number }>> {
    const cacheKey = `percentile:all:${windowMs}:${percentile}`;
    const cached = this.cache.get<Map<string, { percentileValue: number; sampleCount: number }>>(cacheKey);
    if (cached) return cached;

    const map = await fetchAllPercentileThresholds(windowMs, percentile);
    this.cache.set(cacheKey, map, CACHE_TTL_MEDIUM); // 5min TTL
    return map;
  }

  /**
   * Get latest discounts for all tokens (for dashboard)
   * Keyed by token symbol (not stock ticker) to handle multiple tokens per stock
   */
  async getLatestDiscounts(): Promise<Map<string, number>> {
    return fetchLatestDiscounts();
  }

  /**
   * Calculate historical volatility for a token from price history
   * Uses standard deviation of hourly returns over the past week
   * Returns volatility as a percentage (e.g., 2.5 means 2.5% daily volatility)
   */
  async getHistoricalVolatility(stockTicker: string, windowDays: number = 7): Promise<number | null> {
    try {
      const allVolatility = await this.getAllHistoricalVolatility(windowDays);
      return allVolatility.get(stockTicker) ?? null;
    } catch (error) {
      dbLogger.warn({ stockTicker, windowDays, error }, 'Failed to get historical volatility');
      return null;
    }
  }


  /**
   * Get historical volatility for all tokens at once (batch query)
   * More efficient than calling getHistoricalVolatility for each token
   * Returns Map keyed by STOCK TICKER (not token symbol) for consistency with API lookups
   */
  async getAllHistoricalVolatility(windowDays: number = 7): Promise<Map<string, number>> {
    const cacheKey = `volatility:all:${windowDays}`;
    const cached = this.cache.get<Map<string, number>>(cacheKey);
    if (cached) return cached;

    const map = await fetchAllHistoricalVolatilityFromSupabase(windowDays);
    this.cache.set(cacheKey, map, CACHE_TTL_LONG); // 10min TTL
    return map;
  }

  /**
   * Get trading statistics with optional time range filter
   */
  async getStats(_sinceTimestamp?: number): Promise<TradeStats> {
    return fetchStatsFromSupabase(_sinceTimestamp);
  }

  // ==================== Export Functions ====================

  /**
   * Export positions to CSV
   */
  async exportPositionsToCSV(outputPath: string): Promise<void> {
    try {
      // Get both open and closed positions
      const openPositions = await this.getOpenPositions();
      const closedPositions = await this.getClosedPositions(DEFAULT_EXPORT_LIMIT); // Get last 1000 closed
      const allPositions = [...openPositions, ...closedPositions];

      if (allPositions.length === 0) {
        dbLogger.info('No positions to export');
        return;
      }

      // CSV header
      const header = 'id,stock_ticker,buy_symbol,entry_spread_pct,entry_timestamp,size_usd,status,exit_spread_pct,exit_timestamp,pnl_usd\n';

      // CSV rows
      const rows = allPositions.map(pos => {
        const entryTime = new Date(pos.entryTimestamp).toISOString();
        const exitTime = pos.exitTimestamp ? new Date(pos.exitTimestamp).toISOString() : '';

        return [
          pos.id,
          pos.stockTicker,
          pos.buySymbol,
          pos.entrySpreadPct.toFixed(4),
          entryTime,
          pos.sizeUsd.toFixed(2),
          pos.status,
          pos.exitSpreadPct?.toFixed(4) || '',
          exitTime,
          pos.pnlUsd?.toFixed(2) || ''
        ].join(',');
      }).join('\n');

      fs.writeFileSync(outputPath, header + rows);
      dbLogger.info({ outputPath, count: allPositions.length }, 'Exported positions to CSV');
    } catch (error) {
      dbLogger.error({ error, outputPath }, 'Failed to export positions to CSV');
    }
  }

  /**
   * Export discount history to CSV
   */
  async exportDiscountHistoryToCSV(outputPath: string): Promise<void> {
    try {
      // This is a simplified export - getting latest discounts for each ticker
      const latestDiscounts = await this.getLatestDiscounts();

      if (latestDiscounts.size === 0) {
        dbLogger.info('No discount history to export');
        return;
      }

      // CSV header
      const header = 'stock_ticker,latest_discount_pct,timestamp\n';

      // CSV rows
      const rows = Array.from(latestDiscounts.entries()).map(([ticker, discount]) => {
        return [
          ticker,
          discount.toFixed(4),
          new Date().toISOString()
        ].join(',');
      }).join('\n');

      fs.writeFileSync(outputPath, header + rows);
      dbLogger.info({ outputPath, count: latestDiscounts.size }, 'Exported discount history to CSV');
    } catch (error) {
      dbLogger.error({ error, outputPath }, 'Failed to export discount history to CSV');
    }
  }

  /**
   * Export all data for analysis
   */
  async exportAllToCSV(outputDir: string): Promise<void> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    await this.exportPositionsToCSV(path.join(outputDir, `positions_${timestamp}.csv`));
    await this.exportDiscountHistoryToCSV(path.join(outputDir, `discounts_${timestamp}.csv`));

    dbLogger.info({ outputDir }, 'Exported all data to CSV');
  }

  // ==================== Short Position Operations (Flash Trade perps) ====================

  /**
   * Save a short position (insert or update)
   * MIGRATED: Now writes ONLY to Supabase via write queue (SQLite removed)
   */
  saveShortPosition(position: ShortPosition): void {
    // Queue write with retry logic
    this.writeQueue.enqueue({
      id: `short_position:${position.id}`,
      operation: () => upsertShortPosition({
        id: position.id,
        ticker: position.ticker,
        rstock_symbol: position.flashSymbol,
        token_symbol: position.tokenSymbol,
        token_mint: position.tokenMint,
        entry_premium_pct: position.entryPremiumPct,
        entry_stock_price: position.entryStockPrice,
        entry_timestamp: position.entryTimestamp,
        collateral_usd: position.collateralUsd,
        leverage: position.leverage,
        status: position.status,
        entry_tx_signature: position.entryTxSignature,
        exit_premium_pct: position.exitPremiumPct,
        exit_timestamp: position.exitTimestamp,
        exit_reason: position.exitReason,
        exit_tx_signature: position.exitTxSignature,
        pnl_usd: position.pnlUsd,
        pnl_pct: position.pnlPct,
      }),
      retryCount: 0,
      maxRetries: 3,
      timestamp: Date.now(),
    });

    // Invalidate short position cache
    this.cache.invalidate('short_positions:');
  }

  /**
   * Get open short positions
   * MIGRATED: Now reads from Supabase with 30s cache (hot path)
   */
  async getOpenShortPositions(): Promise<ShortPosition[]> {
    const cacheKey = 'short_positions:open';
    const cached = this.cache.get<ShortPosition[]>(cacheKey);
    if (cached) return cached;

    const rows = await fetchOpenShortPositions();
    const positions = rows.map((row) => this.rowToShortPosition(row));
    this.cache.set(cacheKey, positions, CACHE_TTL_SHORT); // 30s TTL
    return positions;
  }

  /**
   * Get closed short positions (most recent first)
   */
  async getClosedShortPositions(limit: number = 100, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<ShortPosition[]> {
    const cacheKey = `short_positions:closed:${limit}:${maxAgeMs}`;
    const cached = this.cache.get<ShortPosition[]>(cacheKey);
    if (cached) return cached;

    const rows = await fetchClosedShortPositions(limit, maxAgeMs);
    const positions = rows.map((row) => this.rowToShortPosition(row));
    this.cache.set(cacheKey, positions, CACHE_TTL_MEDIUM); // 5min TTL
    return positions;
  }

  /**
   * Check if there's an open short position for a ticker
   */
  async hasOpenShortPosition(ticker: string): Promise<boolean> {
    const positions = await this.getOpenShortPositions();
    return positions.some(p => p.ticker === ticker);
  }

  /**
   * Convert database row to ShortPosition
   */
  private rowToShortPosition(row: ShortPositionRow): ShortPosition {
    return {
      id: row.id,
      ticker: row.ticker,
      flashSymbol: row.rstock_symbol as ShortPosition['flashSymbol'],
      tokenSymbol: row.token_symbol || '',  // May be empty for legacy positions
      tokenMint: row.token_mint || '',      // May be empty for legacy positions
      entryPremiumPct: row.entry_premium_pct,
      entryStockPrice: row.entry_stock_price,
      entryTimestamp: row.entry_timestamp,
      collateralUsd: row.collateral_usd,
      leverage: row.leverage,
      status: row.status as 'open' | 'closed',
      entryTxSignature: row.entry_tx_signature || undefined,
      exitPremiumPct: row.exit_premium_pct || undefined,
      exitTimestamp: row.exit_timestamp || undefined,
      exitReason: row.exit_reason as ShortPosition['exitReason'],
      exitTxSignature: row.exit_tx_signature || undefined,
      pnlUsd: row.pnl_usd || undefined,
      pnlPct: row.pnl_pct || undefined,
    };
  }

  // REMOVED: getDiscountCorrelationData - was unused stub method

  /**
   * Get discount heatmap data - discounts over time for all tokens
   * Returns data suitable for a GitHub-style contribution heatmap
   */
  async getDiscountHeatmapData(_sinceTimestamp?: number, bucketMinutes: number = 15): Promise<{
    symbols: string[];
    timestamps: number[];
    data: (number | null)[][];  // [symbolIndex][timeIndex] = discount or null
  }> {
    const since = _sinceTimestamp || Date.now() - MS_PER_DAY;
    const cacheKey = `heatmap:${since}:${bucketMinutes}`;
    const cached = this.cache.get<{
      symbols: string[];
      timestamps: number[];
      data: (number | null)[][];
    }>(cacheKey);
    if (cached) return cached;

    const result = await fetchDiscountHeatmapFromSupabase(since, bucketMinutes);
    this.cache.set(cacheKey, result, CACHE_TTL_LONG); // 10min TTL
    return result;
  }

  /**
   * Get hourly aggregated discount data for Supabase sync
   * Returns data ready to be pushed to discount_heatmap_summary table
   * Note: Not used in Supabase-only mode (legacy SQLite compatibility method)
   */
  getHourlySummaryForSync(_sinceTimestamp?: number): Array<{
    symbol: string;
    bucket_timestamp: number;
    avg_discount: number;
    sample_count: number;
  }> {
    // Stub - not needed in Supabase-only mode
    return [];
  }
}

// Singleton
let databaseInstance: DatabaseManager | null = null;

/**
 * Get the singleton DatabaseManager instance, creating it if it doesn't exist
 */
export function getDatabase(): DatabaseManager {
  if (!databaseInstance) {
    databaseInstance = new DatabaseManager();
    databaseInstance.initialize();
  }
  return databaseInstance;
}
