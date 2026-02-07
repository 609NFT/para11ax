/**
 * Centralized constants for the Parallax trading bot
 *
 * This file contains static values that don't change and shouldn't be in config.
 * For tunable parameters, see config/config.json
 */

// ============================================================================
// BLOCKCHAIN CONSTANTS
// ============================================================================

/** USDC mint address on Solana mainnet */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDC decimals */
export const USDC_DECIMALS = 6;

/** Wrapped SOL mint address on Solana mainnet */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** SOL decimals */
export const SOL_DECIMALS = 9;

// ============================================================================
// FORMULA-BASED DYNAMIC THRESHOLDS
// Thresholds scale smoothly with TVL using: coefficient / sqrt(tvl_in_millions)
// This eliminates arbitrary tier cutoffs and gives more accurate risk-adjusted thresholds
// ============================================================================

/**
 * Entry threshold formula parameters
 *
 * FULLY DYNAMIC ENTRY:
 * Entry threshold = max(roundTripFees + buffer, slippageBuffer / sqrt(tvl))
 *
 * - roundTripFees: Actual pool fee × 2 (fetched from Raydium API per pool)
 * - buffer: 0.02% safety margin
 * - slippageBuffer: COEFFICIENT / sqrt(tvl) for low-liquidity pools
 * - MIN_FLOOR: Absolute minimum threshold regardless of TVL/fees
 *
 * Example thresholds (with 1.50% floor):
 *   $2M+ TVL  → 1.50% (floor - protects against NAV movement)
 *   $250K     → 1.50% (floor)
 *   $100K     → 1.58% (slippage buffer kicks in)
 *   $50K      → 2.24%
 *
 * The 1.50% floor ensures we have enough buffer for stocks that can
 * move 1-2% while holding the position (NAV risk).
 */
export const ENTRY_THRESHOLD_FORMULA = {
  COEFFICIENT: 0.50,   // Slippage buffer: 0.50 / sqrt(tvl_in_millions) - raised for observed 0.5%+ slippage
  MAX_CAP: 12.0,       // Allow even higher thresholds - selectivity is key
} as const;

/**
 * Dynamic floor formula - replaces static MIN_FLOOR
 * 
 * Core insight: A 3.5% discount on low-vol SPY is better than 3.5% on high-vol TSLA
 * because NAV can move 3% against you while holding the volatile one.
 * 
 * Formula: floor = BASE_FLOOR + (ATR% × VOLATILITY_COEFFICIENT) × regime_multiplier
 * 
 * Examples (normal regime):
 *   SPY (1.2% ATR): 2.0 + 1.2×0.6 = 2.72% floor
 *   AAPL (2.5% ATR): 2.0 + 2.5×0.6 = 3.50% floor  
 *   TSLA (4.5% ATR): 2.0 + 4.5×0.6 = 4.70% floor
 *   MSTR (6.0% ATR): 2.0 + 6.0×0.6 = 5.60% → capped at 5.5%
 */
export const DYNAMIC_FLOOR_FORMULA = {
  ENABLED: true,
  BASE_FLOOR: 5.5,              // LOCKED BY 609: Do not change without explicit approval
  VOLATILITY_COEFFICIENT: 0.6,  // Floor += ATR% × 0.6
  ABSOLUTE_MIN: 5.5,            // LOCKED BY 609: Do not change without explicit approval
  ABSOLUTE_MAX: 8.0,            // Allow up to 8% for high-vol tokens
  FALLBACK_ATR: 2.7,            // Default ATR if no data available
} as const;

/**
 * Market regime detection - adjusts all floors based on overall market volatility
 * 
 * Calm market (median ATR <2%): floors × 0.85 (more opportunities)
 * Normal market: floors × 1.0
 * Volatile market (median ATR >3.5%): floors × 1.20 (more selective)
 */
export const MARKET_REGIME = {
  ENABLED: true,
  CALM_THRESHOLD: 2.0,          // Median ATR below this = calm
  VOLATILE_THRESHOLD: 3.5,      // Median ATR above this = volatile
  CALM_MULTIPLIER: 0.85,        // Reduce floors 15% in calm markets
  VOLATILE_MULTIPLIER: 1.20,    // Increase floors 20% in volatile markets
  REFRESH_INTERVAL_MS: 15 * 60 * 1000, // Recalculate every 15 min
} as const;

/**
 * Percentile-based adaptive threshold parameters
 *
 * HYBRID APPROACH:
 * Effective Entry Threshold = max(TVL-based minimum, percentile-based ceiling)
 *
 * - TVL-based: Ensures break-even (covers fees + slippage)
 * - Percentile-based: Only enter when spread is exceptional for THIS token
 *
 * PRINCIPLE: Don't just enter at a fixed threshold - enter when the opportunity
 * is genuinely exceptional relative to that token's historical behavior.
 *
 * Example: Token A typically has 0.3-0.9% spreads (80th percentile = 0.8%)
 *   - TVL-based threshold: 0.5% (covers costs)
 *   - Percentile threshold: 0.8% (exceptional for this token)
 *   - Effective threshold: max(0.5%, 0.8%) = 0.8%
 *
 * This prevents entering mediocre opportunities that technically cover costs
 * but aren't genuinely exceptional moves.
 */
export const PERCENTILE_THRESHOLD_FORMULA = {
  PERCENTILE: 80,              // Reduced from 95% - 95th percentile too aggressive, missing profitable opportunities
  ROLLING_WINDOW_HOURS: 168,   // 7 days of data - index exists now so should be fast
  MIN_SAMPLES: 50,             // Need at least 50 samples before using percentile
  ENABLED: true,               // Re-enabled 2026-02-04: index idx_discount_history_time_symbol exists
} as const;

/**
 * Exit threshold formula parameters
 * Formula: max(MIN_FLOOR, COEFFICIENT / sqrt(tvl_in_millions))
 *
 * PRINCIPLE: Exit when token appreciation covers our costs.
 * Since we enter at discount, token just needs to revert toward fair value.
 * The trailing stop then lets winners run for extra juice.
 *
 * Example thresholds (COEFFICIENT=0.10, MIN_FLOOR=0.35):
 *   $1M+ TVL  → 0.35% (floor) - ensures buffer for execution slippage
 *   $500K     → 0.35% (floor)
 *   $100K     → 0.35% (floor) - need more appreciation to cover slippage
 */
export const EXIT_THRESHOLD_FORMULA = {
  COEFFICIENT: 2.50,   // Backtest: 2.5% exit target dominates all others (+$8 vs +$3.78 at 0.5%)
  MIN_FLOOR: 2.00,     // Don't exit below 2% spread — captures bulk of profitable move
  MAX_CAP: 3.00,       // Cap for very illiquid tokens
} as const;

/**
 * Liquidity-Informed Dynamic Exit Strategy (2026-02-07)
 * Adapts exit thresholds based on pool TVL for optimized reversion timing
 */
export const LIQUIDITY_INFORMED_EXIT = {
  ENABLED: true,                    // Feature flag
  HIGH_TVL_THRESHOLD_MILLIONS: 1.0, // $1M+ = high liquidity
  MEDIUM_TVL_THRESHOLD_MILLIONS: 0.2, // $200K+ = medium liquidity
  HIGH_TVL_EXIT_PCT: 2.0,          // Fast exits for high liquidity
  MEDIUM_TVL_EXIT_PCT: 2.5,        // Standard exits for medium liquidity  
  LOW_TVL_EXIT_PCT: 3.5,           // Patient exits for low liquidity
} as const;

/**
 * Position size formula parameters
 * Scales position size with liquidity: min(1.0, sqrt(tvl_in_millions) * COEFFICIENT)
 * Higher liquidity = can trade larger % of maxUsdPerTrade
 */
export const POSITION_SIZE_FORMULA = {
  COEFFICIENT: 0.7,    // Multiplier for sqrt scaling
  MIN_MULTIPLIER: 0.2, // Minimum position size (20% of maxUsdPerTrade)
  MAX_MULTIPLIER: 1.0, // Maximum position size (100% of maxUsdPerTrade)
} as const;

/**
 * Adaptive position sizing - scales position size with spread size and liquidity
 * Higher spreads = higher expected profit = larger position size (risk-adjusted)
 * Formula: base_position * spread_multiplier * liquidity_factor
 */
export const ADAPTIVE_POSITION_SIZING = {
  ENABLED: true,                     // Feature flag - ENABLED for testing
  SPREAD_COEFFICIENT: 18,            // Increased from 12 to 18: larger positions for good spreads
  LIQUIDITY_EXPONENT: 0.2,           // How much TVL variation affects sizing (0.2 = conservative)
  MIN_SPREAD_MULTIPLIER: 0.6,        // Minimum spread multiplier (60% of base)
  MAX_SPREAD_MULTIPLIER: 2.0,        // Increased from 1.3 to 2.0: allow bigger positions for exceptional spreads
} as const;

/**
 * Portfolio-Based Position Sizing
 * 
 * Automatically scales position size with wallet balance.
 * Compounds gains (larger positions as you win) and limits losses (smaller as you lose).
 * 
 * Formula: wallet_balance × BASE_RISK_PCT × symbol_modifiers
 */
export const PORTFOLIO_SIZING = {
  ENABLED: true,                     // Feature flag
  BASE_RISK_PCT: 0.03,               // 3% of portfolio per trade (conservative)
  MIN_POSITION_USD: 5,               // Minimum $5 per trade (avoid dust)
  MAX_POSITION_USD: 100,             // Maximum $100 per trade (risk cap)
  BALANCE_CACHE_TTL_MS: 60_000,      // Cache wallet balance for 1 minute
  PERFORMANCE_SCALING: {
    ENABLED: true,                   // Scale by symbol win rate
    MIN_MULTIPLIER: 0.5,             // Poor performers get 50% size minimum
    MAX_MULTIPLIER: 1.5,             // Good performers get 150% size maximum
  },
  // Market hours position scaling
  // Outside market hours: NAV is frozen, only spread risk exists
  // Inside market hours: NAV moves constantly, higher risk
  MARKET_HOURS_SCALING: {
    ENABLED: true,
    OFF_MARKET_MULTIPLIER: 2.0,      // 2x position size when market closed (NAV stable)
    PRE_POST_MULTIPLIER: 1.5,        // 1.5x during pre/post (NAV semi-stable)
    REGULAR_MULTIPLIER: 1.0,         // Normal size during regular hours (NAV volatile)
  },
} as const;

// TVL tier constants - used by liquidityChecker for DISABLED threshold
export const TVL_ENTRY_THRESHOLDS = {
  TIER_1: { minTvl: 1_000_000, entryPct: 0.5 },
  TIER_2: { minTvl: 500_000, entryPct: 0.8 },
  TIER_3: { minTvl: 100_000, entryPct: 1.0 },
  TIER_4: { minTvl: 50_000, entryPct: 1.5 },
  TIER_5: { minTvl: 10_000, entryPct: 2.0 },
  DISABLED: { minTvl: 0, entryPct: 999 },
} as const;

/**
 * Minimum TVL to enable trading for a token
 *
 * Raised from $10K to $50K based on actual trade data:
 * - DFDV at $26K TVL: 4-26% round-trip slippage, consistently unprofitable
 * - Pools below $50K have asymmetric liquidity that makes exit slippage catastrophic
 * - Even with large discounts (5%+), fees eat all profit on low-TVL pools
 */
export const MIN_TVL_FOR_TRADING = 50_000;

// ============================================================================
// TRADING TIME FILTERS
// ============================================================================

/** Enhanced time-of-day optimization settings */
export const TIME_OF_DAY_OPTIMIZATION = {
  ENABLED: false,                    // DISABLED: DB connectivity issues causing 100+ errors/min
  FALLBACK_TO_GLOBAL: true,          // Use global stats when insufficient token-specific data
} as const;

/** Hours (UTC) to avoid trading due to historically low win rates
 *  Analysis (640 trades): 12-14 UTC (7-9 AM EST market open) = 6-8% WR vs 33-54% at 17-20 UTC
 *  Updated 2026-02-06: Expanded based on 7-day analysis showing poor performance in broader market hours
 *  Market open creates chaotic spreads that don't mean-revert predictably
 *  NOTE: Used as fallback when TIME_OF_DAY_OPTIMIZATION is disabled */
export const AVOID_TRADING_HOURS_UTC = [12, 13, 14]; // 7-10 AM EST market open + extended volatility

/** Hours (UTC) where we require higher entry thresholds due to lower win rates
 *  These hours have historically lower win rates but not bad enough to completely avoid
 *  Require additional 1.0% spread buffer during these periods */
export const HIGH_THRESHOLD_HOURS_UTC = [10, 11, 15, 16]; // Pre-market, lunch hour chaos

// ============================================================================
// HOLD TIME CONSTANTS
// ============================================================================

/** Max hold time - 60 minutes
 *  Data (7d, 494 trades): 4%+ entries held >2hr = 0% win rate, -$1.79 total.
 *  Sweet spot is 15-30min (64% WR). After 60min, losses accelerate.
 *  Changed 2026-02-05 from 4h based on real trade data. */
export const MAX_HOLD_TIME_MS = 60 * 60 * 1000;

/** Minimum time to hold before allowing exit (prevents quick flips) */
export const MIN_HOLD_TIME_MS = 5 * 60 * 1000; // 5 minutes — data shows <5min exits have 10% WR vs 33% for 5-15min

// ============================================================================
// TIME-DECAYING EXIT THRESHOLD
// ============================================================================
// After DECAY_START, exit threshold linearly decays from full value to MIN_EXIT
// With 60min max hold, decay starts at 30min and ends at 50min.
// Changed 2026-02-05: shortened proportionally with max hold (was 2h/3.5h for 4h hold).

/** Time before exit threshold starts decaying (30 minutes) */
export const EXIT_THRESHOLD_DECAY_START_MS = 30 * 60 * 1000;

/** Time when exit threshold reaches minimum (50 minutes) */
export const EXIT_THRESHOLD_DECAY_END_MS = 50 * 60 * 1000;

/** Minimum exit threshold after time decay (1.0%)
 *  Even at max decay, don't exit unless we capture at least 1% spread.
 *  Backtest: exits below 1.5% have lower P&L. This ensures profit after fees. */
export const MIN_EXIT_THRESHOLD_PCT = 1.0;

// ============================================================================
// SPREAD-WIDENING STOP
// ============================================================================
// If the spread widens significantly from entry, exit immediately.
// Data (7d): trades where spread widened >1.5% from entry had 0% win rate.
// This prevents holding losers until max_hold when the spread is clearly diverging.
// Added 2026-02-05 based on analysis of max_hold exits (all showed spread widening).

/** Maximum spread widening from entry before forced exit (1.5%)
 *  e.g., enter at 4% discount, if spread widens to 5.5%, exit immediately. */
export const SPREAD_WIDENING_STOP_PCT = 1.5;

// ============================================================================
// SAFETY THRESHOLDS
// ============================================================================

/** Grace period before stop-loss executes (prevents false triggers) */
export const STOP_LOSS_GRACE_PERIOD_MS = 60 * 1000; // 60 seconds

/** Maximum stale price age for lenient exit decisions (5 minutes)
 *  If price is unavailable but cache is <5min old, use cached price for exit.
 *  Only force-exit when price is truly stale (>5 minutes) */
export const LENIENT_EXIT_MAX_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Price-based stop loss threshold (triggers when token drops this % from entry) */
export const PRICE_STOP_LOSS_PCT = -5; // -5% = exit if token dropped 5%+ from entry price

/**
 * Stock price stop loss - exit if underlying stock drops too much from entry
 * Now dynamically calculated from ATR (Average True Range) via Twelve Data API
 * See src/feeds/volatilityFeed.ts for implementation
 *
 * Fallback value used when API is unavailable
 */
export const STOCK_STOP_LOSS_DEFAULT_PCT = -5; // Fallback: -5% if no volatility data

/** Cooldown after a failed trade before retrying that token */
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Cooldown for tokens with bad pricing data (unreasonable deviation) */
export const BAD_PRICING_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Cooldown for tokens with excessive price impact (illiquid pools) - default for low liquidity */
export const PRICE_IMPACT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * TVL-based price impact cooldowns
 * Higher liquidity pools recover faster from temporary price impact issues
 * Reduced cooldowns for faster retry on transient issues
 */
export const TVL_PRICE_IMPACT_COOLDOWNS = {
  TIER_1: { minTvl: 1_000_000, cooldownMs: 5 * 60 * 1000 },   // $1M+ TVL: 5 min cooldown (was 10)
  TIER_2: { minTvl: 500_000, cooldownMs: 10 * 60 * 1000 },    // $500K-1M: 10 min cooldown (was 15)
  DEFAULT: { minTvl: 0, cooldownMs: 15 * 60 * 1000 },         // <$500K: 15 min cooldown (was 30)
} as const;

/** Maximum reasonable discount - blocks trades if exceeded (likely data error) */
export const MAX_REASONABLE_DEVIATION_PCT = 50;

/** Maximum reasonable discount for exit checks - blocks if exceeded (stale data) */
export const MAX_REASONABLE_DISCOUNT = 20;

/** Minimum liquidity required to trade (without Raydium pool) */
export const MIN_LIQUIDITY_USD = 1000;

/** Minimum expected profit to execute a trade (in USD) */
export const MIN_EXPECTED_PROFIT_USD = 0.015;

/**
 * TVL-scaled minimum expected profit percentage
 * Higher TVL = more reliable execution = can accept thinner edge
 *
 * Based on trade data analysis:
 * - All historical losses were from max_hold_time/NAV drops, not thin edges
 * - High TVL pools have consistent execution with low slippage
 * - Low TVL pools need more buffer for execution uncertainty
 */
export const MIN_PROFIT_LINEAR = {
  MIN_TVL: 100_000,      // Below this, use max profit requirement
  MAX_TVL: 2_000_000,    // Above this, use min profit requirement
  AT_MIN_TVL: 0.20,      // 0.20% at $100K TVL (current default)
  AT_MAX_TVL: 0.08,      // 0.08% at $2M+ TVL (reliable execution)
} as const;

/**
 * Get minimum expected profit percentage based on TVL
 * Linear interpolation between anchor points
 *
 * @param tvlUsd - Pool TVL in USD
 * @returns Minimum profit percentage required (e.g., 0.15 = 0.15%)
 */
export function getMinExpectedProfitPct(tvlUsd: number): number {
  const { MIN_TVL, MAX_TVL, AT_MIN_TVL, AT_MAX_TVL } = MIN_PROFIT_LINEAR;

  // Below minimum TVL - use max profit requirement
  if (tvlUsd <= 0 || tvlUsd < MIN_TVL) {
    return AT_MIN_TVL;
  }

  // Above maximum TVL - use min profit requirement
  if (tvlUsd >= MAX_TVL) {
    return AT_MAX_TVL;
  }

  // Linear interpolation: higher TVL = lower requirement
  const slope = (AT_MIN_TVL - AT_MAX_TVL) / (MAX_TVL - MIN_TVL);
  return AT_MIN_TVL - (tvlUsd - MIN_TVL) * slope;
}

/** Maximum allowed price impact on entry (difference between API price and actual quote)
 *  Hard cap - blocks entry even if projected profit is positive
 *  Protects against low-liquidity pools where execution slippage can be 5-10x worse than quoted */
export const MAX_ENTRY_PRICE_IMPACT_PCT = 3; // 3% = reject if quote price differs >3% from API price

// ============================================================================
// SIGNAL STABILITY
// ============================================================================

/** Number of price readings to keep for smoothing */
export const SPREAD_HISTORY_SIZE = 3;

/** Consecutive stable readings needed before entry */
export const MIN_STABLE_READINGS = 1; // Was 2 - removed to allow faster entries

// ============================================================================
// TRAILING STOP (Let winners run)
// ============================================================================

/**
 * Trailing stop: once position exceeds exit threshold, we let it run.
 * If it pulls back by this percentage from the peak, we exit.
 * Example: peak = 0.5% appreciation, trailing = 0.1% → exit at 0.4%
 */
export const TRAILING_STOP_PULLBACK_PCT = 0.05; // Exit if drops 0.05% from peak

// ============================================================================
// TIMING & THROTTLING
// ============================================================================

/** Main trading loop interval */
export const LOOP_INTERVAL_MS = 10000; // 10 seconds - reduced from 3s to save Supabase compute

/** Minimum interval between API calls */
export const MIN_API_INTERVAL_MS = 200;

/** Delay between orphan token cleanup sells */
export const ORPHAN_CLEANUP_DELAY_MS = 2000;

/** Minimum USD value to attempt selling orphan tokens (skip dust below this) */
export const MIN_ORPHAN_VALUE_USD = 0.10;

/** Minimum USD value to attempt selling on exit (close position as dust if below this) */
export const MIN_SELLABLE_VALUE_USD = 0.05;

/** Cache duration for market open/closed status */
export const MARKET_STATUS_CACHE_MS = 15 * 60 * 1000; // 15 minutes

/** Liquidity/TVL and token list refresh interval */
export const LIQUIDITY_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** API batch size for pool TVL fetches */
export const API_BATCH_SIZE = 20;

/** Delay between API batch requests */
export const API_BATCH_DELAY_MS = 100;

// ============================================================================
// EXECUTION & RETRY
// ============================================================================

/**
 * Slippage escalation for exit trades (basis points)
 * Starts tight and increases on retry to balance execution vs price protection
 * - Start at 1% to get good fills
 * - Escalate to 1.5% then 2% if needed
 * - Never exceed 2% - if market is that bad, wait for next opportunity
 */
export const EXIT_SLIPPAGE_ESCALATION_BPS = [100, 150, 200]; // 1% → 1.5% → 2%

/** Maximum allowed slippage for any trade (basis points) */
export const MAX_SLIPPAGE_BPS = 200; // 2% hard cap

/** Slippage for orphan token cleanup (basis points) - can be higher since we just want to recover funds */
export const CLEANUP_SLIPPAGE_BPS = 300; // 3%

/** Compute units for Raydium CLMM swaps (typical swap uses ~200k) */
export const RAYDIUM_COMPUTE_UNITS = 300_000;

/** Priority fee escalation per retry attempt (microLamports per compute unit) */
// Start with higher base fees to reduce timeouts, escalate aggressively if needed
// Recent logs show 8+ "block height exceeded" errors - need more aggressive starting fees
export const PRIORITY_FEE_ESCALATION = [5_000, 15_000, 50_000, 100_000, 200_000];

// ============================================================================
// FEE ESTIMATES
// ============================================================================

/**
 * Legacy static fee estimate (kept for reference)
 * @deprecated Use getEstimatedFeesPct(tvl) for TVL-based estimates
 */
export const ESTIMATED_FEES_PCT = 0.05; // Lowered from 0.1 - actual slippage ~0.01% on liquid pools

/**
 * TVL-based fee estimation - LINEAR SCALING approach
 *
 * Based on actual trade data analysis (Jan 2026):
 * - $26K TVL (DFDV): 1.5-26% actual round-trip fees
 * - $82K TVL (COIN): 0.37% actual
 * - $227K TVL (NVDA): 0.26% actual
 * - $648K TVL (MSTR): 0.54% actual
 * - $1M+ TVL (TSLA, CRCL): 0.2-1.1% actual
 *
 * Key insight: Low-TVL pools have ASYMMETRIC slippage - entry may look fine
 * but exit slippage can be 5-10x higher due to thin sell-side liquidity.
 *
 * Linear interpolation between anchor points:
 *   $50K TVL  → 0.50% (higher fees for low liquidity)
 *   $2M+ TVL  → 0.05% (liquid, minimal fees)
 *
 * Formula: fee = maxFee - (tvl - minTvl) * slope
 * where slope = (maxFee - minFee) / (maxTvl - minTvl)
 *
 * Based on actual trade data showing fees typically 0.01-0.05% per trade.
 *
 * Example outputs:
 *   <$100K → 10.00% (effectively blocked)
 *   $100K  → 0.50%
 *   $500K  → 0.40%
 *   $1M    → 0.26%
 *   $2M    → 0.05%
 */
export const FEE_ESTIMATE_LINEAR = {
  MIN_TVL: 80_000,      // Below this, use penalty fee (lowered to make MSTR tradeable at 96K TVL)
  MAX_TVL: 2_000_000,   // Above this, use min fee
  MIN_FEE_PCT: 0.05,    // Fee at MAX_TVL
  MAX_FEE_PCT: 0.50,    // Fee at MIN_TVL
  BELOW_MIN_FEE_PCT: 10.00, // Fee for TVL below MIN_TVL - effectively blocks (raised from 2% after DFDV 33% actual)
} as const;

/**
 * Estimate price impact for a trade
 * Based on constant product AMM formula with liquidity concentration factor
 *
 * Formula: (tradeSize / (tvl/2)) * concentrationMultiplier
 *
 * The concentration multiplier accounts for CLMM pools where liquidity
 * may not be evenly distributed around current price. Tokenized stock
 * pools often have thin liquidity, requiring a higher multiplier.
 *
 * Empirical observation from AMBR ($30K TVL, $20 trade → 20% impact):
 *   Theoretical: 20 / 15000 = 0.13%
 *   Actual: 20%
 *   Multiplier needed: ~150x
 *
 * This suggests these pools have very concentrated liquidity away from
 * current trading prices. We use a conservative multiplier for safety.
 */
export const PRICE_IMPACT_FORMULA = {
  BASE_MULTIPLIER: 50,     // Conservative multiplier for thin liquidity
  HIGH_TVL_MULTIPLIER: 10, // More efficient for pools > $500K
  TVL_THRESHOLD: 500_000,  // TVL threshold for switching multipliers
} as const;

/**
 * Estimate price impact percentage for a given trade
 * @param tradeSizeUsd - Trade size in USD
 * @param tvlUsd - Pool TVL in USD
 * @returns Estimated price impact as percentage (e.g., 1.5 = 1.5%)
 */
export function estimatePriceImpactPct(tradeSizeUsd: number, tvlUsd: number): number {
  if (tvlUsd <= 0) return 100; // No liquidity = 100% impact

  const multiplier = tvlUsd >= PRICE_IMPACT_FORMULA.TVL_THRESHOLD
    ? PRICE_IMPACT_FORMULA.HIGH_TVL_MULTIPLIER
    : PRICE_IMPACT_FORMULA.BASE_MULTIPLIER;

  // Base formula: tradeSize / (tvl/2) gives theoretical impact for constant product
  const theoreticalImpact = (tradeSizeUsd / (tvlUsd / 2)) * 100;

  return theoreticalImpact * multiplier;
}

/**
 * Get estimated round-trip fees based on TVL using linear interpolation
 *
 * Linear scaling between anchor points provides smooth fee estimates
 * that scale proportionally with liquidity depth.
 *
 * @param tvlUsd - Pool TVL in USD
 * @returns Estimated round-trip fee percentage (e.g., 0.5 = 0.5%)
 */
export function getEstimatedFeesPct(tvlUsd: number): number {
  const { MIN_TVL, MAX_TVL, MIN_FEE_PCT, MAX_FEE_PCT, BELOW_MIN_FEE_PCT } = FEE_ESTIMATE_LINEAR;

  // Below minimum TVL - use penalty fee (effectively blocks trading)
  if (tvlUsd <= 0 || tvlUsd < MIN_TVL) {
    return BELOW_MIN_FEE_PCT;
  }

  // Above maximum TVL - use minimum fee
  if (tvlUsd >= MAX_TVL) {
    return MIN_FEE_PCT;
  }

  // Linear interpolation between MIN_TVL and MAX_TVL
  // fee = maxFee - (tvl - minTvl) * slope
  const slope = (MAX_FEE_PCT - MIN_FEE_PCT) / (MAX_TVL - MIN_TVL);
  const fee = MAX_FEE_PCT - (tvlUsd - MIN_TVL) * slope;

  return fee;
}


// ============================================================================
// FEE TRACKING CONSTANTS
// ============================================================================

/** Base Solana transaction fee in lamports (~5000 lamports per signature) */
export const SOLANA_BASE_FEE_LAMPORTS = 5000;

/** Jupiter compute units (typical swap) */
export const JUPITER_COMPUTE_UNITS = 200_000;

/** Lamports per SOL for conversion */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Micro lamports per lamport for priority fee calculation */
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

// ============================================================================
// SOL PRICE CACHE (for fee conversion)
// ============================================================================

let cachedSolPrice: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_MS = 60 * 1000; // 1 minute

/**
 * Fetch SOL price from Jupiter (cached)
 * Used for converting lamport fees to USD
 */
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();

  // Return cached price if fresh
  if (cachedSolPrice && (now - cachedSolPrice.timestamp) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice.price;
  }

  try {
    // Use quote-based pricing: get how much SOL 1 USDC buys, then invert
    const headers: Record<string, string> = {};
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    if (jupiterApiKey) {
      headers['x-api-key'] = jupiterApiKey;
    }
    const response = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000', { headers });
    const data = await response.json() as { outAmount?: string };
    const solLamports = parseInt(data?.outAmount || '0', 10);

    if (solLamports > 0) {
      // 1 USDC (1e6 lamports) buys X SOL lamports
      // Price = 1 / (solLamports / 1e9) = 1e9 / solLamports
      const price = LAMPORTS_PER_SOL / solLamports;
      cachedSolPrice = { price, timestamp: now };
      return price;
    }
  } catch {
    // Fall through to cached/default
  }

  // Return cached price if available, otherwise use fallback
  return cachedSolPrice?.price || 180; // $180 fallback
}

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * Enhanced Quote Optimization
 * Uses network congestion-aware tip estimation and route scoring
 */
export const ENHANCED_QUOTE_OPTIMIZATION = {
  ENABLED: true,                     // Feature flag - enable enhanced quote comparison
  TIP_SCALING_FACTOR: 1.0,          // Scale tips up/down (1.0 = normal)
  EXECUTION_SCORE_WEIGHT: 0.2,      // Weight of execution probability in selection (0.2 = 20%)
} as const;

// Volatility-Adaptive Exit Strategy removed (dead code, feature never used)

/**
 * Calculate priority fee in USD
 * @param microLamportsPerCu - Priority fee in microLamports per compute unit
 * @param computeUnits - Number of compute units used
 * @param solPriceUsd - Current SOL price in USD
 */
export function calculatePriorityFeeUsd(
  microLamportsPerCu: number,
  computeUnits: number,
  solPriceUsd: number
): { lamports: number; usd: number } {
  // microLamports per CU * CUs = total microLamports
  // microLamports / 1e6 = lamports
  // lamports / 1e9 = SOL
  const totalMicroLamports = microLamportsPerCu * computeUnits;
  const lamports = totalMicroLamports / MICRO_LAMPORTS_PER_LAMPORT;
  const sol = lamports / LAMPORTS_PER_SOL;
  const usd = sol * solPriceUsd;

  return { lamports, usd };
}

/**
 * Calculate network fee in USD
 * @param solPriceUsd - Current SOL price in USD
 */
export function calculateNetworkFeeUsd(solPriceUsd: number): { lamports: number; usd: number } {
  const lamports = SOLANA_BASE_FEE_LAMPORTS;
  const sol = lamports / LAMPORTS_PER_SOL;
  const usd = sol * solPriceUsd;

  return { lamports, usd };
}
