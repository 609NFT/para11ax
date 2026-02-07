/**
 * Volatility Feed - Calculates volatility from internal price history
 * Falls back to Twelve Data API for new tokens without enough historical data
 * Used to calculate dynamic stop-loss thresholds based on actual volatility
 */

import axios from 'axios';
import logger from '../logger';
import { STOCK_STOP_LOSS_DEFAULT_PCT, DYNAMIC_FLOOR_FORMULA, MARKET_REGIME, getSessionAdjustments } from '../constants';
import { getDatabase } from '../db/database';
import { fetchAllHistoricalVolatilityFromSupabase } from '../db/supabaseClient';
import { isTokenEnabledByLiquidity } from '../liquidity/liquidityChecker';

const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';
const ATR_PERIOD = 14; // 14-day ATR is standard
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours - volatility doesn't change that fast

// Blending weights for combining API and internal volatility
// API is stronger indicator (14-day ATR) but internal captures on-chain spread behavior
const API_VOLATILITY_WEIGHT = 0.6;  // 60% weight to API (underlying stock)
const INTERNAL_VOLATILITY_WEIGHT = 0.4;  // 40% weight to internal (on-chain behavior)

interface ATRResponse {
  meta: {
    symbol: string;
    interval: string;
    currency: string;
    exchange: string;
    type: string;
  };
  values: Array<{
    datetime: string;
    atr: string;
  }>;
  status: string;
}

interface PriceResponse {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  previous_close: string;
}

interface VolatilityCache {
  atrPct: number; // ATR as percentage of price
  atrAbsolute: number; // ATR in dollars
  price: number; // Current price
  timestamp: number;
}

// Cache volatility data per symbol
const volatilityCache: Map<string, VolatilityCache> = new Map();

const feedLogger = logger.child({ component: 'volatility-feed' });

/**
 * Get the Twelve Data API key from environment
 */
function getApiKey(): string | null {
  return process.env.TWELVE_DATA_API_KEY || null;
}

// Rate limit: 8 API credits per minute on free tier
// Each symbol needs 2 calls (ATR + quote) = 4 symbols per minute max
// Be conservative: 20 seconds between symbols to avoid rate limits
const MIN_DELAY_BETWEEN_SYMBOLS_MS = 20000; // 20 seconds between symbols
let lastApiCallTime: number = 0;
let startupDelayApplied: boolean = false;
const STARTUP_DELAY_MS = 60000; // 60 second delay on startup to let rate limit window reset
let rateLimitBackoffMs = 0; // Additional backoff when rate limited

/**
 * Wait if needed to respect rate limits
 */
async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const baseDelay = MIN_DELAY_BETWEEN_SYMBOLS_MS + rateLimitBackoffMs;
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < baseDelay && lastApiCallTime > 0) {
    const waitTime = baseDelay - timeSinceLastCall;
    feedLogger.debug({ waitTime, backoff: rateLimitBackoffMs }, 'Waiting to respect Twelve Data rate limit');
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
  // Decay backoff over time
  if (rateLimitBackoffMs > 0) {
    rateLimitBackoffMs = Math.max(0, rateLimitBackoffMs - 5000);
  }
}

/**
 * Record a rate limit hit - increases backoff
 */
function recordRateLimit(): void {
  rateLimitBackoffMs = Math.min(rateLimitBackoffMs + 60000, 300000); // Add 60s, max 5 min
  feedLogger.warn({ backoffMs: rateLimitBackoffMs }, 'Rate limit hit - increasing backoff');
}

/**
 * Fetch ATR (Average True Range) for a symbol
 * ATR measures volatility - higher ATR = more volatile
 */
async function fetchATR(symbol: string): Promise<{ atr: number; price: number } | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    feedLogger.warn('TWELVE_DATA_API_KEY not set - using fallback volatility');
    return null;
  }

  // Respect rate limits (8 credits/min, 2 per symbol = 4 symbols/min)
  await respectRateLimit();

  try {
    // Fetch ATR first
    const atrResponse = await axios.get<ATRResponse>(`${TWELVE_DATA_BASE_URL}/atr`, {
      params: {
        symbol,
        interval: '1day',
        time_period: ATR_PERIOD,
        apikey: apiKey,
        outputsize: 1,
      },
      timeout: 10000,
    });

    // Check for rate limit error
    if ((atrResponse.data as unknown as { code?: number }).code === 429) {
      recordRateLimit();
      feedLogger.warn({ symbol }, 'Rate limited by Twelve Data - backing off');
      return null;
    }

    // Check for API errors
    if (atrResponse.data.status === 'error' || !atrResponse.data.values?.length) {
      feedLogger.warn({ symbol, response: atrResponse.data }, 'Failed to fetch ATR from Twelve Data');
      return null;
    }

    // Small delay before second call
    await new Promise(resolve => setTimeout(resolve, 500));

    // Fetch price
    const priceResponse = await axios.get<PriceResponse>(`${TWELVE_DATA_BASE_URL}/quote`, {
      params: {
        symbol,
        apikey: apiKey,
      },
      timeout: 10000,
    });

    // Check for rate limit error on price call
    if ((priceResponse.data as unknown as { code?: number }).code === 429) {
      recordRateLimit();
      feedLogger.warn({ symbol }, 'Rate limited on price fetch - backing off');
      return null;
    }

    const atr = parseFloat(atrResponse.data.values[0].atr);
    const price = parseFloat(priceResponse.data.close);

    if (isNaN(atr) || isNaN(price) || price <= 0) {
      feedLogger.warn({ symbol, atr, price }, 'Invalid ATR or price data');
      return null;
    }

    feedLogger.debug({ symbol, atr: atr.toFixed(2), price: price.toFixed(2) }, 'Fetched ATR data');
    return { atr, price };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    feedLogger.error({ symbol, error: message }, 'Error fetching ATR from Twelve Data');
    return null;
  }
}

/**
 * Get volatility (as percentage of price) for a token symbol
 * For stocks: Blends Twelve Data API (14-day ATR) with internal calculation (7-day on-chain)
 * For non-stocks (like GOLD): Uses internal calculation only
 *
 * Blending rationale:
 * - API captures underlying stock's true volatility (14-day ATR is robust)
 * - Internal captures on-chain token behavior (spread volatility, liquidity gaps)
 * - Combined view is more accurate for setting position sizes and stops
 *
 * NOTE: This function does NOT call the API directly. API data is fetched
 * during prewarm only. This prevents rate limit issues from concurrent API calls.
 */
export async function getVolatilityPct(symbol: string, fetchFromApi = false): Promise<number | null> {
  // Check cache first - but skip if we're explicitly fetching from API (during prewarm)
  // This allows API prewarm to update values even if Supabase prewarm already cached them
  const cached = volatilityCache.get(symbol);
  if (!fetchFromApi && cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
    return cached.atrPct;
  }

  let apiVolatility: number | null = null;
  let internalVolatility: number | null = null;

  // Only call Twelve Data API if explicitly requested (during prewarm)
  // This prevents rate limit issues from multiple concurrent API calls
  if (fetchFromApi) {
    const apiKey = getApiKey();
    if (apiKey) {
      const data = await fetchATR(symbol);
      if (data) {
        apiVolatility = (data.atr / data.price) * 100;
      }
    }
  }

  // Get internal volatility from our own price history
  // This works for ALL tokens including non-stocks like GOLD
  try {
    const db = getDatabase();
    const internal = await db.getHistoricalVolatility(symbol);
    if (internal !== null && internal > 0) {
      internalVolatility = internal;
    }
  } catch (error) {
    feedLogger.debug({ symbol, error }, 'Internal volatility calculation failed');
  }

  // Calculate final volatility based on what's available
  let finalVolatility: number | null = null;

  if (apiVolatility !== null && internalVolatility !== null) {
    // Both available - blend them (weighted average)
    finalVolatility = (apiVolatility * API_VOLATILITY_WEIGHT) +
                      (internalVolatility * INTERNAL_VOLATILITY_WEIGHT);
  } else if (apiVolatility !== null) {
    finalVolatility = apiVolatility;
  } else if (internalVolatility !== null) {
    finalVolatility = internalVolatility;
  }

  // Cache the result if we have one
  if (finalVolatility !== null) {
    volatilityCache.set(symbol, {
      atrPct: finalVolatility,
      atrAbsolute: 0, // Only meaningful for pure API data
      price: 0,
      timestamp: Date.now(),
    });
    return finalVolatility;
  }

  // Return cached value if available (even if stale), otherwise null
  return cached?.atrPct ?? null;
}

/**
 * Get dynamic stop-loss threshold based on actual volatility
 * Uses ATR percentage to set appropriate stop-loss
 *
 * Logic: Stop-loss = -2x daily ATR percentage
 * This means if a stock typically moves 2% per day (ATR), stop-loss is -4%
 *
 * With floors and caps to prevent extreme values:
 * - Minimum: -3% (even for very stable stocks)
 * - Maximum: -15% (even for extremely volatile stocks)
 */
export async function getDynamicStopLossPct(symbol: string): Promise<number> {
  const MIN_STOP_LOSS = -3;  // Floor: never tighter than -3%
  const MAX_STOP_LOSS = -15; // Cap: never wider than -15%
  const ATR_MULTIPLIER = 2;  // Stop-loss = 2x daily ATR

  const atrPct = await getVolatilityPct(symbol);

  if (atrPct === null) {
    feedLogger.debug({ symbol, default: STOCK_STOP_LOSS_DEFAULT_PCT }, 'Using default stop-loss (no volatility data)');
    return STOCK_STOP_LOSS_DEFAULT_PCT;
  }

  // Calculate stop-loss as negative of (ATR * multiplier)
  let stopLoss = -(atrPct * ATR_MULTIPLIER);

  // Apply floor and cap
  stopLoss = Math.max(stopLoss, MAX_STOP_LOSS); // Cap at -15% (max is more negative)
  stopLoss = Math.min(stopLoss, MIN_STOP_LOSS); // Floor at -3% (min is less negative)

  feedLogger.debug({
    symbol,
    atrPct: atrPct.toFixed(2),
    rawStopLoss: (-(atrPct * ATR_MULTIPLIER)).toFixed(2),
    finalStopLoss: stopLoss.toFixed(2),
  }, 'Calculated dynamic stop-loss');

  return stopLoss;
}

/**
 * Pre-warm volatility cache from Supabase price history for ALL tokens
 * Queries Supabase at startup (slower but saves disk space vs local SQLite)
 * Call this first on startup, then optionally call prewarmVolatilityCache for API data
 */
export async function prewarmInternalVolatility(): Promise<void> {
  try {
    feedLogger.info('Fetching historical volatility from Supabase...');
    const volatilityMap = await fetchAllHistoricalVolatilityFromSupabase();

    let count = 0;
    for (const [symbol, volatility] of volatilityMap) {
      // Only cache if we don't already have a fresh value
      const existing = volatilityCache.get(symbol);
      if (!existing || Date.now() - existing.timestamp >= CACHE_DURATION_MS) {
        volatilityCache.set(symbol, {
          atrPct: volatility,
          atrAbsolute: 0,
          price: 0,
          timestamp: Date.now(),
        });
        count++;
      }
    }

    feedLogger.info({
      calculated: volatilityMap.size,
      cached: count,
      samples: Array.from(volatilityMap.entries()).slice(0, 5).map(([s, v]) => `${s}:${v.toFixed(2)}%`),
    }, 'Pre-warmed volatility cache from Supabase');
  } catch (error) {
    feedLogger.warn({ error }, 'Failed to prewarm internal volatility from Supabase');
  }
}

// Incremental refresh state - rotates through symbols one at a time
let incrementalSymbols: string[] = [];
let incrementalIndex = 0;

/**
 * Initialize the incremental volatility refresh with a list of symbols
 * Call once at startup, then call refreshNextVolatility() each main loop cycle
 */
export function initIncrementalVolatilityRefresh(symbols: string[]): void {
  incrementalSymbols = symbols;
  incrementalIndex = 0;
  feedLogger.info({
    symbolCount: symbols.length,
    cycleTimeMin: Math.ceil(symbols.length * 20 / 60) // ~20 seconds per symbol
  }, 'Initialized incremental volatility refresh');
}

/**
 * Refresh volatility for ONE symbol from Twelve Data API
 * Call this once per main loop cycle (~20 seconds) to gradually refresh all symbols
 *
 * Benefits over bulk prewarm:
 * - Never hits rate limits (1 symbol every 20s = 3/min, well under 8 credit limit)
 * - No startup delay needed
 * - Cache stays fresh continuously
 * - Graceful degradation if API is down
 *
 * Returns the symbol that was refreshed, or null if skipped
 */
export async function refreshNextVolatility(): Promise<string | null> {
  // Skip if no symbols configured or no API key
  if (incrementalSymbols.length === 0) return null;
  if (!getApiKey()) return null;

  // Get next symbol in rotation
  const symbol = incrementalSymbols[incrementalIndex];
  incrementalIndex = (incrementalIndex + 1) % incrementalSymbols.length;

  // Skip symbols whose tokens aren't enabled by liquidity (TVL too low)
  // This reduces API calls from ~36 stocks to ~14 that actually pass TVL checks
  if (!isStockEnabledByAnyToken(symbol)) {
    feedLogger.debug({ symbol }, 'Skipping volatility refresh - no tokens enabled for this stock');
    return null;
  }

  // Check if cache is still fresh - skip if so to save API credits
  const cached = volatilityCache.get(symbol);
  const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
  const REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000; // Refresh if older than 6 hours

  if (cacheAge < REFRESH_THRESHOLD_MS) {
    feedLogger.debug({ symbol, cacheAgeMin: Math.round(cacheAge / 60000) },
      'Skipping volatility refresh - cache still fresh');
    return null;
  }

  // Fetch fresh data from API
  const result = await getVolatilityPct(symbol, true);
  if (result !== null) {
    feedLogger.debug({ symbol, atrPct: result.toFixed(2) }, 'Refreshed API volatility');
    return symbol;
  }

  return null;
}

/**
 * Check if any token using this stock ticker is enabled by liquidity
 */
function isStockEnabledByAnyToken(stockTicker: string): boolean {
  // Try common token symbol patterns for this stock
  const possibleTokens = [
    `${stockTicker}x`,   // e.g., TSLAx
    `${stockTicker}r`,   // e.g., TSLAr
    stockTicker,         // Direct match (some tokens use raw ticker)
  ];
  return possibleTokens.some(t => isTokenEnabledByLiquidity(t));
}

/**
 * Legacy bulk prewarm - kept for backwards compatibility but not recommended
 * Use initIncrementalVolatilityRefresh + refreshNextVolatility instead
 */
export async function prewarmVolatilityCache(symbols: string[]): Promise<void> {
  // Skip if no API key configured
  if (!getApiKey()) {
    feedLogger.info('No Twelve Data API key configured, using internal volatility only');
    return;
  }

  // Apply startup delay on first call to let rate limit window reset after deployment
  if (!startupDelayApplied) {
    startupDelayApplied = true;
    feedLogger.info({ delaySeconds: STARTUP_DELAY_MS / 1000 },
      'Waiting before Twelve Data API calls to avoid rate limits after deployment');
    await new Promise(resolve => setTimeout(resolve, STARTUP_DELAY_MS));
  }

  feedLogger.info({ symbols, estimatedTimeMin: Math.ceil(symbols.length * 15 / 60) },
    'Pre-warming volatility cache from Twelve Data API (rate limited to 4 symbols/min)');

  // Fetch sequentially - rate limiting is handled in fetchATR
  // Pass fetchFromApi=true to allow API calls during prewarm
  for (const symbol of symbols) {
    const result = await getVolatilityPct(symbol, true);
    if (result !== null) {
      feedLogger.debug({ symbol, atrPct: result.toFixed(2) }, 'Cached API volatility');
    }
  }

  feedLogger.info({
    cached: volatilityCache.size,
    symbols: Array.from(volatilityCache.keys()),
  }, 'Volatility cache pre-warmed from API');
}

/**
 * Get volatility-adjusted position size multiplier
 * Higher volatility = smaller positions (risk parity principle)
 *
 * Formula: 1 / (1 + atrPct / BASE_ATR)
 * - BASE_ATR = 2% (benchmark volatility)
 * - 1% ATR stock → 1.5x position (low vol bonus)
 * - 2% ATR stock → 1.0x position (baseline)
 * - 4% ATR stock → 0.67x position
 * - 7% ATR stock → 0.44x position
 *
 * Capped between 0.3x (floor) and 1.5x (ceiling) to prevent extremes
 */
export function getVolatilityPositionMultiplier(symbol: string): number {
  const BASE_ATR = 2.0;  // Benchmark: 2% daily ATR is "normal"
  const MIN_MULTIPLIER = 0.3;  // Floor: never less than 30% of base position
  const MAX_MULTIPLIER = 1.5;  // Ceiling: never more than 150% of base position

  const cached = volatilityCache.get(symbol);
  if (!cached) {
    // No volatility data - use baseline (1.0x)
    return 1.0;
  }

  // Risk parity formula: reduce position size proportionally to volatility
  const rawMultiplier = BASE_ATR / (BASE_ATR + cached.atrPct);

  // Apply floor and ceiling
  const multiplier = Math.max(MIN_MULTIPLIER, Math.min(rawMultiplier, MAX_MULTIPLIER));

  feedLogger.debug({
    symbol,
    atrPct: cached.atrPct.toFixed(2),
    rawMultiplier: rawMultiplier.toFixed(3),
    finalMultiplier: multiplier.toFixed(3),
  }, 'Volatility position multiplier');

  return multiplier;
}

/**
 * Get volatility-adjusted entry threshold multiplier
 * Higher volatility = require larger discount to enter (more margin for error)
 *
 * Formula: 1 + (atrPct - BASE_ATR) * SENSITIVITY
 * - SENSITIVITY = 0.6 (aggressive adjustment)
 * - 1.0% ATR stock → 0.8x threshold (stable, can be more lenient)
 * - 1.5% ATR stock → 1.0x threshold (baseline)
 * - 3.0% ATR stock → 1.9x threshold
 * - 4.5% ATR stock (TSLA) → 2.8x threshold (requires 1.4% discount vs 0.5%)
 * - 7.0% ATR stock → 3.0x threshold (capped)
 *
 * Rationale: TSLA trades were losing money even BEFORE fees because the strategy
 * doesn't work for high-volatility stocks - NAV movement wipes out spread gains.
 * By requiring 2.8x the entry threshold for TSLA-level volatility, we filter
 * out marginal opportunities and only enter when the discount is exceptional.
 *
 * Capped between 0.8x (stable stocks get slight discount) and 3.0x (high vol)
 */
export function getVolatilityEntryMultiplier(symbol: string): number {
  const BASE_ATR = 2.7;   // Median ATR across our token universe (was 1.5 — too low, punished everything)
  const SENSITIVITY = 0.15;  // Gentle nudge per 1% ATR difference (was 0.6 — way too aggressive)
  const MIN_MULTIPLIER = 0.85;  // Floor: at most 15% reduction for calm stocks
  const MAX_MULTIPLIER = 1.30;  // Ceiling: at most 30% increase for volatile stocks

  const cached = volatilityCache.get(symbol);
  if (!cached) {
    return 1.0;
  }

  // Linear adjustment based on deviation from baseline volatility
  const rawMultiplier = 1 + (cached.atrPct - BASE_ATR) * SENSITIVITY;

  const multiplier = Math.max(MIN_MULTIPLIER, Math.min(rawMultiplier, MAX_MULTIPLIER));

  feedLogger.debug({
    symbol,
    atrPct: cached.atrPct.toFixed(2),
    rawMultiplier: rawMultiplier.toFixed(3),
    finalMultiplier: multiplier.toFixed(3),
  }, 'Volatility entry multiplier');

  return multiplier;
}

/**
 * Get volatility-adjusted exit threshold multiplier
 * Higher volatility = exit sooner to capture mean reversion before NAV moves against us
 *
 * Formula: 1 - (atrPct - BASE_ATR) * SENSITIVITY
 * - BASE_ATR = 2.7% (median ATR across our universe)
 * - SENSITIVITY = 0.2 (moderate adjustment)
 * - 1.0% ATR stock → 1.34x threshold (stable, can wait longer)
 * - 2.7% ATR stock → 1.0x threshold (baseline)
 * - 4.0% ATR stock → 0.74x threshold (volatile, exit faster)
 * - 6.0% ATR stock → 0.34x threshold (very volatile, exit quickly)
 *
 * Capped between 0.4x (floor) and 1.5x (ceiling) to prevent extremes
 *
 * Rationale: MSTR can move 5-7% daily (high ATR), wiping out 2-3% spread gains
 * if we wait too long. SPY moves 1-2% daily, so we can afford to wait for
 * fuller mean reversion.
 */
export function getVolatilityExitMultiplier(symbol: string): number {
  const BASE_ATR = 2.7;   // Median ATR across our token universe
  const SENSITIVITY = 0.2;  // Moderate adjustment - don't be too aggressive
  const MIN_MULTIPLIER = 0.4;  // Floor: at most 60% reduction (faster exits)
  const MAX_MULTIPLIER = 1.5;  // Ceiling: at most 50% increase (slower exits)

  const cached = volatilityCache.get(symbol);
  if (!cached) {
    return 1.0;
  }

  // Inverse relationship: higher volatility = lower multiplier = faster exits
  const rawMultiplier = 1 - (cached.atrPct - BASE_ATR) * SENSITIVITY;

  const multiplier = Math.max(MIN_MULTIPLIER, Math.min(rawMultiplier, MAX_MULTIPLIER));

  feedLogger.debug({
    symbol,
    atrPct: cached.atrPct.toFixed(2),
    rawMultiplier: rawMultiplier.toFixed(3),
    finalMultiplier: multiplier.toFixed(3),
  }, 'Volatility exit multiplier');

  return multiplier;
}

/**
 * Get all cached volatility data (for debugging/dashboard)
 */
export function getVolatilityCacheSnapshot(): Map<string, VolatilityCache> {
  return new Map(volatilityCache);
}

/**
 * Clear the volatility cache (for testing)
 */
export function clearVolatilityCache(): void {
  volatilityCache.clear();
}

// ============================================================================
// DYNAMIC FLOOR & MARKET REGIME
// ============================================================================

// Cache for market regime multiplier
let cachedRegimeMultiplier: { value: number; timestamp: number; regime: string } | null = null;

/**
 * Calculate market regime multiplier based on median volatility across all tokens
 *
 * Calm market (median ATR <2%): 0.85 (lower floors, more opportunities)
 * Normal market: 1.0
 * Volatile market (median ATR >3.5%): 1.20 (higher floors, more selective)
 */
export function getMarketRegimeMultiplier(): number {
  if (!MARKET_REGIME.ENABLED) return 1.0;

  const now = Date.now();
  if (cachedRegimeMultiplier &&
      now - cachedRegimeMultiplier.timestamp < MARKET_REGIME.REFRESH_INTERVAL_MS) {
    return cachedRegimeMultiplier.value;
  }

  // Get all cached volatilities
  const volatilities = Array.from(volatilityCache.values())
    .map(v => v.atrPct)
    .filter(v => v > 0 && v < 20); // Filter outliers

  if (volatilities.length < 5) {
    // Not enough data, use normal regime
    cachedRegimeMultiplier = { value: 1.0, timestamp: now, regime: 'normal' };
    return 1.0;
  }

  // Use median (robust to outliers like MSTR at 6%+)
  volatilities.sort((a, b) => a - b);
  const median = volatilities[Math.floor(volatilities.length / 2)];

  let multiplier = 1.0;
  let regime = 'normal';

  if (median < MARKET_REGIME.CALM_THRESHOLD) {
    multiplier = MARKET_REGIME.CALM_MULTIPLIER;
    regime = 'calm';
  } else if (median > MARKET_REGIME.VOLATILE_THRESHOLD) {
    multiplier = MARKET_REGIME.VOLATILE_MULTIPLIER;
    regime = 'volatile';
  }

  cachedRegimeMultiplier = { value: multiplier, timestamp: now, regime };

  feedLogger.info({
    medianATR: median.toFixed(2),
    multiplier,
    regime,
    samples: volatilities.length
  }, 'Market regime calculated');

  return multiplier;
}

/**
 * Get dynamic entry floor for a specific token based on its volatility
 *
 * Formula: floor = BASE_FLOOR + (ATR% × VOLATILITY_COEFFICIENT) × regime_multiplier
 *
 * Examples (normal regime):
 *   SPY (1.2% ATR): 2.0 + 1.2×0.6 = 2.72%
 *   AAPL (2.5% ATR): 2.0 + 2.5×0.6 = 3.50%
 *   TSLA (4.5% ATR): 2.0 + 4.5×0.6 = 4.70%
 *   MSTR (6.0% ATR): capped at 5.5%
 *
 * @param symbol Stock ticker (e.g., 'TSLA', 'SPY')
 * @returns Dynamic floor percentage
 */
export function getDynamicFloor(symbol: string): number {
  if (!DYNAMIC_FLOOR_FORMULA.ENABLED) {
    return 3.5; // Fallback to old static floor
  }

  // Get volatility for this symbol
  const cached = volatilityCache.get(symbol);
  const atrPct = cached?.atrPct ?? DYNAMIC_FLOOR_FORMULA.FALLBACK_ATR;

  // Get market regime multiplier
  const regimeMultiplier = getMarketRegimeMultiplier();

  // Get session-based adjustments (time of day)
  const session = getSessionAdjustments();

  // Calculate raw floor
  const rawFloor = DYNAMIC_FLOOR_FORMULA.BASE_FLOOR +
    (atrPct * DYNAMIC_FLOOR_FORMULA.VOLATILITY_COEFFICIENT);

  // Apply regime multiplier AND session floor multiplier
  const adjustedFloor = rawFloor * regimeMultiplier * session.floorMultiplier;

  // Clamp to absolute bounds
  const finalFloor = Math.max(
    DYNAMIC_FLOOR_FORMULA.ABSOLUTE_MIN,
    Math.min(adjustedFloor, DYNAMIC_FLOOR_FORMULA.ABSOLUTE_MAX)
  );

  feedLogger.debug({
    symbol,
    atrPct: atrPct.toFixed(2),
    rawFloor: rawFloor.toFixed(2),
    regimeMultiplier,
    session: session.session,
    sessionMultiplier: session.floorMultiplier,
    finalFloor: finalFloor.toFixed(2),
  }, 'Dynamic floor calculated');

  return finalFloor;
}

/**
 * Get current market regime info (for dashboard/debugging)
 */
export function getMarketRegimeInfo(): { regime: string; multiplier: number; medianATR: number } {
  const multiplier = getMarketRegimeMultiplier();
  const regime = cachedRegimeMultiplier?.regime ?? 'unknown';

  const volatilities = Array.from(volatilityCache.values())
    .map(v => v.atrPct)
    .filter(v => v > 0 && v < 20);

  volatilities.sort((a, b) => a - b);
  const medianATR = volatilities.length > 0
    ? volatilities[Math.floor(volatilities.length / 2)]
    : 0;

  return { regime, multiplier, medianATR };
}
