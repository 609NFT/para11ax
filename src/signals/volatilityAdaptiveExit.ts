/**
 * Volatility-Adaptive Exit Strategy
 * 
 * Enhances the base exit logic by scaling exit thresholds based on token volatility.
 * High-volatility tokens get higher exit targets (let winners run).
 * Low-volatility tokens get lower exit targets (take profits earlier).
 * 
 * Feature flag: VOLATILITY_ADAPTIVE_EXIT.ENABLED in constants.ts
 */

import { signalLogger } from '../logger';
import { getVolatilityPct } from '../feeds/volatilityFeed';

const vadaptiveLogger = signalLogger.child({ component: 'volatility-adaptive-exit' });

/**
 * Configuration for volatility-adaptive exits
 */
export const VOLATILITY_ADAPTIVE_EXIT = {
  ENABLED: false,                    // Feature flag - disabled until tested
  BASE_MARKET_ATR_PCT: 2.7,         // Baseline market volatility (median ATR)
  MIN_MULTIPLIER: 0.6,              // Minimum exit threshold multiplier (60%)
  MAX_MULTIPLIER: 1.8,              // Maximum exit threshold multiplier (180%)
  SMOOTHING_FACTOR: 0.3,             // How much to smooth volatility scaling (30%)
} as const;

/**
 * Calculate volatility-adjusted exit threshold
 * 
 * Formula: baseThreshold * volatilityMultiplier
 * where volatilityMultiplier = smoothed((tokenATR / marketATR))
 * 
 * Examples:
 * - Low vol (SPY, 1.5% ATR): 2.5% * 0.8 = 2.0% exit target
 * - High vol (MSTR, 5.0% ATR): 2.5% * 1.6 = 4.0% exit target
 */
export async function getVolatilityAdjustedExitThreshold(
  baseExitThreshold: number,
  tokenSymbol: string,
  stockTicker: string
): Promise<{
  adjustedThreshold: number;
  multiplier: number;
  tokenATR: number | null;
  reasoning: string;
}> {
  if (!VOLATILITY_ADAPTIVE_EXIT.ENABLED) {
    return {
      adjustedThreshold: baseExitThreshold,
      multiplier: 1.0,
      tokenATR: null,
      reasoning: 'volatility-adaptive-exit-disabled',
    };
  }

  try {
    // Get volatility data for this token's underlying stock
    const tokenATR = await getVolatilityPct(stockTicker);
    
    if (!tokenATR || tokenATR <= 0) {
      vadaptiveLogger.debug({ token: tokenSymbol, ticker: stockTicker }, 'No volatility data - using base threshold');
      return {
        adjustedThreshold: baseExitThreshold,
        multiplier: 1.0,
        tokenATR: null,
        reasoning: 'no-volatility-data',
      };
    }
    const { BASE_MARKET_ATR_PCT, MIN_MULTIPLIER, MAX_MULTIPLIER, SMOOTHING_FACTOR } = VOLATILITY_ADAPTIVE_EXIT;
    
    // Calculate raw volatility ratio
    const volatilityRatio = tokenATR / BASE_MARKET_ATR_PCT;
    
    // Apply smoothing to prevent extreme adjustments
    // smoothedRatio = 1 + smoothingFactor * (rawRatio - 1)
    const smoothedRatio = 1 + SMOOTHING_FACTOR * (volatilityRatio - 1);
    
    // Clamp to reasonable bounds
    const multiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, smoothedRatio));
    
    const adjustedThreshold = baseExitThreshold * multiplier;
    
    const reasoning = multiplier > 1.1 ? 'high-volatility-higher-target' :
                     multiplier < 0.9 ? 'low-volatility-lower-target' :
                     'normal-volatility';
    
    vadaptiveLogger.debug({
      token: tokenSymbol,
      ticker: stockTicker,
      tokenATR: tokenATR.toFixed(2),
      marketATR: BASE_MARKET_ATR_PCT,
      volatilityRatio: volatilityRatio.toFixed(2),
      smoothedRatio: smoothedRatio.toFixed(2),
      multiplier: multiplier.toFixed(2),
      baseThreshold: baseExitThreshold.toFixed(2),
      adjustedThreshold: adjustedThreshold.toFixed(2),
      reasoning,
    }, 'Volatility-adjusted exit threshold calculated');

    return {
      adjustedThreshold,
      multiplier,
      tokenATR,
      reasoning,
    };
    
  } catch (error) {
    vadaptiveLogger.warn({ 
      token: tokenSymbol, 
      ticker: stockTicker, 
      error: error instanceof Error ? error.message : String(error) 
    }, 'Error calculating volatility-adjusted exit threshold');
    
    return {
      adjustedThreshold: baseExitThreshold,
      multiplier: 1.0,
      tokenATR: null,
      reasoning: 'error-fallback-to-base',
    };
  }
}

/**
 * Calculate volatility-adjusted trailing stop
 * 
 * High-volatility tokens get wider trailing stops (less likely to be stopped out by noise)
 * Low-volatility tokens get tighter trailing stops (preserve gains more aggressively)
 */
export async function getVolatilityAdjustedTrailingStop(
  baseTrailingStopPct: number,
  tokenSymbol: string,
  stockTicker: string
): Promise<{
  adjustedTrailingStop: number;
  multiplier: number;
  reasoning: string;
}> {
  if (!VOLATILITY_ADAPTIVE_EXIT.ENABLED) {
    return {
      adjustedTrailingStop: baseTrailingStopPct,
      multiplier: 1.0,
      reasoning: 'volatility-adaptive-exit-disabled',
    };
  }

  try {
    const tokenATR = await getVolatilityPct(stockTicker);
    
    if (!tokenATR || tokenATR <= 0) {
      return {
        adjustedTrailingStop: baseTrailingStopPct,
        multiplier: 1.0,
        reasoning: 'no-volatility-data',
      };
    }
    const { BASE_MARKET_ATR_PCT, MIN_MULTIPLIER, MAX_MULTIPLIER, SMOOTHING_FACTOR } = VOLATILITY_ADAPTIVE_EXIT;
    
    // For trailing stops, we want the opposite behavior:
    // High volatility = wider stops (higher multiplier)
    // Low volatility = tighter stops (lower multiplier)
    const volatilityRatio = tokenATR / BASE_MARKET_ATR_PCT;
    const smoothedRatio = 1 + SMOOTHING_FACTOR * (volatilityRatio - 1);
    const multiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, smoothedRatio));
    
    const adjustedTrailingStop = baseTrailingStopPct * multiplier;
    
    const reasoning = multiplier > 1.1 ? 'high-volatility-wider-stop' :
                     multiplier < 0.9 ? 'low-volatility-tighter-stop' :
                     'normal-volatility';

    vadaptiveLogger.debug({
      token: tokenSymbol,
      ticker: stockTicker,
      tokenATR: tokenATR.toFixed(2),
      multiplier: multiplier.toFixed(2),
      baseTrailingStop: baseTrailingStopPct.toFixed(3),
      adjustedTrailingStop: adjustedTrailingStop.toFixed(3),
      reasoning,
    }, 'Volatility-adjusted trailing stop calculated');

    return {
      adjustedTrailingStop,
      multiplier,
      reasoning,
    };
    
  } catch (error) {
    vadaptiveLogger.warn({ 
      token: tokenSymbol, 
      ticker: stockTicker, 
      error: error instanceof Error ? error.message : String(error) 
    }, 'Error calculating volatility-adjusted trailing stop');
    
    return {
      adjustedTrailingStop: baseTrailingStopPct,
      multiplier: 1.0,
      reasoning: 'error-fallback-to-base',
    };
  }
}

/**
 * Get summary statistics for volatility adjustments across all tokens
 * Used for monitoring and validation
 */
export function getVolatilityAdjustmentSummary(tokens: Array<{ symbol: string; stockTicker: string }>): Promise<{
  enabled: boolean;
  adjustments: Array<{
    token: string;
    ticker: string;
    atr: number | null;
    exitMultiplier: number;
    trailingStopMultiplier: number;
  }>;
}> {
  return Promise.all(
    tokens.map(async ({ symbol, stockTicker }) => {
      const exitResult = await getVolatilityAdjustedExitThreshold(2.5, symbol, stockTicker);
      const trailingResult = await getVolatilityAdjustedTrailingStop(0.05, symbol, stockTicker);
      
      return {
        token: symbol,
        ticker: stockTicker,
        atr: exitResult.tokenATR,
        exitMultiplier: exitResult.multiplier,
        trailingStopMultiplier: trailingResult.multiplier,
      };
    })
  ).then(adjustments => ({
    enabled: VOLATILITY_ADAPTIVE_EXIT.ENABLED,
    adjustments,
  }));
}