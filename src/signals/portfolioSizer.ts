/**
 * Portfolio-Based Position Sizer
 *
 * Dynamically sizes positions based on wallet balance, scaling with wins/losses.
 * Integrates with performance tracker for symbol-specific adjustments.
 *
 * Formula: wallet_balance × BASE_RISK_PCT × tvl_factor × spread_factor × performance_factor
 */

import { PORTFOLIO_SIZING, POSITION_SIZE_FORMULA, ADAPTIVE_POSITION_SIZING } from '../constants';
import { getSymbolPerformance, getAllSymbolPerformance } from './performanceTracker';
import loggerInstance from '../logger';

// Market session getter (injected during init to avoid circular deps)
let marketSessionGetter: (() => 'pre-market' | 'regular' | 'post-market' | 'closed') | null = null;

const logger = loggerInstance.child({ module: 'portfolioSizer' });

// ==================== Types ====================

interface WalletBalance {
  sol: number;
  usdc: number;
  totalUsd: number;
  timestamp: number;
}

interface PositionSizeResult {
  sizeUsd: number;
  baseSize: number;
  tvlMultiplier: number;
  spreadMultiplier: number;
  performanceMultiplier: number;
  walletBalance: number;
}

// ==================== Cache ====================

let cachedBalance: WalletBalance | null = null;
let balanceFetcher: (() => Promise<{ sol: number; usdc: number } | null>) | null = null;
let solPriceFetcher: (() => Promise<number>) | null = null;

// Average win rate for performance scaling (computed from all symbols)
let avgWinRate: number = 0.5; // Default 50%
let avgWinRateLastUpdate: number = 0;
const AVG_WR_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ==================== Initialization ====================

/**
 * Initialize the portfolio sizer with balance fetching functions.
 * Call this once during bot startup with the executor's getBalance method.
 */
export function initPortfolioSizer(
  getBalance: () => Promise<{ sol: number; usdc: number } | null>,
  getSolPrice: () => Promise<number>,
  getMarketSession?: () => 'pre-market' | 'regular' | 'post-market' | 'closed'
): void {
  balanceFetcher = getBalance;
  solPriceFetcher = getSolPrice;
  if (getMarketSession) {
    marketSessionGetter = getMarketSession;
  }
  logger.info('Portfolio sizer initialized');
}

/**
 * Get market hours multiplier based on current session.
 * Higher multiplier = larger positions when NAV is stable.
 */
export function getMarketHoursMultiplier(): number {
  if (!PORTFOLIO_SIZING.MARKET_HOURS_SCALING?.ENABLED) {
    return 1.0;
  }

  if (!marketSessionGetter) {
    return 1.0; // Not initialized, use default
  }

  const session = marketSessionGetter();
  const scaling = PORTFOLIO_SIZING.MARKET_HOURS_SCALING;

  switch (session) {
    case 'closed':
      logger.debug({ session, multiplier: scaling.OFF_MARKET_MULTIPLIER }, 'Off-market: NAV stable, higher position size');
      return scaling.OFF_MARKET_MULTIPLIER;
    case 'pre-market':
    case 'post-market':
      return scaling.PRE_POST_MULTIPLIER;
    case 'regular':
    default:
      return scaling.REGULAR_MULTIPLIER;
  }
}

// ==================== Core Functions ====================

/**
 * Get current wallet balance (cached with TTL).
 */
export async function getWalletBalance(): Promise<WalletBalance | null> {
  // Return cached if fresh
  if (cachedBalance && Date.now() - cachedBalance.timestamp < PORTFOLIO_SIZING.BALANCE_CACHE_TTL_MS) {
    return cachedBalance;
  }

  if (!balanceFetcher || !solPriceFetcher) {
    logger.warn('Portfolio sizer not initialized - using fallback');
    return null;
  }

  try {
    const [balance, solPrice] = await Promise.all([
      balanceFetcher(),
      solPriceFetcher(),
    ]);

    if (!balance) {
      logger.debug('Failed to fetch wallet balance');
      return cachedBalance; // Return stale if available
    }

    const totalUsd = balance.usdc + (balance.sol * solPrice);

    cachedBalance = {
      sol: balance.sol,
      usdc: balance.usdc,
      totalUsd,
      timestamp: Date.now(),
    };

    logger.debug({
      sol: balance.sol.toFixed(4),
      usdc: balance.usdc.toFixed(2),
      solPrice: solPrice.toFixed(2),
      totalUsd: totalUsd.toFixed(2),
    }, 'Wallet balance updated');

    return cachedBalance;

  } catch (error) {
    logger.error({ error }, 'Error fetching wallet balance');
    return cachedBalance; // Return stale if available
  }
}

/**
 * Get wallet balance synchronously from cache.
 * Returns null if not cached.
 */
export function getWalletBalanceSync(): WalletBalance | null {
  if (cachedBalance && Date.now() - cachedBalance.timestamp < PORTFOLIO_SIZING.BALANCE_CACHE_TTL_MS * 2) {
    return cachedBalance;
  }
  // Trigger async refresh
  getWalletBalance().catch((error) => {
    loggerInstance.warn({ error }, 'Failed to refresh wallet balance in background');
  });
  return cachedBalance;
}

/**
 * Calculate performance multiplier for a symbol.
 * Scales position size based on symbol's win rate vs average.
 */
export async function getPerformanceMultiplier(symbol: string): Promise<number> {
  if (!PORTFOLIO_SIZING.PERFORMANCE_SCALING.ENABLED) {
    return 1.0;
  }

  // Update average win rate periodically
  if (Date.now() - avgWinRateLastUpdate > AVG_WR_UPDATE_INTERVAL_MS) {
    await updateAverageWinRate();
  }

  const perf = await getSymbolPerformance(symbol);

  if (!perf || perf.totalTrades < 5) {
    // Not enough data - use neutral multiplier
    return 1.0;
  }

  // Scale: symbolWR / avgWR, clamped to [MIN, MAX]
  const ratio = avgWinRate > 0 ? perf.winRate / avgWinRate : 1.0;

  return Math.max(
    PORTFOLIO_SIZING.PERFORMANCE_SCALING.MIN_MULTIPLIER,
    Math.min(PORTFOLIO_SIZING.PERFORMANCE_SCALING.MAX_MULTIPLIER, ratio)
  );
}

/**
 * Get performance multiplier synchronously (uses cached data).
 */
export function getPerformanceMultiplierSync(symbol: string): number {
  if (!PORTFOLIO_SIZING.PERFORMANCE_SCALING.ENABLED) {
    return 1.0;
  }

  // Trigger async update if stale
  if (Date.now() - avgWinRateLastUpdate > AVG_WR_UPDATE_INTERVAL_MS) {
    updateAverageWinRate().catch((error) => {
      loggerInstance.warn({ error }, 'Failed to update average win rate in background');
    });
  }

  // Use sync performance data
  const { getPerformanceAdjustmentSync } = require('./performanceTracker');
  const adjustment = getPerformanceAdjustmentSync(symbol);

  // If symbol has penalty (low WR), reduce position size
  // adjustment > 0 means WR < 30%, so multiply by 0.5-0.7
  if (adjustment > 0) {
    return PORTFOLIO_SIZING.PERFORMANCE_SCALING.MIN_MULTIPLIER;
  }

  return 1.0; // Neutral if no penalty
}

/**
 * Update the average win rate across all symbols.
 */
async function updateAverageWinRate(): Promise<void> {
  try {
    const allPerf = await getAllSymbolPerformance();

    if (allPerf.length === 0) {
      return;
    }

    // Weight by trade count
    const totalTrades = allPerf.reduce((s, p) => s + p.totalTrades, 0);
    const weightedWR = allPerf.reduce((s, p) => s + p.winRate * p.totalTrades, 0);

    avgWinRate = totalTrades > 0 ? weightedWR / totalTrades : 0.5;
    avgWinRateLastUpdate = Date.now();

    logger.debug({
      avgWinRate: (avgWinRate * 100).toFixed(1) + '%',
      symbolCount: allPerf.length,
      totalTrades,
    }, 'Average win rate updated');

  } catch (error) {
    logger.error({ error }, 'Failed to update average win rate');
  }
}

/**
 * Calculate dynamic position size based on portfolio.
 *
 * @param symbol Token symbol
 * @param spreadPct Current spread percentage
 * @param tvl Pool TVL
 * @returns Position size details
 */
export async function calculatePortfolioPositionSize(
  symbol: string,
  spreadPct: number,
  tvl: number
): Promise<PositionSizeResult> {
  const balance = await getWalletBalance();

  // Fallback to config if balance unavailable
  const walletBalance = balance?.totalUsd ?? 100; // Default $100 if unknown

  // Base size from portfolio percentage
  const baseSize = walletBalance * PORTFOLIO_SIZING.BASE_RISK_PCT;

  // TVL multiplier (same as existing logic)
  const tvlInMillions = tvl / 1_000_000;
  const tvlMultiplier = Math.max(
    POSITION_SIZE_FORMULA.MIN_MULTIPLIER,
    Math.min(
      POSITION_SIZE_FORMULA.MAX_MULTIPLIER,
      Math.sqrt(tvlInMillions) * POSITION_SIZE_FORMULA.COEFFICIENT
    )
  );

  // Spread multiplier (higher spread = larger position)
  const spreadMultiplier = Math.max(
    ADAPTIVE_POSITION_SIZING.MIN_SPREAD_MULTIPLIER,
    Math.min(
      ADAPTIVE_POSITION_SIZING.MAX_SPREAD_MULTIPLIER,
      (spreadPct * ADAPTIVE_POSITION_SIZING.SPREAD_COEFFICIENT) / 100
    )
  );

  // Performance multiplier (symbol WR vs average)
  const performanceMultiplier = await getPerformanceMultiplier(symbol);

  // Market hours multiplier (higher when NAV is stable)
  const marketHoursMultiplier = getMarketHoursMultiplier();

  // Final calculation
  let sizeUsd = baseSize * tvlMultiplier * spreadMultiplier * performanceMultiplier * marketHoursMultiplier;

  // Apply min/max caps (max scales with market hours too)
  const effectiveMax = PORTFOLIO_SIZING.MAX_POSITION_USD * marketHoursMultiplier;
  sizeUsd = Math.max(PORTFOLIO_SIZING.MIN_POSITION_USD, sizeUsd);
  sizeUsd = Math.min(effectiveMax, sizeUsd);

  logger.debug({
    symbol,
    walletBalance: walletBalance.toFixed(2),
    baseSize: baseSize.toFixed(2),
    tvlMultiplier: tvlMultiplier.toFixed(3),
    spreadMultiplier: spreadMultiplier.toFixed(3),
    performanceMultiplier: performanceMultiplier.toFixed(3),
    marketHoursMultiplier: marketHoursMultiplier.toFixed(2),
    finalSize: sizeUsd.toFixed(2),
  }, 'Portfolio position size calculated');

  return {
    sizeUsd,
    baseSize,
    tvlMultiplier,
    spreadMultiplier,
    performanceMultiplier,
    walletBalance,
  };
}

/**
 * Get position size synchronously (uses cached data).
 * Falls back to config.maxUsdPerTrade if portfolio sizing unavailable.
 */
export function getPortfolioPositionSizeSync(
  symbol: string,
  spreadPct: number,
  tvl: number,
  fallbackMaxUsd: number
): number {
  if (!PORTFOLIO_SIZING.ENABLED) {
    return fallbackMaxUsd;
  }

  const balance = getWalletBalanceSync();

  // Use fallback if balance not available
  if (!balance) {
    return fallbackMaxUsd;
  }

  // Base size from portfolio percentage
  const baseSize = balance.totalUsd * PORTFOLIO_SIZING.BASE_RISK_PCT;

  // TVL multiplier
  const tvlInMillions = tvl / 1_000_000;
  const tvlMultiplier = Math.max(
    POSITION_SIZE_FORMULA.MIN_MULTIPLIER,
    Math.min(
      POSITION_SIZE_FORMULA.MAX_MULTIPLIER,
      Math.sqrt(tvlInMillions) * POSITION_SIZE_FORMULA.COEFFICIENT
    )
  );

  // Spread multiplier
  const spreadMultiplier = Math.max(
    ADAPTIVE_POSITION_SIZING.MIN_SPREAD_MULTIPLIER,
    Math.min(
      ADAPTIVE_POSITION_SIZING.MAX_SPREAD_MULTIPLIER,
      (spreadPct * ADAPTIVE_POSITION_SIZING.SPREAD_COEFFICIENT) / 100
    )
  );

  // Performance multiplier (sync version)
  const performanceMultiplier = getPerformanceMultiplierSync(symbol);

  // Market hours multiplier (higher when NAV is stable)
  const marketHoursMultiplier = getMarketHoursMultiplier();

  // Final calculation with caps
  const effectiveMax = PORTFOLIO_SIZING.MAX_POSITION_USD * marketHoursMultiplier;
  let sizeUsd = baseSize * tvlMultiplier * spreadMultiplier * performanceMultiplier * marketHoursMultiplier;
  sizeUsd = Math.max(PORTFOLIO_SIZING.MIN_POSITION_USD, sizeUsd);
  sizeUsd = Math.min(effectiveMax, sizeUsd);

  return sizeUsd;
}

/**
 * Get portfolio sizing stats for dashboard/monitoring.
 */
export function getPortfolioStats(): {
  enabled: boolean;
  walletBalance: number | null;
  baseRiskPct: number;
  avgWinRate: number;
  lastBalanceUpdate: number | null;
} {
  return {
    enabled: PORTFOLIO_SIZING.ENABLED,
    walletBalance: cachedBalance?.totalUsd ?? null,
    baseRiskPct: PORTFOLIO_SIZING.BASE_RISK_PCT,
    avgWinRate,
    lastBalanceUpdate: cachedBalance?.timestamp ?? null,
  };
}
