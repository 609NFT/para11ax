/**
 * Half-Life Filter for Mean Reversion
 *
 * Uses Ornstein-Uhlenbeck (OU) process to estimate how quickly spreads
 * mean-revert for each token. Tokens with slow mean-reversion (high half-life)
 * are filtered out or require higher entry thresholds.
 *
 * Theory:
 * - OU process: dS = θ(μ - S)dt + σdW
 * - θ = mean-reversion speed (higher = faster reversion)
 * - Half-life = ln(2) / θ (time for spread to revert halfway to mean)
 *
 * Estimation:
 * - Discrete approximation: ΔS[t] = θ(μ - S[t])Δt + noise
 * - Linear regression: ΔS vs S gives slope = -θ × Δt
 * - Solve for θ, then half-life = ln(2) / θ
 */

import { getTradesPool } from '../db/supabaseClient';
import { signalLogger } from '../logger';
import { HALF_LIFE_FILTER } from '../constants';
import { MS_PER_HOUR, MS_PER_DAY } from '../utils/timeConstants';

// Cache structure: symbol -> { halfLifeHours, calculatedAt }
interface HalfLifeCache {
  halfLifeHours: number;
  calculatedAt: number;
  sampleCount: number;
}

const halfLifeCache = new Map<string, HalfLifeCache>();

// Minimum data requirements
const MIN_SAMPLES = 50;           // Need at least 50 data points
const MIN_TIME_SPAN_HOURS = 24;   // Data must span at least 24 hours
const LOOKBACK_DAYS = 7;          // Fetch 7 days of data

/**
 * Fetch spread history for a token from Supabase
 * Returns time series of { timestamp, discount }
 */
async function fetchSpreadHistory(
  symbol: string,
  lookbackMs: number = LOOKBACK_DAYS * MS_PER_DAY
): Promise<Array<{ timestamp: number; discount: number }>> {
  const pool = getTradesPool();
  if (!pool) {
    signalLogger.warn({ symbol }, 'Half-life: No database connection');
    return [];
  }

  const cutoffTime = Date.now() - lookbackMs;

  try {
    const result = await pool.query(`
      SELECT
        timestamp,
        COALESCE(token_a_discount_vs_stock, spread_pct, 0) as discount
      FROM discount_history
      WHERE token_a_symbol = $1
        AND timestamp > $2
      ORDER BY timestamp ASC
    `, [symbol, cutoffTime]);

    return result.rows.map(row => ({
      timestamp: Number(row.timestamp),
      discount: Number(row.discount),
    }));
  } catch (error) {
    signalLogger.error({ error, symbol }, 'Half-life: Failed to fetch spread history');
    return [];
  }
}

/**
 * Estimate Ornstein-Uhlenbeck parameters using linear regression
 *
 * Discrete-time model: ΔS[t] = θ(μ - S[t])Δt + noise
 * Rearranging: ΔS[t] = θμΔt - θΔt × S[t]
 *
 * Linear regression of ΔS vs S:
 *   y = a + b × x  where y = ΔS, x = S
 *   slope (b) = -θ × Δt
 *   intercept (a) = θ × μ × Δt
 *
 * Therefore:
 *   θ = -b / Δt
 *   μ = a / (-b) = a / (θ × Δt)
 *
 * @returns { theta, mu, r2 } or null if estimation fails
 */
function estimateOUParameters(
  data: Array<{ timestamp: number; discount: number }>
): { theta: number; mu: number; r2: number; avgDeltaT: number } | null {
  if (data.length < MIN_SAMPLES) {
    return null;
  }

  // Calculate returns (ΔS) and time deltas
  const observations: Array<{ deltaS: number; S: number; deltaT: number }> = [];

  for (let i = 1; i < data.length; i++) {
    const deltaT = (data[i].timestamp - data[i - 1].timestamp) / MS_PER_HOUR; // in hours
    const deltaS = data[i].discount - data[i - 1].discount;
    const S = data[i - 1].discount;

    // Skip if time delta is too large (gap in data) or zero
    if (deltaT <= 0 || deltaT > 4) continue; // Max 4 hours between observations

    observations.push({ deltaS, S, deltaT });
  }

  if (observations.length < MIN_SAMPLES) {
    return null;
  }

  // Calculate average deltaT for normalization
  const avgDeltaT = observations.reduce((sum, o) => sum + o.deltaT, 0) / observations.length;

  // Normalize: scale deltaS by (avgDeltaT / deltaT) to account for varying time intervals
  // This makes the regression more accurate when observation intervals vary
  const normalizedObs = observations.map(o => ({
    deltaS: o.deltaS * (avgDeltaT / o.deltaT),
    S: o.S,
  }));

  // Linear regression: deltaS = a + b × S
  const n = normalizedObs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (const obs of normalizedObs) {
    sumX += obs.S;
    sumY += obs.deltaS;
    sumXY += obs.S * obs.deltaS;
    sumX2 += obs.S * obs.S;
    sumY2 += obs.deltaS * obs.deltaS;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-10) {
    // Degenerate case: all S values are the same
    return null;
  }

  const b = (n * sumXY - sumX * sumY) / denominator;  // slope
  const a = (sumY - b * sumX) / n;                     // intercept

  // Calculate R² (coefficient of determination)
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const obs of normalizedObs) {
    const predicted = a + b * obs.S;
    ssTot += Math.pow(obs.deltaS - meanY, 2);
    ssRes += Math.pow(obs.deltaS - predicted, 2);
  }
  const r2 = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

  // Extract θ from slope: b = -θ × avgDeltaT  =>  θ = -b / avgDeltaT
  const theta = -b / avgDeltaT;

  // Mean-reversion requires θ > 0 (negative slope)
  if (theta <= 0) {
    // Series is not mean-reverting (trending or random walk)
    return null;
  }

  // Calculate long-term mean: μ = a / (θ × avgDeltaT)
  const mu = a / (theta * avgDeltaT);

  return { theta, mu, r2, avgDeltaT };
}

/**
 * Calculate half-life in hours from mean-reversion speed θ
 * Half-life = ln(2) / θ
 *
 * Interpretation:
 * - 1 hour: Very fast mean-reversion (great for trading)
 * - 4 hours: Moderate mean-reversion (acceptable)
 * - 8+ hours: Slow mean-reversion (risky, position may not revert in time)
 */
function calculateHalfLife(theta: number): number {
  return Math.LN2 / theta;
}

/**
 * Get half-life for a token symbol
 *
 * Returns the time (in hours) for a spread to revert halfway to its mean.
 * Uses cached values if fresh (within CACHE_HOURS), otherwise recalculates.
 *
 * @param symbol - Token symbol (e.g., 'TSLAx', 'NVDAx')
 * @returns Half-life in hours, or Infinity if not mean-reverting / insufficient data
 */
export async function getHalfLife(symbol: string): Promise<number> {
  // Check cache first
  const cached = halfLifeCache.get(symbol);
  const now = Date.now();

  if (cached && (now - cached.calculatedAt) < HALF_LIFE_FILTER.CACHE_HOURS * MS_PER_HOUR) {
    return cached.halfLifeHours;
  }

  // Fetch spread history
  const spreadData = await fetchSpreadHistory(symbol);

  if (spreadData.length < MIN_SAMPLES) {
    signalLogger.debug({
      symbol,
      samples: spreadData.length,
      required: MIN_SAMPLES,
    }, 'Half-life: Insufficient data');
    return Infinity; // Not enough data to estimate
  }

  // Check time span
  const timeSpanHours = (spreadData[spreadData.length - 1].timestamp - spreadData[0].timestamp) / MS_PER_HOUR;
  if (timeSpanHours < MIN_TIME_SPAN_HOURS) {
    signalLogger.debug({
      symbol,
      timeSpanHours: timeSpanHours.toFixed(1),
      required: MIN_TIME_SPAN_HOURS,
    }, 'Half-life: Data span too short');
    return Infinity;
  }

  // Estimate OU parameters
  const params = estimateOUParameters(spreadData);

  if (!params) {
    signalLogger.debug({
      symbol,
      samples: spreadData.length,
    }, 'Half-life: Failed to estimate OU parameters (non-stationary?)');
    return Infinity; // Series is not mean-reverting
  }

  const halfLifeHours = calculateHalfLife(params.theta);

  // Cache the result
  halfLifeCache.set(symbol, {
    halfLifeHours,
    calculatedAt: now,
    sampleCount: spreadData.length,
  });

  signalLogger.info({
    symbol,
    halfLifeHours: halfLifeHours.toFixed(2),
    theta: params.theta.toFixed(4),
    mu: params.mu.toFixed(2),
    r2: params.r2.toFixed(3),
    samples: spreadData.length,
    timeSpanHours: timeSpanHours.toFixed(1),
  }, 'Half-life calculated');

  return halfLifeHours;
}

/**
 * Check if a token passes the half-life filter
 *
 * @param symbol - Token symbol
 * @returns { allowed: boolean, halfLife: number, reason?: string }
 */
export async function checkHalfLifeFilter(symbol: string): Promise<{
  allowed: boolean;
  halfLife: number;
  thresholdMultiplier: number;
  reason?: string;
}> {
  if (!HALF_LIFE_FILTER.ENABLED) {
    return { allowed: true, halfLife: 0, thresholdMultiplier: 1.0 };
  }

  const halfLife = await getHalfLife(symbol);

  // If half-life is infinite (insufficient data or non-stationary), allow with caution
  if (!isFinite(halfLife)) {
    return {
      allowed: true,
      halfLife: Infinity,
      thresholdMultiplier: 1.0,
      reason: 'Insufficient data for half-life estimation',
    };
  }

  // Check against threshold
  if (halfLife > HALF_LIFE_FILTER.MAX_HALF_LIFE_HOURS) {
    // Token has slow mean-reversion - either skip or require higher threshold
    return {
      allowed: false,
      halfLife,
      thresholdMultiplier: HALF_LIFE_FILTER.THRESHOLD_MULTIPLIER,
      reason: `Half-life ${halfLife.toFixed(1)}h > max ${HALF_LIFE_FILTER.MAX_HALF_LIFE_HOURS}h`,
    };
  }

  return {
    allowed: true,
    halfLife,
    thresholdMultiplier: 1.0,
  };
}

/**
 * Get all cached half-life values (for dashboard/debugging)
 */
export function getAllCachedHalfLives(): Map<string, HalfLifeCache> {
  return new Map(halfLifeCache);
}

/**
 * Clear the half-life cache (for testing/reset)
 */
export function clearHalfLifeCache(): void {
  halfLifeCache.clear();
}

/**
 * Calculate half-lives for multiple symbols in batch
 * Useful for initial warmup or dashboard display
 *
 * @param symbols - Array of token symbols
 * @returns Map of symbol -> half-life in hours
 */
export async function calculateBatchHalfLives(
  symbols: string[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async symbol => ({
        symbol,
        halfLife: await getHalfLife(symbol),
      }))
    );

    for (const { symbol, halfLife } of batchResults) {
      results.set(symbol, halfLife);
    }
  }

  return results;
}
