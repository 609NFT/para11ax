/**
 * Mean Reversion Signal Generator
 *
 * Detects when tokenized stocks trade at a discount vs their stock price.
 * Entry: Token trades >1.5% below stock price (buy the discount)
 * Exit: Discount normalizes to ~0.3% (sell at fair value)
 *
 * Works 24/7 - token markets trade around the clock.
 */

import {
  TokenPair,
  PairSpread,
  MeanReversionSignal,
  MeanReversionPosition,
  OnchainPrice,
} from '../types';
import { signalLogger } from '../logger';
import { getConfigSync } from '../config';
import { getOnchainFeed, getStockFeed } from '../feeds';
import { getEntryThreshold, getExitThreshold, getAdaptivePositionSize, isTokenEnabledByLiquidity, isTokenEnabledForSpread, getTokenTVL, getSwapRouting } from '../liquidity/liquidityChecker';
import { isEquityMarketOpen } from '../execution/flashTradeClient';
import { fetchBatchDexScreenerPrices } from '../feeds/dexScreenerFeed';
import { getRaydiumClient, getJupiterClient } from '../execution';
import {
  getEstimatedFeesPct,
  FAILURE_COOLDOWN_MS,
  BAD_PRICING_COOLDOWN_MS,
  TVL_PRICE_IMPACT_COOLDOWNS,
  SPREAD_HISTORY_SIZE,
  MIN_STABLE_READINGS,
  STOP_LOSS_GRACE_PERIOD_MS,
  MAX_HOLD_TIME_MS,
  MAX_REASONABLE_DEVIATION_PCT,
  MAX_REASONABLE_DISCOUNT,
  MIN_LIQUIDITY_USD,
  MIN_EXPECTED_PROFIT_USD,
  getMinExpectedProfitPct,
  MIN_HOLD_TIME_MS,
  PRICE_STOP_LOSS_PCT,
  MAX_ENTRY_PRICE_IMPACT_PCT,
  TRAILING_STOP_PULLBACK_PCT,
  USDC_MINT,
  EXIT_THRESHOLD_DECAY_START_MS,
  EXIT_THRESHOLD_DECAY_END_MS,
  MIN_EXIT_THRESHOLD_PCT,
  LENIENT_EXIT_MAX_STALE_MS,
  SPREAD_WIDENING_STOP_PCT,
  AVOID_TRADING_HOURS_UTC,
  TIME_OF_DAY_OPTIMIZATION,
} from '../constants';
import { getDynamicStopLossPct, getVolatilityPositionMultiplier, getVolatilityEntryMultiplier } from '../feeds/volatilityFeed';
import { isOptimalTradingTime } from './timeOfDayOptimizer';

// Timeout helper for quote fetching
const QUOTE_TIMEOUT_MS = 10000; // 10 second timeout for quotes
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ]);
}

/**
 * Generate exit reason string describing spread/NAV movement
 * Format: "X%→Y%" (spread) and/or "NAV↑Z%" or "NAV↓Z%"
 * Shows both positive and negative factors to explain actual P&L
 */
function getDetailedExitReason(
  discountCaptured: number,
  stockChangePct: number,
  entryDiscount: number,
  exitDiscount: number
): string {
  const discountNarrowed = discountCaptured > 0.3;
  const navRose = stockChangePct > 0.3;
  const navDropped = stockChangePct < -0.3;
  const e = entryDiscount.toFixed(1);
  const x = exitDiscount.toFixed(1);

  const parts: string[] = [];

  // Show spread movement if significant
  if (discountNarrowed) {
    parts.push(`${e}%→${x}%`);
  }

  // Show NAV movement (up or down) if significant
  if (navRose) {
    parts.push(`NAV↑${stockChangePct.toFixed(1)}%`);
  } else if (navDropped) {
    parts.push(`NAV↓${Math.abs(stockChangePct).toFixed(1)}%`);
  }

  return parts.length > 0 ? parts.join(' + ') : 'target';
}

// Max hold time is now flat 24 hours regardless of market status
// If mean reversion hasn't happened in 24h, exit and move on

// Cache for near-threshold tokens (for dashboard watchlist)
export interface WatchlistItem {
  symbol: string;
  ticker: string;
  mint: string;
  stockPrice: number;
  tokenPrice: number;
  discount: number;
  entryThreshold: number;
  gap: number;
  tvl: number;
  timestamp: number;  // When prices were last updated (legacy)
  stockTimestamp: number;  // When stock price was last updated
  tokenTimestamp: number;  // When token price was last updated
  rejectReason?: string;  // Why above-threshold token isn't trading (short, for UI)
}
let cachedWatchlist: WatchlistItem[] = [];

// Cache for rejection reasons (populated during evaluation, used by watchlist)
const rejectionReasonCache: Map<string, string> = new Map();

export function setRejectionReason(symbol: string, reason: string): void {
  rejectionReasonCache.set(symbol, reason);
}

export function clearRejectionReason(symbol: string): void {
  rejectionReasonCache.delete(symbol);
}

export function getRejectionReason(symbol: string): string | undefined {
  return rejectionReasonCache.get(symbol);
}

// Track when prices actually changed (not just fetched)
interface PriceChangeTracker {
  stockPrice: number;
  stockChangedAt: number;
  tokenPrice: number;
  tokenChangedAt: number;
}
const priceChangeTrackers: Map<string, PriceChangeTracker> = new Map();

export function getWatchlist(): WatchlistItem[] {
  // Attach rejection reasons to watchlist items before returning
  return cachedWatchlist.map(item => ({
    ...item,
    rejectReason: item.gap <= 0 ? rejectionReasonCache.get(item.symbol) : undefined,
  }));
}

// Cache for batch spreads - used to ensure evaluate() uses the same prices as batch calculation
let cachedBatchSpreads: Map<string, PairSpread> = new Map();
let batchSpreadsCacheTime: number = 0;
let batchSpreadsCacheTtlMs = 10000; // Default: spreads are valid for this long
const DEXSCREENER_RATE_LIMIT_PER_MIN = 300;
const DEXSCREENER_BATCH_SIZE = 30;
const JUPITER_RATE_LIMIT_PER_MIN = 60;
const JUPITER_BATCH_SIZE = 50;
let useDexScreenerBatchNext = true;

function getDexScreenerMinBatchIntervalMs(targetCount: number): number {
  const batchCount = Math.max(1, Math.ceil(targetCount / DEXSCREENER_BATCH_SIZE));
  return Math.ceil((batchCount / DEXSCREENER_RATE_LIMIT_PER_MIN) * 60 * 1000);
}

function getJupiterMinBatchIntervalMs(targetCount: number): number {
  const batchCount = Math.max(1, Math.ceil(targetCount / JUPITER_BATCH_SIZE));
  return Math.ceil((batchCount / JUPITER_RATE_LIMIT_PER_MIN) * 60 * 1000);
}

// Exit cooldown: prevent re-entry immediately after exiting a position
// This avoids "self-interference" where our own exit shifts pool liquidity
// and causes worse entry price on immediate re-entry
// INCREASED from 60s to 5min to prevent churning across ALL tokens
const EXIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes after closing a position
const ENTRY_COOLDOWN_MS = 5_000; // 5 seconds after opening a position (prevents duplicate entries)

export class MeanReversionSignalGenerator {
  private targets: TokenPair[] = [];
  private failureCooldowns: Map<string, number> = new Map();
  private badPricingCooldowns: Map<string, number> = new Map(); // Tokens with unreasonable deviations
  private priceImpactCooldowns: Map<string, number> = new Map(); // Tokens with excessive price impact
  private exitCooldowns: Map<string, number> = new Map(); // Tokens recently exited (by token symbol)
  private entryCooldowns: Map<string, number> = new Map(); // Tokens recently entered (prevents duplicate positions)
  private discountHistory: Map<string, number[]> = new Map();

  // Trailing stop: track peak appreciation for each position
  // Key: position ID, Value: { peakAppreciationPct, trailingStopActive }
  private trailingStops: Map<string, { peakPct: number; active: boolean }> = new Map();

  constructor() {
    this.buildTargets();
    signalLogger.info({ targets: this.targets.length }, 'MeanReversionSignalGenerator initialized');
  }

  /**
   * Record discount reading for smoothing
   */
  private recordDiscount(ticker: string, symbol: string, discountPct: number): void {
    const key = `${ticker}:${symbol}`;
    const history = this.discountHistory.get(key) || [];
    history.push(discountPct);
    while (history.length > SPREAD_HISTORY_SIZE) {
      history.shift();
    }
    this.discountHistory.set(key, history);
  }

  /**
   * Check if discount has been stable above threshold for N readings
   */
  private isDiscountStable(ticker: string, symbol: string, threshold: number): boolean {
    const key = `${ticker}:${symbol}`;
    const history = this.discountHistory.get(key);
    if (!history || history.length < MIN_STABLE_READINGS) return false;
    const recentReadings = history.slice(-MIN_STABLE_READINGS);
    return recentReadings.every((discount: number) => discount >= threshold);
  }

  /**
   * Build targets from config - one entry per enabled token
   */
  private buildTargets(): void {
    const config = getConfigSync();

    for (const token of config.tokens) {
      if (!token.enabled) continue;

      // TokenPair format for backwards compatibility (tokenA === tokenB)
      this.targets.push({
        stockTicker: token.stockTicker,
        tokenA: token,
        tokenB: token,
      });

      signalLogger.debug({
        ticker: token.stockTicker,
        token: token.symbol,
      }, 'Added mean reversion target');
    }
  }

  /**
   * Get all configured targets
   */
  getTargets(): TokenPair[] {
    return this.targets;
  }

  /**
   * Record a failed trade attempt for cooldown tracking
   * Uses token symbol (not stock ticker) to avoid blocking other tokens for the same stock
   */
  recordFailure(symbol: string): void {
    this.failureCooldowns.set(symbol, Date.now());
    signalLogger.warn({ symbol, cooldownMs: FAILURE_COOLDOWN_MS }, 'Token entered failure cooldown');
  }

  /**
   * Check if a token is in cooldown after failure
   * Uses token symbol (not stock ticker) to check per-token cooldown
   */
  isInCooldown(symbol: string): boolean {
    const lastFailure = this.failureCooldowns.get(symbol);
    if (!lastFailure) return false;
    const elapsed = Date.now() - lastFailure;
    if (elapsed >= FAILURE_COOLDOWN_MS) {
      this.failureCooldowns.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * Get remaining cooldown time in ms
   * Uses token symbol (not stock ticker)
   */
  getCooldownRemaining(symbol: string): number {
    const lastFailure = this.failureCooldowns.get(symbol);
    if (!lastFailure) return 0;
    const elapsed = Date.now() - lastFailure;
    return Math.max(0, FAILURE_COOLDOWN_MS - elapsed);
  }

  /**
   * Record a token with bad pricing data (unreasonable deviation)
   * These tokens are skipped for 30 minutes to avoid log spam
   */
  private recordBadPricing(symbol: string): void {
    this.badPricingCooldowns.set(symbol, Date.now());
  }

  /**
   * Check if a token is in bad pricing cooldown
   */
  private isInBadPricingCooldown(symbol: string): boolean {
    const lastBad = this.badPricingCooldowns.get(symbol);
    if (!lastBad) return false;
    const elapsed = Date.now() - lastBad;
    if (elapsed >= BAD_PRICING_COOLDOWN_MS) {
      this.badPricingCooldowns.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * Record a token with excessive price impact (illiquid pool)
   * These tokens are skipped for 30 minutes to avoid log spam
   */
  private recordPriceImpactCooldown(symbol: string): void {
    this.priceImpactCooldowns.set(symbol, Date.now());
  }

  /**
   * Get TVL-based cooldown duration for price impact
   * Higher liquidity tokens get shorter cooldowns (recover faster)
   */
  private getPriceImpactCooldownMs(symbol: string): number {
    const tvl = getTokenTVL(symbol);
    if (tvl >= TVL_PRICE_IMPACT_COOLDOWNS.TIER_1.minTvl) {
      return TVL_PRICE_IMPACT_COOLDOWNS.TIER_1.cooldownMs; // 10 min for $1M+
    } else if (tvl >= TVL_PRICE_IMPACT_COOLDOWNS.TIER_2.minTvl) {
      return TVL_PRICE_IMPACT_COOLDOWNS.TIER_2.cooldownMs; // 15 min for $500K-1M
    }
    return TVL_PRICE_IMPACT_COOLDOWNS.DEFAULT.cooldownMs; // 30 min default
  }

  /**
   * Check if a token is in price impact cooldown
   * Uses TVL-based cooldown duration - high liquidity tokens recover faster
   */
  private isInPriceImpactCooldown(symbol: string): boolean {
    const lastBad = this.priceImpactCooldowns.get(symbol);
    if (!lastBad) return false;
    const elapsed = Date.now() - lastBad;
    const cooldownMs = this.getPriceImpactCooldownMs(symbol);
    if (elapsed >= cooldownMs) {
      this.priceImpactCooldowns.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * Set exit cooldown for a specific TOKEN (not stock ticker) after closing a position
   * This prevents immediate re-entry which can suffer from self-interference
   * (our exit shifted pool liquidity, making immediate re-entry more expensive)
   *
   * IMPORTANT: Uses token symbol (e.g., 'NVDAx') not stock ticker ('NVDA')
   * This allows different tokens for the same stock to trade independently
   */
  setExitCooldown(tokenSymbol: string): void {
    this.exitCooldowns.set(tokenSymbol, Date.now());
    signalLogger.info({ tokenSymbol, cooldownMs: EXIT_COOLDOWN_MS }, 'Exit cooldown set for token');
  }

  /**
   * Check if a token is in exit cooldown
   */
  private isInExitCooldown(tokenSymbol: string): boolean {
    const exitTime = this.exitCooldowns.get(tokenSymbol);
    if (!exitTime) return false;
    const elapsed = Date.now() - exitTime;
    if (elapsed >= EXIT_COOLDOWN_MS) {
      this.exitCooldowns.delete(tokenSymbol);
      return false;
    }
    return true;
  }

  /**
   * Get remaining exit cooldown time in ms
   */
  private getExitCooldownRemaining(tokenSymbol: string): number {
    const exitTime = this.exitCooldowns.get(tokenSymbol);
    if (!exitTime) return 0;
    const elapsed = Date.now() - exitTime;
    return Math.max(0, EXIT_COOLDOWN_MS - elapsed);
  }

  /**
   * Set entry cooldown after opening a position.
   * This prevents duplicate positions when loop iterations happen faster than
   * the position can be saved and reflected in existingPositions.
   */
  setEntryCooldown(tokenSymbol: string): void {
    this.entryCooldowns.set(tokenSymbol, Date.now());
    signalLogger.info({ tokenSymbol, cooldownMs: ENTRY_COOLDOWN_MS }, 'Entry cooldown set for token');
  }

  /**
   * Check if a token is in entry cooldown
   */
  private isInEntryCooldown(tokenSymbol: string): boolean {
    const entryTime = this.entryCooldowns.get(tokenSymbol);
    if (!entryTime) return false;
    const elapsed = Date.now() - entryTime;
    if (elapsed >= ENTRY_COOLDOWN_MS) {
      this.entryCooldowns.delete(tokenSymbol);
      return false;
    }
    return true;
  }

  /**
   * Get remaining entry cooldown time in ms
   */
  private getEntryCooldownRemaining(tokenSymbol: string): number {
    const entryTime = this.entryCooldowns.get(tokenSymbol);
    if (!entryTime) return 0;
    const elapsed = Date.now() - entryTime;
    return Math.max(0, ENTRY_COOLDOWN_MS - elapsed);
  }

  /**
   * Calculate spread/discount for a token vs its stock price
   * @param pair The token pair to calculate spread for
   * @param forExit If true, uses the longer exitPriceStalenessMs threshold
   */
  async calculateSpread(pair: TokenPair, forExit: boolean = false): Promise<PairSpread | null> {
    const config = getConfigSync();
    const onchainFeed = getOnchainFeed();
    const stockFeed = getStockFeed();

    // Skip tokens in bad pricing cooldown (30 min after unreasonable deviation)
    if (this.isInBadPricingCooldown(pair.tokenA.symbol)) {
      return null;
    }

    try {
      // Get token price and stock price in parallel
      // Use getPriceForToken to route to appropriate price source (stock/swissquote/etc)
      const [tokenPrice, stockPrice] = await Promise.all([
        onchainFeed.getPrice(pair.tokenA.mint, pair.tokenA.symbol),
        stockFeed.getPriceForToken(pair.tokenA),
      ]);

      if (!tokenPrice) {
        signalLogger.debug({ ticker: pair.stockTicker, symbol: pair.tokenA.symbol, mint: pair.tokenA.mint.slice(0, 8) }, 'Missing token price');
        return null;
      }

      if (!isFinite(tokenPrice.tradingPrice) || tokenPrice.tradingPrice <= 0) {
        signalLogger.warn({
          ticker: pair.stockTicker,
          tradingPrice: tokenPrice.tradingPrice,
        }, 'Invalid trading price value');
        return null;
      }

      // Check staleness - use longer threshold for exit decisions
      const stalenessThreshold = forExit ? config.exitPriceStalenessMs : config.priceStalenessMs;
      const now = Date.now();
      const tokenIsStale = now - tokenPrice.timestamp > stalenessThreshold;
      const stockIsStale = stockPrice && (now - stockPrice.timestamp > stalenessThreshold);

      if (tokenIsStale || stockIsStale) {
        const staleSource = tokenIsStale && stockIsStale ? 'both' : tokenIsStale ? 'token' : 'stock';
        signalLogger.warn({
          ticker: pair.stockTicker,
          staleSource,
          tokenAgeMs: now - tokenPrice.timestamp,
          stockAgeMs: stockPrice ? now - stockPrice.timestamp : null,
          thresholdMs: stalenessThreshold,
          forExit,
        }, `Rejecting stale price data (${staleSource})`);
        return null;
      }

      if (!stockPrice) {
        signalLogger.warn({ ticker: pair.stockTicker }, 'No stock price available');
        return null;
      }

      if (stockPrice.price <= 0) {
        signalLogger.warn({
          ticker: pair.stockTicker,
          stockPrice: stockPrice.price,
        }, 'Stock price is zero or negative');
        return null;
      }

      // Calculate discount vs stock
      // Positive = token is cheaper than stock (good to buy)
      // Negative = token is more expensive than stock (premium)
      const discount = ((stockPrice.price - tokenPrice.tradingPrice) / stockPrice.price) * 100;

      // SANITY CHECK: Skip tokens with unreasonable price deviations
      // This catches illiquid tokens with bad quote-based pricing
      // Put them in 30-min cooldown to avoid checking every loop
      if (Math.abs(discount) > MAX_REASONABLE_DEVIATION_PCT) {
        this.recordBadPricing(pair.tokenA.symbol);
        signalLogger.debug({
          ticker: pair.stockTicker,
          token: pair.tokenA.symbol,
          discount: discount.toFixed(2),
          cooldownMin: BAD_PRICING_COOLDOWN_MS / 60000,
        }, `Skipping ${pair.tokenA.symbol} - unreasonable deviation ${discount.toFixed(1)}% (cooldown 30m)`);
        return null;
      }

      // Record for smoothing
      this.recordDiscount(pair.stockTicker, pair.tokenA.symbol, discount);

      // Log when discount exceeds entry threshold (use dynamic threshold)
      const entryThreshold = getEntryThreshold(pair.tokenA.symbol);
      if (discount >= entryThreshold) {
        const tvl = getTokenTVL(pair.tokenA.symbol);
        signalLogger.info({
          ticker: pair.stockTicker,
          discount: discount.toFixed(2),
          token: pair.tokenA.symbol,
          entryThreshold: entryThreshold.toFixed(2),
          tvl: tvl.toFixed(0),
        }, 'Entry opportunity detected');
      }

      // Return in PairSpread format for orchestrator compatibility
      // tokenA === tokenB for mean reversion
      return {
        stockTicker: pair.stockTicker,
        tokenA: {
          symbol: pair.tokenA.symbol,
          mint: pair.tokenA.mint,
          price: tokenPrice.tradingPrice,
          liquidity: tokenPrice.poolLiquidity,
          discountVsStock: discount,
        },
        tokenB: {
          symbol: pair.tokenB.symbol,
          mint: pair.tokenB.mint,
          price: tokenPrice.tradingPrice,
          liquidity: tokenPrice.poolLiquidity,
          discountVsStock: discount,
        },
        spreadPct: 0,  // No spread between A and B since they're the same
        spreadAbsolute: 0,
        cheaperToken: 'A',
        stockPrice: stockPrice.price,
        moreDiscounted: 'A',
        timestamp: Date.now(),
      };
    } catch (error) {
      signalLogger.error({ ticker: pair.stockTicker, error }, 'Error calculating spread');
      return null;
    }
  }

  /**
   * Evaluate a token for mean reversion opportunity
   * @param pair The token pair to evaluate
   * @param existingPositions Current open positions
   * @param precomputedSpread Optional pre-computed spread from batch calculation (prevents price mismatch)
   */
  async evaluate(pair: TokenPair, existingPositions: MeanReversionPosition[], precomputedSpread?: PairSpread | null): Promise<MeanReversionSignal> {
    const config = getConfigSync();
    const reasons: string[] = [];
    let shouldTrade = true;
    const token = pair.tokenA;  // For mean reversion, tokenA === tokenB

    // Basic liquidity check - ensure token has been evaluated and isn't completely disabled
    // The more sophisticated spread-aware check happens later after we have price data
    if (!isTokenEnabledByLiquidity(token.symbol)) {
      const tvl = getTokenTVL(token.symbol);
      if (tvl < 25_000) {
        // Completely disabled - TVL too low even for high spreads
        return {
          shouldTrade: false,
          pair,
          spread: this.createEmptySpread(pair),
          buyToken: token,
          sellToken: token,
          suggestedSizeUsd: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          reasons: [`❌ Disabled due to very low liquidity (TVL: $${tvl.toFixed(0)})`],
        };
      }
      // Otherwise, continue to spread-aware check later
    }

    // Check 0: Is this token in failure cooldown?
    if (this.isInCooldown(token.symbol)) {
      const remainingSec = Math.ceil(this.getCooldownRemaining(token.symbol) / 1000);
      return {
        shouldTrade: false,
        pair,
        spread: this.createEmptySpread(pair),
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ In cooldown after failed trade (${remainingSec}s remaining)`],
      };
    }

    // Check 0.5: Time-of-day filter - enhanced or legacy mode
    if (TIME_OF_DAY_OPTIMIZATION.ENABLED) {
      // Enhanced per-token time filtering with global fallback
      const timeCheck = await isOptimalTradingTime(token.symbol);
      if (!timeCheck.allowed) {
        return {
          shouldTrade: false,
          pair,
          spread: this.createEmptySpread(pair),
          buyToken: token,
          sellToken: token,
          suggestedSizeUsd: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          reasons: [`❌ ${timeCheck.reason || 'Time filter blocked'}`],
        };
      }
    } else {
      // Legacy global time filtering
      const currentHourUTC = new Date().getUTCHours();
      if (AVOID_TRADING_HOURS_UTC.includes(currentHourUTC)) {
        return {
          shouldTrade: false,
          pair,
          spread: this.createEmptySpread(pair),
          buyToken: token,
          sellToken: token,
          suggestedSizeUsd: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          reasons: [`❌ Avoiding low win-rate hours (${currentHourUTC}:00 UTC market open chaos)`],
        };
      }
    }

    // Check 0b: Is this token in price impact cooldown? (excessive slippage detected previously)
    if (this.isInPriceImpactCooldown(token.symbol)) {
      return {
        shouldTrade: false,
        pair,
        spread: this.createEmptySpread(pair),
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ In cooldown due to excessive price impact`],
      };
    }

    // Check 0c: Is this TOKEN in exit cooldown? (prevents self-interference after exiting)
    // Uses token symbol (not stock ticker) so different tokens for same stock can trade independently
    if (this.isInExitCooldown(token.symbol)) {
      const remainingSec = Math.ceil(this.getExitCooldownRemaining(token.symbol) / 1000);
      return {
        shouldTrade: false,
        pair,
        spread: this.createEmptySpread(pair),
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ Exit cooldown (${remainingSec}s remaining) - avoiding self-interference`],
      };
    }

    // Check 0d: Is this TOKEN in entry cooldown? (prevents duplicate positions from race conditions)
    // This catches cases where the loop runs faster than positions can be saved to DB
    if (this.isInEntryCooldown(token.symbol)) {
      const remainingSec = Math.ceil(this.getEntryCooldownRemaining(token.symbol) / 1000);
      return {
        shouldTrade: false,
        pair,
        spread: this.createEmptySpread(pair),
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ Entry cooldown (${remainingSec}s remaining) - position just opened`],
      };
    }

    // Use pre-computed spread if provided (from batch calculation), otherwise fetch fresh
    // This prevents price mismatch between batch logging and trade evaluation
    const spread = precomputedSpread !== undefined ? precomputedSpread : await this.calculateSpread(pair);
    if (!spread) {
      return {
        shouldTrade: false,
        pair,
        spread: this.createEmptySpread(pair),
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: ['Could not get prices'],
      };
    }

    // REQUIRE stock price
    if (!spread.stockPrice || spread.stockPrice <= 0) {
      return {
        shouldTrade: false,
        pair,
        spread,
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: ['❌ No stock price - cannot calculate discount'],
      };
    }

    const discount = spread.tokenA.discountVsStock ?? 0;

    // SPREAD-AWARE LIQUIDITY CHECK: Now that we have the actual discount, check if token should be enabled
    // Use tiered TVL requirements: high spreads get relaxed liquidity rules
    if (!isTokenEnabledForSpread(token.symbol, Math.abs(discount))) {
      const tvl = getTokenTVL(token.symbol);
      const requiredTvl = Math.abs(discount) >= 6.0 ? 25_000 : 
                         Math.abs(discount) >= 4.5 ? 50_000 : 75_000;
      return {
        shouldTrade: false,
        pair,
        spread,
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ Insufficient liquidity for ${Math.abs(discount).toFixed(1)}% spread (TVL: $${tvl.toFixed(0)}, need: $${requiredTvl.toFixed(0)})`],
      };
    }

    // SANITY CHECK: Reject absurd price deviations
    if (Math.abs(discount) > MAX_REASONABLE_DEVIATION_PCT) {
      signalLogger.error({
        ticker: pair.stockTicker,
        discountPct: discount.toFixed(2),
        stockPrice: spread.stockPrice,
        tokenPrice: spread.tokenA.price,
        threshold: MAX_REASONABLE_DEVIATION_PCT,
      }, 'BLOCKING TRADE: Token price deviates >50% from stock');
      return {
        shouldTrade: false,
        pair,
        spread,
        buyToken: token,
        sellToken: token,
        suggestedSizeUsd: 0,
        expectedProfitUsd: 0,
        expectedProfitPct: 0,
        reasons: [`❌ BLOCKED: Price deviation too extreme (${Math.abs(discount).toFixed(1)}%)`],
      };
    }

    // Mean reversion thresholds - use dynamic threshold based on liquidity + volatility
    const hasRaydiumPool = !!(token.poolAddress && token.poolAddress.length > 0);
    const tvl = getTokenTVL(token.symbol);
    const dynamicEntryThreshold = getEntryThreshold(token.symbol);
    // Apply volatility adjustment: higher volatility = require larger discount
    const volatilityEntryMultiplier = getVolatilityEntryMultiplier(pair.stockTicker);
    const entryDiscountPct = dynamicEntryThreshold * volatilityEntryMultiplier;
    const exitDiscountPct = getExitThreshold(token.symbol);
    // Use ACTUAL discount for capture calculation, not just threshold
    // If discount is 1.67% and exit is 0.80%, capture is 0.87%, not (threshold - exit)
    const expectedCapture = discount - exitDiscountPct;
    const estimatedFees = getEstimatedFeesPct(tvl);  // TVL-based fee estimate
    const netProfit = expectedCapture - estimatedFees;

    reasons.push(`📊 ${token.symbol} discount: ${discount.toFixed(2)}% | TVL: $${(tvl/1000).toFixed(0)}K | Entry: ${entryDiscountPct}%`);

    // Track which route gave the better quote (set inside shouldTrade block)
    let entryPreferredRoute: 'raydium' | 'jupiter' | undefined;

    // Check 1: Is the token sufficiently discounted?
    if (discount < entryDiscountPct) {
      reasons.push(`❌ Discount ${discount.toFixed(2)}% < entry threshold ${entryDiscountPct}% (TVL-based)`);
      shouldTrade = false;
    } else {
      reasons.push(`✓ Discount ${discount.toFixed(2)}% >= entry ${entryDiscountPct}% (capture ~${netProfit.toFixed(2)}%)`);
    }

    // Check 1b: Discount stability
    if (shouldTrade && !this.isDiscountStable(pair.stockTicker, token.symbol, entryDiscountPct)) {
      reasons.push(`❌ Discount not stable - need ${MIN_STABLE_READINGS} consecutive readings`);
      shouldTrade = false;
    } else if (shouldTrade) {
      reasons.push(`✓ Discount stable for ${MIN_STABLE_READINGS}+ readings`);
    }

    // Check 2: No existing position for this specific token (allows multiple tokens per stock)
    const hasExistingPosition = existingPositions.some(
      p => p.buyMint === token.mint && p.status === 'open'
    );
    if (hasExistingPosition) {
      reasons.push('❌ Already have open position for this token');
      shouldTrade = false;
    } else {
      reasons.push('✓ No existing position for this token');
    }

    // Check 3: Liquidity (prefer Raydium pool; otherwise enforce minimum liquidity)
    // Use liquidity checker's TVL (from GeckoTerminal) instead of price feed liquidity (DexScreener)
    // This ensures we see Meteora pools that DexScreener doesn't return
    const checkerTvl = getTokenTVL(token.symbol);
    if (hasRaydiumPool) {
      reasons.push(`✓ Raydium pool (liquidity OK)`);
    } else if (checkerTvl < MIN_LIQUIDITY_USD) {
      reasons.push(`❌ Insufficient liquidity: $${checkerTvl.toFixed(0)}`);
      shouldTrade = false;
    } else {
      reasons.push(`✓ Liquidity: $${(checkerTvl / 1000).toFixed(0)}K`);
    }

    // Calculate position size based on TVL tier, spread, and volatility
    // Higher volatility stocks get smaller positions (risk parity)
    // Higher spreads get larger positions (better risk-adjusted return)
    const tvlBasedSize = getAdaptivePositionSize(token.symbol, Math.abs(discount));
    const volatilityMultiplier = getVolatilityPositionMultiplier(pair.stockTicker);
    const volatilityAdjustedSize = tvlBasedSize * volatilityMultiplier;
    const liquidityBasedSize = checkerTvl * config.liquidityFraction;
    const suggestedSizeUsd = Math.min(volatilityAdjustedSize, liquidityBasedSize);

    // Expected profit
    const expectedProfitPct = netProfit;
    const expectedProfitUsd = suggestedSizeUsd * (expectedProfitPct / 100);

    // Check 4: Is expected profit worth it?
    if (expectedProfitUsd < MIN_EXPECTED_PROFIT_USD) {
      reasons.push(`❌ Expected profit $${expectedProfitUsd.toFixed(2)} too small`);
      shouldTrade = false;
    } else {
      reasons.push(`✓ Expected profit: $${expectedProfitUsd.toFixed(2)}`);
    }

    // Check 5: Verify actual entry price via quote (prevents price impact disasters)
    // Only check if we're still planning to trade
    if (shouldTrade) {
      const routing = getSwapRouting(token.symbol, token.poolAddress);
      const useRaydium = routing.useRaydiumDirect && routing.poolAddress;

      // Log routing decision for debugging
      signalLogger.debug({
        ticker: pair.stockTicker,
        token: token.symbol,
        useRaydium,
        routingDexId: routing.dexId,
        routingSource: routing.source,
        routingPoolAddress: routing.poolAddress?.slice(0, 12),
        routingLiquidityUsd: routing.liquidityUsd,
      }, 'Entry quote routing decision');

      let quotedTokenAmount: number | null = null;
      let quoteSource = '';
      let quotePriceImpact: number | null = null;

      try {
        // Get quotes from BOTH Raydium and Jupiter, use the better one
        let raydiumQuoteAmount: number | null = null;
        let raydiumPriceImpact: number | null = null;
        let jupiterQuoteAmount: number | null = null;
        let jupiterPriceImpact: number | null = null;

        // Get Raydium quote if available (with timeout to prevent hangs)
        if (useRaydium) {
          const raydiumClient = getRaydiumClient();
          if (raydiumClient.isReady()) {
            const inputMint = USDC_MINT;
            const inputDecimals = 6; // USDC decimals

            const buyQuote = await withTimeout(
              raydiumClient.getQuote(
                routing.poolAddress!,
                inputMint,
                suggestedSizeUsd,
                inputDecimals
              ),
              QUOTE_TIMEOUT_MS,
              null
            );

            if (buyQuote && buyQuote.amountOut > 0) {
              raydiumQuoteAmount = buyQuote.amountOut;
              raydiumPriceImpact = buyQuote.priceImpact;
            }
          }
        }

        // Always get Jupiter quote to compare (with timeout)
        const jupiterClient = getJupiterClient();
        const jupBuyQuote = await withTimeout(
          jupiterClient.getBuyQuote(token.mint, suggestedSizeUsd),
          QUOTE_TIMEOUT_MS,
          null
        );

        if (jupBuyQuote && jupBuyQuote.outputAmount > 0) {
          const tokenDecimals = token.decimals || 9;
          jupiterQuoteAmount = jupBuyQuote.outputAmount / Math.pow(10, tokenDecimals);
          jupiterPriceImpact = jupBuyQuote.priceImpactPct;
        }

        // Choose the better quote (higher output = better price, prefer Jupiter on tie)
        // Always log entry quote comparison at info level for debugging
        // BUT first validate quotes against API price - discard anomalous ones
        const apiPrice = spread.tokenA.price;
        const QUOTE_ANOMALY_THRESHOLD = -10; // Quote > 10% below API = anomalous

        // Check if each quote is sane (effective price not wildly below API price)
        let raydiumValid = false;
        let jupiterValid = false;

        if (raydiumQuoteAmount && raydiumQuoteAmount > 0) {
          const raydiumEffectivePrice = suggestedSizeUsd / raydiumQuoteAmount;
          const raydiumPriceDeviation = ((raydiumEffectivePrice - apiPrice) / apiPrice) * 100;
          raydiumValid = raydiumPriceDeviation >= QUOTE_ANOMALY_THRESHOLD;
          if (!raydiumValid) {
            signalLogger.warn({
              ticker: pair.stockTicker,
              token: token.symbol,
              raydiumPrice: raydiumEffectivePrice.toFixed(2),
              apiPrice: apiPrice.toFixed(2),
              deviationPct: raydiumPriceDeviation.toFixed(1),
            }, 'Raydium quote anomalous (price too low vs API) - discarding');
          }
        }

        if (jupiterQuoteAmount && jupiterQuoteAmount > 0) {
          const jupiterEffectivePrice = suggestedSizeUsd / jupiterQuoteAmount;
          const jupiterPriceDeviation = ((jupiterEffectivePrice - apiPrice) / apiPrice) * 100;
          jupiterValid = jupiterPriceDeviation >= QUOTE_ANOMALY_THRESHOLD;
          if (!jupiterValid) {
            signalLogger.warn({
              ticker: pair.stockTicker,
              token: token.symbol,
              jupiterPrice: jupiterEffectivePrice.toFixed(2),
              apiPrice: apiPrice.toFixed(2),
              deviationPct: jupiterPriceDeviation.toFixed(1),
            }, 'Jupiter quote anomalous (price too low vs API) - discarding');
          }
        }

        // Use only valid quotes for comparison
        const validRaydium = raydiumValid ? raydiumQuoteAmount : null;
        const validJupiter = jupiterValid ? jupiterQuoteAmount : null;

        if (validRaydium && validJupiter) {
          // Both valid - pick the better one (prefer Jupiter on tie for aggregator benefits)
          const diffPct = ((validJupiter - validRaydium) / validRaydium) * 100;
          if (validJupiter >= validRaydium) {
            quotedTokenAmount = validJupiter;
            quotePriceImpact = jupiterPriceImpact;
            quoteSource = 'jupiter';
            entryPreferredRoute = 'jupiter';
            signalLogger.info({
              ticker: pair.stockTicker,
              token: token.symbol,
              winner: 'jupiter',
              jupiterTokens: validJupiter.toFixed(6),
              raydiumTokens: validRaydium.toFixed(6),
              diffPct: diffPct.toFixed(4),
              inputUsd: suggestedSizeUsd.toFixed(2),
            }, 'ENTRY QUOTE: Jupiter wins (better or equal)');
          } else {
            quotedTokenAmount = validRaydium;
            quotePriceImpact = raydiumPriceImpact;
            quoteSource = 'raydium';
            entryPreferredRoute = 'raydium';
            signalLogger.info({
              ticker: pair.stockTicker,
              token: token.symbol,
              winner: 'raydium',
              raydiumTokens: validRaydium.toFixed(6),
              jupiterTokens: validJupiter.toFixed(6),
              diffPct: diffPct.toFixed(4),
              inputUsd: suggestedSizeUsd.toFixed(2),
            }, 'ENTRY QUOTE: Raydium wins (better price)');
          }
        } else if (validJupiter) {
          // Only Jupiter valid (Raydium missing or anomalous)
          quotedTokenAmount = validJupiter;
          quotePriceImpact = jupiterPriceImpact;
          quoteSource = 'jupiter';
          entryPreferredRoute = 'jupiter';
          const reason = raydiumQuoteAmount ? 'Raydium anomalous' : 'Raydium unavailable';
          signalLogger.info({
            ticker: pair.stockTicker,
            token: token.symbol,
            winner: 'jupiter',
            jupiterTokens: validJupiter.toFixed(6),
            raydiumTokens: raydiumQuoteAmount?.toFixed(6) ?? 'N/A',
            inputUsd: suggestedSizeUsd.toFixed(2),
            reason,
          }, `ENTRY QUOTE: Jupiter only (${reason})`);
        } else if (validRaydium) {
          // Only Raydium valid (Jupiter missing or anomalous)
          quotedTokenAmount = validRaydium;
          quotePriceImpact = raydiumPriceImpact;
          quoteSource = 'raydium';
          entryPreferredRoute = 'raydium';
          const reason = jupiterQuoteAmount ? 'Jupiter anomalous' : 'Jupiter unavailable';
          signalLogger.info({
            ticker: pair.stockTicker,
            token: token.symbol,
            winner: 'raydium',
            raydiumTokens: validRaydium.toFixed(6),
            jupiterTokens: jupiterQuoteAmount?.toFixed(6) ?? 'N/A',
            inputUsd: suggestedSizeUsd.toFixed(2),
            reason,
          }, `ENTRY QUOTE: Raydium only (${reason})`);
        }

        if (quotedTokenAmount && quotedTokenAmount > 0) {
          // Calculate effective buy price from quote
          const effectiveBuyPrice = suggestedSizeUsd / quotedTokenAmount;
          const priceImpactPct = ((effectiveBuyPrice - apiPrice) / apiPrice) * 100;

          // Calculate projected profit after actual price impact
          // projectedProfit = discount - priceImpact - estimatedExitFees
          // We use the actual quote price impact instead of the static threshold
          const projectedProfitPct = discount - priceImpactPct - estimatedFees;
          const projectedProfitUsd = suggestedSizeUsd * (projectedProfitPct / 100);

          signalLogger.debug({
            ticker: pair.stockTicker,
            apiPrice: apiPrice.toFixed(4),
            quotedPrice: effectiveBuyPrice.toFixed(4),
            priceImpactPct: priceImpactPct.toFixed(2),
            quotePriceImpact: quotePriceImpact?.toFixed(2) ?? 'N/A',
            quoteSource,
            discount: discount.toFixed(2),
            estimatedFees: estimatedFees.toFixed(2),
            projectedProfitPct: projectedProfitPct.toFixed(2),
            projectedProfitUsd: projectedProfitUsd.toFixed(4),
          }, 'Entry profitability check');

          // Block if trade would be unprofitable after price impact
          // Also block extremely negative quotes (> -10%) as likely data errors
          if (priceImpactPct < -10) {
            // Negative impact means quote price is LOWER than API - likely stale API data
            reasons.push(`❌ Quote price anomaly: ${priceImpactPct.toFixed(1)}% (quote lower than API - stale data?)`);
            shouldTrade = false;
            this.recordPriceImpactCooldown(token.symbol);
            const cooldownMin = this.getPriceImpactCooldownMs(token.symbol) / 60000;
            signalLogger.warn({
              ticker: pair.stockTicker,
              token: token.symbol,
              priceImpactPct: priceImpactPct.toFixed(2),
              cooldownMin,
            }, `Entry blocked: quote price anomaly (cooldown ${cooldownMin}m)`);
          } else if (priceImpactPct > MAX_ENTRY_PRICE_IMPACT_PCT) {
            // HARD CAP: Block if price impact exceeds max, regardless of projected profit
            // This protects against low-liquidity pools where execution slippage can be much worse than quoted
            reasons.push(`❌ Price impact too high: ${priceImpactPct.toFixed(1)}% exceeds max ${MAX_ENTRY_PRICE_IMPACT_PCT}%`);
            shouldTrade = false;
            this.recordPriceImpactCooldown(token.symbol);
            const cooldownMin = this.getPriceImpactCooldownMs(token.symbol) / 60000;
            signalLogger.warn({
              ticker: pair.stockTicker,
              token: token.symbol,
              priceImpactPct: priceImpactPct.toFixed(2),
              maxAllowed: MAX_ENTRY_PRICE_IMPACT_PCT,
              cooldownMin,
            }, `Entry blocked: price impact exceeds hard cap (cooldown ${cooldownMin}m)`);
          } else if (projectedProfitPct <= 0) {
            // Trade would be unprofitable
            reasons.push(`❌ Unprofitable: discount ${discount.toFixed(2)}% - impact ${priceImpactPct.toFixed(1)}% - fees ${estimatedFees.toFixed(2)}% = ${projectedProfitPct.toFixed(2)}%`);
            shouldTrade = false;

            // Only cooldown if price impact is really high (>5%), otherwise just skip this cycle
            if (priceImpactPct > MAX_ENTRY_PRICE_IMPACT_PCT) {
              this.recordPriceImpactCooldown(token.symbol);
              const cooldownMin = this.getPriceImpactCooldownMs(token.symbol) / 60000;
              signalLogger.warn({
                ticker: pair.stockTicker,
                token: token.symbol,
                discount: discount.toFixed(2),
                priceImpactPct: priceImpactPct.toFixed(2),
                projectedProfitPct: projectedProfitPct.toFixed(2),
                cooldownMin,
              }, `Entry blocked: unprofitable with high impact (cooldown ${cooldownMin}m)`);
            } else {
              signalLogger.debug({
                ticker: pair.stockTicker,
                token: token.symbol,
                discount: discount.toFixed(2),
                priceImpactPct: priceImpactPct.toFixed(2),
                projectedProfitPct: projectedProfitPct.toFixed(2),
              }, 'Entry skipped: marginally unprofitable (no cooldown)');
            }
          } else {
            // Check TVL-scaled minimum profit threshold
            const minProfitPct = getMinExpectedProfitPct(tvl);
            if (projectedProfitPct < minProfitPct || projectedProfitUsd < MIN_EXPECTED_PROFIT_USD) {
              // Trade is technically profitable but edge is too thin
              reasons.push(`❌ Edge too thin: ${projectedProfitPct.toFixed(2)}% ($${projectedProfitUsd.toFixed(2)}) - need ${minProfitPct.toFixed(2)}% or $${MIN_EXPECTED_PROFIT_USD}`);
              shouldTrade = false;
              signalLogger.info({
                ticker: pair.stockTicker,
                token: token.symbol,
                discount: discount.toFixed(2),
                priceImpactPct: priceImpactPct.toFixed(2),
                projectedProfitPct: projectedProfitPct.toFixed(2),
                projectedProfitUsd: projectedProfitUsd.toFixed(4),
                minProfitPct,
                minProfitUsd: MIN_EXPECTED_PROFIT_USD,
                tvl,
              }, 'Entry skipped: projected profit below minimum threshold');
            } else {
              // Trade is projected to be profitable with sufficient edge!
              reasons.push(`✓ Projected profit: ${projectedProfitPct.toFixed(2)}% ($${projectedProfitUsd.toFixed(4)}) after ${priceImpactPct.toFixed(1)}% impact`);
            }
          }
        } else {
          // Quote failed or returned 0 - block trade and cooldown
          reasons.push(`❌ Entry quote failed (${quoteSource || 'unknown'} returned no output)`);
          shouldTrade = false;

          // Put token in cooldown to avoid repeated checks and log spam
          this.recordPriceImpactCooldown(token.symbol);
          const cooldownMin = this.getPriceImpactCooldownMs(token.symbol) / 60000;

          signalLogger.warn({
            ticker: pair.stockTicker,
            token: token.symbol,
            quoteSource: quoteSource || 'unknown',
            cooldownMin,
          }, `Entry blocked: quote returned no output (cooldown ${cooldownMin}m)`);
        }
      } catch (error) {
        signalLogger.warn({
          ticker: pair.stockTicker,
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to get entry quote, proceeding with caution');
        // Don't block trade on quote failure, but log warning
      }
    }

    const signal: MeanReversionSignal = {
      shouldTrade,
      pair,
      spread,
      buyToken: token,
      sellToken: token,  // Same token for mean reversion
      suggestedSizeUsd,
      expectedProfitUsd,
      expectedProfitPct,
      reasons,
      preferredRoute: entryPreferredRoute,
      tvlUsd: tvl,
    };

    if (shouldTrade) {
      signalLogger.info({
        ticker: pair.stockTicker,
        token: token.symbol,
        discountPct: discount.toFixed(2),
        sizeUsd: suggestedSizeUsd.toFixed(2),
        expectedProfitUsd: expectedProfitUsd.toFixed(2),
      }, '✓ TRADEABLE signal found');
    }

    return signal;
  }

  /**
   * Evaluate all tokens (parallel for efficiency)
   * Uses cached batch spreads if available and fresh
   */
  async evaluateAll(existingPositions: MeanReversionPosition[]): Promise<MeanReversionSignal[]> {
    // Check if we have fresh cached batch spreads
    const cacheAge = Date.now() - batchSpreadsCacheTime;
    const useCachedSpreads = cacheAge < batchSpreadsCacheTtlMs && cachedBatchSpreads.size > 0;

    if (useCachedSpreads) {
      signalLogger.debug({
        cacheAgeMs: cacheAge,
        cachedCount: cachedBatchSpreads.size,
        cacheTtlMs: batchSpreadsCacheTtlMs,
      }, 'Using cached batch spreads for evaluation');
    }

    const signals = await Promise.all(
      this.targets.map(pair => {
        // Use cached spread if available, otherwise evaluate will fetch fresh
        // Key is tokenA.symbol to match how spreads are stored in calculateAllSpreadsBatch()
        const cachedSpread = useCachedSpreads ? cachedBatchSpreads.get(pair.tokenA.symbol) : undefined;
        return this.evaluate(pair, existingPositions, cachedSpread);
      })
    );
    return signals;
  }

  /**
   * Get best opportunity
   * Uses cached batch spreads to ensure price consistency with dashboard display
   */
  async getBestOpportunity(existingPositions: MeanReversionPosition[]): Promise<MeanReversionSignal | null> {
    const signals = await this.evaluateAll(existingPositions);
    const validSignals = signals.filter(s => s.shouldTrade);

    // Log evaluation summary for debugging and cache rejection reasons for UI
    const aboveThreshold = signals.filter(s => s.reasons?.some(r => r.includes('✓ Discount')));

    // Clear rejection reasons for tokens that are now valid (prevents stale "Position open" etc.)
    const validAboveThreshold = aboveThreshold.filter(s => s.shouldTrade);
    for (const s of validAboveThreshold) {
      clearRejectionReason(s.buyToken.symbol);
    }

    // Log why above-threshold signals aren't valid and cache for watchlist UI
    const rejectedAboveThreshold = aboveThreshold.filter(s => !s.shouldTrade);
    if (rejectedAboveThreshold.length > 0) {
      for (const s of rejectedAboveThreshold) {
        const rejectionReasons = s.reasons?.filter(r => r.includes('❌')) || [];
        // Cache a short rejection reason for UI (extract key info)
        if (rejectionReasons.length > 0) {
          const firstReason = rejectionReasons[0];
          // Shorten common reasons for compact display
          let shortReason = firstReason
            .replace('❌ ', '')
            .replace(/Expected profit \$[\d.-]+ too small/, 'Profit too small')
            .replace('Already have open position for this token', 'Position open')
            .replace('In cooldown after failed trade', 'Cooldown')
            .replace('In cooldown due to excessive price impact', 'Impact cooldown')
            .replace(/Exit cooldown \(\d+s remaining\) - avoiding self-interference/, 'Exit cooldown')
            .replace('Insufficient liquidity', 'Low liquidity')
            .replace(/Unprofitable:.*/, 'Unprofitable');
          // Truncate if still too long
          if (shortReason.length > 25) shortReason = shortReason.slice(0, 22) + '...';
          setRejectionReason(s.buyToken.symbol, shortReason);
        }
        // Only log first 3
        if (rejectedAboveThreshold.indexOf(s) < 3) {
          signalLogger.info({
            ticker: s.pair.stockTicker,
            token: s.buyToken.symbol,
            rejections: rejectionReasons.join('; '),
          }, 'Above-threshold token rejected');
        }
      }
    }
    signalLogger.debug({
      totalEvaluated: signals.length,
      aboveThreshold: aboveThreshold.length,
      validSignals: validSignals.length,
      validTickers: validSignals.map(s => s.pair.stockTicker).join(', ') || 'none',
    }, 'getBestOpportunity evaluation summary');

    if (validSignals.length === 0) return null;

    // Sort by expected profit (highest first)
    validSignals.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);
    return validSignals[0];
  }

  /**
   * Check if an open position should be closed
   */
  async checkExit(position: MeanReversionPosition): Promise<{
    shouldExit: boolean;
    reason: string;
    currentSpreadPct: number;
    spread: PairSpread | null;
    preferredRoute?: 'raydium' | 'jupiter';
    expectedExitUsd?: number;  // Expected USDC output from signal's quote
  }> {
    const config = getConfigSync();

    // Find the pair/token - must match BOTH stockTicker AND the actual token symbol
    // This is important when multiple tokens exist for the same stock (e.g., CRCLx and CRCLr)
    let pair = this.targets.find(p =>
      p.stockTicker === position.stockTicker &&
      p.tokenA.symbol === position.buySymbol
    );
    if (!pair) {
      // Fallback: try just by stockTicker (legacy behavior for positions with old token symbols)
      pair = this.targets.find(p => p.stockTicker === position.stockTicker);
      if (!pair) {
        return { shouldExit: true, reason: 'Pair not found', currentSpreadPct: 0, spread: null };
      }
      signalLogger.warn({
        ticker: position.stockTicker,
        positionToken: position.buySymbol,
        foundToken: pair.tokenA.symbol,
      }, 'Exit check using fallback pair - token mismatch (position may use different token than current target)');
    }

    // Try to get spread with retries to handle transient API failures
    // This prevents premature exits due to temporary price unavailability
    const MAX_SPREAD_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    let spread: PairSpread | null = null;
    let lastError: string = 'Price unavailable';

    for (let attempt = 1; attempt <= MAX_SPREAD_RETRIES; attempt++) {
      // On retry attempts, force fresh stock price fetch to bypass stale cache
      if (attempt > 1) {
        const stockFeed = getStockFeed();
        signalLogger.info({
          ticker: position.stockTicker,
          attempt,
        }, 'Forcing fresh stock price fetch for retry');
        await stockFeed.getPriceForToken(pair.tokenA, true); // forceFetch=true
      }

      spread = await this.calculateSpread(pair, true); // forExit=true uses longer staleness threshold

      if (spread) {
        if (attempt > 1) {
          signalLogger.info({
            ticker: position.stockTicker,
            attempt,
          }, 'Retry succeeded - got valid spread');
        }
        break; // Success, exit retry loop
      }

      // On failure, determine reason and potentially retry
      const onchainFeed = getOnchainFeed();
      const stockFeed = getStockFeed();
      const tokenPrice = await onchainFeed.getPrice(pair.tokenA.mint, pair.tokenA.symbol);
      const stockPrice = await stockFeed.getPriceForToken(pair.tokenA);

      if (!tokenPrice) {
        lastError = 'Token price unavailable';
      } else if (!stockPrice) {
        lastError = 'Stock API failed';
      } else if (tokenPrice.isStale || stockPrice.isStale) {
        lastError = 'Stale prices';
      }

      if (attempt < MAX_SPREAD_RETRIES) {
        signalLogger.warn({
          ticker: position.stockTicker,
          attempt,
          maxAttempts: MAX_SPREAD_RETRIES,
          reason: lastError,
        }, `Exit check failed, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    if (!spread) {
      // Before force-exiting, try to use cached/stale prices if available and recent enough
      // This prevents premature exits due to transient API failures or temporary staleness
      const onchainFeed = getOnchainFeed();
      const stockFeed = getStockFeed();
      const cachedToken = onchainFeed.getCachedPrice(pair.tokenA.mint, pair.tokenA.symbol);
      const cachedStock = stockFeed.getCachedPrice(pair.stockTicker);

      if (cachedToken && cachedStock &&
          cachedToken.ageMs < LENIENT_EXIT_MAX_STALE_MS &&
          cachedStock.ageMs < LENIENT_EXIT_MAX_STALE_MS) {
        // Both caches are recent enough - use them for exit decision
        const tokenPrice = cachedToken.price.tradingPrice;
        const stockPrice = cachedStock.price;
        const discount = ((stockPrice - tokenPrice) / stockPrice) * 100;

        signalLogger.warn({
          ticker: position.stockTicker,
          reason: lastError,
          tokenCacheAgeMs: cachedToken.ageMs,
          stockCacheAgeMs: cachedStock.ageMs,
          maxStaleMs: LENIENT_EXIT_MAX_STALE_MS,
          cachedDiscount: discount.toFixed(2),
        }, 'Using cached prices for exit check (within lenient threshold)');

        // Build a synthetic spread for exit evaluation
        spread = {
          stockTicker: pair.stockTicker,
          tokenA: {
            symbol: pair.tokenA.symbol,
            mint: pair.tokenA.mint,
            price: tokenPrice,
            discountVsStock: discount,
            liquidity: cachedToken.price.poolLiquidity || 0,
          },
          tokenB: {
            symbol: pair.tokenA.symbol,
            mint: pair.tokenA.mint,
            price: tokenPrice,
            discountVsStock: discount,
            liquidity: cachedToken.price.poolLiquidity || 0,
          },
          spreadPct: 0,
          spreadAbsolute: 0,
          stockPrice: stockPrice,
          moreDiscounted: 'A',
          cheaperToken: 'A',
          timestamp: Math.min(cachedToken.price.timestamp, cachedStock.timestamp),
        };
        // Continue to normal exit evaluation below with synthetic spread
      } else {
        // No cache or cache too stale - force exit for safety
        signalLogger.error({
          ticker: position.stockTicker,
          reason: lastError,
          attempts: MAX_SPREAD_RETRIES,
          tokenCacheAgeMs: cachedToken?.ageMs ?? null,
          stockCacheAgeMs: cachedStock?.ageMs ?? null,
          maxStaleMs: LENIENT_EXIT_MAX_STALE_MS,
        }, 'All retry attempts failed and no recent cached price - triggering safety exit');
        return { shouldExit: true, reason: lastError, currentSpreadPct: 0, spread: null };
      }
    }

    // Use the discount of the token we ACTUALLY bought, not always tokenA
    const boughtToken = spread.tokenA.symbol === position.buySymbol ? spread.tokenA : spread.tokenB;
    const currentDiscount = boughtToken.discountVsStock ?? 0;
    const currentSpreadPct = currentDiscount;  // For backwards compatibility
    const currentTokenPrice = boughtToken.price;

    // Calculate entry token price from position data
    // sizeUsd = USDC spent, buyAmount = tokens received
    const entryTokenPrice = position.sizeUsd / position.buyAmount;

    // Check for price-based stop-loss BEFORE sanity check
    // This ensures we can still exit if token price crashed, even if discount data looks weird
    const earlyTokenAppreciationPct = ((currentTokenPrice - entryTokenPrice) / entryTokenPrice) * 100;
    const holdTimeMs = Date.now() - position.entryTimestamp;

    if (earlyTokenAppreciationPct <= PRICE_STOP_LOSS_PCT && holdTimeMs >= STOP_LOSS_GRACE_PERIOD_MS) {
      signalLogger.warn({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entryTokenPrice: entryTokenPrice.toFixed(2),
        currentTokenPrice: currentTokenPrice.toFixed(2),
        tokenAppreciationPct: earlyTokenAppreciationPct.toFixed(2),
        priceStopLossThreshold: PRICE_STOP_LOSS_PCT,
        currentDiscount: currentDiscount.toFixed(2),
      }, 'Price stop-loss triggered (early check) - token dropped too much from entry');
      return {
        shouldExit: true,
        reason: 'price_stop_loss',
        currentSpreadPct,
        spread,
      };
    }

    // SANITY CHECK: Reject absurd discount data (but only for profit-taking, not stop-losses)
    if (Math.abs(currentDiscount) > MAX_REASONABLE_DISCOUNT) {
      signalLogger.warn({
        ticker: position.stockTicker,
        currentDiscount,
        entrySpreadPct: position.entrySpreadPct,
        threshold: MAX_REASONABLE_DISCOUNT,
        tokenAppreciationPct: earlyTokenAppreciationPct.toFixed(2),
      }, 'Exit check blocked: discount data appears invalid (stop-loss not triggered)');
      return { shouldExit: false, reason: '', currentSpreadPct, spread };
    }

    // Exit thresholds based on ACTUAL TOKEN PRICE APPRECIATION
    // Use TVL-based dynamic threshold to account for slippage on low-liquidity pools
    // Check if Raydium is actually the best route (not just if we have a pool address)
    const exitRouting = getSwapRouting(position.buySymbol, position.buyPoolAddress, position.buyDexId);
    const useRaydiumForExit = exitRouting.useRaydiumDirect && !!exitRouting.poolAddress;
    const baseExitThreshold = getExitThreshold(position.buySymbol);

    // Apply time-decaying exit threshold to free up capital faster
    // After DECAY_START, threshold linearly decays to MIN_EXIT by DECAY_END
    let exitAppreciationPct = baseExitThreshold;
    if (holdTimeMs > EXIT_THRESHOLD_DECAY_START_MS) {
      const decayProgress = Math.min(1, (holdTimeMs - EXIT_THRESHOLD_DECAY_START_MS) / (EXIT_THRESHOLD_DECAY_END_MS - EXIT_THRESHOLD_DECAY_START_MS));
      exitAppreciationPct = baseExitThreshold - (baseExitThreshold - MIN_EXIT_THRESHOLD_PCT) * decayProgress;
      signalLogger.debug({
        ticker: position.stockTicker,
        token: position.buySymbol,
        holdTimeHours: (holdTimeMs / (60 * 60 * 1000)).toFixed(1),
        baseThreshold: baseExitThreshold.toFixed(2),
        decayedThreshold: exitAppreciationPct.toFixed(2),
        decayProgress: (decayProgress * 100).toFixed(0),
      }, 'Exit threshold decayed due to hold time');
    }

    // Get actual quotes from BOTH Raydium and Jupiter to find best exit price
    // This ensures we only trigger exit when the ACTUAL swap will be profitable
    let effectiveExitPrice = currentTokenPrice;
    let priceSource: 'price_api' | 'raydium_quote' | 'jupiter_quote' = 'price_api';
    let exitPreferredRoute: 'raydium' | 'jupiter' | undefined;
    let bestQuoteUsd: number | undefined;  // Track the actual quote USDC amount for execution validation

    if (position.buyDecimals) {
      let raydiumUsdcOut: number | null = null;
      let jupiterUsdcOut: number | null = null;

      // Try Raydium quote if we have a direct pool (with timeout)
      if (useRaydiumForExit && exitRouting.poolAddress) {
        const raydiumClient = getRaydiumClient();
        if (raydiumClient.isReady()) {
          try {
            const quote = await withTimeout(
              raydiumClient.getQuote(
                exitRouting.poolAddress,
                position.buyMint,
                position.buyAmount,
                position.buyDecimals
              ),
              QUOTE_TIMEOUT_MS,
              null
            );
            if (quote && quote.amountOut > 0) {
              // SANITY CHECK: Quote should be within reasonable range of position size
              // Reject quotes that are >2x or <0.5x the original position size (same as Jupiter check)
              const maxReasonableQuote = position.sizeUsd * 2;
              const minReasonableQuote = position.sizeUsd * 0.5;

              if (quote.amountOut > maxReasonableQuote) {
                signalLogger.warn({
                  ticker: position.stockTicker,
                  raydiumUsdcOut: quote.amountOut.toFixed(2),
                  positionSizeUsd: position.sizeUsd.toFixed(2),
                  maxReasonable: maxReasonableQuote.toFixed(2),
                }, 'Raydium quote rejected: unreasonably high (likely bad data)');
              } else if (quote.amountOut < minReasonableQuote) {
                signalLogger.warn({
                  ticker: position.stockTicker,
                  raydiumUsdcOut: quote.amountOut.toFixed(2),
                  positionSizeUsd: position.sizeUsd.toFixed(2),
                  minReasonable: minReasonableQuote.toFixed(2),
                }, 'Raydium quote rejected: unreasonably low (likely bad data)');
              } else {
                raydiumUsdcOut = quote.amountOut;
                signalLogger.debug({
                  ticker: position.stockTicker,
                  raydiumUsdcOut: raydiumUsdcOut.toFixed(2),
                  priceImpact: quote.priceImpact.toFixed(2),
                }, 'Got Raydium exit quote');
              }
            }
          } catch (error) {
            signalLogger.warn({
              ticker: position.stockTicker,
              error: error instanceof Error ? error.message : String(error),
            }, 'Failed to get Raydium exit quote');
          }
        }
      }

      // Always try Jupiter quote to compare (with timeout)
      const jupiterClient = getJupiterClient();
      try {
        const rawSellAmount = position.buyAmount * Math.pow(10, position.buyDecimals);
        const quote = await withTimeout(
          jupiterClient.getSellQuoteRaw(position.buyMint, rawSellAmount),
          QUOTE_TIMEOUT_MS,
          null
        );
        if (quote && quote.outputAmount > 0) {
          // Jupiter returns USDC in lamports (6 decimals)
          const rawJupiterUsdcOut = quote.outputAmount / 1e6;

          // SANITY CHECK: Quote should be within reasonable range of position size
          // Reject quotes that are >2x or <0.5x the original position size (allows for price movement but catches bad quotes)
          const maxReasonableQuote = position.sizeUsd * 2;
          const minReasonableQuote = position.sizeUsd * 0.5;

          if (rawJupiterUsdcOut > maxReasonableQuote) {
            signalLogger.warn({
              ticker: position.stockTicker,
              jupiterUsdcOut: rawJupiterUsdcOut.toFixed(2),
              positionSizeUsd: position.sizeUsd.toFixed(2),
              maxReasonable: maxReasonableQuote.toFixed(2),
            }, 'Jupiter quote rejected: unreasonably high (likely bad data)');
          } else if (rawJupiterUsdcOut < minReasonableQuote) {
            signalLogger.warn({
              ticker: position.stockTicker,
              jupiterUsdcOut: rawJupiterUsdcOut.toFixed(2),
              positionSizeUsd: position.sizeUsd.toFixed(2),
              minReasonable: minReasonableQuote.toFixed(2),
            }, 'Jupiter quote rejected: unreasonably low (likely bad data)');
          } else {
            jupiterUsdcOut = rawJupiterUsdcOut;
            signalLogger.debug({
              ticker: position.stockTicker,
              jupiterUsdcOut: jupiterUsdcOut.toFixed(2),
              rawSellAmount,
            }, 'Got Jupiter exit quote');
          }
        }
      } catch (error) {
        signalLogger.warn({
          ticker: position.stockTicker,
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to get Jupiter exit quote');
      }

      // Choose the better quote (higher USDC output = better price)
      if (raydiumUsdcOut !== null && jupiterUsdcOut !== null) {
        if (jupiterUsdcOut > raydiumUsdcOut) {
          effectiveExitPrice = jupiterUsdcOut / position.buyAmount;
          priceSource = 'jupiter_quote';
          exitPreferredRoute = 'jupiter';
          bestQuoteUsd = jupiterUsdcOut;
          signalLogger.info({
            ticker: position.stockTicker,
            jupiterUsdcOut: jupiterUsdcOut.toFixed(2),
            raydiumUsdcOut: raydiumUsdcOut.toFixed(2),
            improvementPct: (((jupiterUsdcOut - raydiumUsdcOut) / raydiumUsdcOut) * 100).toFixed(3),
          }, 'Jupiter wins exit: better price than Raydium direct');
        } else {
          effectiveExitPrice = raydiumUsdcOut / position.buyAmount;
          priceSource = 'raydium_quote';
          exitPreferredRoute = 'raydium';
          bestQuoteUsd = raydiumUsdcOut;
          signalLogger.debug({
            ticker: position.stockTicker,
            raydiumUsdcOut: raydiumUsdcOut.toFixed(2),
            jupiterUsdcOut: jupiterUsdcOut.toFixed(2),
          }, 'Raydium wins exit: better or equal price');
        }
      } else if (jupiterUsdcOut !== null) {
        effectiveExitPrice = jupiterUsdcOut / position.buyAmount;
        priceSource = 'jupiter_quote';
        exitPreferredRoute = 'jupiter';
        bestQuoteUsd = jupiterUsdcOut;
      } else if (raydiumUsdcOut !== null) {
        effectiveExitPrice = raydiumUsdcOut / position.buyAmount;
        priceSource = 'raydium_quote';
        exitPreferredRoute = 'raydium';
        bestQuoteUsd = raydiumUsdcOut;
      }

      if (priceSource !== 'price_api') {
        signalLogger.debug({
          ticker: position.stockTicker,
          priceApiPrice: currentTokenPrice.toFixed(2),
          effectiveExitPrice: effectiveExitPrice.toFixed(2),
          priceSource,
          exitPreferredRoute,
        }, 'Using quote-based exit price');
      }
    }

    const tokenAppreciationPct = ((effectiveExitPrice - entryTokenPrice) / entryTokenPrice) * 100;

    // Also track discount for logging purposes
    const discountCaptured = position.entrySpreadPct - currentDiscount;

    const stopLossDiscountPct = config.meanReversionStopLossSpreadPct ?? -3.0;

    // Determine if trailing stop should be used for this position
    // Only use trailing stops when token has very high liquidity (>$5M TVL)
    // At $5M TVL, a $10K trade only moves price ~0.2% - safe for trailing stops
    const tokenTVL = getTokenTVL(position.buySymbol);
    const TRAILING_STOP_MIN_TVL = 5000000; // $5M minimum for trailing stop
    const useTrailingStop = tokenTVL >= TRAILING_STOP_MIN_TVL;

    // Get or initialize trailing stop state for this position
    let trailingState = this.trailingStops.get(position.id);
    if (!trailingState) {
      trailingState = { peakPct: tokenAppreciationPct, active: false };
      this.trailingStops.set(position.id, trailingState);
    }

    // Calculate stock price change for detailed exit reasons
    // Use stored entry stock price if available (accurate), otherwise fall back to back-calculation (less accurate due to slippage)
    const entryStockPrice = position.entryStockPrice ?? (entryTokenPrice / (1 - position.entrySpreadPct / 100));
    const stockChangePct = spread.stockPrice && spread.stockPrice > 0 && entryStockPrice > 0
      ? ((spread.stockPrice - entryStockPrice) / entryStockPrice) * 100
      : 0;

    // ANTI-CHURNING GUARD: Prevent exit if spread narrowed due to stock drop (not token rise)
    // This catches "fake profit" scenarios where discount narrows because stock crashed
    // Example: Entry at 2.5% discount, exit at 1.7% looks like 0.8% capture
    //          But if stock dropped 0.8%, we actually lost money (NAV degradation)
    // Only apply this guard if we've captured > 0.3% spread (meaningful narrowing)
    // EXCEPTION: Never block forced exits (max_hold_time, spread_widening_stop, stop_loss)
    const isPastMaxHold = holdTimeMs > MAX_HOLD_TIME_MS;
    const isSpreadWidening = position.entrySpreadPct !== undefined &&
      currentDiscount > position.entrySpreadPct + SPREAD_WIDENING_STOP_PCT;
    const isStopLoss = currentDiscount <= stopLossDiscountPct && holdTimeMs >= STOP_LOSS_GRACE_PERIOD_MS;
    if (discountCaptured > 0.3 && stockChangePct < -0.3 && !isPastMaxHold && !isSpreadWidening && !isStopLoss) {
      // Spread narrowed, but stock also dropped significantly
      // This is likely a losing trade disguised as profit - continue holding
      signalLogger.info({
        ticker: position.stockTicker,
        token: position.buySymbol,
        discountCaptured: discountCaptured.toFixed(2),
        stockChangePct: stockChangePct.toFixed(2),
        entryDiscount: position.entrySpreadPct.toFixed(2),
        exitDiscount: currentDiscount.toFixed(2),
      }, 'Exit blocked: spread narrowed from stock drop, not token rise (preventing fake profit exit)');
      return { shouldExit: false, reason: '', currentSpreadPct, spread };
    }

    // 1. PROFIT TARGET - take profit when spread has narrowed enough
    // CRITICAL: Use discountCaptured (spread narrowing), NOT tokenAppreciationPct (raw price move)
    // Token can appreciate due to stock moving up, but if spread widened, we lose money
    // If trailing stop is disabled (market closed or low liquidity), exit immediately
    if (discountCaptured >= exitAppreciationPct && holdTimeMs >= MIN_HOLD_TIME_MS && !useTrailingStop) {
      const detailedReason = getDetailedExitReason(
        discountCaptured, stockChangePct, position.entrySpreadPct, currentDiscount
      );
      signalLogger.info({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entryTokenPrice: entryTokenPrice.toFixed(2),
        exitPrice: effectiveExitPrice.toFixed(2),
        priceSource,
        discountCaptured: discountCaptured.toFixed(3),
        tokenAppreciationPct: tokenAppreciationPct.toFixed(3),
        exitThreshold: exitAppreciationPct.toFixed(3),
        marketOpen: isEquityMarketOpen(),
        tvl: tokenTVL,
        stockChangePct: stockChangePct.toFixed(2),
        detailedReason,
      }, 'Profit target hit - spread narrowed, exiting (trailing stop disabled)');
      this.trailingStops.delete(position.id);
      return {
        shouldExit: true,
        reason: detailedReason,
        currentSpreadPct,
        spread,
        preferredRoute: exitPreferredRoute,
        expectedExitUsd: bestQuoteUsd,
      };
    }

    // 2. TRAILING STOP LOGIC - let winners run (only when market open + high liquidity)
    // Once we've captured enough spread, activate trailing stop and track peak spread captured
    // CRITICAL: Use discountCaptured (spread narrowing), NOT tokenAppreciationPct
    if (discountCaptured >= exitAppreciationPct && holdTimeMs >= MIN_HOLD_TIME_MS && useTrailingStop) {
      // Activate trailing stop if not already active
      if (!trailingState.active) {
        trailingState.active = true;
        trailingState.peakPct = discountCaptured; // Track peak SPREAD captured, not token appreciation
        signalLogger.info({
          ticker: position.stockTicker,
          token: position.buySymbol,
          discountCaptured: discountCaptured.toFixed(3),
          exitThreshold: exitAppreciationPct.toFixed(3),
        }, 'Trailing stop activated - letting winner run');
      }

      // Update peak if spread captured is higher
      if (discountCaptured > trailingState.peakPct) {
        const oldPeak = trailingState.peakPct;
        trailingState.peakPct = discountCaptured;
        signalLogger.debug({
          ticker: position.stockTicker,
          token: position.buySymbol,
          oldPeakPct: oldPeak.toFixed(3),
          newPeakPct: discountCaptured.toFixed(3),
        }, 'Trailing stop: new peak spread captured');
      }

      // Check if spread captured has pulled back enough from peak to trigger exit
      const pullbackFromPeak = trailingState.peakPct - discountCaptured;
      if (pullbackFromPeak >= TRAILING_STOP_PULLBACK_PCT) {
        const detailedReason = getDetailedExitReason(
          discountCaptured, stockChangePct, position.entrySpreadPct, currentDiscount
        );
        signalLogger.info({
          ticker: position.stockTicker,
          token: position.buySymbol,
          entryTokenPrice: entryTokenPrice.toFixed(2),
          exitPrice: effectiveExitPrice.toFixed(2),
          priceSource,
          discountCaptured: discountCaptured.toFixed(3),
          peakSpreadCaptured: trailingState.peakPct.toFixed(3),
          pullbackPct: pullbackFromPeak.toFixed(3),
          pullbackThreshold: TRAILING_STOP_PULLBACK_PCT.toFixed(3),
          detailedReason,
        }, 'Trailing stop triggered - taking profit after pullback');
        // Clean up trailing state
        this.trailingStops.delete(position.id);
        return {
          shouldExit: true,
          reason: detailedReason,
          currentSpreadPct,
          spread,
          preferredRoute: exitPreferredRoute,
          expectedExitUsd: bestQuoteUsd,
        };
      }

      // Still running - log status
      signalLogger.debug({
        ticker: position.stockTicker,
        token: position.buySymbol,
        discountCaptured: discountCaptured.toFixed(3),
        peakPct: trailingState.peakPct.toFixed(3),
        pullbackFromPeak: pullbackFromPeak.toFixed(3),
        needPullback: TRAILING_STOP_PULLBACK_PCT.toFixed(3),
      }, 'Trailing stop: letting winner run');

      // Don't exit yet - let it run
    } else if (trailingState.active && discountCaptured < exitAppreciationPct) {
      // Was capturing spread, now below threshold
      // BUT only exit if we still captured SOME spread - don't "lock in" a loss!
      if (discountCaptured > 0) {
        const detailedReason = getDetailedExitReason(
          discountCaptured, stockChangePct, position.entrySpreadPct, currentDiscount
        );
        signalLogger.info({
          ticker: position.stockTicker,
          token: position.buySymbol,
          entryTokenPrice: entryTokenPrice.toFixed(2),
          exitPrice: effectiveExitPrice.toFixed(2),
          priceSource,
          discountCaptured: discountCaptured.toFixed(3),
          exitThreshold: exitAppreciationPct.toFixed(3),
          peakPct: trailingState.peakPct.toFixed(3),
          detailedReason,
        }, 'Trailing stop: dropped below threshold - exiting to lock profit');
        this.trailingStops.delete(position.id);
        return {
          shouldExit: true,
          reason: detailedReason,
          currentSpreadPct,
          spread,
          preferredRoute: exitPreferredRoute,
          expectedExitUsd: bestQuoteUsd,
        };
      } else {
        // We've gone from capturing spread to losing spread - deactivate trailing stop and let normal logic handle it
        signalLogger.warn({
          ticker: position.stockTicker,
          token: position.buySymbol,
          entryTokenPrice: entryTokenPrice.toFixed(2),
          exitPrice: effectiveExitPrice.toFixed(2),
          priceSource,
          discountCaptured: discountCaptured.toFixed(3),
          peakPct: trailingState.peakPct.toFixed(3),
        }, 'Trailing stop: spread widened to loss - deactivating, waiting for recovery');
        trailingState.active = false;
        trailingState.peakPct = 0;
      }
    }

    // 3. Token price dropped too much from entry (PRICE-BASED STOP LOSS)
    // This catches situations where both stock and token crash together (discount stays positive but we're losing money)
    if (tokenAppreciationPct <= PRICE_STOP_LOSS_PCT && holdTimeMs >= STOP_LOSS_GRACE_PERIOD_MS) {
      signalLogger.warn({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entryTokenPrice: entryTokenPrice.toFixed(2),
        currentTokenPrice: effectiveExitPrice.toFixed(2),
        tokenAppreciationPct: tokenAppreciationPct.toFixed(2),
        priceStopLossThreshold: PRICE_STOP_LOSS_PCT,
        currentDiscount: currentDiscount.toFixed(2),
      }, 'Price stop-loss triggered - token dropped too much from entry');
      this.trailingStops.delete(position.id); // Clean up trailing state
      return {
        shouldExit: true,
        reason: 'price_stop_loss',
        currentSpreadPct,
        spread,
        preferredRoute: exitPreferredRoute,
        expectedExitUsd: bestQuoteUsd,
      };
    } else if (tokenAppreciationPct <= PRICE_STOP_LOSS_PCT) {
      signalLogger.info({
        ticker: position.stockTicker,
        tokenAppreciationPct: tokenAppreciationPct.toFixed(2),
        remainingGraceSec: Math.round((STOP_LOSS_GRACE_PERIOD_MS - holdTimeMs) / 1000),
      }, 'Price stop-loss condition met but in grace period');
    }

    // 3b. Stock price dropped too much from entry (STOCK-BASED STOP LOSS)
    // This catches situations where the underlying stock crashes - even if discount is stable, we're losing on direction
    // Uses dynamic volatility from Twelve Data ATR (Average True Range)
    if (spread.stockPrice && spread.stockPrice > 0) {
      // Calculate entry stock price from entry data: tokenPrice = stockPrice * (1 - discount/100)
      // So: stockPrice = tokenPrice / (1 - discount/100)
      const entryStockPrice = entryTokenPrice / (1 - position.entrySpreadPct / 100);
      const stockAppreciationPct = ((spread.stockPrice - entryStockPrice) / entryStockPrice) * 100;

      // Get dynamic stop loss threshold based on actual ATR volatility
      // Falls back to STOCK_STOP_LOSS_DEFAULT_PCT (-5%) if API unavailable
      const stockStopLossThreshold = await getDynamicStopLossPct(position.stockTicker);

      if (stockAppreciationPct <= stockStopLossThreshold && holdTimeMs >= STOP_LOSS_GRACE_PERIOD_MS) {
        signalLogger.warn({
          ticker: position.stockTicker,
          token: position.buySymbol,
          entryStockPrice: entryStockPrice.toFixed(2),
          currentStockPrice: spread.stockPrice.toFixed(2),
          stockAppreciationPct: stockAppreciationPct.toFixed(2),
          stockStopLossThreshold: stockStopLossThreshold.toFixed(1),
          currentDiscount: currentDiscount.toFixed(2),
        }, 'NAV stop-loss triggered - underlying dropped too much');
        this.trailingStops.delete(position.id);
        return {
          shouldExit: true,
          reason: 'rwa_stop_loss',
          currentSpreadPct,
          spread,
          preferredRoute: exitPreferredRoute,
          expectedExitUsd: bestQuoteUsd,
        };
      } else if (stockAppreciationPct <= stockStopLossThreshold) {
        signalLogger.debug({
          ticker: position.stockTicker,
          stockAppreciationPct: stockAppreciationPct.toFixed(2),
          stockStopLossThreshold: stockStopLossThreshold.toFixed(1),
          remainingGraceSec: Math.round((STOP_LOSS_GRACE_PERIOD_MS - holdTimeMs) / 1000),
        }, 'Stock stop-loss condition met but in grace period');
      }
    }

    // 4. Token went to premium (DISCOUNT-BASED STOP LOSS)
    if (currentDiscount <= stopLossDiscountPct && holdTimeMs >= STOP_LOSS_GRACE_PERIOD_MS) {
      signalLogger.warn({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entryDiscount: position.entrySpreadPct,
        currentDiscount,
        stopLossThreshold: stopLossDiscountPct,
      }, 'Stop-loss triggered - token went to premium');
      this.trailingStops.delete(position.id); // Clean up trailing state
      return {
        shouldExit: true,
        reason: 'stop_loss',
        currentSpreadPct,
        spread,
        preferredRoute: exitPreferredRoute,
        expectedExitUsd: bestQuoteUsd,
      };
    } else if (currentDiscount <= stopLossDiscountPct) {
      signalLogger.info({
        ticker: position.stockTicker,
        currentDiscount,
        remainingGraceSec: Math.round((STOP_LOSS_GRACE_PERIOD_MS - holdTimeMs) / 1000),
      }, 'Discount stop-loss condition met but in grace period');
    }

    // 5a. Spread-widening stop — exit if spread has widened significantly from entry
    // Data (7d): trades where spread widened >1.5% from entry had 0% win rate.
    const spreadWidening = currentDiscount - position.entrySpreadPct;
    if (spreadWidening >= SPREAD_WIDENING_STOP_PCT && holdTimeMs >= MIN_HOLD_TIME_MS) {
      signalLogger.info({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entrySpread: position.entrySpreadPct.toFixed(2),
        currentSpread: currentDiscount.toFixed(2),
        spreadWidening: spreadWidening.toFixed(2),
        holdTimeMin: (holdTimeMs / 60000).toFixed(1),
        threshold: SPREAD_WIDENING_STOP_PCT,
      }, 'Spread-widening stop triggered - spread diverging from entry, cutting losses');
      this.trailingStops.delete(position.id);
      return {
        shouldExit: true,
        reason: 'spread_widening_stop',
        currentSpreadPct,
        spread,
        preferredRoute: exitPreferredRoute,
        expectedExitUsd: bestQuoteUsd,
      };
    }

    // 5b. Max hold time - 60 minutes
    if (holdTimeMs > MAX_HOLD_TIME_MS) {
      signalLogger.info({
        ticker: position.stockTicker,
        token: position.buySymbol,
        entryTokenPrice: entryTokenPrice.toFixed(2),
        currentTokenPrice: currentTokenPrice.toFixed(2),
        tokenAppreciationPct: tokenAppreciationPct.toFixed(2),
        holdTimeMin: (holdTimeMs / 60000).toFixed(1),
        maxHoldMin: (MAX_HOLD_TIME_MS / 60000).toFixed(0),
      }, 'Max hold time reached - exiting at current price');
      this.trailingStops.delete(position.id); // Clean up trailing state
      return {
        shouldExit: true,
        reason: 'max_hold_time',
        currentSpreadPct,
        spread,
        preferredRoute: exitPreferredRoute,
        expectedExitUsd: bestQuoteUsd,
      };
    }

    // Log position status periodically (every ~5 minutes based on check interval)
    signalLogger.debug({
      ticker: position.stockTicker,
      token: position.buySymbol,
      entryTokenPrice: entryTokenPrice.toFixed(2),
      currentTokenPrice: currentTokenPrice.toFixed(2),
      tokenAppreciationPct: tokenAppreciationPct.toFixed(2),
      neededAppreciationPct: exitAppreciationPct.toFixed(2),
      holdTimeHours: (holdTimeMs / (60 * 60 * 1000)).toFixed(1),
      discountCaptured: discountCaptured.toFixed(2),
    }, 'Position check - waiting for token price appreciation');

    return { shouldExit: false, reason: '', currentSpreadPct, spread };
  }

  /**
   * Create empty spread for error cases
   */
  private createEmptySpread(pair: TokenPair): PairSpread {
    return {
      stockTicker: pair.stockTicker,
      tokenA: {
        symbol: pair.tokenA.symbol,
        mint: pair.tokenA.mint,
        price: 0,
        liquidity: 0,
      },
      tokenB: {
        symbol: pair.tokenB.symbol,
        mint: pair.tokenB.mint,
        price: 0,
        liquidity: 0,
      },
      spreadPct: 0,
      spreadAbsolute: 0,
      cheaperToken: 'A',
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate spreads for all targets in batch mode
   * Uses batch API calls for both stock and token prices
   * Much more efficient for large token lists (300+ tokens)
   *
   * Flow:
   * 1. Fetch all stock prices in parallel (using all Finnhub keys)
   * 2. Fetch all token prices in batch (30 per DexScreener request)
   * 3. Calculate discounts for all pairs with synchronized prices
   */
  async calculateAllSpreadsBatch(): Promise<PairSpread[]> {
    const stockFeed = getStockFeed();
    const onchainFeed = getOnchainFeed();
    const startTime = Date.now();
    const results: PairSpread[] = [];
    const useDexScreenerBatch = useDexScreenerBatchNext;
    const tokenMinIntervalMs = useDexScreenerBatch
      ? getDexScreenerMinBatchIntervalMs(this.targets.length)
      : getJupiterMinBatchIntervalMs(this.targets.length);

    // Keep cached spreads fresh but never beyond the staleness threshold.
    const stockMinIntervalMs = stockFeed.getMinBatchIntervalMs(this.targets.length);
    const minBatchIntervalMs = Math.max(tokenMinIntervalMs, stockMinIntervalMs);
    const stalenessLimitMs = getConfigSync().priceStalenessMs;
    batchSpreadsCacheTtlMs = Math.max(10000, Math.min(minBatchIntervalMs, stalenessLimitMs));

    const cacheAge = Date.now() - batchSpreadsCacheTime;
    const effectiveCacheLimitMs = Math.min(minBatchIntervalMs, stalenessLimitMs);
    if (cachedBatchSpreads.size > 0 && cacheAge < effectiveCacheLimitMs) {
      signalLogger.debug({
        cacheAgeMs: cacheAge,
        minBatchIntervalMs,
        effectiveCacheLimitMs,
        tokenMinIntervalMs,
        stockMinIntervalMs,
        targetCount: this.targets.length,
        source: useDexScreenerBatch ? 'dexscreener' : 'jupiter',
      }, 'Skipping batch fetch (rate-limit safe interval not met)');
      return Array.from(cachedBatchSpreads.values());
    }

    // Prepare lists for batch fetching
    const stockSymbols = this.targets.map(t => t.stockTicker);
    const tokenList = this.targets.map(t => ({
      mint: t.tokenA.mint,
      symbol: t.tokenA.symbol,
    }));
    const tokenMints = tokenList.map(t => t.mint);

    signalLogger.info({
      totalTokens: this.targets.length,
      minBatchIntervalMs,
      tokenMinIntervalMs,
      stockMinIntervalMs,
      source: useDexScreenerBatch ? 'dexscreener' : 'jupiter',
    }, 'Starting batch price fetch');

    // Fetch stock and token prices in parallel
    const [stockPrices, tokenPrices] = await Promise.all([
      stockFeed.getBatchPrices(stockSymbols),
      useDexScreenerBatch ? fetchBatchDexScreenerPrices(tokenList) : Promise.resolve(new Map()),
    ]);
    if (!useDexScreenerBatch) {
      await onchainFeed.prefetchPrices(tokenMints);
    }
    useDexScreenerBatchNext = !useDexScreenerBatchNext;

    const fetchTime = Date.now() - startTime;

    // Also try to get onchain prices from Jupiter cache for tokens not in DexScreener
    // (Use existing cache only - no additional API calls)
    const onchainCache = new Map<string, OnchainPrice>();
    const cachedOnchain = onchainFeed.getAllPrices();
    for (const target of this.targets) {
      if (!tokenPrices.has(target.tokenA.mint)) {
        const cached = cachedOnchain.get(target.tokenA.mint);
        if (cached && !cached.isStale) {
          onchainCache.set(target.tokenA.mint, cached);
        }
      }
    }

    // Calculate discounts for each target
    let successCount = 0;
    let missingStock = 0;
    let missingToken = 0;

    // Track discount stats for better observability
    const allDiscounts: number[] = [];
    let aboveThresholdCount = 0;
    let nearThresholdCount = 0;
    let dexScreenerCount = 0;
    let jupiterFallbackCount = 0;
    const missingTokenSamples: string[] = [];
    const nearThresholdItems: WatchlistItem[] = [];

    for (const pair of this.targets) {
      // Skip tokens in bad pricing cooldown
      if (this.isInBadPricingCooldown(pair.tokenA.symbol)) {
        continue;
      }

      const stockPrice = stockPrices.get(pair.stockTicker);
      const dexScreenerPrice = tokenPrices.get(pair.tokenA.mint);
      const onchainPrice = onchainCache.get(pair.tokenA.mint);

      // Get token price (prefer DexScreener, fallback to onchain cache)
      let tokenPrice: number | null = null;
      let tokenLiquidity = 0;

      if (dexScreenerPrice) {
        tokenPrice = dexScreenerPrice.priceUsd;
        tokenLiquidity = dexScreenerPrice.totalLiquidityUsd;
        dexScreenerCount++;
      } else if (onchainPrice) {
        tokenPrice = onchainPrice.tradingPrice;
        tokenLiquidity = onchainPrice.poolLiquidity || 0;
        jupiterFallbackCount++;
      }

      // Skip if missing data
      if (!stockPrice || stockPrice.price <= 0) {
        missingStock++;
        continue;
      }

      if (!tokenPrice || tokenPrice <= 0 || !isFinite(tokenPrice)) {
        missingToken++;
        if (missingTokenSamples.length < 5) {
          missingTokenSamples.push(pair.tokenA.symbol);
        }
        continue;
      }

      // Calculate discount
      const discount = ((stockPrice.price - tokenPrice) / stockPrice.price) * 100;

      // Skip unreasonable discounts and put in cooldown
      if (Math.abs(discount) > MAX_REASONABLE_DEVIATION_PCT) {
        this.recordBadPricing(pair.tokenA.symbol);
        continue;
      }

      // Record for smoothing
      this.recordDiscount(pair.stockTicker, pair.tokenA.symbol, discount);

      // Create spread result
      const spread: PairSpread = {
        stockTicker: pair.stockTicker,
        tokenA: {
          symbol: pair.tokenA.symbol,
          mint: pair.tokenA.mint,
          price: tokenPrice,
          liquidity: tokenLiquidity,
          discountVsStock: discount,
        },
        tokenB: {
          symbol: pair.tokenB.symbol,
          mint: pair.tokenB.mint,
          price: tokenPrice,
          liquidity: tokenLiquidity,
          discountVsStock: discount,
        },
        spreadPct: discount,
        spreadAbsolute: stockPrice.price - tokenPrice,
        cheaperToken: 'A',
        stockPrice: stockPrice.price,
        moreDiscounted: 'A',
        timestamp: Date.now(),
      };

      results.push(spread);
      successCount++;

      // Track discount stats
      allDiscounts.push(discount);
      const entryThreshold = getEntryThreshold(pair.tokenA.symbol);
      const tvl = getTokenTVL(pair.tokenA.symbol);
      const thresholdGap = entryThreshold - discount;

      if (discount >= entryThreshold) {
        aboveThresholdCount++;
        signalLogger.info({
          ticker: pair.stockTicker,
          discount: discount.toFixed(2),
          token: pair.tokenA.symbol,
          entryThreshold: entryThreshold.toFixed(2),
          tvl: tvl.toFixed(0),
        }, 'Entry opportunity detected (batch)');

        // Also add above-threshold tokens to watchlist (shown as green "ready to trade")
        const now = Date.now();
        const trackerKey = pair.tokenA.symbol;
        const existingTracker = priceChangeTrackers.get(trackerKey);
        let stockChangedAt = now;
        let tokenChangedAt = now;
        if (existingTracker) {
          const stockDiff = Math.abs(existingTracker.stockPrice - stockPrice.price);
          const tokenDiff = Math.abs(existingTracker.tokenPrice - tokenPrice);
          stockChangedAt = stockDiff > 0.001 ? now : existingTracker.stockChangedAt;
          tokenChangedAt = tokenDiff > 0.0001 ? now : existingTracker.tokenChangedAt;
        }
        priceChangeTrackers.set(trackerKey, {
          stockPrice: stockPrice.price,
          stockChangedAt,
          tokenPrice,
          tokenChangedAt,
        });
        nearThresholdItems.push({
          symbol: pair.tokenA.symbol,
          ticker: pair.stockTicker,
          mint: pair.tokenA.mint,
          stockPrice: stockPrice.price,
          tokenPrice,
          discount,
          entryThreshold,
          gap: thresholdGap, // Will be negative for above-threshold
          tvl,
          timestamp: now,
          stockTimestamp: stockChangedAt,
          tokenTimestamp: tokenChangedAt,
        });
      } else if (thresholdGap > 0 && thresholdGap <= 1.0 && discount > 0) {
        // Track near-threshold tokens for watchlist (within 1% and positive discount)
        // Track when prices actually CHANGE (not just when fetched)
        const now = Date.now();
        const trackerKey = pair.tokenA.symbol;
        const existingTracker = priceChangeTrackers.get(trackerKey);

        let stockChangedAt = now;
        let tokenChangedAt = now;

        if (existingTracker) {
          // Only update timestamp if price actually changed
          const stockDiff = Math.abs(existingTracker.stockPrice - stockPrice.price);
          const tokenDiff = Math.abs(existingTracker.tokenPrice - tokenPrice);

          stockChangedAt = stockDiff > 0.001 ? now : existingTracker.stockChangedAt;
          tokenChangedAt = tokenDiff > 0.0001 ? now : existingTracker.tokenChangedAt;

          // Debug: log when prices change
          if (stockDiff > 0.001 || tokenDiff > 0.0001) {
            signalLogger.debug({
              symbol: pair.tokenA.symbol,
              stockDiff: stockDiff.toFixed(4),
              tokenDiff: tokenDiff.toFixed(6),
              stockChanged: stockDiff > 0.001,
              tokenChanged: tokenDiff > 0.0001,
            }, 'Price change detected');
          }
        }

        // Update tracker with current prices
        priceChangeTrackers.set(trackerKey, {
          stockPrice: stockPrice.price,
          stockChangedAt,
          tokenPrice,
          tokenChangedAt,
        });

        nearThresholdItems.push({
          symbol: pair.tokenA.symbol,
          ticker: pair.stockTicker,
          mint: pair.tokenA.mint,
          stockPrice: stockPrice.price,
          tokenPrice,
          discount,
          entryThreshold,
          gap: thresholdGap,
          tvl,
          timestamp: now,
          stockTimestamp: stockChangedAt,
          tokenTimestamp: tokenChangedAt,
        });
        // Log if very close (within 0.5%)
        if (thresholdGap <= 0.5) {
          nearThresholdCount++;
          signalLogger.info({
            ticker: pair.stockTicker,
            discount: discount.toFixed(2),
            entryThreshold: entryThreshold.toFixed(2),
            gap: thresholdGap.toFixed(2),
          }, 'Near-threshold opportunity (watching)');
        }
      }
    }

    const totalTime = Date.now() - startTime;

    // Calculate discount stats
    const sortedDiscounts = [...allDiscounts].sort((a, b) => a - b);
    const minDiscount = sortedDiscounts.length > 0 ? sortedDiscounts[0] : 0;
    const maxDiscount = sortedDiscounts.length > 0 ? sortedDiscounts[sortedDiscounts.length - 1] : 0;
    const medianDiscount = sortedDiscounts.length > 0
      ? sortedDiscounts[Math.floor(sortedDiscounts.length / 2)]
      : 0;

    signalLogger.info({
      totalTokens: this.targets.length,
      success: successCount,
      missingStock,
      missingToken,
      missingTokenSamples: missingTokenSamples.length > 0 ? missingTokenSamples : undefined,
      discountStats: {
        min: minDiscount.toFixed(2),
        max: maxDiscount.toFixed(2),
        median: medianDiscount.toFixed(2),
        aboveThreshold: aboveThresholdCount,
        nearThreshold: nearThresholdCount,
      },
      priceSources: {
        dexScreener: dexScreenerCount,
        jupiterFallback: jupiterFallbackCount,
      },
      fetchTimeMs: fetchTime,
      totalTimeMs: totalTime,
    }, 'Batch spread calculation complete');

    // Update watchlist cache - merge new items with existing ones
    // This prevents the watchlist from flickering when alternating between DexScreener/Jupiter
    // Keep items that were updated in this batch, and retain old items that weren't re-evaluated
    const WATCHLIST_STALE_MS = 60_000; // Remove items older than 60 seconds
    const cacheNow = Date.now();

    // Create a map of new items by symbol for quick lookup
    // Note: preserve stockTimestamp/tokenTimestamp from nearThresholdItems (tracks actual price changes)
    const newItemsBySymbol = new Map(nearThresholdItems.map(item => [item.symbol, item]));

    // Start with new items (already have correct timestamps set)
    const mergedItems: WatchlistItem[] = [...nearThresholdItems];

    // Add old items that weren't updated (if not stale)
    for (const oldItem of cachedWatchlist) {
      const oldWithTimestamp = oldItem as WatchlistItem & { timestamp?: number };
      if (!newItemsBySymbol.has(oldItem.symbol)) {
        // Keep if not too stale
        if (oldWithTimestamp.timestamp && (cacheNow - oldWithTimestamp.timestamp) < WATCHLIST_STALE_MS) {
          mergedItems.push(oldWithTimestamp);
        }
      }
    }

    // Sort by progress (discount/entryThreshold) descending - most filled first
    cachedWatchlist = mergedItems
      .sort((a, b) => {
        const progressA = a.entryThreshold > 0 ? a.discount / a.entryThreshold : 0;
        const progressB = b.entryThreshold > 0 ? b.discount / b.entryThreshold : 0;
        return progressB - progressA;
      })
      .slice(0, 10);

    // Cache the batch spreads for use by evaluate() - prevents price mismatch
    // between batch logging ("Entry opportunity detected") and trade evaluation
    // Use tokenA.symbol as key (not stockTicker) to avoid collisions when multiple
    // tokens share the same stock ticker (e.g., SPYr and SPYx both have ticker "SPY")
    cachedBatchSpreads.clear();
    for (const spread of results) {
      cachedBatchSpreads.set(spread.tokenA.symbol, spread);
    }
    batchSpreadsCacheTime = Date.now();

    signalLogger.debug({
      cachedSpreads: cachedBatchSpreads.size,
    }, 'Batch spreads cached for evaluation');

    return results;
  }

  /**
   * Get trailing stop state for a position (for UI display)
   */
  getTrailingStopState(positionId: string): { active: boolean; peakPct: number } | null {
    return this.trailingStops.get(positionId) || null;
  }
}

// Singleton
let instance: MeanReversionSignalGenerator | null = null;

export function getMeanReversionSignalGenerator(): MeanReversionSignalGenerator {
  if (!instance) {
    instance = new MeanReversionSignalGenerator();
  }
  return instance;
}

/**
 * Get trailing stop state for a position (convenience export)
 */
export function getTrailingStopState(positionId: string): { active: boolean; peakPct: number } | null {
  return getMeanReversionSignalGenerator().getTrailingStopState(positionId);
}
