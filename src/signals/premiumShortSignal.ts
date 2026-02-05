/**
 * Premium Short Signal Generator
 *
 * Detects when tokenized stocks trade at a PREMIUM vs their stock price.
 * When premium detected, opens SHORT positions on Flash Trade perps.
 *
 * Flash Trade perps use Pyth oracles for NASDAQ pricing, so shorting
 * captures the premium as it collapses back to fair value.
 *
 * Supported markets: TSLA, NVDA, CRCL, MSTR, SPY (via rStock perps)
 */

import { PairSpread } from '../types';
import { signalLogger } from '../logger';
import { getConfigSync } from '../config';
import { getDatabase } from '../db/database';
import {
  isShortingEnabled,
  isFlashTradeAvailable,
  hasFlashMarket,
  getFlashSymbol,
  isEquityMarketOpen,
  getMarketHolidayStatus,
  FlashSymbol,
} from '../execution/flashTradeClient';

// ============================================================================
// SHORT THRESHOLD CONFIGURATION
// ============================================================================
// Dynamic thresholds based on Flash Trade fees + profit margin
//
// Components:
// 1. Flash Trade fees: ~0.1% open + 0.1% close = 0.2% round-trip
// 2. Slippage buffer: 0.1% for price movement during execution
// 3. Profit margin: Minimum profit we want after costs
//
// Formula: entryThreshold = fees + slippage + profitMargin
// ============================================================================

const FLASH_TRADE_FEE_PCT = 0.2;        // Round-trip fees (open + close)
const SHORT_SLIPPAGE_BUFFER_PCT = 0.1;  // Buffer for execution slippage
const SHORT_MIN_PROFIT_PCT = 0.2;       // Minimum profit margin we want

// Base threshold = fees + slippage + profit = 0.5% minimum
const BASE_SHORT_THRESHOLD_PCT = FLASH_TRADE_FEE_PCT + SHORT_SLIPPAGE_BUFFER_PCT + SHORT_MIN_PROFIT_PCT;

// Per-symbol adjustments based on volatility/characteristics
// Higher volatility = higher threshold (more buffer needed)
const SYMBOL_THRESHOLD_MULTIPLIERS: Record<string, number> = {
  SPY: 1.0,    // Stable ETF, use base threshold
  NVDA: 1.2,   // Tech stock, moderate volatility
  TSLA: 1.5,   // High volatility
  MSTR: 2.0,   // Very high volatility (Bitcoin proxy)
  CRCL: 1.3,   // Moderate volatility
};

/**
 * Get dynamic entry threshold for shorting based on symbol characteristics
 * Returns a NEGATIVE number (premium = negative discount)
 */
function getShortEntryThreshold(ticker: string): number {
  const multiplier = SYMBOL_THRESHOLD_MULTIPLIERS[ticker] ?? 1.2; // Default to 1.2x for unknown
  const threshold = BASE_SHORT_THRESHOLD_PCT * multiplier;
  return -threshold; // Return negative (premium thresholds are negative)
}

// ============================================================================
// MARKET CLOSE SAFETY - Prevent opening shorts too close to market close
// ============================================================================
// This prevents getting stuck with an open position that can't be closed
// due to stale Pyth oracles or weekend market closure.
//
// Rules:
// - No new shorts after 7 PM ET on Mon-Thu (1 hour buffer before 8 PM close)
// - No new shorts after 12 PM ET on Friday (avoid weekend gap risk entirely)
// ============================================================================

const WEEKDAY_CUTOFF_HOUR_ET = 19;  // 7 PM ET (Mon-Thu)
const FRIDAY_CUTOFF_HOUR_ET = 12;   // 12 PM ET (Friday noon)

/**
 * Check if we're too close to market close to safely open a short
 * Returns { blocked: true, reason: string } if entry should be blocked
 */
function isNearMarketClose(): { blocked: boolean; reason: string } {
  const now = new Date();

  // Convert to Eastern Time properly (handles DST automatically)
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = etTime.getHours();
  const etDay = etTime.getDay();

  // Friday (5) - stricter cutoff to avoid weekend risk
  if (etDay === 5) {
    if (etHour >= FRIDAY_CUTOFF_HOUR_ET) {
      return {
        blocked: true,
        reason: `No new shorts after ${FRIDAY_CUTOFF_HOUR_ET}:00 ET on Fridays (weekend gap risk)`,
      };
    }
  }

  // Mon-Thu (1-4) - 1 hour before market close
  if (etDay >= 1 && etDay <= 4) {
    if (etHour >= WEEKDAY_CUTOFF_HOUR_ET) {
      return {
        blocked: true,
        reason: `No new shorts after ${WEEKDAY_CUTOFF_HOUR_ET}:00 ET (approaching market close)`,
      };
    }
  }

  return { blocked: false, reason: '' };
}

// Exit and stop-loss are relative to entry
// Exit when premium drops to 40% of entry threshold
// Stop-loss when premium expands to 5x entry threshold
const EXIT_THRESHOLD_RATIO = 0.4;   // Exit at 40% of entry premium
const STOP_LOSS_RATIO = 5.0;        // Stop-loss at 5x entry premium

/**
 * Get dynamic exit threshold for a short position
 * Exit when premium drops to EXIT_THRESHOLD_RATIO of entry threshold
 */
function getShortExitThreshold(ticker: string): number {
  const entryThreshold = getShortEntryThreshold(ticker);
  return entryThreshold * EXIT_THRESHOLD_RATIO; // e.g., -0.5% * 0.4 = -0.2%
}

/**
 * Get dynamic stop-loss threshold for a short position
 * Stop-loss when premium expands to STOP_LOSS_RATIO of entry threshold
 */
function getShortStopLossThreshold(ticker: string): number {
  const entryThreshold = getShortEntryThreshold(ticker);
  return entryThreshold * STOP_LOSS_RATIO; // e.g., -0.5% * 5 = -2.5%
}

// Leverage settings
// Flash Trade has a minimum leverage requirement for rStock markets
// Error 6023 at 1.1x and 1.5x indicates minimum is ~2x
const MIN_LEVERAGE = 2.0;     // Minimum leverage for Flash Trade rStocks
const MAX_LEVERAGE = 3.0;     // Max allowed

/**
 * Get dynamic leverage for shorting based on threshold multiplier
 *
 * Derives leverage from SYMBOL_THRESHOLD_MULTIPLIERS - single source of truth:
 * - Higher multiplier = higher volatility = need more buffer = LOWER leverage
 * - Lower multiplier = lower volatility = stable asset = HIGHER leverage
 *
 * Formula: leverage = MAX - (multiplier - 1) * scale
 * Where scale maps the multiplier range [1.0, 2.0] to leverage range [MAX, MIN]
 *
 * Examples with current multipliers:
 * - SPY (1.0x): 2.0 leverage (stable ETF, max leverage)
 * - NVDA (1.2x): 1.8 leverage
 * - CRCL (1.3x): 1.7 leverage
 * - TSLA (1.5x): 1.5 leverage (high vol, min leverage)
 * - MSTR (2.0x): 1.5 leverage (very high vol, capped at min)
 */
function getShortLeverage(ticker: string): number {
  const multiplier = SYMBOL_THRESHOLD_MULTIPLIERS[ticker] ?? 1.2;

  // Scale: maps multiplier range to leverage range
  // multiplier 1.0 -> MAX_LEVERAGE (2.0)
  // multiplier 2.0 -> MIN_LEVERAGE (1.5)
  const scale = (MAX_LEVERAGE - MIN_LEVERAGE) / 1.0; // 0.5 per 1.0 multiplier increase
  const rawLeverage = MAX_LEVERAGE - (multiplier - 1.0) * scale;

  // Clamp to valid range and warn if clamped
  const clampedLeverage = Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE, rawLeverage));
  if (rawLeverage !== clampedLeverage) {
    signalLogger.warn({
      ticker,
      multiplier,
      rawLeverage: rawLeverage.toFixed(2),
      clampedLeverage: clampedLeverage.toFixed(2),
    }, 'Leverage clamped to bounds - multiplier outside expected range [1.0, 2.0]');
  }

  return clampedLeverage;
}

// Premium watchlist item - tracks tokens approaching short threshold
export interface PremiumWatchlistItem {
  symbol: string;
  ticker: string;
  flashSymbol: FlashSymbol;
  mint: string;
  stockPrice: number;
  tokenPrice: number;
  premiumPct: number;       // Positive number (e.g., 1.5 = 1.5% premium)
  entryThreshold: number;   // Positive number (e.g., 2.0 = 2% premium needed)
  gap: number;              // How far from threshold
  leverage: number;         // Leverage that will be used for this ticker
  timestamp: number;
  stockTimestamp: number;   // When stock price last changed
  tokenTimestamp: number;   // When token price last changed
}

// Track when prices actually changed (not just fetched)
interface ShortPriceChangeTracker {
  stockPrice: number;
  stockChangedAt: number;
  tokenPrice: number;
  tokenChangedAt: number;
}
const shortPriceChangeTrackers: Map<string, ShortPriceChangeTracker> = new Map();

// Cache for premium watchlist
let cachedPremiumWatchlist: PremiumWatchlistItem[] = [];

// Cooldown tracking - prevent rapid re-entry after a position is closed
const shortEntryCooldowns: Map<string, number> = new Map();
const SHORT_ENTRY_COOLDOWN_MS = 60000; // 1 minute cooldown after closing a position

/**
 * Set cooldown for a ticker after closing a position
 */
export function setShortEntryCooldown(ticker: string): void {
  shortEntryCooldowns.set(ticker, Date.now());
}

/**
 * Check if a ticker is in cooldown
 */
function isInShortEntryCooldown(ticker: string): boolean {
  const cooldownStart = shortEntryCooldowns.get(ticker);
  if (!cooldownStart) return false;

  const elapsed = Date.now() - cooldownStart;
  if (elapsed >= SHORT_ENTRY_COOLDOWN_MS) {
    shortEntryCooldowns.delete(ticker);
    return false;
  }
  return true;
}

/**
 * Get the premium watchlist (tokens approaching short threshold)
 */
export function getPremiumWatchlist(): PremiumWatchlistItem[] {
  return cachedPremiumWatchlist;
}

/**
 * Update the premium watchlist from spread data
 * Called during batch spread calculations
 */
export function updatePremiumWatchlist(spreads: PairSpread[]): void {
  const watchlistItems: PremiumWatchlistItem[] = [];
  const now = Date.now();

  for (const spread of spreads) {
    // Only track tokens with rStock markets
    if (!hasFlashMarket(spread.stockTicker)) continue;

    const flashSymbol = getFlashSymbol(spread.stockTicker);
    if (!flashSymbol) continue;

    // Only show the actual Flash token (e.g., SPYr), not other tokens like SPYx
    // that happen to track the same underlying stock
    if (spread.tokenA.symbol !== flashSymbol) continue;

    // Get premium (negative discount = premium)
    const discountPct = spread.tokenA.discountVsStock ?? 0;
    const premiumPct = -discountPct; // Convert to positive for display

    // Entry threshold as positive number (dynamic per symbol)
    const entryThreshold = -getShortEntryThreshold(spread.stockTicker);

    // Gap: how far from threshold (negative = already past threshold)
    const gap = entryThreshold - premiumPct;

    // Only add to watchlist if:
    // 1. Token is at premium (premiumPct > 0)
    // 2. Within 1.5% of threshold OR already past threshold
    if (premiumPct > 0 && gap <= 1.5) {
      // Track when prices actually CHANGE (not just when fetched)
      const trackerKey = spread.tokenA.symbol;
      const existingTracker = shortPriceChangeTrackers.get(trackerKey);
      const stockPrice = spread.stockPrice || 0;
      const tokenPrice = spread.tokenA.price;

      let stockChangedAt = now;
      let tokenChangedAt = now;

      if (existingTracker) {
        // Only update timestamp if price actually changed
        const stockDiff = Math.abs(existingTracker.stockPrice - stockPrice);
        const tokenDiff = Math.abs(existingTracker.tokenPrice - tokenPrice);

        stockChangedAt = stockDiff > 0.001 ? now : existingTracker.stockChangedAt;
        tokenChangedAt = tokenDiff > 0.0001 ? now : existingTracker.tokenChangedAt;
      }

      // Update tracker with current prices
      shortPriceChangeTrackers.set(trackerKey, {
        stockPrice,
        stockChangedAt,
        tokenPrice,
        tokenChangedAt,
      });

      watchlistItems.push({
        symbol: spread.tokenA.symbol,
        ticker: spread.stockTicker,
        flashSymbol,
        mint: spread.tokenA.mint,
        stockPrice,
        tokenPrice,
        premiumPct,
        entryThreshold,
        gap,
        leverage: getShortLeverage(spread.stockTicker),
        timestamp: now,
        stockTimestamp: stockChangedAt,
        tokenTimestamp: tokenChangedAt,
      });
    }
  }

  // Sort by progress (premium/threshold ratio) descending - closest to trigger first
  cachedPremiumWatchlist = watchlistItems
    .sort((a, b) => {
      const progressA = a.entryThreshold > 0 ? a.premiumPct / a.entryThreshold : 0;
      const progressB = b.entryThreshold > 0 ? b.premiumPct / b.entryThreshold : 0;
      return progressB - progressA;
    })
    .slice(0, 10); // Keep top 10
}

export interface PremiumShortSignal {
  shouldShort: boolean;
  ticker: string;
  flashSymbol: FlashSymbol | null;
  tokenSymbol: string;       // Which token triggered this signal (for position tracking)
  tokenMint: string;         // Mint address for precise matching
  premiumPct: number;        // Negative number (e.g., -2.5 = 2.5% premium)
  stockPrice: number;
  tokenPrice: number;
  suggestedCollateralUsd: number;
  leverage: number;
  reasons: string[];
}

export interface ShortPosition {
  id: string;
  ticker: string;
  flashSymbol: FlashSymbol;
  tokenSymbol: string;  // Which token's premium triggered this position (e.g., 'NVDAx' vs 'NVDAr')
  tokenMint: string;    // Mint address for precise matching
  entryPremiumPct: number;
  entryStockPrice: number;
  entryTimestamp: number;
  collateralUsd: number;
  leverage: number;
  status: 'open' | 'closed';
  entryTxSignature?: string;
  exitPremiumPct?: number;
  exitTimestamp?: number;
  exitReason?: 'profit_target' | 'stop_loss' | 'max_hold_time' | 'manual' | 'position_missing' | 'weekend_close';
  exitTxSignature?: string;
  pnlUsd?: number;
  pnlPct?: number;
}

// Short positions are now stored in the database (not in-memory)
// This ensures positions persist across restarts and prevents duplicates

/**
 * Check if a spread indicates a premium opportunity for shorting
 */
export async function evaluatePremiumSignal(spread: PairSpread): Promise<PremiumShortSignal> {
  const reasons: string[] = [];
  let shouldShort = false;

  // Default response - always include token info for tracking
  const defaultResponse: PremiumShortSignal = {
    shouldShort: false,
    ticker: spread.stockTicker,
    flashSymbol: null,
    tokenSymbol: spread.tokenA.symbol,  // Track which token we evaluated
    tokenMint: spread.tokenA.mint,      // Mint for precise matching
    premiumPct: 0,
    stockPrice: spread.stockPrice || 0,
    tokenPrice: spread.tokenA.price,
    suggestedCollateralUsd: 0,
    leverage: getShortLeverage(spread.stockTicker),
    reasons,
  };

  // Check 0: Is shorting enabled?
  if (!isShortingEnabled()) {
    return defaultResponse;
  }

  // Check 1: Is Flash Trade available?
  if (!isFlashTradeAvailable()) {
    reasons.push('❌ Flash Trade not initialized');
    return { ...defaultResponse, reasons };
  }

  // Check 2: Does this ticker have a Flash Trade market?
  if (!hasFlashMarket(spread.stockTicker)) {
    // Silently skip - most tokens won't have Flash markets
    return defaultResponse;
  }

  const flashSymbol = getFlashSymbol(spread.stockTicker);
  if (!flashSymbol) {
    return defaultResponse;
  }

  // Check 3: Is the equity market open?
  if (!isEquityMarketOpen()) {
    reasons.push('❌ Equity market closed');
    return { ...defaultResponse, flashSymbol, reasons };
  }

  // Check 3a: Is today a market holiday?
  const holidayStatus = await getMarketHolidayStatus();
  if (holidayStatus.isHoliday) {
    if (holidayStatus.isEarlyClose) {
      reasons.push(`⚠️ Early close today: ${holidayStatus.eventName} (${holidayStatus.tradingHours})`);
      // Don't block but warn - user should be cautious
    } else {
      reasons.push(`❌ Market holiday: ${holidayStatus.eventName}`);
      return { ...defaultResponse, flashSymbol, reasons };
    }
  }

  // Check 3b: Don't open shorts too close to market close (risk of being stuck)
  const closeBlockResult = isNearMarketClose();
  if (closeBlockResult.blocked) {
    reasons.push(`❌ ${closeBlockResult.reason}`);
    return { ...defaultResponse, flashSymbol, reasons };
  }

  // Check 4: Do we have stock price?
  if (!spread.stockPrice || spread.stockPrice <= 0) {
    reasons.push('❌ No stock price available');
    return { ...defaultResponse, flashSymbol, reasons };
  }

  // Get the discount (negative = premium)
  const discountPct = spread.tokenA.discountVsStock ?? 0;
  const premiumPct = discountPct; // Keep as negative for premium

  // Get dynamic entry threshold for this symbol
  const entryThreshold = getShortEntryThreshold(spread.stockTicker);

  reasons.push(`📊 ${spread.stockTicker} premium: ${(-premiumPct).toFixed(2)}% (threshold: ${(-entryThreshold).toFixed(2)}%)`);

  // Check 5: Is token at sufficient premium?
  if (premiumPct > entryThreshold) {
    // Not at premium (or not enough premium)
    reasons.push(`❌ Premium ${(-premiumPct).toFixed(2)}% < threshold ${(-entryThreshold).toFixed(2)}%`);
    return { ...defaultResponse, flashSymbol, premiumPct, reasons };
  }

  // Check 5b: Don't enter if premium is already at exit threshold (would immediately trigger exit)
  // This prevents loops where stale data shows entry premium but current premium is already collapsed
  const exitThreshold = getShortExitThreshold(spread.stockTicker);
  if (premiumPct >= exitThreshold) {
    reasons.push(`❌ Premium ${(-premiumPct).toFixed(2)}% already at exit threshold ${(-exitThreshold).toFixed(2)}%`);
    return { ...defaultResponse, flashSymbol, premiumPct, reasons };
  }

  // Check 5c: Cooldown check - prevent rapid re-entry after closing a position
  if (isInShortEntryCooldown(spread.stockTicker)) {
    reasons.push(`❌ In cooldown after recent position close (${SHORT_ENTRY_COOLDOWN_MS / 1000}s)`);
    return { ...defaultResponse, flashSymbol, premiumPct, reasons };
  }

  // Token is at premium - check for existing position in database
  const db = getDatabase();
  if (await db.hasOpenShortPosition(spread.stockTicker)) {
    reasons.push('❌ Already have open short position');
    return { ...defaultResponse, flashSymbol, premiumPct, reasons };
  }

  // All checks passed - signal to short
  shouldShort = true;
  reasons.push(`✓ Premium ${(-premiumPct).toFixed(2)}% >= threshold ${(-entryThreshold).toFixed(2)}%`);
  reasons.push(`✓ Flash market: ${flashSymbol}`);

  // Calculate position size (conservative for now)
  const config = getConfigSync();
  const suggestedCollateralUsd = Math.min(config.maxUsdPerTrade, 20); // Max $20 collateral

  const leverage = getShortLeverage(spread.stockTicker);

  signalLogger.info({
    ticker: spread.stockTicker,
    flashSymbol,
    tokenSymbol: spread.tokenA.symbol,
    premiumPct: premiumPct.toFixed(2),
    stockPrice: spread.stockPrice,
    tokenPrice: spread.tokenA.price,
    suggestedCollateralUsd,
    leverage,
  }, '✓ Premium SHORT signal detected');

  return {
    shouldShort,
    ticker: spread.stockTicker,
    flashSymbol,
    tokenSymbol: spread.tokenA.symbol,
    tokenMint: spread.tokenA.mint,
    premiumPct,
    stockPrice: spread.stockPrice,
    tokenPrice: spread.tokenA.price,
    suggestedCollateralUsd,
    leverage,
    reasons,
  };
}

/**
 * Check if an open short position should be closed
 */
export function checkShortExit(position: ShortPosition, currentSpread: PairSpread): {
  shouldExit: boolean;
  reason: ShortPosition['exitReason'];
  currentPremiumPct: number;
} {
  const currentDiscount = currentSpread.tokenA.discountVsStock ?? 0;
  const currentPremiumPct = currentDiscount;

  // Get dynamic thresholds for this symbol
  const exitThreshold = getShortExitThreshold(position.ticker);
  const stopLossThreshold = getShortStopLossThreshold(position.ticker);

  // 1. Profit target: premium collapsed
  if (currentPremiumPct >= exitThreshold) {
    signalLogger.info({
      ticker: position.ticker,
      entryPremium: position.entryPremiumPct.toFixed(2),
      currentPremium: currentPremiumPct.toFixed(2),
      exitThreshold: exitThreshold.toFixed(2),
    }, 'Short profit target reached - premium collapsed');
    return { shouldExit: true, reason: 'profit_target', currentPremiumPct };
  }

  // 2. Stop-loss: premium expanded further
  if (currentPremiumPct <= stopLossThreshold) {
    signalLogger.warn({
      ticker: position.ticker,
      entryPremium: position.entryPremiumPct.toFixed(2),
      currentPremium: currentPremiumPct.toFixed(2),
      stopLossThreshold: stopLossThreshold.toFixed(2),
    }, 'Short stop-loss triggered - premium expanded');
    return { shouldExit: true, reason: 'stop_loss', currentPremiumPct };
  }

  // 3. Max hold time (24 hours)
  const holdTimeMs = Date.now() - position.entryTimestamp;
  const maxHoldTimeMs = 24 * 60 * 60 * 1000;
  if (holdTimeMs > maxHoldTimeMs) {
    signalLogger.info({
      ticker: position.ticker,
      holdTimeHours: (holdTimeMs / (60 * 60 * 1000)).toFixed(1),
    }, 'Short max hold time reached');
    return { shouldExit: true, reason: 'max_hold_time', currentPremiumPct };
  }

  // 4. Friday pre-close: exit 30 mins before market close to avoid weekend gap
  if (isFridayPreClose()) {
    signalLogger.info({
      ticker: position.ticker,
      currentPremium: currentPremiumPct.toFixed(2),
    }, 'Friday pre-close exit - avoiding weekend gap risk');
    return { shouldExit: true, reason: 'weekend_close', currentPremiumPct };
  }

  return { shouldExit: false, reason: undefined, currentPremiumPct };
}

/**
 * Check if we're in the Friday pre-close window (30 mins before market close)
 * Market closes at 8 PM ET on Friday, so exit at 7:30 PM ET
 */
function isFridayPreClose(): boolean {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  // Convert to ET (UTC-5 for EST, simplified)
  const etHour = (utcHour - 5 + 24) % 24;
  const etDay = utcHour < 5 ? (utcDay - 1 + 7) % 7 : utcDay;

  // Friday = 5 in JS Date
  if (etDay !== 5) {
    return false;
  }

  // Exit window: 7:30 PM ET onwards (30 mins before 8 PM close)
  const FRIDAY_EXIT_HOUR = 19;
  const FRIDAY_EXIT_MINUTE = 30;

  if (etHour > FRIDAY_EXIT_HOUR) {
    return true;
  }
  if (etHour === FRIDAY_EXIT_HOUR && utcMinute >= FRIDAY_EXIT_MINUTE) {
    return true;
  }

  return false;
}

/**
 * Get all open short positions from database
 */
export async function getOpenShortPositions(): Promise<ShortPosition[]> {
  const db = getDatabase();
  return db.getOpenShortPositions();
}

/**
 * Get closed short positions (most recent first) from database
 */
export async function getClosedShortPositions(limit: number = 10): Promise<ShortPosition[]> {
  const db = getDatabase();
  return await db.getClosedShortPositions(limit);
}

/**
 * Save a short position to database
 */
export function saveShortPosition(position: ShortPosition): void {
  const db = getDatabase();
  db.saveShortPosition(position);
}

/**
 * Get premium thresholds for a specific ticker (for dashboard display)
 * If no ticker provided, returns base thresholds
 */
export function getPremiumThresholds(ticker?: string) {
  const entryPct = ticker ? getShortEntryThreshold(ticker) : -BASE_SHORT_THRESHOLD_PCT;
  const exitPct = ticker ? getShortExitThreshold(ticker) : entryPct * EXIT_THRESHOLD_RATIO;
  const stopLossPct = ticker ? getShortStopLossThreshold(ticker) : entryPct * STOP_LOSS_RATIO;
  const leverage = ticker ? getShortLeverage(ticker) : MIN_LEVERAGE;

  return {
    entryPct,
    exitPct,
    stopLossPct,
    defaultLeverage: leverage,
    maxLeverage: MAX_LEVERAGE,
  };
}

/**
 * Get all symbol threshold multipliers (for dashboard display)
 */
export function getSymbolThresholdMultipliers(): Record<string, number> {
  return { ...SYMBOL_THRESHOLD_MULTIPLIERS };
}

/**
 * Get all symbol leverage settings (for dashboard display)
 * Derived from threshold multipliers - not a separate config
 */
export function getSymbolLeverageSettings(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [ticker, multiplier] of Object.entries(SYMBOL_THRESHOLD_MULTIPLIERS)) {
    const scale = (MAX_LEVERAGE - MIN_LEVERAGE) / 1.0;
    const leverage = MAX_LEVERAGE - (multiplier - 1.0) * scale;
    result[ticker] = Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE, leverage));
  }
  return result;
}

/**
 * Get the base threshold percentage (before multiplier)
 */
export function getBaseShortThreshold(): number {
  return BASE_SHORT_THRESHOLD_PCT;
}
