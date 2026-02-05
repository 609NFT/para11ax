/**
 * Risk Manager
 *
 * FAIL-SAFES (MANDATORY):
 * - Global kill switch
 * - Per-token disable switch
 * - Auto-disable on consecutive failures
 * - Auto-disable on price feed staleness
 * - Manual override supported
 */

import { RiskState } from '../types';
import { riskLogger } from '../logger';
import { getConfigSync } from '../config';

export class RiskManager {
  private state: RiskState;

  // Daily tracking (resets at midnight UTC)
  private dailyResetDate: string = '';

  constructor() {
    this.state = {
      globalKillSwitch: false,
      disabledTokens: new Set(),
      consecutiveFailures: new Map(),
      lastPriceFeedTimestamp: new Map(),
      dailyLossUsd: 0,
      dailyTradeCount: 0,
    };

    riskLogger.info('RiskManager initialized');
  }

  /**
   * GLOBAL KILL SWITCH
   * Immediately stops all trading activity
   */
  activateKillSwitch(reason: string): void {
    this.state.globalKillSwitch = true;
    riskLogger.error({ reason }, '🚨 GLOBAL KILL SWITCH ACTIVATED');
  }

  /**
   * Deactivate kill switch (requires manual confirmation)
   */
  deactivateKillSwitch(): void {
    this.state.globalKillSwitch = false;
    riskLogger.warn('Kill switch deactivated - trading resumed');
  }

  /**
   * Check if kill switch is active
   */
  isKillSwitchActive(): boolean {
    return this.state.globalKillSwitch;
  }

  /**
   * Disable trading for a specific token
   */
  disableToken(symbol: string, reason: string): void {
    this.state.disabledTokens.add(symbol);
    riskLogger.warn({ symbol, reason }, 'Token trading disabled');
  }

  /**
   * Re-enable trading for a specific token
   */
  enableToken(symbol: string): void {
    this.state.disabledTokens.delete(symbol);
    this.state.consecutiveFailures.set(symbol, 0);
    riskLogger.info({ symbol }, 'Token trading re-enabled');
  }

  /**
   * Check if a token is disabled
   */
  isTokenDisabled(symbol: string): boolean {
    return this.state.disabledTokens.has(symbol);
  }

  /**
   * Record a trade failure
   */
  recordFailure(symbol: string, error: string): void {
    const config = getConfigSync();
    const failures = (this.state.consecutiveFailures.get(symbol) || 0) + 1;
    this.state.consecutiveFailures.set(symbol, failures);

    riskLogger.warn({
      symbol,
      failures,
      maxFailures: config.maxConsecutiveFailures,
      error,
    }, 'Trade failure recorded');

    // Auto-disable after consecutive failures
    if (failures >= config.maxConsecutiveFailures) {
      this.disableToken(symbol, `Auto-disabled after ${failures} consecutive failures`);
    }
  }

  /**
   * Record a successful trade (resets failure counter)
   */
  recordSuccess(symbol: string): void {
    this.checkDailyReset();
    this.state.consecutiveFailures.set(symbol, 0);
    this.state.dailyTradeCount++;
  }

  /**
   * Update price feed timestamp
   */
  updatePriceFeed(symbol: string, timestamp: number): void {
    this.state.lastPriceFeedTimestamp.set(symbol, timestamp);
  }

  /**
   * Check if price feed is stale
   */
  isPriceFeedStale(symbol: string): boolean {
    const config = getConfigSync();
    const lastUpdate = this.state.lastPriceFeedTimestamp.get(symbol);

    if (!lastUpdate) return true;

    return Date.now() - lastUpdate > config.priceStalenessMs;
  }

  /**
   * Get market session type
   * Returns: 'pre-market', 'regular', 'post-market', or 'closed'
   *
   * Market hours (all times ET):
   * - Pre-market: 4:00 AM - 9:30 AM
   * - Regular: 9:30 AM - 4:00 PM
   * - Post-market: 4:00 PM - 8:00 PM
   * - Closed: 8:00 PM - 4:00 AM (and weekends)
   */
  getMarketSession(): 'pre-market' | 'regular' | 'post-market' | 'closed' {
    const now = new Date();

    // Convert to ET (Eastern Time)
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    const day = etTime.getDay();
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    // Time boundaries in minutes from midnight
    const preMarketOpen = 4 * 60;      // 4:00 AM
    const regularOpen = 9 * 60 + 30;   // 9:30 AM
    const regularClose = 16 * 60;       // 4:00 PM
    const postMarketClose = 20 * 60;   // 8:00 PM

    // Weekend check (0 = Sunday, 6 = Saturday)
    if (day === 0 || day === 6) {
      return 'closed';
    }

    // Determine session based on time
    if (timeInMinutes >= preMarketOpen && timeInMinutes < regularOpen) {
      return 'pre-market';
    } else if (timeInMinutes >= regularOpen && timeInMinutes < regularClose) {
      return 'regular';
    } else if (timeInMinutes >= regularClose && timeInMinutes < postMarketClose) {
      return 'post-market';
    } else {
      return 'closed';
    }
  }

  /**
   * Check if US stock market is open (regular hours only)
   * Regular hours: 9:30 AM - 4:00 PM ET (Mon-Fri)
   */
  isMarketOpen(): boolean {
    return this.getMarketSession() === 'regular';
  }

  /**
   * Check if any trading session is active (including pre/post market)
   */
  isAnySessionActive(): boolean {
    const session = this.getMarketSession();
    return session === 'pre-market' || session === 'regular' || session === 'post-market';
  }

  /**
   * Check if we can open a new position
   */
  canOpenPosition(symbol: string): { allowed: boolean; reason: string } {
    // Check market hours first
    if (!this.isMarketOpen()) {
      return { allowed: false, reason: 'Market is closed' };
    }

    // Check global kill switch
    if (this.state.globalKillSwitch) {
      return { allowed: false, reason: 'Global kill switch is active' };
    }

    // Check token-specific disable
    if (this.state.disabledTokens.has(symbol)) {
      return { allowed: false, reason: 'Token is disabled' };
    }

    // Check price feed staleness
    if (this.isPriceFeedStale(symbol)) {
      return { allowed: false, reason: 'Price feed is stale' };
    }

    // Check daily limits
    const config = getConfigSync();
    if (this.state.dailyTradeCount >= config.maxDailyTrades) {
      return { allowed: false, reason: 'Daily trade limit reached' };
    }

    if (this.state.dailyLossUsd >= config.maxDailyLossUsd) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }

    return { allowed: true, reason: 'All checks passed' };
  }

  /**
   * Record realized PnL
   */
  recordPnL(pnlUsd: number): void {
    this.checkDailyReset();

    if (pnlUsd < 0) {
      this.state.dailyLossUsd += Math.abs(pnlUsd);
    }

    const config = getConfigSync();
    if (this.state.dailyLossUsd >= config.maxDailyLossUsd) {
      this.activateKillSwitch('Daily loss limit reached');
    }
  }

  /**
   * Get full risk state for dashboard
   */
  getState(): RiskState {
    this.checkDailyReset();
    return { ...this.state };
  }

  /**
   * Get summary for logging/display
   */
  getSummary(): {
    killSwitch: boolean;
    disabledTokens: string[];
    dailyLoss: number;
    dailyTrades: number;
  } {
    this.checkDailyReset();
    return {
      killSwitch: this.state.globalKillSwitch,
      disabledTokens: Array.from(this.state.disabledTokens),
      dailyLoss: this.state.dailyLossUsd,
      dailyTrades: this.state.dailyTradeCount,
    };
  }

  /**
   * Reset daily counters at midnight UTC
   */
  private checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.dailyResetDate) {
      this.dailyResetDate = today;
      this.state.dailyLossUsd = 0;
      this.state.dailyTradeCount = 0;
      riskLogger.info({ date: today }, 'Daily counters reset');
    }
  }

  /**
   * Pre-trade validation
   * Returns list of all risk checks and their status
   */
  validateTrade(symbol: string, sizeUsd: number): {
    valid: boolean;
    checks: Array<{ name: string; passed: boolean; message: string }>;
  } {
    const checks: Array<{ name: string; passed: boolean; message: string }> = [];
    const config = getConfigSync();

    // Kill switch
    checks.push({
      name: 'Kill Switch',
      passed: !this.state.globalKillSwitch,
      message: this.state.globalKillSwitch ? 'Kill switch is active' : 'OK',
    });

    // Token enabled
    checks.push({
      name: 'Token Enabled',
      passed: !this.state.disabledTokens.has(symbol),
      message: this.state.disabledTokens.has(symbol) ? 'Token is disabled' : 'OK',
    });

    // Price feed
    checks.push({
      name: 'Price Feed',
      passed: !this.isPriceFeedStale(symbol),
      message: this.isPriceFeedStale(symbol) ? 'Price feed is stale' : 'OK',
    });

    // Daily trades
    checks.push({
      name: 'Daily Trade Limit',
      passed: this.state.dailyTradeCount < config.maxDailyTrades,
      message: `${this.state.dailyTradeCount}/${config.maxDailyTrades} trades`,
    });

    // Daily loss
    checks.push({
      name: 'Daily Loss Limit',
      passed: this.state.dailyLossUsd < config.maxDailyLossUsd,
      message: `$${this.state.dailyLossUsd.toFixed(2)}/$${config.maxDailyLossUsd} loss`,
    });

    // Position size
    checks.push({
      name: 'Position Size',
      passed: sizeUsd <= config.maxUsdPerTrade,
      message: `$${sizeUsd.toFixed(2)} <= $${config.maxUsdPerTrade}`,
    });

    const valid = checks.every(c => c.passed);

    return { valid, checks };
  }
}

// Singleton
let riskManagerInstance: RiskManager | null = null;

export function getRiskManager(): RiskManager {
  if (!riskManagerInstance) {
    riskManagerInstance = new RiskManager();
  }
  return riskManagerInstance;
}
