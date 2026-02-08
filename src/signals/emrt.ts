/**
 * EMRT - Empirical Mean Reversion Time Optimization
 *
 * Dynamically adjusts max hold time per token based on historical reversion patterns.
 * Tokens that revert quickly get shorter hold times; slow reverters get longer.
 *
 * Strategy: Use 1.5x the average target exit time as the max hold for that token.
 * Falls back to default MAX_HOLD_TIME_MS if insufficient data.
 */

import { getTradesPool } from '../db/supabaseClient';
import logger from '../logger';
import { MAX_HOLD_TIME_MS, getSessionAdjustments } from '../constants';

const emrtLogger = logger.child({ component: 'emrt' });

// Cache of token-specific hold times (milliseconds)
const tokenHoldTimes: Map<string, number> = new Map();

// Minimum number of target exits needed to trust the data
const MIN_TARGET_EXITS = 3;

// Multiplier: recommended hold = avgTargetTime * HOLD_MULTIPLIER
const HOLD_MULTIPLIER = 1.5;

// Cache refresh interval (1 hour)
const CACHE_REFRESH_MS = 60 * 60 * 1000;
let lastRefresh = 0;

/**
 * Get the optimal max hold time for a specific token
 *
 * @param token Token symbol (e.g., "TSLAx", "SPYr")
 * @returns Max hold time in milliseconds
 */
export function getTokenMaxHoldTime(token: string): number {
  // Get session multiplier
  const session = getSessionAdjustments();
  const sessionMultiplier = session.maxHoldMultiplier;

  // Check if we have token-specific data
  const tokenHoldMs = tokenHoldTimes.get(token);

  if (tokenHoldMs) {
    const adjustedHold = tokenHoldMs * sessionMultiplier;
    emrtLogger.debug({
      token,
      baseHoldMin: Math.round(tokenHoldMs / 60000),
      sessionMultiplier,
      adjustedHoldMin: Math.round(adjustedHold / 60000),
      session: session.session
    }, 'EMRT: Token-specific hold time');
    return adjustedHold;
  }

  // Fall back to default
  const defaultHold = MAX_HOLD_TIME_MS * sessionMultiplier;
  emrtLogger.debug({
    token,
    defaultHoldMin: Math.round(defaultHold / 60000),
    session: session.session,
    reason: 'no_emrt_data'
  }, 'EMRT: Using default hold time');
  return defaultHold;
}

/**
 * Refresh EMRT cache from database
 * Called on startup and periodically
 */
export async function refreshEMRTCache(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < CACHE_REFRESH_MS && tokenHoldTimes.size > 0) {
    emrtLogger.debug('EMRT cache still fresh, skipping refresh');
    return;
  }

  try {
    const pool = getTradesPool();

    // Get average target exit times per token (last 30 days)
    const result = await pool.query(`
      SELECT 
        buy_symbol as token,
        COUNT(*) FILTER (WHERE exit_reason = 'target') as target_count,
        AVG(CASE WHEN exit_reason = 'target' 
            THEN (exit_timestamp - entry_timestamp) 
            ELSE NULL END) as avg_target_time_ms
      FROM mean_reversion_positions
      WHERE entry_timestamp > $1
        AND exit_timestamp IS NOT NULL
      GROUP BY buy_symbol
      HAVING COUNT(*) FILTER (WHERE exit_reason = 'target') >= $2
    `, [now - 30 * 24 * 60 * 60 * 1000, MIN_TARGET_EXITS]);

    // Clear old cache
    tokenHoldTimes.clear();

    // Populate with new data
    for (const row of result.rows) {
      const avgTargetMs = parseFloat(row.avg_target_time_ms);
      const recommendedHoldMs = avgTargetMs * HOLD_MULTIPLIER;

      // Clamp between 30 min and 8 hours
      const clampedHoldMs = Math.max(30 * 60 * 1000, Math.min(8 * 60 * 60 * 1000, recommendedHoldMs));

      tokenHoldTimes.set(row.token, clampedHoldMs);

      emrtLogger.info({
        token: row.token,
        targetExits: parseInt(row.target_count),
        avgTargetMin: Math.round(avgTargetMs / 60000),
        recommendedHoldMin: Math.round(clampedHoldMs / 60000)
      }, 'EMRT: Set token-specific hold time');
    }

    lastRefresh = now;
    emrtLogger.info({
      tokensWithData: tokenHoldTimes.size,
      tokens: Array.from(tokenHoldTimes.keys())
    }, 'EMRT cache refreshed');

  } catch (error) {
    emrtLogger.error({ error }, 'Failed to refresh EMRT cache');
    // Keep using existing cache on error
  }
}

/**
 * Get EMRT status for dashboard/monitoring
 */
export function getEMRTStatus(): { tokens: Array<{ token: string; holdTimeMin: number }>; lastRefresh: number } {
  const tokens = Array.from(tokenHoldTimes.entries()).map(([token, holdMs]) => ({
    token,
    holdTimeMin: Math.round(holdMs / 60000)
  }));

  return { tokens, lastRefresh };
}

/**
 * Initialize EMRT on startup
 */
export async function initializeEMRT(): Promise<void> {
  emrtLogger.info('Initializing EMRT (Empirical Mean Reversion Time)');
  await refreshEMRTCache();
}
