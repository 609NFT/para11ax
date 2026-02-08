/**
 * Main Orchestrator
 * Coordinates all system components for mean reversion trading
 *
 * Strategy: Buy tokens when trading at discount vs stock price,
 * sell when discount normalizes to fair value
 */

import { getConfig, getConfigSync, getModeDescription, validateLiveReadiness } from './config';
import { getFeedAggregator } from './feeds';
import {
  getMeanReversionSignalGenerator,
  evaluatePremiumSignal,
  checkShortExit,
  getOpenShortPositions,
  saveShortPosition,
  updatePremiumWatchlist,
  setShortEntryCooldown,
  type PremiumShortSignal,
  type ShortPosition,
} from './signals';
import { getRiskManager } from './risk';
import { getJupiterClient, getExecutor } from './execution';
import {
  isShortingEnabled,
  initializeFlashClient,
  openPerpPosition,
  closePerpPosition,
  getOpenPerpPositions,
  getTickerFromFlashSymbol,
  isFlashTradeAvailable,
  getOraclePrice,
  getFlashInitState,
} from './execution/flashTradeClient';
import { getDatabase } from './db';
import { initializeShortThresholds } from './signals/shortThresholdCalc';
import { initPortfolioSizer } from './signals/portfolioSizer';
import { initializeEMRT, refreshEMRTCache } from './signals/emrt';
import { pruneOldDiscountHistory, upsertHeatmapSummary, getHourlySummaryFromSupabase } from './db/supabaseClient';
import { Dashboard } from './dashboard';
import logger, { executionLogger, dbLogger } from './logger';
import { MeanReversionPosition, MeanReversionSignal, PairSpread, TradeResult } from './types';
import { refreshLiquidity, maybeRefreshLiquidity, getAllThresholds, getSwapRouting } from './liquidity/liquidityChecker';
import {
  USDC_MINT,
  SOL_MINT,
  MIN_API_INTERVAL_MS,
  LOOP_INTERVAL_MS,
  CLEANUP_SLIPPAGE_BPS,
  ORPHAN_CLEANUP_DELAY_MS,
  EXIT_SLIPPAGE_ESCALATION_BPS,
  MAX_SLIPPAGE_BPS,
  getEstimatedFeesPct,
  MIN_ORPHAN_VALUE_USD,
  MIN_SELLABLE_VALUE_USD,
  getSolPriceUsd,
} from './constants';
import { startWebServer, stopWebServer } from './web/server';
import { prewarmInternalVolatility, refreshNextVolatility } from './feeds/volatilityFeed';
import { notifyEntry, notifyExit, notifyStartup, notifyCircuitBreaker, notifyShortEntry, notifyShortExit } from './notifications/discord';
import { scanCrossDexOpportunities } from './signals/crossDexMonitor';

export class Orchestrator {
  private running: boolean = false;
  private loopInterval: NodeJS.Timeout | null = null;
  private dashboard: Dashboard;

  // Component references
  private feedAggregator = getFeedAggregator();
  private signalGenerator!: ReturnType<typeof getMeanReversionSignalGenerator>;
  private riskManager = getRiskManager();
  private jupiterClient = getJupiterClient();
  private executor = getExecutor();
  private database = getDatabase();

  // Execution locks to prevent duplicate trades
  private executingEntries: Set<string> = new Set();
  private executingExits: Set<string> = new Set();
  private executingShortEntries: Set<string> = new Set();
  private executingShortExits: Set<string> = new Set();

  // Track recently closed short positions to prevent double-close race condition
  // (Supabase write queue can lag behind, causing getOpenShortPositions to return stale data)
  private recentlyClosedShorts: Map<string, number> = new Map(); // positionId -> closeTime

  // Loop-level mutex to prevent concurrent trading loop execution
  private loopRunning: boolean = false;

  // Last API call timestamp for throttling
  private lastApiCall: number = 0;
  private readonly minApiIntervalMs = MIN_API_INTERVAL_MS;

  // Circuit breaker: stop bot after consecutive losing trades
  // Requires BOTH conditions: 10 consecutive losses AND > $1 cumulative loss
  private consecutiveLosses: number = 0;
  private consecutiveLossAmount: number = 0;  // Track cumulative loss amount
  private readonly maxConsecutiveLosses: number = 10;
  private readonly minLossAmountForTrip: number = 1.0;  // Must lose > $1 total
  private circuitBreakerTripped: boolean = false;

  // SOL auto-topup settings
  private readonly minSolBalance: number = 0.05;  // Minimum SOL before topping up
  private readonly solTopupAmountUsd: number = 10; // USDC to swap to SOL
  private lastSolTopupTime: number = 0;
  private readonly solTopupCooldownMs: number = 60000; // 1 minute cooldown between topups

  // SOL auto-rebalance settings (swap excess SOL back to USDC)
  private readonly maxSolBalance: number = 0.25;  // Max SOL before rebalancing to USDC
  private lastSolRebalanceTime: number = 0;
  private readonly solRebalanceCooldownMs: number = 300000; // 5 minute cooldown
  
  // Health check settings
  private readonly healthCheckTimeoutMs: number = 30000; // 30 second timeout for health check script

  constructor() {
    this.dashboard = new Dashboard();
    logger.info('Orchestrator initialized');
  }

  /**
   * Check if circuit breaker has been tripped
   */
  isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  /**
   * Record a trade result for circuit breaker tracking
   * @param pnlUsd - The PnL of the completed trade
   */
  private recordTradeForCircuitBreaker(pnlUsd: number): void {
    if (pnlUsd < 0) {
      this.consecutiveLosses++;
      this.consecutiveLossAmount += Math.abs(pnlUsd);
      executionLogger.warn({
        consecutiveLosses: this.consecutiveLosses,
        maxAllowed: this.maxConsecutiveLosses,
        consecutiveLossAmount: this.consecutiveLossAmount.toFixed(2),
        minLossForTrip: this.minLossAmountForTrip,
        pnlUsd: pnlUsd.toFixed(4),
      }, `Losing trade recorded (${this.consecutiveLosses}/${this.maxConsecutiveLosses} consecutive, $${this.consecutiveLossAmount.toFixed(2)} total)`);

      // Trip circuit breaker only if BOTH conditions met:
      // 1. At least 10 consecutive losses
      // 2. Cumulative loss exceeds $1
      if (this.consecutiveLosses >= this.maxConsecutiveLosses && this.consecutiveLossAmount >= this.minLossAmountForTrip) {
        this.circuitBreakerTripped = true;
        executionLogger.error({
          consecutiveLosses: this.consecutiveLosses,
          consecutiveLossAmount: this.consecutiveLossAmount.toFixed(2),
        }, '🚨 CIRCUIT BREAKER TRIPPED: 10 consecutive losing trades with >$1 loss - stopping bot');

        // Log circuit breaker event for visibility
        const breakerMsg = [
          '=' + '='.repeat(58) + '=',
          '🚨 CIRCUIT BREAKER TRIPPED',
          `   ${this.consecutiveLosses} consecutive losing trades`,
          `   $${this.consecutiveLossAmount.toFixed(2)} cumulative loss`,
          '   Bot has been stopped to prevent further losses',
          '=' + '='.repeat(58) + '='
        ].join('\n');
        logger.error(breakerMsg);

        // Discord notification
        notifyCircuitBreaker(this.consecutiveLosses, this.consecutiveLossAmount).catch((err) => {
          logger.warn({ error: err }, 'Failed to send circuit breaker Discord notification');
        });

        // Stop the bot
        this.stop();
      }
    } else {
      // Winning trade resets both counters
      if (this.consecutiveLosses > 0) {
        executionLogger.info({
          previousLosses: this.consecutiveLosses,
          previousLossAmount: this.consecutiveLossAmount.toFixed(2),
          pnlUsd: pnlUsd.toFixed(4),
        }, 'Winning trade - resetting consecutive loss counter');
      }
      this.consecutiveLosses = 0;
      this.consecutiveLossAmount = 0;
    }
  }

  /**
   * Throttle API calls to prevent rate limiting
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCall;
    if (elapsed < this.minApiIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minApiIntervalMs - elapsed));
    }
    this.lastApiCall = Date.now();
  }

  /**
   * Check SOL balance and swap USDC to SOL if below minimum
   * This ensures we always have enough SOL for transaction fees
   */
  private async checkAndTopupSol(): Promise<void> {
    const config = getConfigSync();

    // Only run in live mode
    if (config.mode !== 'live' || !this.executor.isLive()) {
      return;
    }

    // Check cooldown to avoid spamming
    const now = Date.now();
    if (now - this.lastSolTopupTime < this.solTopupCooldownMs) {
      return;
    }

    try {
      const balance = await this.executor.getBalance();
      if (!balance) {
        return;
      }

      if (balance.sol < this.minSolBalance) {
        // Check if we have enough USDC
        if (balance.usdc < this.solTopupAmountUsd) {
          executionLogger.warn({
            solBalance: balance.sol.toFixed(4),
            usdcBalance: balance.usdc.toFixed(2),
            minSol: this.minSolBalance,
            topupAmount: this.solTopupAmountUsd,
          }, 'SOL balance low but not enough USDC to top up');
          return;
        }

        executionLogger.info({
          solBalance: balance.sol.toFixed(4),
          minSol: this.minSolBalance,
          topupAmountUsd: this.solTopupAmountUsd,
        }, 'SOL balance low - swapping USDC to SOL');

        // Get quote for USDC -> SOL swap
        const usdcAmountRaw = this.solTopupAmountUsd * 1e6; // USDC has 6 decimals
        const quote = await this.jupiterClient.getQuote(USDC_MINT, SOL_MINT, usdcAmountRaw, 100); // 1% slippage

        if (!quote) {
          executionLogger.error('Failed to get quote for SOL topup');
          return;
        }

        // Execute the swap
        const result = await this.executor.executeBuy(SOL_MINT, this.solTopupAmountUsd, quote);

        if (result.success) {
          const solReceived = (result.outputAmount || 0) / 1e9;
          executionLogger.info({
            usdcSpent: this.solTopupAmountUsd,
            solReceived: solReceived.toFixed(4),
            txSignature: result.txSignature,
          }, 'SOL topup successful');
          this.lastSolTopupTime = now;
        } else {
          executionLogger.error({
            error: result.error,
          }, 'SOL topup swap failed');
        }
      }
    } catch (error) {
      executionLogger.error({ error }, 'Error checking/topping up SOL balance');
    }
  }

  /**
   * Check SOL balance and swap excess SOL back to USDC if too high
   * This prevents wallet from getting SOL-heavy when trades end in SOL
   */
  private async checkAndRebalanceToUsdc(): Promise<void> {
    const config = getConfigSync();

    // Only run in live mode
    if (config.mode !== 'live' || !this.executor.isLive()) {
      return;
    }

    // Check cooldown to avoid spamming
    const now = Date.now();
    if (now - this.lastSolRebalanceTime < this.solRebalanceCooldownMs) {
      return;
    }

    try {
      const balance = await this.executor.getBalance();
      if (!balance) {
        return;
      }

      // If SOL is above max, swap excess back to USDC
      if (balance.sol > this.maxSolBalance) {
        const excessSol = balance.sol - this.minSolBalance; // Keep minSolBalance for gas
        const excessSolLamports = Math.floor(excessSol * 1e9);

        executionLogger.info({
          solBalance: balance.sol.toFixed(4),
          maxSol: this.maxSolBalance,
          excessSol: excessSol.toFixed(4),
        }, 'SOL balance high - swapping excess to USDC');

        // Get quote for SOL -> USDC swap
        const quote = await this.jupiterClient.getQuote(SOL_MINT, USDC_MINT, excessSolLamports, 100); // 1% slippage

        if (!quote) {
          executionLogger.error('Failed to get quote for SOL->USDC rebalance');
          return;
        }

        // Execute the swap using executeSell (SOL -> USDC)
        // Note: executeSell expects raw lamports for sells
        const result = await this.executor.executeSell(SOL_MINT, excessSolLamports, quote);

        if (result.success) {
          const usdcReceived = (result.outputAmount || 0) / 1e6;
          executionLogger.info({
            solSwapped: excessSol.toFixed(4),
            usdcReceived: usdcReceived.toFixed(2),
            txSignature: result.txSignature,
          }, 'SOL->USDC rebalance successful');
          this.lastSolRebalanceTime = now;
        } else {
          executionLogger.error({
            error: result.error,
          }, 'SOL->USDC rebalance swap failed');
        }
      }
    } catch (error) {
      executionLogger.error({ error }, 'Error rebalancing SOL to USDC');
    }
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    const config = await getConfig();

    // Initialize signal generator after config is loaded (so custom tokens are included)
    this.signalGenerator = getMeanReversionSignalGenerator();

    logger.info('═══════════════════════════════════════════════════════');
    logger.info('        PARALLAX - MEAN REVERSION BOT');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info(getModeDescription(config.mode));

    // Validate live mode prerequisites
    if (config.mode === 'live') {
      const readiness = validateLiveReadiness(config);
      if (!readiness.ready) {
        logger.error({ issues: readiness.issues }, 'Live trading prerequisites not met');
        throw new Error('Cannot start in live mode: ' + readiness.issues.join(', '));
      }
    }

    // Initialize database
    logger.info('Initializing database...');
    this.database.initialize();

    // Initialize feeds
    logger.info('Initializing price feeds...');
    await this.feedAggregator.initialize();

    // Verify feed health
    const feedHealth = this.feedAggregator.getHealthStatus();
    if (!feedHealth.overall) {
      logger.warn('Feed health check failed - some feeds may not be available');
    }

    // Pre-warm volatility BEFORE liquidity refresh so dynamic floors use real ATR values
    logger.info('Pre-warming volatility cache from Supabase...');
    await prewarmInternalVolatility();

    // Initialize liquidity-based thresholds with timeout protection
    logger.info('Fetching pool liquidity (with 2 minute timeout)...');
    logger.info('Fetching pool liquidity for dynamic thresholds...');
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Liquidity refresh timeout after 120s')), 120000)
      );
      await Promise.race([refreshLiquidity(), timeoutPromise]);
      logger.info('Pool liquidity refresh completed successfully');
    } catch (error) {
      logger.error({ error }, 'Pool liquidity refresh failed - using fallback thresholds');
    }

    // Log threshold summary
    const thresholds = getAllThresholds();
    const enabledCount = thresholds.filter(t => t.enabled).length;
    logger.info({ totalTokens: thresholds.length, enabledTokens: enabledCount }, 'Dynamic thresholds initialized');

    // Initialize portfolio-based position sizing
    logger.info('Initializing portfolio-based position sizing...');
    initPortfolioSizer(
      () => this.executor.getBalance(),
      () => getSolPriceUsd(),
      () => this.riskManager.getMarketSession()  // For market hours position scaling
    );
    logger.info('Portfolio sizer initialized - positions scale with wallet balance and market hours');

    // Initialize EMRT (Empirical Mean Reversion Time) for token-specific hold times
    logger.info('Initializing EMRT (token-specific hold times)...');
    await initializeEMRT();
    logger.info('EMRT initialized - hold times optimized per token based on historical reversion patterns');

    // Clean up orphan tokens (tokens in wallet with no open position)
    if (config.mode === 'live') {
      await this.cleanupOrphanTokens();
    }

    // Initialize Flash Trade for shorting (if enabled)
    if (isShortingEnabled()) {
      logger.info('Initializing Flash Trade for premium shorting...');
      const flashInitialized = await initializeFlashClient();
      if (flashInitialized) {
        logger.info('Flash Trade initialized - premium shorting enabled');

        // Compute data-driven short thresholds from on-chain fees + historical spreads
        await initializeShortThresholds();

        // Reconcile orphaned on-chain positions (positions that exist on-chain but not in DB)
        if (config.mode === 'live') {
          await this.reconcileOrphanedShortPositions();
        }
      } else {
        logger.warn('Flash Trade initialization failed - shorting disabled');
      }
    }

    // Start web dashboard server if enabled
    const webPort = parseInt(process.env.WEB_PORT || '3000');
    if (process.env.WEB_ENABLED !== 'false') {
      logger.info(`Starting web server on port ${webPort}...`);
      startWebServer(webPort);
    }

    // Prune old discount history from both SQLite and Supabase (keep last 8 days)
    logger.info('Pruning old data...');
    this.database.pruneOldDiscountHistory();
    await pruneOldDiscountHistory();

    // Schedule daily pruning (runs every 24 hours)
    setInterval(() => {
      this.database.pruneOldDiscountHistory();
      pruneOldDiscountHistory().catch((err) => {
        dbLogger.error({ error: err }, 'Daily pruning failed');
      });
    }, 24 * 60 * 60 * 1000);

    // Schedule log rotation every 6 hours (keeps parallax.log under 50MB)
    setInterval(() => {
      this.rotateLogsIfNeeded().catch(err => {
        logger.warn({ error: err }, 'Log rotation failed');
      });
    }, 6 * 60 * 60 * 1000);

    // EC2 health monitoring every 15 minutes
    setInterval(() => {
      this.runEc2HealthCheck().catch(err => {
        logger.warn({ error: err }, 'EC2 health check failed');
      });
    }, 15 * 60 * 1000);

    // Sync hourly heatmap summary to Supabase for fast 7d queries
    // Run once on startup, then every hour
    logger.info('Syncing heatmap summary to Supabase...');
    this.syncHeatmapSummary().catch(err => {
      logger.warn({ error: err }, 'Failed initial heatmap summary sync');
    });
    setInterval(() => {
      this.syncHeatmapSummary().catch(err => {
        logger.warn({ error: err }, 'Failed hourly heatmap summary sync');
      });
    }, 60 * 60 * 1000); // Every hour

    // Refresh EMRT cache every hour (uses latest trade data for hold time optimization)
    setInterval(() => {
      refreshEMRTCache().catch(err => {
        logger.warn({ error: err }, 'Failed hourly EMRT cache refresh');
      });
    }, 60 * 60 * 1000);

    logger.info('Initialization complete. Bot is running.');

    // Signal PM2 that we're ready (enables zero-downtime reload)
    if (process.send) {
      process.send('ready');
    }

    // Discord notification
    notifyStartup().catch((err) => {
      logger.warn({ error: err }, 'Failed to send startup Discord notification');
    });
  }

  /**
   * Rotate parallax.log if it exceeds 50MB
   * Keeps last 10K lines, archives rest with gzip, deletes archives older than 3 days
   */
  private async rotateLogsIfNeeded(): Promise<void> {
    const { execSync } = require('child_process');
    const scriptPath = `${process.env.HOME}/parallax/scripts/rotate-logs.sh`;

    try {
      const result = execSync(`bash ${scriptPath}`, { encoding: 'utf8' });
      if (result.includes('Rotated')) {
        logger.info({ result: result.trim() }, 'Log rotation completed');
      }
    } catch (error) {
      // Script might not exist or fail - not critical
      logger.debug({ error }, 'Log rotation skipped');
    }
  }

  /**
   * Run EC2 health check - alerts to Discord if thresholds breached
   */
  private async runEc2HealthCheck(): Promise<void> {
    const { execSync } = require('child_process');
    const scriptPath = `${process.env.HOME}/parallax/scripts/health-check.js`;

    try {
      execSync(`node ${scriptPath}`, { encoding: 'utf8', timeout: this.healthCheckTimeoutMs });
    } catch (error) {
      logger.warn({ error }, 'EC2 health check script failed');
    }
  }

  /**
   * Sync hourly heatmap summary within Supabase
   * Aggregates discount_history into discount_heatmap_summary for fast 7d queries
   */
  private async syncHeatmapSummary(): Promise<void> {
    try {
      // Aggregate discount_history from Supabase (last 25 hours for overlap)
      const summaries = await getHourlySummaryFromSupabase();

      if (summaries.length === 0) {
        logger.debug('No heatmap summary data to sync');
        return;
      }

      // Upsert aggregated data into discount_heatmap_summary
      await upsertHeatmapSummary(summaries);
      logger.info({ rows: summaries.length }, 'Synced heatmap summary to Supabase');
    } catch (error) {
      logger.error({ error }, 'Failed to sync heatmap summary');
      throw error;
    }
  }

  /**
   * Clean up orphan tokens - tokens in wallet that don't have an open position
   * Sells them back to USDC to recover capital
   */
  private async cleanupOrphanTokens(): Promise<void> {
    const config = getConfigSync();

    // Get all tokens in wallet
    const walletTokens = await this.executor.getAllTokenBalances();
    if (walletTokens.length === 0) {
      logger.info('No tokens in wallet to check for orphans');
      return;
    }

    // Get open positions
    const openPositions = await this.database.getOpenPositions();
    const openMints = new Set(openPositions.map(p => p.buyMint));

    // Find orphan tokens (in wallet but no open position)
    const orphanTokens = walletTokens.filter(t =>
      t.mint !== USDC_MINT && !openMints.has(t.mint)
    );

    if (orphanTokens.length === 0) {
      logger.info('No orphan tokens found');
      return;
    }

    logger.info({
      orphanCount: orphanTokens.length,
      orphans: orphanTokens.map(t => ({ symbol: t.symbol, balance: t.balance.toFixed(6) })),
    }, 'Found orphan tokens - selling back to USDC');

    // Find pool addresses for orphan tokens from config
    const tokenConfigs = config.tokens;

    for (const orphan of orphanTokens) {
      // Find matching token config
      const tokenConfig = tokenConfigs.find(t => t.mint === orphan.mint);

      if (!tokenConfig) {
        logger.warn({
          mint: orphan.mint,
          symbol: orphan.symbol,
        }, 'No config found for orphan token - skipping (may need manual sell)');
        continue;
      }

      // Get routing info (uses dynamically discovered pool from liquidity checker)
      const routing = getSwapRouting(tokenConfig.symbol);
      const poolAddress = routing.poolAddress || tokenConfig.poolAddress;

      if (!poolAddress && !routing.useRaydiumDirect) {
        // No pool discovered, but Jupiter can still route - we'll use Jupiter fallback
        logger.debug({
          symbol: orphan.symbol,
          routing: routing.dexId,
        }, 'No pool address for orphan token - will attempt Jupiter routing');
      }

      // Estimate the USD value of the orphan token
      // Use the token price from feeds if available, otherwise use a rough estimate
      let estimatedValueUsd = 0;
      try {
        const tokenPrice = await this.feedAggregator.getTokenPrice(orphan.mint);
        if (tokenPrice) {
          estimatedValueUsd = orphan.balance * tokenPrice;
        }
      } catch {
        // If we can't get price, log and skip (don't waste gas on potential dust)
        logger.debug({ symbol: orphan.symbol }, 'Could not get price for orphan token');
      }

      // Skip dust amounts that are too small to be worth selling
      // The swap would cost more in fees than the value recovered
      if (estimatedValueUsd < MIN_ORPHAN_VALUE_USD) {
        logger.info({
          symbol: orphan.symbol,
          balance: orphan.balance,
          estimatedValueUsd: estimatedValueUsd.toFixed(6),
          minRequired: MIN_ORPHAN_VALUE_USD,
        }, 'Skipping orphan token - dust amount too small to sell');
        continue;
      }

      // Sell the orphan token
      logger.info({
        symbol: orphan.symbol,
        balance: orphan.balance,
        estimatedValueUsd: estimatedValueUsd.toFixed(2),
        mint: orphan.mint.slice(0, 8),
      }, 'Selling orphan token');

      try {
        const result = await this.executor.executeSellDirect(
          orphan.mint,
          poolAddress || '', // Will fallback to Jupiter if empty
          orphan.balance,
          orphan.decimals,
          CLEANUP_SLIPPAGE_BPS
        );

        if (result.success) {
          logger.info({
            symbol: orphan.symbol,
            inputAmount: result.inputAmount,
            outputUsdc: result.outputAmount,
            txSignature: result.txSignature,
          }, 'Orphan token sold successfully');
        } else {
          logger.error({
            symbol: orphan.symbol,
            error: result.error,
          }, 'Failed to sell orphan token');
        }
      } catch (error) {
        logger.error({
          symbol: orphan.symbol,
          error,
        }, 'Error selling orphan token');
      }

      // Small delay between sells to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, ORPHAN_CLEANUP_DELAY_MS));
    }
  }

  /**
   * Reconcile orphaned on-chain short positions
   * Finds positions that exist on Flash Trade but are not tracked in our DB
   * Re-adds them to the DB so they can be properly managed and closed
   */
  private async reconcileOrphanedShortPositions(): Promise<void> {
    if (!isFlashTradeAvailable()) {
      return;
    }

    try {
      logger.info('Checking for orphaned on-chain short positions...');

      // Get all on-chain positions
      const onChainPositions = await getOpenPerpPositions();
      const onChainShorts = onChainPositions.filter(p => p.side === 'short');

      if (onChainShorts.length === 0) {
        logger.info('No on-chain short positions found');
        return;
      }

      // Get all DB open positions
      const dbOpenPositions = await getOpenShortPositions();
      const dbSymbols = new Set(dbOpenPositions.map(p => p.flashSymbol));

      // Find orphans: on-chain but not in DB
      const orphanedPositions = onChainShorts.filter(p => !dbSymbols.has(p.symbol));

      if (orphanedPositions.length === 0) {
        logger.info({
          onChainCount: onChainShorts.length,
          dbCount: dbOpenPositions.length,
        }, 'All on-chain positions are tracked in DB');
        return;
      }

      logger.warn({
        orphanedCount: orphanedPositions.length,
        symbols: orphanedPositions.map(p => p.symbol),
      }, 'Found orphaned on-chain positions - re-adding to DB');

      // Re-add each orphaned position to the DB
      for (const onChain of orphanedPositions) {
        const ticker = getTickerFromFlashSymbol(onChain.symbol);
        if (!ticker) {
          logger.warn({
            symbol: onChain.symbol,
          }, 'Could not determine ticker for orphaned position - skipping');
          continue;
        }

        // Create a synthetic position entry
        // Try to look up historical discount data to get the actual entry premium
        const entryTimestampMs = onChain.openTime * 1000;
        const historicalDiscount = await this.database.getDiscountAtTimestamp(ticker, onChain.symbol, entryTimestampMs);

        let entryPremiumPct = 0;
        if (historicalDiscount) {
          // discount is negative for premium (token above stock)
          entryPremiumPct = historicalDiscount.discount;
          executionLogger.info({
            ticker,
            symbol: onChain.symbol,
            entryPremiumPct: entryPremiumPct.toFixed(4),
            historicalTimestamp: new Date(historicalDiscount.timestamp).toISOString(),
          }, 'Found historical discount data for orphaned position');
        } else {
          executionLogger.warn({
            ticker,
            symbol: onChain.symbol,
          }, 'No historical discount data found - entry premium will be 0');
        }

        // For reconciled positions, we don't know which token triggered the original entry
        // Use flashSymbol as tokenSymbol (best guess) - exit will use fallback ticker-based matching
        const reconciledPosition: ShortPosition = {
          id: `reconciled-${Date.now()}-${onChain.symbol}`,
          ticker,
          flashSymbol: onChain.symbol,
          tokenSymbol: onChain.symbol,  // Best guess - use Flash symbol
          tokenMint: '',                 // Unknown - will use fallback matching
          entryPremiumPct, // From historical data if available, otherwise 0
          entryStockPrice: onChain.entryPrice,
          entryTimestamp: entryTimestampMs,
          collateralUsd: onChain.collateralUsd,
          leverage: onChain.leverage,
          status: 'open',
          entryTxSignature: `reconciled-from-chain-${onChain.positionKey}`,
        };

        saveShortPosition(reconciledPosition);

        executionLogger.info({
          positionId: reconciledPosition.id,
          ticker,
          symbol: onChain.symbol,
          collateralUsd: onChain.collateralUsd.toFixed(2),
          sizeUsd: onChain.sizeUsd.toFixed(2),
          leverage: onChain.leverage.toFixed(1),
          entryPrice: onChain.entryPrice.toFixed(2),
          entryPremiumPct: entryPremiumPct.toFixed(4),
          openTime: new Date(entryTimestampMs).toISOString(),
        }, 'Reconciled orphaned on-chain position - added to DB for management');
      }

      logger.info({
        reconciledCount: orphanedPositions.length,
      }, 'Orphaned position reconciliation complete');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to reconcile orphaned short positions');
    }
  }

  /**
   * Start the trading loop
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Orchestrator already running');
      return;
    }

    this.running = true;

    logger.info('Starting trading loop...');

    // NOTE: Volatility is pre-warmed during init() BEFORE liquidity refresh
    // This ensures dynamic floors use real ATR values instead of fallback
    // This ensures we only fetch for stocks with TVL-enabled tokens (~14 vs 36 stocks)
    // See liquidityChecker.ts refreshLiquidity() for the initialization call

    // CLI dashboard updates are disabled - all output goes to web dashboard and log file
    // To re-enable, set DASHBOARD_ENABLED=true in environment

    // Run main loop
    this.loopInterval = setInterval(async () => {
      try {
        await this.runTradingLoop();
      } catch (error) {
        logger.error({ error }, 'Error in trading loop');
        this.riskManager.recordFailure('SYSTEM', (error as Error).message);
      }
    }, LOOP_INTERVAL_MS);

    // Run immediately
    await this.runTradingLoop();
  }

  /**
   * Stop the trading loop
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }

    this.dashboard.stopLiveUpdates();

    // Stop web server
    stopWebServer();

    // Persist state
    await this.persistState();

    // Shutdown feeds
    await this.feedAggregator.shutdown();

    // Close database
    this.database.close();

    logger.info('Orchestrator stopped');
  }

  /**
   * Main trading loop
   */
  private async runTradingLoop(): Promise<void> {
    // Prevent concurrent loop execution (race condition fix)
    if (this.loopRunning) {
      logger.debug('Trading loop already running, skipping this iteration');
      return;
    }
    this.loopRunning = true;

    try {
      // Check kill switch
      if (this.riskManager.isKillSwitchActive()) {
        logger.debug('Kill switch active - skipping loop');
        return;
      }

      // Check circuit breaker (10 consecutive losing trades with >$1 total loss)
      if (this.circuitBreakerTripped) {
        logger.debug('Circuit breaker tripped - bot stopped after 10 consecutive losses with >$1 total loss');
        return;
      }

      // Check SOL balance and top up if needed (for transaction fees)
      await this.checkAndTopupSol();

      // Check if SOL is too high and rebalance to USDC
      await this.checkAndRebalanceToUsdc();

      // Check if liquidity data needs refresh (hourly)
      await maybeRefreshLiquidity();

      // Incrementally refresh volatility data from Twelve Data API (one symbol per cycle)
      // This spreads API calls over time to avoid rate limits
      await refreshNextVolatility();

      // Run mean reversion strategy
      await this.runMeanReversionLoop();

      // Save state periodically
      await this.persistState();
    } finally {
      this.loopRunning = false;
    }
  }

  /**
   * Mean reversion trading loop
   */
  private async runMeanReversionLoop(): Promise<void> {
    // Get open positions
    const openPositions = await this.database.getOpenPositions();

    // Update discount snapshots and save to DB
    const discounts = await this.updateDiscounts();

    // Monitor cross-DEX arbitrage opportunities (research/logging phase)
    await this.monitorCrossDexOpportunities(discounts);

    // Check for exit signals on open positions (LONG positions)
    await this.checkExitSignals(openPositions);

    // Check for entry signals (LONG positions - buy discounts)
    await this.checkEntrySignals(openPositions);

    // Premium shorting (if enabled)
    if (isShortingEnabled()) {
      await this.runPremiumShortingLoop(discounts);
    }
  }

  /**
   * Monitor cross-DEX arbitrage opportunities (research phase)
   */
  private async monitorCrossDexOpportunities(discounts: PairSpread[]): Promise<void> {
    try {
      // Extract token info from current discount analysis
      const tokens = discounts.map(spread => ({
        mint: spread.tokenA.mint,
        symbol: spread.tokenA.symbol
      }));

      // Scan for cross-DEX opportunities (non-blocking)
      const opportunities = await scanCrossDexOpportunities(tokens);

      // Log summary if opportunities found
      if (opportunities.length > 0) {
        logger.info({
          opportunities: opportunities.length,
          totalPotentialProfit: opportunities.reduce((sum, opp) => sum + opp.estimatedProfit, 0).toFixed(2),
          topOpportunity: opportunities[0],
        }, 'Cross-DEX arbitrage opportunities detected');
      }
    } catch (error) {
      logger.debug({ error }, 'Error monitoring cross-DEX opportunities');
    }
  }

  /**
   * Premium shorting loop - detects premiums and opens/closes short positions
   */
  private async runPremiumShortingLoop(discounts: PairSpread[]): Promise<void> {
    // Update premium watchlist (for dashboard display)
    updatePremiumWatchlist(discounts);

    // Check for exit signals on open short positions
    const openShorts = await getOpenShortPositions();
    for (const position of openShorts) {
      // IMPORTANT: Find spread by tokenMint (not just ticker) to handle multiple tokens per stock
      // This ensures we use the SAME token's premium that triggered the entry
      let spread = discounts.find(d => d.tokenA.mint === position.tokenMint);

      // Fallback: if exact token not found (legacy positions), try by ticker
      if (!spread && position.tokenMint) {
        executionLogger.warn({
          ticker: position.ticker,
          tokenMint: position.tokenMint,
          tokenSymbol: position.tokenSymbol,
        }, 'Could not find exact token spread, will skip this exit check');
        continue;
      }
      if (!spread) {
        // Legacy position without tokenMint - use old behavior
        spread = discounts.find(d => d.stockTicker === position.ticker);
        if (spread) {
          executionLogger.warn({
            ticker: position.ticker,
            foundToken: spread.tokenA.symbol,
          }, 'Using fallback ticker-based spread matching (legacy position)');
        }
      }
      if (!spread) continue;

      const exitCheck = checkShortExit(position, spread);
      if (exitCheck.shouldExit && exitCheck.reason) {
        await this.executeShortExit(position, exitCheck.reason, exitCheck.currentPremiumPct, spread);
      }
    }

    // Check for new short entry signals
    for (const spread of discounts) {
      const signal = await evaluatePremiumSignal(spread);
      if (signal.shouldShort && signal.flashSymbol) {
        await this.executeShortEntry(signal, spread);
      }
    }
  }

  /**
   * Execute short entry via Flash Trade
   */
  private async executeShortEntry(signal: PremiumShortSignal, _spread: PairSpread): Promise<void> {
    if (!signal.flashSymbol) return;

    const lockKey = signal.ticker;
    if (this.executingShortEntries.has(lockKey)) {
      executionLogger.debug({ ticker: signal.ticker }, 'Short entry already executing, skipping');
      return;
    }
    this.executingShortEntries.add(lockKey);

    const config = getConfigSync();

    executionLogger.info({
      ticker: signal.ticker,
      flashSymbol: signal.flashSymbol,
      premiumPct: (-signal.premiumPct).toFixed(2),
      stockPrice: signal.stockPrice,
      collateralUsd: signal.suggestedCollateralUsd,
      leverage: signal.leverage,
      mode: config.mode,
    }, 'Executing premium SHORT entry');

    try {
      let txSignature: string | undefined;

      // Get oracle price at entry (this is what Flash Trade uses for PnL)
      const entryOraclePrice = await getOraclePrice(signal.flashSymbol);
      if (!entryOraclePrice) {
        executionLogger.error({
          ticker: signal.ticker,
          flashSymbol: signal.flashSymbol,
        }, 'Cannot get oracle price for short entry - aborting');
        return;
      }

      // Only execute on Flash Trade in live mode
      if (config.mode === 'live') {
        const result = await openPerpPosition({
          symbol: signal.flashSymbol,
          side: 'short',
          collateralUsd: signal.suggestedCollateralUsd,
          leverage: signal.leverage,
          currentPriceUsd: entryOraclePrice, // Use oracle price for position
        });

        if (!result.success) {
          executionLogger.error({
            ticker: signal.ticker,
            error: result.error,
          }, 'Flash Trade short entry failed');
          return;
        }

        txSignature = result.txSignature;
        executionLogger.info({
          ticker: signal.ticker,
          txSignature,
          entryOraclePrice: entryOraclePrice.toFixed(2),
        }, 'Flash Trade short position opened');
      }

      // Create short position record - use oracle price as entry price for accurate PnL
      // IMPORTANT: Store tokenSymbol and tokenMint to track which token triggered this position
      const position: ShortPosition = {
        id: `short-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        ticker: signal.ticker,
        flashSymbol: signal.flashSymbol,
        tokenSymbol: signal.tokenSymbol,  // Track which token's premium triggered this
        tokenMint: signal.tokenMint,      // For precise spread matching on exit
        entryPremiumPct: signal.premiumPct,
        entryStockPrice: entryOraclePrice, // Oracle price, not stock price
        entryTimestamp: Date.now(),
        collateralUsd: signal.suggestedCollateralUsd,
        leverage: signal.leverage,
        status: 'open',
        entryTxSignature: txSignature,
      };

      saveShortPosition(position);

      // Send Discord notification
      notifyShortEntry({
        ticker: signal.ticker,
        flashSymbol: signal.flashSymbol,
        premiumPct: -signal.premiumPct, // Make positive for display
        collateralUsd: signal.suggestedCollateralUsd,
        leverage: signal.leverage,
        txSignature,
      }).catch((err) => {
        executionLogger.warn({ error: err }, 'Discord notification failed for short entry');
      });

      executionLogger.info({
        positionId: position.id,
        ticker: signal.ticker,
        premiumPct: (-signal.premiumPct).toFixed(2),
        isLive: config.mode === 'live',
      }, 'Premium short entry executed');
    } catch (error) {
      executionLogger.error({ ticker: signal.ticker, error }, 'Short entry failed');
    } finally {
      this.executingShortEntries.delete(lockKey);
    }
  }

  /**
   * Execute short exit via Flash Trade
   */
  private async executeShortExit(
    position: ShortPosition,
    reason: ShortPosition['exitReason'],
    currentPremiumPct: number,
    spread: PairSpread
  ): Promise<void> {
    if (this.executingShortExits.has(position.id)) {
      executionLogger.debug({ positionId: position.id }, 'Short exit already executing, skipping');
      return;
    }

    // Check if this position was recently closed (prevents double-close race condition)
    const recentCloseTime = this.recentlyClosedShorts.get(position.id);
    if (recentCloseTime && Date.now() - recentCloseTime < 60000) {
      executionLogger.debug({ positionId: position.id }, 'Short position was recently closed, skipping');
      return;
    }

    this.executingShortExits.add(position.id);

    const config = getConfigSync();

    executionLogger.info({
      positionId: position.id,
      ticker: position.ticker,
      reason,
      entryPremium: (-position.entryPremiumPct).toFixed(2),
      exitPremium: (-currentPremiumPct).toFixed(2),
      mode: config.mode,
    }, 'Executing premium SHORT exit');

    try {
      let txSignature: string | undefined;
      let positionMissingOnChain = false;

      // Only execute on Flash Trade in live mode
      if (config.mode === 'live') {
        // CRITICAL: Don't check on-chain positions while Flash Trade is still initializing
        // This prevents false "position_missing" during startup
        const flashState = getFlashInitState();
        if (flashState === 'pending') {
          executionLogger.warn({
            positionId: position.id,
            ticker: position.ticker,
            flashState,
          }, 'Flash Trade still initializing - skipping short exit check to prevent false position_missing');
          return; // Skip this exit check entirely, will retry next loop
        }

        // First, verify the position still exists on-chain
        // This handles cases where the position was liquidated, manually closed, or never opened
        const onChainPositions = await getOpenPerpPositions();
        const onChainPosition = onChainPositions.find(
          p => p.symbol === position.flashSymbol && p.side === 'short'
        );

        if (!onChainPosition) {
          // Double-check Flash Trade is actually available before marking as missing
          if (!isFlashTradeAvailable()) {
            executionLogger.warn({
              positionId: position.id,
              ticker: position.ticker,
            }, 'Flash Trade not available - skipping position check to prevent false position_missing');
            return; // Skip, will retry when Flash Trade is available
          }

          executionLogger.warn({
            positionId: position.id,
            ticker: position.ticker,
            flashSymbol: position.flashSymbol,
          }, 'Short position not found on-chain - may have been liquidated or already closed');
          positionMissingOnChain = true;
          // Continue to close in DB with special reason
        } else {
          // Position exists, try to close it
          const result = await closePerpPosition({
            symbol: position.flashSymbol,
            side: 'short',
            currentPriceUsd: spread.stockPrice || position.entryStockPrice,
          });

          if (!result.success) {
            // Check if it's the "account not initialized" error (3012)
            // This means the position doesn't exist on-chain anymore
            if (result.error?.includes('3012') || result.error?.includes('not initialized')) {
              executionLogger.warn({
                positionId: position.id,
                error: result.error,
              }, 'Position missing on-chain (error 3012) - marking as closed');
              positionMissingOnChain = true;
            } else {
              executionLogger.error({
                positionId: position.id,
                error: result.error,
              }, 'Flash Trade short exit failed');
              return;
            }
          } else {
            txSignature = result.txSignature;
            executionLogger.info({
              positionId: position.id,
              txSignature,
            }, 'Flash Trade short position closed');
          }
        }
      }

      // Calculate PnL using oracle prices (same as Flash Trade UI)
      // For shorts: profit when price falls = (entryPrice - exitPrice) / entryPrice * leverage
      // Then deduct Flash Trade fees: ~0.1% per side = 0.2% round-trip on position size
      const FLASH_TRADE_FEE_PCT = 0.2; // Round-trip fees (open + close)
      let pnlPct: number;
      let pnlUsd: number;

      if (positionMissingOnChain) {
        // Position was closed externally (liquidation, manual close, or system issue)
        // DON'T assume 100% loss — could have been closed at breakeven or profit
        // Use current spread to estimate, or fallback to 30% loss (conservative but not catastrophic)
        const ESTIMATED_MISSING_LOSS_PCT = 30; // Conservative estimate, not 100%

        // Try to estimate based on current premium vs entry
        const premiumChange = currentPremiumPct - position.entryPremiumPct;
        const estimatedPnlFromPremium = premiumChange * position.leverage;

        // Use premium-based estimate if it's a loss, otherwise use conservative estimate
        // (If premium shows profit, the position was likely closed profitably externally)
        if (estimatedPnlFromPremium < 0) {
          // Cap at -100% (can't lose more than collateral)
          pnlPct = Math.max(-100, estimatedPnlFromPremium);
        } else {
          // Premium suggests profit or breakeven — use conservative loss estimate
          // (We don't know actual outcome, so assume some loss for safety)
          pnlPct = -ESTIMATED_MISSING_LOSS_PCT;
        }
        pnlUsd = position.collateralUsd * (pnlPct / 100);

        executionLogger.warn({
          positionId: position.id,
          ticker: position.ticker,
          estimatedPnlPct: pnlPct.toFixed(2),
          estimatedPnlUsd: pnlUsd.toFixed(2),
          premiumChange: premiumChange.toFixed(2),
          note: 'Position missing on-chain - PnL estimated (not verified)',
        }, 'Position missing on-chain - using estimated PnL (not 100% loss)');
      } else {
        // Get current oracle price for accurate PnL calculation
        const currentOraclePrice = await getOraclePrice(position.flashSymbol);

        if (currentOraclePrice && position.entryStockPrice > 0) {
          // Oracle-based PnL (matches Flash Trade exactly)
          const priceChangePct = ((position.entryStockPrice - currentOraclePrice) / position.entryStockPrice) * 100;
          const grossPnlPct = priceChangePct * position.leverage;

          // Deduct fees: fees are charged on position size, not collateral
          // Position size = collateral * leverage
          // Fee impact on collateral = (sizeUsd * feePct) / collateralUsd = feePct * leverage
          const feeImpactPct = FLASH_TRADE_FEE_PCT * position.leverage;

          pnlPct = grossPnlPct - feeImpactPct;
          pnlUsd = position.collateralUsd * (pnlPct / 100);

          executionLogger.info({
            positionId: position.id,
            entryPrice: position.entryStockPrice.toFixed(2),
            exitPrice: currentOraclePrice.toFixed(2),
            priceChangePct: priceChangePct.toFixed(4),
            grossPnlPct: grossPnlPct.toFixed(4),
            feeImpactPct: feeImpactPct.toFixed(4),
            netPnlPct: pnlPct.toFixed(4),
          }, 'Short PnL calculated from oracle prices');
        } else {
          // Fallback to premium-based calculation if oracle unavailable
          executionLogger.warn({
            positionId: position.id,
            hasOraclePrice: !!currentOraclePrice,
            entryStockPrice: position.entryStockPrice,
          }, 'Oracle price unavailable, using premium-based PnL (less accurate)');

          const premiumChange = currentPremiumPct - position.entryPremiumPct;
          const grossPnlPct = premiumChange * position.leverage;
          const feeImpactPct = FLASH_TRADE_FEE_PCT * position.leverage;

          pnlPct = grossPnlPct - feeImpactPct;
          pnlUsd = position.collateralUsd * (pnlPct / 100);
        }
      }

      // Determine exit reason (override if position was missing)
      const finalExitReason = positionMissingOnChain ? 'position_missing' : reason;

      // Update position
      const closedPosition: ShortPosition = {
        ...position,
        status: 'closed',
        exitPremiumPct: currentPremiumPct,
        exitTimestamp: Date.now(),
        exitReason: finalExitReason,
        exitTxSignature: txSignature,
        pnlUsd,
        pnlPct,
      };

      saveShortPosition(closedPosition);

      // Track this position as recently closed (prevents double-close race condition)
      this.recentlyClosedShorts.set(position.id, Date.now());
      // Clean up old entries (keep map size bounded)
      if (this.recentlyClosedShorts.size > 100) {
        const now = Date.now();
        for (const [id, time] of this.recentlyClosedShorts) {
          if (now - time > 120000) this.recentlyClosedShorts.delete(id);
        }
      }

      // Send Discord notification
      notifyShortExit({
        ticker: position.ticker,
        flashSymbol: position.flashSymbol,
        premiumPct: currentPremiumPct,
        collateralUsd: position.collateralUsd,
        leverage: position.leverage,
        pnlUsd,
        exitReason: finalExitReason,
        txSignature,
      }).catch((err) => {
        executionLogger.warn({ error: err }, 'Discord notification failed for short exit');
      });

      executionLogger.info({
        positionId: position.id,
        ticker: position.ticker,
        pnlUsd: pnlUsd.toFixed(2),
        pnlPct: pnlPct.toFixed(3),
        reason: finalExitReason,
        positionMissingOnChain,
        isLive: config.mode === 'live',
      }, 'Premium short exit executed');

      // Set cooldown to prevent immediate re-entry
      setShortEntryCooldown(position.ticker);

      // Record PnL for risk management (daily loss tracking)
      // BUT skip for position_missing — it's an external event, not a trading strategy failure
      // We don't want external position closures to trigger kill switch
      if (!positionMissingOnChain) {
        this.riskManager.recordPnL(pnlUsd);
      } else {
        executionLogger.warn({
          ticker: position.ticker,
          pnlUsd: pnlUsd.toFixed(2),
        }, 'Skipping risk manager recording for position_missing (external event)');
      }

      // Circuit breaker: track consecutive losses (only for live trades with real PnL)
      // Also skip for position_missing — don't want external events triggering circuit breaker
      if (config.mode === 'live' && this.executor.isLive() && !positionMissingOnChain) {
        this.recordTradeForCircuitBreaker(pnlUsd);
      }
    } catch (error) {
      executionLogger.error({ positionId: position.id, error }, 'Short exit failed');
    } finally {
      this.executingShortExits.delete(position.id);
    }
  }

  /**
   * Update and save discount snapshots
   * Uses batch fetching for efficiency with large token lists
   */
  private async updateDiscounts(): Promise<PairSpread[]> {
    try {
      // Use batch method for efficient parallel fetching
      const discounts = await this.signalGenerator.calculateAllSpreadsBatch();

      // Save each discount snapshot to database
      for (const discount of discounts) {
        this.database.saveDiscountSnapshot(discount);
      }

      return discounts;
    } catch (error) {
      logger.error({ error }, 'Error in batch discount update, falling back to sequential');

      // Fallback to sequential if batch fails
      const targets = this.signalGenerator.getTargets();
      const discounts: PairSpread[] = [];

      for (const target of targets) {
        try {
          const discount = await this.signalGenerator.calculateSpread(target);
          if (discount) {
            this.database.saveDiscountSnapshot(discount);
            discounts.push(discount);
          }
        } catch (err) {
          logger.error({ ticker: target.stockTicker, error: err }, 'Error updating discount');
        }
      }

      return discounts;
    }
  }

  /**
   * Check exit signals on open positions
   */
  private async checkExitSignals(positions: MeanReversionPosition[]): Promise<number> {
    let exitsTriggered = 0;

    for (const position of positions) {
      try {
        const exitCheck = await this.signalGenerator.checkExit(position);

        if (exitCheck.shouldExit) {
          exitsTriggered += 1;
          await this.executeExit(
            position,
            exitCheck.reason,
            exitCheck.currentSpreadPct,
            exitCheck.spread,
            exitCheck.preferredRoute,
            exitCheck.expectedExitUsd
          );
        }
      } catch (error) {
        logger.error({ positionId: position.id, error }, 'Error checking exit signal');
      }
    }

    return exitsTriggered;
  }

  /**
   * Check entry signals
   */
  private async checkEntrySignals(existingPositions: MeanReversionPosition[]): Promise<MeanReversionSignal | null> {
    // Time filter removed — 4.5% threshold is selective enough
    const signal = await this.signalGenerator.getBestOpportunity(existingPositions);

    if (!signal || !signal.shouldTrade) {
      return null;
    }

    await this.executeEntry(signal);
    return signal;
  }

  /**
   * Execute entry trade
   */
  private async executeEntry(signal: MeanReversionSignal): Promise<void> {
    // Prevent duplicate execution - use token symbol to allow parallel entries for different tokens
    const lockKey = signal.buyToken.symbol;
    if (this.executingEntries.has(lockKey)) {
      executionLogger.debug({ ticker: signal.pair.stockTicker, token: lockKey }, 'Entry already executing, skipping');
      return;
    }
    this.executingEntries.add(lockKey);

    const config = getConfigSync();

    executionLogger.info({
      ticker: signal.pair.stockTicker,
      token: signal.buyToken.symbol,
      discountPct: signal.spread.tokenA.discountVsStock,
      sizeUsd: signal.suggestedSizeUsd,
      mode: config.mode,
    }, 'Executing mean reversion entry');

    try {
      const buyPrice = signal.spread.moreDiscounted === 'A'
        ? signal.spread.tokenA.price
        : signal.spread.tokenB.price;
      const sellPrice = signal.spread.moreDiscounted === 'A'
        ? signal.spread.tokenB.price
        : signal.spread.tokenA.price;

      let buyAmount = signal.suggestedSizeUsd / buyPrice;
      let sellAmount = signal.suggestedSizeUsd / sellPrice;

      // LIVE MODE: Execute real on-chain swaps
      // Determine routing: use DexScreener-discovered pools or config pool address
      const routing = getSwapRouting(signal.buyToken.symbol, signal.buyToken.poolAddress);

      // Track buy result for tx signature and fees (only set in live mode)
      let buyResult: TradeResult | undefined;

      if (config.mode === 'live' && this.executor.isLive()) {
        await this.throttle();

        // Use the route that gave the best quote (from signal evaluation)
        // Default to Raydium if no preference but Raydium is available
        const useJupiter = signal.preferredRoute === 'jupiter' ||
          (!signal.preferredRoute && !routing.useRaydiumDirect);

        executionLogger.info({
          ticker: signal.pair.stockTicker,
          buyMint: signal.buyToken.mint,
          sizeUsd: signal.suggestedSizeUsd,
          preferredRoute: signal.preferredRoute || 'default',
          useJupiter,
          raydiumAvailable: routing.useRaydiumDirect,
          dex: routing.dexId,
          poolSource: routing.source,
          poolAddress: routing.poolAddress?.slice(0, 8),
          quoteToken: routing.quoteToken,
          liquidity: routing.liquidityUsd.toFixed(0),
        }, 'Executing LIVE on-chain swap: BUY');

        // Track whether we used Jupiter (returns raw units) vs Raydium (returns human-readable)
        let usedJupiter = false;

        if (!useJupiter && routing.useRaydiumDirect && routing.poolAddress && routing.quoteToken !== 'OTHER') {
          // Direct Raydium CLMM swap (USDC or SOL pools)
          // SOL pools use existing SOL balance directly (single hop)
          // Pass buyPrice for accurate fee calculation (true cost of entry)
          buyResult = await this.executor.executeBuyWithQuote(
            signal.buyToken.mint,
            routing.poolAddress,
            signal.suggestedSizeUsd,
            routing.quoteToken,
            routing.quoteMint,
            config.maxSlippageBps,
            buyPrice  // Token price for accurate fee tracking
          );
        } else {
          // Use Jupiter aggregator (better price or non-Raydium pools)
          usedJupiter = true;
          const buyQuote = await this.jupiterClient.getBuyQuote(
            signal.buyToken.mint,
            signal.suggestedSizeUsd
          );

          if (!buyQuote) {
            executionLogger.error({ ticker: signal.pair.stockTicker }, 'Failed to get buy quote');
            return;
          }

          buyResult = await this.executor.executeBuy(
            signal.buyToken.mint,
            signal.suggestedSizeUsd,
            buyQuote
          );
        }

        // If Jupiter fails and we have Raydium pool info, try Raydium as fallback
        if (!buyResult.success && usedJupiter && routing.poolAddress && routing.quoteToken !== 'OTHER') {
          // Get Raydium quote first to check profitability
          const raydiumBuyQuote = await this.executor.getRaydiumBuyQuote(
            routing.poolAddress,
            signal.suggestedSizeUsd
          );

          // Calculate expected tokens at current market price
          const expectedTokens = buyPrice > 0 ? signal.suggestedSizeUsd / buyPrice : 0;

          if (raydiumBuyQuote && expectedTokens > 0) {
            // Check if Raydium gives us at least (1 - maxSlippage) of expected tokens
            const raydiumDeviationPct = ((expectedTokens - raydiumBuyQuote.amountOut) / expectedTokens) * 100;

            if (raydiumDeviationPct <= MAX_SLIPPAGE_BPS / 100) {
              executionLogger.warn({
                ticker: signal.pair.stockTicker,
                jupiterError: buyResult.error,
                expectedTokens: expectedTokens.toFixed(6),
                raydiumTokens: raydiumBuyQuote.amountOut.toFixed(6),
                deviationPct: raydiumDeviationPct.toFixed(2),
              }, 'Jupiter buy failed, Raydium fallback within profitability threshold');

              usedJupiter = false;
              buyResult = await this.executor.executeBuyWithQuote(
                signal.buyToken.mint,
                routing.poolAddress,
                signal.suggestedSizeUsd,
                routing.quoteToken,
                routing.quoteMint,
                config.maxSlippageBps,
                buyPrice
              );
            } else {
              executionLogger.warn({
                ticker: signal.pair.stockTicker,
                jupiterError: buyResult.error,
                expectedTokens: expectedTokens.toFixed(6),
                raydiumTokens: raydiumBuyQuote.amountOut.toFixed(6),
                deviationPct: raydiumDeviationPct.toFixed(2),
                maxAllowedPct: (MAX_SLIPPAGE_BPS / 100).toFixed(2),
              }, 'Jupiter buy failed, Raydium quote exceeds profitability threshold - skipping fallback');
            }
          } else {
            executionLogger.warn({
              ticker: signal.pair.stockTicker,
              jupiterError: buyResult.error,
              raydiumQuoteAvailable: !!raydiumBuyQuote,
              buyPriceAvailable: buyPrice > 0,
            }, 'Jupiter buy failed, Raydium quote unavailable - no fallback');
          }
        }

        if (!buyResult.success) {
          executionLogger.error({
            ticker: signal.pair.stockTicker,
            token: signal.buyToken.symbol,
            error: buyResult.error,
          }, 'Live buy execution failed');
          this.signalGenerator.recordFailure(signal.buyToken.symbol);
          return;
        }

        // Jupiter returns outputAmount in raw units (lamports), Raydium returns human-readable
        // Convert Jupiter output to human-readable format
        const outputAmountHuman = usedJupiter
          ? buyResult.outputAmount / Math.pow(10, signal.buyToken.decimals)
          : buyResult.outputAmount;

        executionLogger.info({
          ticker: signal.pair.stockTicker,
          txSignature: buyResult.txSignature,
          inputAmount: buyResult.inputAmount,
          outputAmountRaw: buyResult.outputAmount,
          outputAmountHuman,
          usedJupiter,
          decimals: signal.buyToken.decimals,
        }, 'LIVE buy executed successfully');

        buyAmount = outputAmountHuman;
      }

      // Create position
      // For mean reversion, store the entry DISCOUNT (vs stock), not the token-token spread
      // Use the best available discount - handles tokenA === tokenB case and undefined values
      const discountA = signal.spread.tokenA.discountVsStock;
      const discountB = signal.spread.tokenB.discountVsStock;
      const entryDiscount = Math.max(discountA ?? 0, discountB ?? 0);

      // Store the pool address and DEX ID used for entry (needed for exit)
      // Always use routing pool address if available (works for Raydium, Meteora, etc.)
      const entryPoolAddress = routing.poolAddress || signal.buyToken.poolAddress;
      const entryDexId = routing.dexId;

      // Get tx signature from live execution (if available)
      const entryTxSignature = buyResult?.txSignature;

      // Extract entry fees (if available from live execution)
      const entryFees = buyResult?.fees;
      const entryFeesUsd = entryFees?.totalFeeUsd ?? 0;

      const position: MeanReversionPosition = {
        id: `pair-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        stockTicker: signal.pair.stockTicker,
        buySymbol: signal.buyToken.symbol,
        buyMint: signal.buyToken.mint,
        buyPoolAddress: entryPoolAddress || '',
        buyDexId: entryDexId,
        buyDecimals: signal.buyToken.decimals,
        sellSymbol: signal.sellToken.symbol,
        sellMint: signal.sellToken.mint,
        entrySpreadPct: entryDiscount,
        entryTimestamp: Date.now(),
        sizeUsd: signal.suggestedSizeUsd,
        buyAmount,
        sellAmount,
        status: 'open',
        entryTxSignature,
        // Fee tracking - entry fees recorded now, exit fees added on close
        entryFeesUsd,
        totalFeesUsd: entryFeesUsd,
        priorityFeesUsd: entryFees?.priorityFeeUsd ?? 0,
        networkFeesUsd: entryFees?.networkFeeUsd ?? 0,
        slippageUsd: entryFees?.executionSlippageUsd ?? 0,
        platformFeesUsd: entryFees?.platformFeeUsd ?? 0,
        // Execution route tracking (jupiter, jupiter-ultra, raydium)
        entryRoute: entryFees?.route,
        // Liquidity tracking
        entryTvlUsd: signal.tvlUsd,
        // Entry stock price for accurate NAV calculations
        entryStockPrice: signal.spread.stockPrice,
      };

      this.database.savePosition(position);

      // Set entry cooldown to prevent duplicate positions from race conditions
      this.signalGenerator.setEntryCooldown(signal.buyToken.symbol);

      // Record trade
      this.riskManager.recordSuccess(signal.buyToken.symbol);

      executionLogger.info({
        positionId: position.id,
        ticker: signal.pair.stockTicker,
        token: signal.buyToken.symbol,
        discountPct: entryDiscount.toFixed(2),
        isLive: config.mode === 'live' && this.executor.isLive(),
      }, 'Mean reversion entry executed');

      // Discord notification
      notifyEntry({
        type: 'entry',
        ticker: signal.pair.stockTicker,
        token: signal.buyToken.symbol,
        spreadPct: entryDiscount,
        sizeUsd: signal.suggestedSizeUsd,
        txSignature: entryTxSignature,
      }).catch((err) => {
        executionLogger.warn({ error: err }, 'Discord notification failed for entry');
      });
    } catch (error) {
      executionLogger.error({ ticker: signal.pair.stockTicker, token: signal.buyToken.symbol, error }, 'Entry failed');
    } finally {
      this.executingEntries.delete(signal.buyToken.symbol);
    }
  }

  /**
   * Execute exit trade
   */
  private async executeExit(
    position: MeanReversionPosition,
    reason: string,
    currentDiscountPct: number,
    spread?: PairSpread | null,
    preferredRoute?: 'raydium' | 'jupiter',
    expectedExitUsd?: number  // Expected USDC from signal's quote - used to validate execution quote
  ): Promise<void> {
    if (this.executingExits.has(position.id)) {
      executionLogger.debug({ positionId: position.id }, 'Exit already executing, skipping');
      return;
    }
    this.executingExits.add(position.id);

    const config = getConfigSync();

    executionLogger.info({
      positionId: position.id,
      ticker: position.stockTicker,
      reason,
      entryDiscount: position.entrySpreadPct,
      exitDiscount: currentDiscountPct,
      mode: config.mode,
    }, 'Executing mean reversion exit');

    try {
      let sellResult: TradeResult | null = null;

      // LIVE MODE: Execute real on-chain swap
      if (config.mode === 'live' && this.executor.isLive()) {
        await this.throttle();

        // Get best routing for exit (may differ from entry if liquidity has changed)
        // Use Raydium for both USDC and SOL pools
        const exitRouting = getSwapRouting(position.buySymbol, position.buyPoolAddress, position.buyDexId);
        const useDirectRaydium = exitRouting.useRaydiumDirect && exitRouting.poolAddress;

        // Query actual token balance to ensure we don't try to sell more than we have
        // IMPORTANT: Only sell THIS position's tokens, not the entire wallet balance
        // (Multiple positions may hold the same token)
        let sellAmount = position.buyAmount;
        if (position.buyDecimals) {
          const actualBalance = await this.executor.getTokenBalance(position.buyMint, position.buyDecimals);

          if (actualBalance === null) {
            // Error fetching balance - skip this exit attempt, try again next loop
            executionLogger.warn({
              ticker: position.stockTicker,
              mint: position.buyMint,
              positionId: position.id,
            }, 'Could not fetch token balance - skipping exit attempt');
            this.executingExits.delete(position.id);
            return;
          } else if (actualBalance === 0) {
            // Balance is confirmed to be zero
            executionLogger.warn({
              ticker: position.stockTicker,
              mint: position.buyMint,
              positionId: position.id,
            }, 'Token balance is zero - marking position as closed (already sold or failed buy)');

            // Close the position in DB since there's nothing to sell
            const closedPosition: MeanReversionPosition = {
              ...position,
              status: 'closed',
              exitSpreadPct: currentDiscountPct,
              exitTimestamp: Date.now(),
              exitReason: 'balance_zero',
              pnlUsd: 0,  // Unknown since we don't know what happened
              pnlPct: 0,
            };
            this.database.savePosition(closedPosition);
            // Also set exit cooldown even for zero-balance exits
            // Use buySymbol (token symbol) not stockTicker so different tokens can trade independently
            this.signalGenerator.setExitCooldown(position.buySymbol);
            this.executingExits.delete(position.id);
            return;
          }

          // Check for dust: if remaining value is below minimum sellable threshold, close as dust
          // This prevents endless failed sell attempts for negligible amounts
          const tokenPriceForDust = spread
            ? (spread.tokenA.symbol === position.buySymbol ? spread.tokenA.price : spread.tokenB.price)
            : (position.sizeUsd / position.buyAmount);  // Fallback to entry price
          const estimatedValueUsd = actualBalance * tokenPriceForDust;

          if (estimatedValueUsd < MIN_SELLABLE_VALUE_USD) {
            executionLogger.warn({
              ticker: position.stockTicker,
              mint: position.buyMint,
              positionId: position.id,
              actualBalance,
              estimatedValueUsd: estimatedValueUsd.toFixed(6),
              minSellable: MIN_SELLABLE_VALUE_USD,
              entryTxSignature: position.entryTxSignature,
            }, 'Token balance is dust (below min sellable) - marking position as closed');

            // Close the position as dust - the amount is too small to sell
            // We don't know what happened to the tokens (price crash, failed sells, tracking bug)
            // Set PnL to approximate entry fees (small loss) rather than -100% to avoid fake losses
            // This matches the logic at lines 1887-1897 for similar cases
            let dustPnlUsd = 0;
            let dustPnlPct = 0;

            if (config.mode === 'live' && this.executor.isLive() && position.entryTxSignature) {
              // Live trade: entry succeeded but balance is now dust
              // We can't determine true PnL without exit TX, so estimate based on entry fees
              // This avoids recording -100% loss when we don't know what happened
              dustPnlUsd = -(position.entryFeesUsd || 0.01); // Small negative (entry fees lost)
              dustPnlPct = position.sizeUsd > 0 ? (dustPnlUsd / position.sizeUsd) * 100 : 0;

              executionLogger.warn({
                ticker: position.stockTicker,
                positionId: position.id,
                entryTxSignature: position.entryTxSignature,
                sizeUsd: position.sizeUsd,
                estimatedDustValue: estimatedValueUsd.toFixed(6),
                pnlUsd: dustPnlUsd.toFixed(4),
              }, 'Dust position with entry TX - setting conservative PnL to avoid fake -100% loss');
            } else {
              // Paper mode or no entry TX: use estimated loss from current value
              dustPnlUsd = estimatedValueUsd - position.sizeUsd;
              dustPnlPct = ((estimatedValueUsd - position.sizeUsd) / position.sizeUsd) * 100;
            }

            const closedPosition: MeanReversionPosition = {
              ...position,
              status: 'closed',
              exitSpreadPct: currentDiscountPct,
              exitTimestamp: Date.now(),
              exitReason: 'dust',
              pnlUsd: dustPnlUsd,
              pnlPct: dustPnlPct,
            };
            this.database.savePosition(closedPosition);
            this.signalGenerator.setExitCooldown(position.buySymbol);
            this.executingExits.delete(position.id);

            // Record the loss for circuit breaker (now much smaller, not -100%)
            if (config.mode === 'live' && this.executor.isLive()) {
              this.recordTradeForCircuitBreaker(closedPosition.pnlUsd || 0);
            }
            return;
          }

          // Balance is above dust threshold - proceed with sell
          {
            // FIXED: Only sell this position's tokens, not the entire wallet balance
            // Use the minimum of position amount and actual balance
            // This prevents selling tokens belonging to OTHER open positions
            sellAmount = Math.min(position.buyAmount, actualBalance);

            if (actualBalance < position.buyAmount) {
              executionLogger.warn({
                ticker: position.stockTicker,
                positionAmount: position.buyAmount,
                actualBalance,
                sellAmount,
              }, 'Wallet balance less than position amount - selling available balance');
            }
          }
        }

        // Use preferredRoute from exit signal if available, otherwise fall back to routing decision
        const useJupiterForExit = preferredRoute === 'jupiter' ||
          (!preferredRoute && !useDirectRaydium);

        executionLogger.info({
          positionId: position.id,
          ticker: position.stockTicker,
          sellMint: position.buyMint,
          sellAmount: sellAmount,
          preferredRoute,
          useJupiterForExit,
          useDirectRaydium,
          dex: exitRouting.dexId,
          poolSource: exitRouting.source,
          poolAddress: exitRouting.poolAddress?.slice(0, 8),
          liquidity: exitRouting.liquidityUsd.toFixed(0),
        }, 'Executing LIVE on-chain swap: SELL');

        let result: TradeResult | undefined;
        let usedJupiterForSell = false;

        // Get current token price for accurate fee calculation and sanity check
        const tokenPriceUsd = spread
          ? (spread.tokenA.symbol === position.buySymbol ? spread.tokenA.price : spread.tokenB.price)
          : undefined;

        // Calculate expected output for sanity check
        const expectedOutputUsd = tokenPriceUsd ? sellAmount * tokenPriceUsd : position.sizeUsd;
        const rawSellAmount = sellAmount * Math.pow(10, position.buyDecimals || 6);

        // Try execution with escalating slippage tolerance
        // Start tight (1%) and increase on failure up to 2% max
        for (let attempt = 0; attempt < EXIT_SLIPPAGE_ESCALATION_BPS.length; attempt++) {
          const exitSlippageBps = EXIT_SLIPPAGE_ESCALATION_BPS[attempt];

          // Get fresh quote for each attempt
          const sellQuote = await this.jupiterClient.getSellQuoteRaw(
            position.buyMint,
            rawSellAmount,
            exitSlippageBps
          );

          if (!sellQuote) {
            executionLogger.warn({
              ticker: position.stockTicker,
              attempt: attempt + 1,
              slippageBps: exitSlippageBps,
            }, 'Failed to get sell quote, will retry with higher slippage');
            continue;
          }

          // Quote sanity check: verify quote is within acceptable range of expected price
          const quotedOutputUsd = sellQuote.outputAmount / 1e6; // Convert from lamports

          // Guard against division by zero (shouldn't happen but safety first)
          if (expectedOutputUsd <= 0) {
            executionLogger.error({
              ticker: position.stockTicker,
              expectedOutputUsd,
              positionSizeUsd: position.sizeUsd,
            }, 'Expected output is zero or negative - skipping sanity check');
            continue;
          }

          const quotePriceDeviationPct = ((expectedOutputUsd - quotedOutputUsd) / expectedOutputUsd) * 100;

          if (quotePriceDeviationPct > MAX_SLIPPAGE_BPS / 100) {
            executionLogger.warn({
              ticker: position.stockTicker,
              expectedUsd: expectedOutputUsd.toFixed(2),
              quotedUsd: quotedOutputUsd.toFixed(2),
              deviationPct: quotePriceDeviationPct.toFixed(2),
              maxAllowedPct: (MAX_SLIPPAGE_BPS / 100).toFixed(2),
            }, 'Quote deviates too much from expected price - skipping exit, will retry next loop');
            this.executingExits.delete(position.id);
            return;
          }

          // QUOTE DEGRADATION CHECK: Compare execution quote vs signal quote
          // Abort if the execution quote is significantly worse than what the signal saw
          // Different thresholds based on exit urgency:
          // - profit_target: tight (0.3%) - we can wait for better price
          // - time_decay: medium (0.5%) - some urgency but not critical
          // - max_hold_time/stop_loss: loose (1.0%) - must exit, but avoid catastrophic slippage
          if (expectedExitUsd) {
            const quoteDegradationPct = ((expectedExitUsd - quotedOutputUsd) / expectedExitUsd) * 100;

            // Set max degradation based on exit reason urgency
            let maxDegradationPct: number;
            switch (reason) {
              case 'profit_target':
                maxDegradationPct = 0.3; // Tight - can retry later
                break;
              case 'time_decay':
                maxDegradationPct = 0.5; // Medium - some urgency
                break;
              case 'max_hold_time':
              case 'stop_loss':
              default:
                maxDegradationPct = 1.0; // Loose - must exit but avoid disaster
                break;
            }

            if (quoteDegradationPct > maxDegradationPct) {
              executionLogger.warn({
                ticker: position.stockTicker,
                signalQuoteUsd: expectedExitUsd.toFixed(2),
                executionQuoteUsd: quotedOutputUsd.toFixed(2),
                degradationPct: quoteDegradationPct.toFixed(3),
                maxAllowedPct: maxDegradationPct.toFixed(2),
                positionSizeUsd: position.sizeUsd.toFixed(2),
                potentialLossUsd: (expectedExitUsd - quotedOutputUsd).toFixed(3),
                exitReason: reason,
              }, `Quote degraded since signal - aborting ${reason} exit to prevent excessive loss`);
              this.executingExits.delete(position.id);
              return;
            }

            executionLogger.debug({
              ticker: position.stockTicker,
              signalQuoteUsd: expectedExitUsd.toFixed(2),
              executionQuoteUsd: quotedOutputUsd.toFixed(2),
              degradationPct: quoteDegradationPct.toFixed(3),
              maxAllowedPct: maxDegradationPct.toFixed(2),
              exitReason: reason,
            }, 'Quote degradation within acceptable range');
          }

          executionLogger.info({
            ticker: position.stockTicker,
            attempt: attempt + 1,
            slippageBps: exitSlippageBps,
            expectedUsd: expectedOutputUsd.toFixed(2),
            quotedUsd: quotedOutputUsd.toFixed(2),
            deviationPct: quotePriceDeviationPct.toFixed(2),
          }, 'Attempting exit with slippage tolerance');

          // Try Raydium first if routing prefers it
          if (!useJupiterForExit && useDirectRaydium && position.buyDecimals && exitRouting.poolAddress) {
            result = await this.executor.executeSellDirect(
              position.buyMint,
              exitRouting.poolAddress,
              sellAmount,
              position.buyDecimals,
              exitSlippageBps,
              tokenPriceUsd
            );

            // If Raydium fails, try Jupiter
            if (!result.success) {
              executionLogger.warn({
                ticker: position.stockTicker,
                raydiumError: result.error,
                slippageBps: exitSlippageBps,
              }, 'Raydium sell failed, trying Jupiter');

              usedJupiterForSell = true;
              result = await this.executor.executeSell(
                position.buyMint,
                rawSellAmount,
                sellQuote
              );
            }
          } else {
            // Use Jupiter directly
            usedJupiterForSell = true;
            result = await this.executor.executeSell(
              position.buyMint,
              rawSellAmount,
              sellQuote
            );

            // If Jupiter fails (e.g., Meteora routing error) and we have Raydium pool info, try Raydium as fallback
            if (!result.success && exitRouting.poolAddress && position.buyDecimals) {
              // Get Raydium quote first to check profitability
              const raydiumQuote = await this.executor.getRaydiumSellQuote(
                exitRouting.poolAddress,
                position.buyMint,
                sellAmount,
                position.buyDecimals
              );

              if (raydiumQuote && expectedOutputUsd > 0) {
                const raydiumQuotedOutputUsd = raydiumQuote.amountOut; // USDC output
                const raydiumDeviationPct = ((expectedOutputUsd - raydiumQuotedOutputUsd) / expectedOutputUsd) * 100;

                if (raydiumDeviationPct <= MAX_SLIPPAGE_BPS / 100) {
                  executionLogger.warn({
                    ticker: position.stockTicker,
                    jupiterError: result.error,
                    raydiumQuotedUsd: raydiumQuotedOutputUsd.toFixed(2),
                    expectedUsd: expectedOutputUsd.toFixed(2),
                    deviationPct: raydiumDeviationPct.toFixed(2),
                    slippageBps: exitSlippageBps,
                  }, 'Jupiter sell failed, Raydium fallback within profitability threshold');

                  usedJupiterForSell = false;
                  result = await this.executor.executeSellDirect(
                    position.buyMint,
                    exitRouting.poolAddress,
                    sellAmount,
                    position.buyDecimals,
                    exitSlippageBps,
                    tokenPriceUsd
                  );
                } else {
                  executionLogger.warn({
                    ticker: position.stockTicker,
                    jupiterError: result.error,
                    raydiumQuotedUsd: raydiumQuotedOutputUsd.toFixed(2),
                    expectedUsd: expectedOutputUsd.toFixed(2),
                    deviationPct: raydiumDeviationPct.toFixed(2),
                    maxAllowedPct: (MAX_SLIPPAGE_BPS / 100).toFixed(2),
                  }, 'Jupiter sell failed, Raydium quote exceeds profitability threshold - skipping fallback');
                }
              } else {
                executionLogger.warn({
                  ticker: position.stockTicker,
                  jupiterError: result.error,
                  raydiumQuoteAvailable: !!raydiumQuote,
                }, 'Jupiter sell failed, Raydium quote unavailable - no fallback');
              }
            }
          }

          if (result.success) {
            executionLogger.info({
              ticker: position.stockTicker,
              attempt: attempt + 1,
              slippageBps: exitSlippageBps,
              usedJupiterForSell,
            }, 'Exit succeeded');
            break;
          }

          // Log failure and try next slippage level
          executionLogger.warn({
            ticker: position.stockTicker,
            attempt: attempt + 1,
            slippageBps: exitSlippageBps,
            error: result.error,
          }, 'Exit attempt failed, will retry with higher slippage');
        }

        if (!result || !result.success) {
          executionLogger.error({
            ticker: position.stockTicker,
            error: result?.error || 'All attempts failed',
            usedJupiterForSell,
            attemptsExhausted: EXIT_SLIPPAGE_ESCALATION_BPS.length,
          }, 'Live sell execution failed after all slippage escalation attempts');
          this.executingExits.delete(position.id);
          return;
        }

        sellResult = result;

        executionLogger.info({
          ticker: position.stockTicker,
          txSignature: result.txSignature,
          inputAmount: position.buyAmount,
          outputAmount: result.outputAmount,
        }, 'LIVE sell executed successfully');
      }

      // Extract exit fees (if available from live execution)
      const exitFees = sellResult?.fees;
      const exitFeesUsd = exitFees?.totalFeeUsd ?? 0;

      // Combine entry + exit fees for total
      const totalFeesUsd = (position.entryFeesUsd ?? 0) + exitFeesUsd;

      // Calculate PnL (NET of SOL fees only)
      let pnlUsd: number;
      let pnlPct: number;

      if (sellResult && sellResult.success && sellResult.outputAmount !== undefined) {
        // LIVE MODE: Use actual USD value received
        let usdReceived: number;

        // PRIORITY 1: Use outputAmountUsd if available (Raydium provides this, handles SOL pools correctly)
        if (sellResult.outputAmountUsd !== undefined && sellResult.outputAmountUsd > 0) {
          usdReceived = sellResult.outputAmountUsd;
          executionLogger.debug({
            ticker: position.stockTicker,
            outputMint: sellResult.outputMint?.slice(0, 8),
            rawOutput: sellResult.outputAmount,
            usdValue: usdReceived.toFixed(4),
          }, 'Using outputAmountUsd for PnL (handles SOL pools)');
        } else {
          // FALLBACK: Determine if output is in lamports (Jupiter) or human-readable (Raydium USDC)
          // Jupiter returns millions (lamports), Raydium USDC returns ~$10-100 range
          // Use 10000 as threshold - anything above is likely lamports
          const isLamports = sellResult.outputAmount > 10000;
          usdReceived = isLamports
            ? sellResult.outputAmount / 1e6  // Jupiter: convert from lamports
            : sellResult.outputAmount;       // Raydium USDC: already in dollars
        }

        // GROSS PnL = USD out - USD in
        // Note: Slippage is already reflected in the USD amounts:
        // - Entry: we paid sizeUsd and got fewer tokens than ideal (slippage baked in)
        // - Exit: we got less USD than quoted (slippage baked in)
        const grossPnlUsd = usdReceived - position.sizeUsd;

        // NET PnL = gross - SOL fees (priority + network)
        // IMPORTANT: We ONLY subtract SOL fees because slippage is already in the USD flow.
        // The tracked totalFeesUsd includes slippage which would double-count.
        const totalSolFeesUsd =
          (position.priorityFeesUsd ?? 0) + (position.networkFeesUsd ?? 0) +
          (exitFees?.priorityFeeUsd ?? 0) + (exitFees?.networkFeeUsd ?? 0);

        pnlUsd = grossPnlUsd - totalSolFeesUsd;
        pnlPct = (pnlUsd / position.sizeUsd) * 100;

        executionLogger.debug({
          ticker: position.stockTicker,
          usdIn: position.sizeUsd.toFixed(4),
          usdOut: usdReceived.toFixed(4),
          grossPnl: grossPnlUsd.toFixed(4),
          solFees: totalSolFeesUsd.toFixed(4),
          netPnl: pnlUsd.toFixed(4),
          totalFeesTracked: totalFeesUsd.toFixed(4),
        }, 'PnL calculation (net of SOL fees)');
      } else {
        // No sell result or sell failed
        // In live mode with an entry tx, this means the exit didn't happen properly
        // Don't calculate fake PnL - use zero or total loss depending on context
        if (config.mode === 'live' && this.executor.isLive() && position.entryTxSignature) {
          // Live trade with entry tx but no valid exit - this shouldn't happen in normal operation
          // The position likely has zero balance (dust) or the transaction failed
          // Set PnL to zero to avoid recording fake losses
          pnlUsd = 0;
          pnlPct = 0;
          executionLogger.warn({
            ticker: position.stockTicker,
            positionId: position.id,
            reason,
          }, 'Live exit with no sell result - setting PnL to zero (likely dust or failed tx)');
        } else {
          // PAPER MODE: Estimate PnL from discount change
          // Mean reversion: profit = (entryDiscount - exitDiscount) - fees
          const discountChange = position.entrySpreadPct - currentDiscountPct;
          const estimatedFeesPct = getEstimatedFeesPct(position.entryTvlUsd || 50000);
          pnlPct = discountChange - estimatedFeesPct;
          pnlUsd = position.sizeUsd * (pnlPct / 100);
        }
      }
      const totalPriorityFeesUsd = (position.priorityFeesUsd ?? 0) + (exitFees?.priorityFeeUsd ?? 0);
      const totalNetworkFeesUsd = (position.networkFeesUsd ?? 0) + (exitFees?.networkFeeUsd ?? 0);
      const totalSlippageUsd = (position.slippageUsd ?? 0) + (exitFees?.executionSlippageUsd ?? 0);
      const totalPlatformFeesUsd = (position.platformFeesUsd ?? 0) + (exitFees?.platformFeeUsd ?? 0);

      // Update position
      const closedPosition: MeanReversionPosition = {
        ...position,
        status: 'closed',
        exitSpreadPct: currentDiscountPct,
        exitTimestamp: Date.now(),
        exitReason: reason as MeanReversionPosition['exitReason'],
        pnlUsd,
        pnlPct,
        exitTxSignature: sellResult?.txSignature,
        // Fee tracking - combine entry + exit fees
        exitFeesUsd,
        totalFeesUsd,
        priorityFeesUsd: totalPriorityFeesUsd,
        networkFeesUsd: totalNetworkFeesUsd,
        slippageUsd: totalSlippageUsd,
        platformFeesUsd: totalPlatformFeesUsd,
        // Execution route tracking
        exitRoute: exitFees?.route,
      };

      this.database.savePosition(closedPosition);

      // Set exit cooldown to prevent self-interference on immediate re-entry
      // Our exit may have shifted pool liquidity, making immediate re-entry more expensive
      // Use buySymbol (token symbol) not stockTicker so different tokens can trade independently
      this.signalGenerator.setExitCooldown(position.buySymbol);

      // Record PnL and success
      this.riskManager.recordPnL(pnlUsd);
      this.riskManager.recordSuccess(position.buySymbol);

      // Circuit breaker: track consecutive losses (only for live trades with real PnL)
      if (config.mode === 'live' && this.executor.isLive()) {
        this.recordTradeForCircuitBreaker(pnlUsd);
      }

      executionLogger.info({
        positionId: position.id,
        ticker: position.stockTicker,
        pnlUsd: pnlUsd.toFixed(2),
        pnlPct: pnlPct.toFixed(3),
        reason,
        isLive: config.mode === 'live' && this.executor.isLive(),
        consecutiveLosses: this.consecutiveLosses,
      }, 'Mean reversion exit executed');

      // Discord notification
      notifyExit({
        type: 'exit',
        ticker: position.stockTicker,
        token: position.buySymbol,
        spreadPct: currentDiscountPct,
        sizeUsd: position.sizeUsd,
        pnlUsd,
        exitReason: reason,
        txSignature: sellResult?.txSignature,
      }).catch((err) => {
        executionLogger.warn({ error: err }, 'Discord notification failed for exit');
      });
    } catch (error) {
      executionLogger.error({ positionId: position.id, error }, 'Exit failed');
    } finally {
      this.executingExits.delete(position.id);
    }
  }

  /**
   * Persist state to database
   */
  private async persistState(): Promise<void> {
    this.database.saveState('riskState', this.riskManager.getSummary());
  }

  /**
   * Activate kill switch
   */
  activateKillSwitch(reason: string): void {
    this.riskManager.activateKillSwitch(reason);
  }

  /**
   * Deactivate kill switch
   */
  deactivateKillSwitch(): void {
    this.riskManager.deactivateKillSwitch();
  }

  /**
   * Get system status
   */
  async getStatus() {
    const config = getConfigSync();

    return {
      running: this.running,
      mode: config.mode,
      feedHealth: this.feedAggregator.getHealthStatus(),
      riskSummary: this.riskManager.getSummary(),
      meanReversion: {
        openPositions: (await this.database.getOpenPositions()).length,
        stats: await this.database.getStats(),
        targets: this.signalGenerator.getTargets().map(t => t.stockTicker),
      },
    };
  }
}

// Singleton
let orchestratorInstance: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new Orchestrator();
  }
  return orchestratorInstance;
}
