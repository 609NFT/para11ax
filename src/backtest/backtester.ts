/**
 * Backtester for Parallax mean reversion strategy
 * Replays historical spread data against configurable parameters
 */

import { Pool } from 'pg';
import logger from '../logger';

export interface BacktestConfig {
  // Entry conditions
  minEntrySpread: number;      // Minimum spread % to enter (e.g., 3.5)
  maxEntrySpread?: number;     // Maximum spread % to enter (optional cap)

  // Exit conditions
  targetSpread: number;        // Target spread % to exit (e.g., 0.5)
  stopLossSpread?: number;     // Stop loss spread % (optional)
  minHoldMs: number;           // Minimum hold time before exit allowed
  maxHoldMs: number;           // Maximum hold time (force exit)

  // Time-decaying exit
  decayStartMs?: number;       // When to start decay (default: 2h)
  decayEndMs?: number;         // When decay completes (default: 3.5h)
  minDecayedSpread?: number;   // Final decayed exit threshold (default: 1.0%)

  // Trailing stop
  trailingStopPullbackPct?: number;  // Pullback % from peak to exit (default: 0.05%)

  // Position sizing
  positionSizeUsd: number;     // Size per trade in USD
  maxConcurrentPositions: number;  // Max positions at once

  // Filters
  tokens?: string[];           // Specific tokens to test (null = all)
  startTime?: number;          // Start timestamp (null = all available)
  endTime?: number;            // End timestamp (null = now)

  // Fee assumptions
  entryFeePct: number;         // Entry fee as % of position (e.g., 0.3)
  exitFeePct: number;          // Exit fee as % of position
}

export interface BacktestTrade {
  token: string;
  entryTime: number;
  entrySpread: number;
  exitTime: number;
  exitSpread: number;
  exitReason: 'target' | 'stop_loss' | 'max_hold' | 'end_of_data' | 'trailing_stop';
  grossPnlPct: number;
  netPnlPct: number;
  netPnlUsd: number;
  holdTimeMs: number;
}

export interface BacktestResult {
  config: BacktestConfig;

  // Summary stats
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  // P&L
  totalPnlUsd: number;
  grossPnlUsd: number;
  totalFeesUsd: number;
  avgPnlPerTrade: number;
  largestWin: number;
  largestLoss: number;

  // Risk metrics
  sharpeRatio: number;         // Annualized Sharpe ratio (365 trading days)
  maxDrawdown: number;         // Maximum peak-to-trough drawdown in USD

  // Time stats
  avgHoldTimeMs: number;
  avgHoldTimeMin: number;

  // Equity curve
  equityCurve: { timestamp: number; equity: number }[];

  // By token
  byToken: Map<string, {
    trades: number;
    winRate: number;
    pnlUsd: number;
  }>;

  // By hour (UTC)
  byHour: Map<number, {
    trades: number;
    winRate: number;
    pnlUsd: number;
  }>;

  // Individual trades
  trades: BacktestTrade[];

  // Data coverage
  dataStartTime: number;
  dataEndTime: number;
  uniqueTokens: string[];
}

interface SpreadDataPoint {
  token: string;
  timestamp: number;
  spread: number;  // discount % (positive = discount, negative = premium)
}

interface OpenPosition {
  token: string;
  entryTime: number;
  entrySpread: number;
  peakImprovement: number;     // Best spread improvement seen (for trailing stop)
  inProfit: boolean;           // Whether position has been in profit
}

export class Backtester {
  private pool: Pool;

  constructor() {
    const connectionString = process.env.TRADES_DB_URL;
    if (!connectionString) {
      throw new Error('TRADES_DB_URL environment variable not set');
    }
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Fetch historical spread data from discount_history
   * Downsampled to reduce memory usage - takes 1 sample per 5 minutes per token
   */
  private async fetchSpreadData(
    startTime?: number,
    endTime?: number,
    tokens?: string[]
  ): Promise<SpreadDataPoint[]> {
    // Default to last 3 days if no start time specified (8 days max retention)
    const effectiveStartTime = startTime || (Date.now() - 3 * 24 * 60 * 60 * 1000);
    const effectiveEndTime = endTime || Date.now();

    const conditions: string[] = [`timestamp >= $1`, `timestamp <= $2`];
    const params: (number | string)[] = [effectiveStartTime, effectiveEndTime];
    let paramIdx = 3;

    if (tokens && tokens.length > 0) {
      conditions.push(`token_a_symbol = ANY($${paramIdx++})`);
      params.push(tokens as unknown as string);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Downsample to 5-minute buckets to reduce data volume
    const BUCKET_MS = 5 * 60 * 1000;

    const result = await this.pool.query(`
      SELECT
        token_a_symbol as token,
        (FLOOR(timestamp / ${BUCKET_MS}) * ${BUCKET_MS})::bigint as timestamp,
        AVG(COALESCE(token_a_discount_vs_stock, 0)) as spread
      FROM discount_history
      ${whereClause}
      GROUP BY token_a_symbol, FLOOR(timestamp / ${BUCKET_MS})
      ORDER BY timestamp ASC
    `, params);

    return result.rows.map(row => ({
      token: row.token,
      timestamp: Number(row.timestamp),
      spread: Number(row.spread),
    }));
  }

  /**
   * Run backtest with given configuration
   */
  async run(config: BacktestConfig): Promise<BacktestResult> {
    logger.info({ config }, 'Starting backtest');

    // Set defaults for new parameters
    const decayStartMs = config.decayStartMs ?? (2 * 60 * 60 * 1000);      // 2 hours
    const decayEndMs = config.decayEndMs ?? (3.5 * 60 * 60 * 1000);       // 3.5 hours
    const minDecayedSpread = config.minDecayedSpread ?? 1.0;               // 1.0%
    const trailingStopPullbackPct = config.trailingStopPullbackPct ?? 0.05; // 0.05%

    // Fetch spread data
    const spreadData = await this.fetchSpreadData(
      config.startTime,
      config.endTime,
      config.tokens
    );

    if (spreadData.length === 0) {
      throw new Error('No spread data found for backtest period');
    }

    logger.info({
      dataPoints: spreadData.length,
      startTime: new Date(spreadData[0].timestamp).toISOString(),
      endTime: new Date(spreadData[spreadData.length - 1].timestamp).toISOString(),
    }, 'Loaded spread data');

    // Track state
    const openPositions = new Map<string, OpenPosition>();  // token -> position
    const trades: BacktestTrade[] = [];
    const uniqueTokens = new Set<string>();
    const equityCurve: { timestamp: number; equity: number }[] = [];
    let cumulativePnl = 0;

    // Process each data point chronologically
    for (const dataPoint of spreadData) {
      uniqueTokens.add(dataPoint.token);
      const { token, timestamp, spread } = dataPoint;

      // Check for exits first
      const position = openPositions.get(token);
      if (position) {
        const holdTime = timestamp - position.entryTime;
        let shouldExit = false;
        let exitReason: BacktestTrade['exitReason'] = 'target';

        // Update trailing stop tracking
        const currentImprovement = position.entrySpread - spread;  // How much spread has improved
        if (currentImprovement > position.peakImprovement) {
          position.peakImprovement = currentImprovement;
        }

        // Track if position has ever been in profit
        if (spread < position.entrySpread) {
          position.inProfit = true;
        }

        // Check exit conditions (only after min hold time)
        if (holdTime >= config.minHoldMs) {
          // Calculate time-decaying exit threshold
          let exitThreshold = config.targetSpread;
          if (holdTime >= decayStartMs) {
            if (holdTime >= decayEndMs) {
              // Decay complete, use minimum
              exitThreshold = minDecayedSpread;
            } else {
              // Linear decay between decayStartMs and decayEndMs
              const decayProgress = (holdTime - decayStartMs) / (decayEndMs - decayStartMs);
              exitThreshold = config.targetSpread + decayProgress * (minDecayedSpread - config.targetSpread);
            }
          }

          // Target reached (spread collapsed below decaying threshold)
          if (spread <= exitThreshold) {
            shouldExit = true;
            exitReason = 'target';
          }
          // Stop loss (spread widened further)
          else if (config.stopLossSpread && spread >= config.stopLossSpread) {
            shouldExit = true;
            exitReason = 'stop_loss';
          }
          // Trailing stop: position was profitable but pulled back
          else if (position.inProfit &&
                   currentImprovement <= position.peakImprovement - trailingStopPullbackPct) {
            shouldExit = true;
            exitReason = 'trailing_stop';
          }
        }

        // Max hold time exceeded
        if (holdTime >= config.maxHoldMs) {
          shouldExit = true;
          exitReason = 'max_hold';
        }

        if (shouldExit) {
          const trade = this.closeTrade(position, timestamp, spread, exitReason, config);
          trades.push(trade);
          cumulativePnl += trade.netPnlUsd;
          openPositions.delete(token);
        }
      }

      // Check for entry
      if (!openPositions.has(token) && openPositions.size < config.maxConcurrentPositions) {
        // Entry conditions
        if (spread >= config.minEntrySpread) {
          if (!config.maxEntrySpread || spread <= config.maxEntrySpread) {
            openPositions.set(token, {
              token,
              entryTime: timestamp,
              entrySpread: spread,
              peakImprovement: 0,
              inProfit: false,
            });
          }
        }
      }

      // Record equity curve at regular intervals (every hour)
      if (equityCurve.length === 0 ||
          timestamp - equityCurve[equityCurve.length - 1].timestamp >= 60 * 60 * 1000) {
        equityCurve.push({ timestamp, equity: cumulativePnl });
      }
    }

    // Close any remaining positions at end of data
    const endTime = spreadData[spreadData.length - 1].timestamp;
    openPositions.forEach((position, token) => {
      // Find last spread for this token
      const lastSpread = spreadData
        .filter(d => d.token === token)
        .pop()?.spread ?? position.entrySpread;

      const trade = this.closeTrade(position, endTime, lastSpread, 'end_of_data', config);
      trades.push(trade);
      cumulativePnl += trade.netPnlUsd;
    });

    // Ensure final equity point
    if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].timestamp < endTime) {
      equityCurve.push({ timestamp: endTime, equity: cumulativePnl });
    }

    // Calculate results
    return this.calculateResults(config, trades, spreadData, Array.from(uniqueTokens), equityCurve);
  }

  private closeTrade(
    position: OpenPosition,
    exitTime: number,
    exitSpread: number,
    exitReason: BacktestTrade['exitReason'],
    config: BacktestConfig
  ): BacktestTrade {
    const holdTimeMs = exitTime - position.entryTime;

    // P&L calculation:
    // Entry at X% discount, exit at Y% discount
    // Profit = (entrySpread - exitSpread) as % of position
    // (buying at 5% discount, selling at 1% discount = 4% gain)
    const grossPnlPct = position.entrySpread - exitSpread;
    const totalFeePct = config.entryFeePct + config.exitFeePct;
    const netPnlPct = grossPnlPct - totalFeePct;
    const netPnlUsd = (netPnlPct / 100) * config.positionSizeUsd;

    return {
      token: position.token,
      entryTime: position.entryTime,
      entrySpread: position.entrySpread,
      exitTime,
      exitSpread,
      exitReason,
      grossPnlPct,
      netPnlPct,
      netPnlUsd,
      holdTimeMs,
    };
  }

  private calculateResults(
    config: BacktestConfig,
    trades: BacktestTrade[],
    spreadData: SpreadDataPoint[],
    uniqueTokens: string[],
    equityCurve: { timestamp: number; equity: number }[]
  ): BacktestResult {
    const winningTrades = trades.filter(t => t.netPnlUsd > 0);
    const losingTrades = trades.filter(t => t.netPnlUsd <= 0);

    const totalPnlUsd = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const grossPnlUsd = trades.reduce((sum, t) => sum + (t.grossPnlPct / 100) * config.positionSizeUsd, 0);
    const totalFeesUsd = grossPnlUsd - totalPnlUsd;

    // Calculate Sharpe ratio
    let sharpeRatio = 0;
    if (trades.length > 1) {
      const tradePnls = trades.map(t => t.netPnlUsd);
      const mean = tradePnls.reduce((sum, pnl) => sum + pnl, 0) / tradePnls.length;
      const variance = tradePnls.reduce((sum, pnl) => sum + Math.pow(pnl - mean, 2), 0) / (tradePnls.length - 1);
      const stdDev = Math.sqrt(variance);

      if (stdDev > 0) {
        // Annualize assuming 365 trading days
        // Adjust for trade frequency: if we made N trades over D days, daily return = mean * (N/D)
        const durationMs = spreadData[spreadData.length - 1].timestamp - spreadData[0].timestamp;
        const durationDays = durationMs / (24 * 60 * 60 * 1000);
        const tradesPerDay = trades.length / durationDays;
        const dailyExpectedReturn = mean * tradesPerDay;
        const dailyStdDev = stdDev * Math.sqrt(tradesPerDay);

        sharpeRatio = (dailyExpectedReturn / dailyStdDev) * Math.sqrt(365);
      }
    }

    // Calculate max drawdown from equity curve
    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equityCurve) {
      if (point.equity > peak) {
        peak = point.equity;
      }
      const drawdown = peak - point.equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // By token stats
    const byToken = new Map<string, { trades: number; winRate: number; pnlUsd: number }>();
    for (const token of uniqueTokens) {
      const tokenTrades = trades.filter(t => t.token === token);
      const tokenWins = tokenTrades.filter(t => t.netPnlUsd > 0).length;
      byToken.set(token, {
        trades: tokenTrades.length,
        winRate: tokenTrades.length > 0 ? tokenWins / tokenTrades.length : 0,
        pnlUsd: tokenTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
      });
    }

    // By hour stats
    const byHour = new Map<number, { trades: number; winRate: number; pnlUsd: number }>();
    for (let hour = 0; hour < 24; hour++) {
      const hourTrades = trades.filter(t => new Date(t.entryTime).getUTCHours() === hour);
      const hourWins = hourTrades.filter(t => t.netPnlUsd > 0).length;
      byHour.set(hour, {
        trades: hourTrades.length,
        winRate: hourTrades.length > 0 ? hourWins / hourTrades.length : 0,
        pnlUsd: hourTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
      });
    }

    const avgHoldTimeMs = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.holdTimeMs, 0) / trades.length
      : 0;

    return {
      config,
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
      totalPnlUsd,
      grossPnlUsd,
      totalFeesUsd,
      avgPnlPerTrade: trades.length > 0 ? totalPnlUsd / trades.length : 0,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.netPnlUsd)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.netPnlUsd)) : 0,
      sharpeRatio,
      maxDrawdown,
      avgHoldTimeMs,
      avgHoldTimeMin: avgHoldTimeMs / (60 * 1000),
      equityCurve,
      byToken,
      byHour,
      trades,
      dataStartTime: spreadData[0].timestamp,
      dataEndTime: spreadData[spreadData.length - 1].timestamp,
      uniqueTokens,
    };
  }
}

/**
 * CLI runner for quick backtests
 */
export async function runBacktest(config: Partial<BacktestConfig> = {}): Promise<BacktestResult> {
  const fullConfig: BacktestConfig = {
    minEntrySpread: config.minEntrySpread ?? 3.5,
    maxEntrySpread: config.maxEntrySpread,
    targetSpread: config.targetSpread ?? 0.5,
    stopLossSpread: config.stopLossSpread,
    minHoldMs: config.minHoldMs ?? 5 * 60 * 1000,      // 5 min
    maxHoldMs: config.maxHoldMs ?? 4 * 60 * 60 * 1000, // 4 hours
    decayStartMs: config.decayStartMs ?? 2 * 60 * 60 * 1000,     // 2 hours
    decayEndMs: config.decayEndMs ?? 3.5 * 60 * 60 * 1000,       // 3.5 hours
    minDecayedSpread: config.minDecayedSpread ?? 1.0,             // 1.0%
    trailingStopPullbackPct: config.trailingStopPullbackPct ?? 0.05, // 0.05%
    positionSizeUsd: config.positionSizeUsd ?? 10,
    maxConcurrentPositions: config.maxConcurrentPositions ?? 3,
    tokens: config.tokens,
    startTime: config.startTime,
    endTime: config.endTime,
    entryFeePct: config.entryFeePct ?? 0.3,
    exitFeePct: config.exitFeePct ?? 0.3,
  };

  const backtester = new Backtester();
  try {
    return await backtester.run(fullConfig);
  } finally {
    await backtester.close();
  }
}

/**
 * Compare multiple configurations
 */
export async function compareConfigs(
  configs: Partial<BacktestConfig>[]
): Promise<{ config: Partial<BacktestConfig>; result: BacktestResult }[]> {
  const results: { config: Partial<BacktestConfig>; result: BacktestResult }[] = [];

  for (const config of configs) {
    const result = await runBacktest(config);
    results.push({ config, result });
  }

  return results;
}
