/**
 * Predict Orchestrator
 * Separate trading loop for prediction market information arbitrage
 * Completely isolated from RWA arbitrage logic
 */

import { 
  getNearTermMarkets, 
  getMarketByTicker, 
  classifyMarket,
  isMarketTradeable 
} from '../dflow/client';
import { 
  executePredictTrade, 
  calculateSettledPnL,
  isPaperMode 
} from '../dflow/executor';
import { PredictPosition, PredictOpportunity } from '../dflow/types';
import { scanForOpportunities, getSupportedCategories } from '../resolvers';
import { 
  savePredictPosition, 
  getOpenPredictPositions, 
  updatePredictPosition,
  getPredictStats 
} from './database';
import logger from '../logger';

// Configuration constants
const PREDICT_CONFIG = {
  // Loop timing
  SCAN_INTERVAL_MS: 60_000,           // Scan every 60 seconds
  SETTLEMENT_CHECK_INTERVAL_MS: 300_000, // Check settlements every 5 min
  
  // Risk limits
  MAX_POSITION_USD: 2,                // Max $2 per position (live testing cap)
  MAX_OPEN_POSITIONS: 10,             // Max concurrent positions
  MAX_DAILY_LOSS_USD: 10,             // Daily loss limit
  
  // Entry criteria
  MIN_EDGE_PCT: 0.20,                // Minimum 20% edge (was 8% — too many low-quality trades)
  MIN_CONFIDENCE: 0.75,              // Minimum 75% data confidence
  MIN_MARKET_PRICE: 0.03,            // Minimum 3¢ market price (1¢ = no liquidity, fake edge)
  MIN_HOURS_TO_EXPIRY: 0.5,           // At least 30 min to expiry
  MAX_HOURS_TO_EXPIRY: 24,             // Only markets settling within 24h
  
  // Sizing
  BASE_SIZE_USD: 2,                   // Base position size ($2 cap)
  KELLY_FRACTION: 0.25,               // Use 25% of Kelly optimal
};

export class PredictOrchestrator {
  private running: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private settlementInterval: NodeJS.Timeout | null = null;
  
  // Tracking
  private dailyPnL: number = 0;
  private dailyTradeCount: number = 0;
  private lastDayReset: number = 0;
  
  // Locks
  private scanning: boolean = false;
  private checkingSettlements: boolean = false;
  
  // Failed markets cache (don't retry for 1 hour)
  private failedMarkets: Map<string, number> = new Map();

  constructor() {
    logger.info('PredictOrchestrator initialized');
  }

  /**
   * Start the predict trading loop
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('PredictOrchestrator already running');
      return;
    }

    this.running = true;
    this.resetDailyStats();

    logger.info({
      mode: isPaperMode() ? 'paper' : 'live',
      categories: getSupportedCategories(),
      config: PREDICT_CONFIG,
    }, '🔮 PredictOrchestrator started');

    // Initial scan
    await this.runScanLoop();
    await this.runSettlementCheck();

    // Set up intervals
    this.scanInterval = setInterval(
      () => this.runScanLoop(),
      PREDICT_CONFIG.SCAN_INTERVAL_MS
    );

    this.settlementInterval = setInterval(
      () => this.runSettlementCheck(),
      PREDICT_CONFIG.SETTLEMENT_CHECK_INTERVAL_MS
    );
  }

  /**
   * Stop the predict trading loop
   */
  stop(): void {
    this.running = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    if (this.settlementInterval) {
      clearInterval(this.settlementInterval);
      this.settlementInterval = null;
    }

    logger.info('PredictOrchestrator stopped');
  }

  /**
   * Reset daily statistics at midnight UTC
   */
  private resetDailyStats(): void {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    
    if (todayStart > this.lastDayReset) {
      this.dailyPnL = 0;
      this.dailyTradeCount = 0;
      this.lastDayReset = todayStart;
      logger.info('Daily predict stats reset');
    }
  }

  /**
   * Check if we can take new positions
   */
  private async canTrade(): Promise<{ allowed: boolean; reason?: string }> {
    // Check daily loss limit
    if (this.dailyPnL <= -PREDICT_CONFIG.MAX_DAILY_LOSS_USD) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }

    // Check open positions
    const openPositions = await getOpenPredictPositions();
    if (openPositions.length >= PREDICT_CONFIG.MAX_OPEN_POSITIONS) {
      return { allowed: false, reason: `Max open positions (${PREDICT_CONFIG.MAX_OPEN_POSITIONS})` };
    }

    return { allowed: true };
  }

  /**
   * Main scan loop - find and execute opportunities
   */
  private async runScanLoop(): Promise<void> {
    if (!this.running || this.scanning) return;
    this.scanning = true;

    try {
      this.resetDailyStats();

      // Check if we can trade
      const { allowed, reason } = await this.canTrade();
      if (!allowed) {
        logger.debug({ reason }, 'Skipping scan - trading not allowed');
        return;
      }

      // Fetch near-term markets
      const markets = await getNearTermMarkets(PREDICT_CONFIG.MAX_HOURS_TO_EXPIRY);
      
      // Filter to tradeable markets in supported categories
      const tradeableMarkets = markets.filter(m => {
        const category = classifyMarket(m);
        return (
          getSupportedCategories().includes(category) &&
          isMarketTradeable(m) &&
          m.expirationTime * 1000 - Date.now() > PREDICT_CONFIG.MIN_HOURS_TO_EXPIRY * 60 * 60 * 1000
        );
      });

      if (tradeableMarkets.length === 0) {
        logger.info('No tradeable markets found in supported categories');
        return;
      }

      logger.info({ count: tradeableMarkets.length }, 'Scanning markets for opportunities');

      // Scan for opportunities
      const opportunities = await scanForOpportunities(
        tradeableMarkets,
        PREDICT_CONFIG.MIN_EDGE_PCT,
        PREDICT_CONFIG.MIN_CONFIDENCE,
        PREDICT_CONFIG.MIN_MARKET_PRICE
      );

      if (opportunities.length === 0) {
        logger.info({ markets: tradeableMarkets.length }, 'Scan complete - no opportunities above thresholds');
        return;
      }

      logger.info({ count: opportunities.length }, 'Found predict opportunities');

      // Check for duplicate positions
      const openPositions = await getOpenPredictPositions();
      const openTickers = new Set(openPositions.map(p => p.marketTicker));

      // Execute best opportunities
      for (const opp of opportunities) {
        // Skip if we already have a position in this market
        if (openTickers.has(opp.market.ticker)) {
          logger.debug({ ticker: opp.market.ticker }, 'Already have position in market');
          continue;
        }

        // Skip if market previously failed (retry after 1 hour)
        const failedAt = this.failedMarkets.get(opp.market.ticker);
        if (failedAt && Date.now() - failedAt < 3600_000) {
          continue;
        }

        // Calculate size using fractional Kelly
        const size = Math.min(
          PREDICT_CONFIG.MAX_POSITION_USD,
          Math.max(
            PREDICT_CONFIG.BASE_SIZE_USD,
            opp.kellyFraction * PREDICT_CONFIG.KELLY_FRACTION * 100
          )
        );

        await this.executeOpportunity(opp, size);

        // Only one entry per loop to be conservative
        break;
      }
    } catch (e) {
      logger.error({ error: e }, 'Error in predict scan loop');
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Execute a predict opportunity
   */
  private async executeOpportunity(opp: PredictOpportunity, sizeUsd: number): Promise<void> {
    logger.info({
      ticker: opp.market.ticker,
      outcome: opp.outcome,
      size: sizeUsd,
      edge: (opp.edgePct * 100).toFixed(1) + '%',
      confidence: (opp.dataConfidence * 100).toFixed(0) + '%',
      price: (opp.marketPrice * 100).toFixed(1) + '¢',
      reasons: opp.reasons,
    }, '🎯 Executing predict opportunity');

    try {
      const { position, result } = await executePredictTrade(
        opp.market,
        opp.outcome,
        sizeUsd,
        opp.dataSource,
        opp.dataValue,
        opp.dataConfidence
      );

      if (result.success) {
        // Save to database
        await savePredictPosition(position);
        this.dailyTradeCount++;

        logger.info({
          id: position.id,
          ticker: position.marketTicker,
          outcome: position.outcome,
          size: position.sizeUsd,
          tokens: position.tokensHeld,
          tx: position.entryTxSignature,
        }, '✅ Predict position opened');
      } else {
        logger.warn({ ticker: opp.market.ticker, err: result.error }, 'Failed to execute predict trade - blacklisting for 1h');
        this.failedMarkets.set(opp.market.ticker, Date.now());
      }
    } catch (e) {
      logger.error({ ticker: opp.market.ticker, err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, 'Exception executing predict opportunity');
      this.failedMarkets.set(opp.market.ticker, Date.now());
    }
  }

  /**
   * Check for settled markets and update positions
   */
  private async runSettlementCheck(): Promise<void> {
    if (!this.running || this.checkingSettlements) return;
    this.checkingSettlements = true;

    try {
      const openPositions = await getOpenPredictPositions();
      if (openPositions.length === 0) return;

      logger.debug({ count: openPositions.length }, 'Checking settlements');

      for (const position of openPositions) {
        const now = Date.now();

        // Always fetch market state — DFlow may finalize before our stored expiration
        const market = await getMarketByTicker(position.marketTicker);
        if (!market) {
          logger.warn({ ticker: position.marketTicker }, 'Could not fetch market for settlement');
          continue;
        }

        // Check if settled
        if (market.result && (market.result === 'yes' || market.result === 'no')) {
          await this.settlePosition(position, market.result as 'yes' | 'no');
        } else if (now - position.expirationTime > 24 * 60 * 60 * 1000) {
          // Expired more than 24h ago without settlement - mark as expired
          logger.warn({ ticker: position.marketTicker }, 'Market expired without settlement');
          await updatePredictPosition(position.id, {
            status: 'expired',
            updatedAt: now,
          });
        }
      }
    } catch (e) {
      logger.error({ error: e }, 'Error in settlement check');
    } finally {
      this.checkingSettlements = false;
    }
  }

  /**
   * Settle a position based on market result
   */
  private async settlePosition(position: PredictPosition, result: 'yes' | 'no'): Promise<void> {
    const { pnlUsd, pnlPct, result: winLoss } = calculateSettledPnL(position, result);

    await updatePredictPosition(position.id, {
      status: 'settled',
      settlementResult: winLoss,
      pnlUsd,
      pnlPct,
      exitTimestamp: Date.now(),
      updatedAt: Date.now(),
    });

    this.dailyPnL += pnlUsd;

    const emoji = winLoss === 'win' ? '🎉' : '💸';
    logger.info({
      id: position.id,
      ticker: position.marketTicker,
      outcome: position.outcome,
      marketResult: result,
      result: winLoss,
      pnlUsd: pnlUsd.toFixed(2),
      pnlPct: pnlPct.toFixed(1) + '%',
    }, `${emoji} Predict position settled`);
  }

  /**
   * Get current stats
   */
  async getStats(): Promise<{
    running: boolean;
    mode: string;
    openPositions: number;
    dailyPnL: number;
    dailyTrades: number;
    totalStats: Awaited<ReturnType<typeof getPredictStats>>;
  }> {
    const openPositions = await getOpenPredictPositions();
    const totalStats = await getPredictStats();

    return {
      running: this.running,
      mode: isPaperMode() ? 'paper' : 'live',
      openPositions: openPositions.length,
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTradeCount,
      totalStats,
    };
  }

  /**
   * Get open positions
   */
  async getOpenPositions(): Promise<PredictPosition[]> {
    return getOpenPredictPositions();
  }

  /**
   * Force a scan (for manual trigger)
   */
  async forceScan(): Promise<PredictOpportunity[]> {
    const markets = await getNearTermMarkets(PREDICT_CONFIG.MAX_HOURS_TO_EXPIRY);
    const tradeableMarkets = markets.filter(m => {
      const category = classifyMarket(m);
      return getSupportedCategories().includes(category) && isMarketTradeable(m);
    });

    return scanForOpportunities(
      tradeableMarkets,
      PREDICT_CONFIG.MIN_EDGE_PCT,
      PREDICT_CONFIG.MIN_CONFIDENCE,
      PREDICT_CONFIG.MIN_MARKET_PRICE
    );
  }
}

// Singleton instance
let predictOrchestrator: PredictOrchestrator | null = null;

export function getPredictOrchestrator(): PredictOrchestrator {
  if (!predictOrchestrator) {
    predictOrchestrator = new PredictOrchestrator();
  }
  return predictOrchestrator;
}
