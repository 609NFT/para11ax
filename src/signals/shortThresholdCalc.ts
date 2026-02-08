/**
 * Short Threshold Calculator — Data-Driven
 *
 * Computes entry/exit thresholds for premium shorting based on:
 * 1. On-chain Flash Trade fees (decoded from Remora pool custody accounts)
 * 2. Historical spread volatility (from Supabase discount_history)
 * 3. Premium reversion rates (computed from spread time series)
 *
 * No hardcoded per-symbol multipliers. Everything derived from data.
 * Recalculates on each bot startup using the last N days of spread data.
 *
 * If data sources are unavailable, falls back to conservative defaults.
 */

import dns from 'dns';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { PoolConfig, IDL } from 'flash-sdk';
import { Client as PgClient } from 'pg';
import logger from '../logger';
import { getConfigSync } from '../config';

// Ensure IPv4 resolution for Supabase pooler (IPv6-only direct host is unreachable)
dns.setDefaultResultOrder('ipv4first');

// =============================================================================
// PROTOCOL CONSTANTS (not per-symbol — these describe how Flash Trade works)
// =============================================================================

/** Flash Trade stores fees with 10^9 precision */
const RATE_POWER = 1_000_000_000;

/** Remora pool name on Flash Trade (rStock perps) */
const POOL_NAME = 'Remora.1';
const CLUSTER = 'mainnet-beta';

// =============================================================================
// ALGORITHM PARAMETERS
// These control the algo behavior. They are NOT per-symbol tuning knobs.
// Changing these changes behavior for ALL symbols uniformly.
// =============================================================================

/** Days of spread history to analyze */
const LOOKBACK_DAYS = 3;

/** Bucket size for time series analysis (ms) */
const BUCKET_SIZE_MS = 300_000; // 5 minutes

/** Entry must clear this multiple of round-trip fees to be profitable */
const PROFIT_MULTIPLIER = 2.5;

/** Entry must be this many standard deviations of spread noise */
const NOISE_MULTIPLIER = 2.0;

/** Symbol must show at least this 30-min reversion rate to be shortable */
const MIN_REVERSION_RATE = 0.40;

/** Absolute floor — never short below this premium regardless of data */
const MIN_ENTRY_THRESHOLD_PCT = 0.15;

/** Minimum premium events required for statistical confidence */
const MIN_SAMPLE_SIZE = 10;

/** Leverage bounds (Flash Trade requires ≥2x for rStock markets) */
const MIN_LEVERAGE = 2.0;
const MAX_LEVERAGE = 3.0;

// Fallback values when data is unavailable
const FALLBACK_ENTRY_PCT = 0.5;
const FALLBACK_EXIT_RATIO = 0.4;
const FALLBACK_STOP_LOSS_FACTOR = 3.0;
const FALLBACK_LEVERAGE = 2.0;

// =============================================================================
// TYPES
// =============================================================================

export interface OnChainFees {
  openPositionBps: number;
  closePositionBps: number;
  roundTripBps: number;
  roundTripPct: number;
  volatilityBps: number;
}

export interface SpreadStats {
  /** Std dev of 5-min spread changes (measures noise level) */
  spreadVol: number;
  /** Average discount when token is at premium (negative number) */
  avgPremiumWhenPremium: number;
  /** % of time token trades at >0.1% premium */
  premiumFreqPct: number;
  /** Fraction of >0.1% premium events where premium halves within 30min */
  reversionRate30m: number;
  /** Fraction of >0.1% premium events where premium halves within 60min */
  reversionRate60m: number;
  /** Fraction where premium fully disappears in 30min */
  flatRate30m: number;
  /** Fraction where premium expands 1.5x in 30min */
  expandRate30m: number;
  /** Number of premium events analyzed */
  sampleSize: number;
  /** Average fraction of premium that reverts in 30min (0-1) */
  avgReversionFraction: number;
}

export interface ComputedThreshold {
  ticker: string;
  flashSymbol: string;

  // Inputs
  fees: OnChainFees;
  stats: SpreadStats;

  // Outputs
  /** Positive number: minimum premium % to enter (e.g., 0.5 = need 0.5% premium) */
  entryThresholdPct: number;
  /** Fraction of entry premium at which to take profit (e.g., 0.4 = exit at 40% of entry) */
  exitRatio: number;
  /** Multiple of entry premium at which to stop-loss (e.g., 2.5 = stop at 2.5x entry) */
  stopLossFactor: number;
  /** Recommended leverage for this symbol */
  leverage: number;

  /** Whether this symbol should be shorted at all */
  eligible: boolean;
  /** Human-readable explanation of the decision */
  reason: string;
  /** When this was computed */
  computedAt: number;
}

// =============================================================================
// STATE
// =============================================================================

const computedThresholds: Map<string, ComputedThreshold> = new Map();
let _initialized = false;

// =============================================================================
// PUBLIC API
// =============================================================================

export function isShortThresholdsInitialized(): boolean {
  return _initialized;
}

/**
 * Get computed threshold for a ticker (e.g., "TSLA", "SPY").
 * Returns null if ticker not found.
 */
export function getComputedThreshold(ticker: string): ComputedThreshold | null {
  return computedThresholds.get(ticker) ?? null;
}

/** Get all computed thresholds */
export function getAllComputedThresholds(): ComputedThreshold[] {
  return Array.from(computedThresholds.values());
}

/**
 * Get entry threshold as a NEGATIVE number (for compatibility with premium signal).
 * Returns null if ticker is not eligible for shorting.
 */
export function getShortEntryThresholdComputed(ticker: string): number | null {
  const t = computedThresholds.get(ticker);
  if (!t || !t.eligible) return null;
  return -t.entryThresholdPct;
}

export function getShortExitRatioComputed(ticker: string): number {
  return computedThresholds.get(ticker)?.exitRatio ?? FALLBACK_EXIT_RATIO;
}

export function getShortStopLossFactorComputed(ticker: string): number {
  return computedThresholds.get(ticker)?.stopLossFactor ?? FALLBACK_STOP_LOSS_FACTOR;
}

export function getShortLeverageComputed(ticker: string): number {
  return computedThresholds.get(ticker)?.leverage ?? FALLBACK_LEVERAGE;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the threshold calculator.
 * Reads on-chain fees and historical spread data, then computes thresholds.
 * Call this after Flash Trade client is initialized.
 */
export async function initializeShortThresholds(): Promise<boolean> {
  try {
    logger.info('Computing data-driven short thresholds...');

    const poolConfig = PoolConfig.fromIdsByName(POOL_NAME, CLUSTER);
    const config = getConfigSync();

    // Step 1: Read on-chain fees from Remora pool custody accounts
    const feeMap = await readOnChainFees(config.rpcEndpoint, poolConfig);

    // Step 2: Read historical spread statistics from Supabase
    const statsMap = await readSpreadStatistics(poolConfig);

    // Step 3: Compute median spread volatility across all symbols (for leverage scaling)
    const allVols = Object.values(statsMap)
      .map(s => s.spreadVol)
      .filter(v => v > 0);
    const medianVol = allVols.length > 0
      ? allVols.sort((a, b) => a - b)[Math.floor(allVols.length / 2)]
      : 0.4;

    // Step 4: Compute thresholds for each symbol
    computedThresholds.clear();

    for (const [flashSymbol, stats] of Object.entries(statsMap)) {
      const fee = feeMap.get(flashSymbol);
      if (!fee) {
        logger.warn({ flashSymbol }, 'No on-chain fee data — skipping');
        continue;
      }

      const threshold = computeThreshold(flashSymbol, fee, stats, medianVol);

      // Store by underlying ticker (TSLA, not TSLAr)
      // Strip trailing r/x suffix for the lookup key
      const underlyingTicker = flashSymbol.replace(/[rx]$/i, '').toUpperCase();
      computedThresholds.set(underlyingTicker, threshold);

      logger.info({
        ticker: underlyingTicker,
        flashSymbol,
        eligible: threshold.eligible,
        entryPct: threshold.entryThresholdPct.toFixed(4),
        exitRatio: threshold.exitRatio.toFixed(2),
        stopLoss: threshold.stopLossFactor.toFixed(2),
        leverage: threshold.leverage.toFixed(1),
        feeBps: fee.roundTripBps.toFixed(1),
        spreadVol: stats.spreadVol.toFixed(4),
        reversion30m: `${(stats.reversionRate30m * 100).toFixed(0)}%`,
        premFreq: `${stats.premiumFreqPct.toFixed(1)}%`,
        samples: stats.sampleSize,
        reason: threshold.reason,
      }, `Threshold: ${underlyingTicker}`);
    }

    _initialized = true;
    logger.info({
      symbolCount: computedThresholds.size,
      eligible: Array.from(computedThresholds.values()).filter(t => t.eligible).map(t => t.ticker),
      ineligible: Array.from(computedThresholds.values()).filter(t => !t.eligible).map(t => `${t.ticker}: ${t.reason}`),
    }, 'Short thresholds initialized');

    return true;
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Failed to initialize short thresholds — using fallbacks');
    _initialized = false;
    return false;
  }
}

// =============================================================================
// ON-CHAIN FEE READING
// Fetches custody account data from Solana and decodes fee parameters
// =============================================================================

async function readOnChainFees(
  rpcEndpoint: string,
  poolConfig: PoolConfig,
): Promise<Map<string, OnChainFees>> {
  const result = new Map<string, OnChainFees>();

  try {
    const connection = new Connection(rpcEndpoint, 'confirmed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coder = new BorshAccountsCoder(IDL as any);

    // Batch-fetch all custody accounts in one RPC call
    const custodyPubkeys = poolConfig.custodies.map(
      c => new PublicKey((c as unknown as Record<string, string>).custodyAccount),
    );
    const accounts = await connection.getMultipleAccountsInfo(custodyPubkeys);

    for (let i = 0; i < poolConfig.custodies.length; i++) {
      const custody = poolConfig.custodies[i];
      const accountInfo = accounts[i];

      if (!accountInfo || custody.isStable) continue;

      try {
        const decoded = coder.decode('custody', accountInfo.data);

        const openBps = decoded.fees.openPosition.toNumber() / RATE_POWER * 10000;
        const closeBps = decoded.fees.closePosition.toNumber() / RATE_POWER * 10000;
        const volBps = decoded.fees.volatility.toNumber() / RATE_POWER * 10000;

        result.set(custody.symbol, {
          openPositionBps: openBps,
          closePositionBps: closeBps,
          roundTripBps: openBps + closeBps,
          roundTripPct: (openBps + closeBps) / 100,
          volatilityBps: volBps,
        });

        logger.debug({
          symbol: custody.symbol,
          openBps: openBps.toFixed(1),
          closeBps: closeBps.toFixed(1),
          roundTripBps: (openBps + closeBps).toFixed(1),
          volBps: volBps.toFixed(1),
        }, `On-chain fees: ${custody.symbol}`);
      } catch (e) {
        logger.warn({ symbol: custody.symbol, error: String(e) }, 'Failed to decode custody');
      }
    }

    logger.info({ symbols: Array.from(result.keys()) }, `Read on-chain fees for ${result.size} custodies`);
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to read on-chain fees — thresholds will use fallbacks');
  }

  return result;
}

// =============================================================================
// SPREAD STATISTICS FROM SUPABASE
// Queries bucketed discount_history and computes volatility + reversion rates
// =============================================================================

async function readSpreadStatistics(
  poolConfig: PoolConfig,
): Promise<Record<string, SpreadStats>> {
  const result: Record<string, SpreadStats> = {};
  let client: PgClient | null = null;

  try {
    // Build connection string from credentials file
    const connStr = buildSupabasePoolerUrl();
    if (!connStr) {
      logger.warn('No Supabase pooler URL available — spread stats will use defaults');
      return result;
    }

    client = new PgClient({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    // Get shortable symbols from pool config
    const symbols = poolConfig.custodies
      .filter(c => !c.isStable)
      .map(c => c.symbol);

    // Query all symbols (sequentially to avoid overloading Supabase)
    for (const symbol of symbols) {
      try {
        result[symbol] = await computeSpreadStats(client, symbol, cutoffMs);
      } catch (e) {
        logger.warn({ symbol, error: String(e) }, 'Failed to compute spread stats');
      }
    }

    logger.info({ symbols: Object.keys(result) }, `Spread stats computed for ${Object.keys(result).length} symbols`);
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to read spread statistics from Supabase');
  } finally {
    if (client) {
      try { await client.end(); } catch (error) { 
        logger.debug({ error: String(error) }, 'Failed to close Supabase client connection');
      }
    }
  }

  return result;
}

/**
 * Build the Supabase pooler URL from credentials.
 * Tries secrets file first, then env var.
 */
function buildSupabasePoolerUrl(): string | null {
  // Try env var first
  if (process.env.SUPABASE_DB_URL) {
    return process.env.SUPABASE_DB_URL;
  }

  // Try secrets file
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const creds = require('/home/ec2-user/.parallax-secrets/supabase-db.json');
    const password = creds.password;
    if (!password) return null;

    // Extract project ref from SUPABASE_URL env var if available
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const refMatch = supabaseUrl.match(/https?:\/\/([^.]+)\.supabase\.co/);
    const projectRef = refMatch ? refMatch[1] : 'tixpkokukqccehbnpkpf';

    // Determine region from SUPABASE_URL or default
    // The pooler host format: aws-0-{region}.pooler.supabase.com
    const region = 'us-west-2'; // Could be derived from URL in future

    return `postgresql://postgres.${projectRef}:${password}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
  } catch (error) {
    logger.debug({ error }, 'Failed to load Supabase credentials from secrets file');
    return null;
  }
}

/**
 * Compute spread statistics for a single symbol from bucketed time series.
 */
async function computeSpreadStats(
  client: PgClient,
  symbol: string,
  cutoffMs: number,
): Promise<SpreadStats> {
  // Fetch bucketed time series
  const queryResult = await client.query(
    `SELECT (timestamp / $1) AS bucket, AVG(token_a_discount_vs_stock) AS d
     FROM discount_history
     WHERE token_a_symbol = $2
       AND timestamp > $3
       AND token_a_discount_vs_stock IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket`,
    [BUCKET_SIZE_MS, symbol, cutoffMs],
  );

  const values: number[] = queryResult.rows.map((r: { d: string }) => parseFloat(r.d));

  // Not enough data — return defaults
  if (values.length < 24) {
    return defaultSpreadStats();
  }

  // --- Spread volatility: stddev of 5-min changes ---
  const deltas: number[] = [];
  for (let i = 1; i < values.length; i++) {
    deltas.push(values[i] - values[i - 1]);
  }
  const spreadVol = Math.sqrt(
    deltas.reduce((sum, d) => sum + d * d, 0) / deltas.length,
  );

  // --- Premium statistics ---
  const premiums = values.filter(v => v < -0.1); // >0.1% premium
  const premiumFreqPct = (premiums.length / values.length) * 100;
  const avgPremiumWhenPremium = premiums.length > 0
    ? premiums.reduce((s, v) => s + v, 0) / premiums.length
    : 0;

  // --- Reversion analysis ---
  let total = 0;
  let revert30 = 0;
  let revert60 = 0;
  let flat30 = 0;
  let expand30 = 0;
  let premSumEntry = 0;
  let premSum30 = 0;

  for (let i = 0; i < values.length - 12; i++) {
    if (values[i] >= -0.1) continue; // Only analyze premium events
    total++;
    premSumEntry += values[i];

    const d6 = values[i + 6];   // ~30 min later
    const d12 = values[i + 12]; // ~60 min later
    premSum30 += d6;

    // Premium halved (moved toward 0 by ≥50%)
    if (d6 > values[i] * 0.5) revert30++;
    if (d12 > values[i] * 0.5) revert60++;

    // Premium fully gone
    if (d6 >= 0) flat30++;

    // Premium expanded ≥50%
    if (d6 < values[i] * 1.5) expand30++;
  }

  const reversionRate30m = total > 0 ? revert30 / total : 0;
  const reversionRate60m = total > 0 ? revert60 / total : 0;
  const flatRate30m = total > 0 ? flat30 / total : 0;
  const expandRate30m = total > 0 ? expand30 / total : 0;

  // Average reversion fraction: what fraction of the premium disappears in 30min
  // (1 - avg_premium_30min / avg_entry_premium)
  const avgReversionFraction = total > 0 && premSumEntry !== 0
    ? Math.max(0, Math.min(1, 1 - (premSum30 / total) / (premSumEntry / total)))
    : 0.5;

  return {
    spreadVol,
    avgPremiumWhenPremium,
    premiumFreqPct,
    reversionRate30m,
    reversionRate60m,
    flatRate30m,
    expandRate30m,
    sampleSize: total,
    avgReversionFraction,
  };
}

function defaultSpreadStats(): SpreadStats {
  return {
    spreadVol: 0.5,
    avgPremiumWhenPremium: 0,
    premiumFreqPct: 0,
    reversionRate30m: 0,
    reversionRate60m: 0,
    flatRate30m: 0,
    expandRate30m: 0,
    sampleSize: 0,
    avgReversionFraction: 0.5,
  };
}

// =============================================================================
// THRESHOLD COMPUTATION
// Pure function: inputs → threshold. No side effects.
// =============================================================================

function computeThreshold(
  flashSymbol: string,
  fees: OnChainFees,
  stats: SpreadStats,
  medianVol: number,
): ComputedThreshold {
  const now = Date.now();
  const ticker = flashSymbol;

  // --- Eligibility gate 1: enough data ---
  if (stats.sampleSize < MIN_SAMPLE_SIZE) {
    return ineligible(ticker, flashSymbol, fees, stats, now,
      `Insufficient data: ${stats.sampleSize} premium events < ${MIN_SAMPLE_SIZE} minimum`);
  }

  // --- Eligibility gate 2: premium must actually revert ---
  if (stats.reversionRate30m < MIN_REVERSION_RATE) {
    return ineligible(ticker, flashSymbol, fees, stats, now,
      `Structural premium: ${(stats.reversionRate30m * 100).toFixed(0)}% reversion < ${MIN_REVERSION_RATE * 100}% minimum`);
  }

  // --- Compute entry threshold ---
  // Two floors: must clear both fees AND noise
  const feeFloor = fees.roundTripPct * PROFIT_MULTIPLIER;
  const noiseFloor = stats.spreadVol * NOISE_MULTIPLIER;
  const entryThresholdPct = Math.max(feeFloor, noiseFloor, MIN_ENTRY_THRESHOLD_PCT);

  // --- Compute exit ratio from reversion data ---
  // avgReversionFraction tells us what fraction of premium typically reverts in 30min
  // We target capturing ~80% of the expected reversion
  // Higher reversion → lower exit ratio (take profit sooner since it reverts fast)
  const exitRatio = Math.max(0.25, Math.min(0.7, 1 - stats.avgReversionFraction * 0.8));

  // --- Compute stop-loss from spread volatility ---
  // Stop if premium expands beyond entry + 2 stddev of spread noise
  const rawStopFactor = 1 + Math.max(1.5, 2 * stats.spreadVol / entryThresholdPct);
  const stopLossFactor = Math.min(5.0, Math.max(2.0, rawStopFactor));

  // --- Compute leverage from spread volatility ---
  // Lower vol → higher leverage (more predictable, less risk)
  // Higher vol → lower leverage (wilder swings, more risk)
  const volRatio = medianVol > 0 ? stats.spreadVol / medianVol : 1;
  const rawLeverage = MAX_LEVERAGE - (volRatio - 0.5) * (MAX_LEVERAGE - MIN_LEVERAGE);
  const leverage = Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE, rawLeverage));

  const reason = [
    `fee_floor=${feeFloor.toFixed(3)}%`,
    `noise_floor=${noiseFloor.toFixed(3)}%`,
    `entry=${entryThresholdPct.toFixed(3)}%`,
    `reversion=${(stats.reversionRate30m * 100).toFixed(0)}%`,
    `expand=${(stats.expandRate30m * 100).toFixed(0)}%`,
  ].join(', ');

  return {
    ticker,
    flashSymbol,
    fees,
    stats,
    entryThresholdPct,
    exitRatio,
    stopLossFactor,
    leverage,
    eligible: true,
    reason,
    computedAt: now,
  };
}

function ineligible(
  ticker: string,
  flashSymbol: string,
  fees: OnChainFees,
  stats: SpreadStats,
  now: number,
  reason: string,
): ComputedThreshold {
  return {
    ticker,
    flashSymbol,
    fees,
    stats,
    entryThresholdPct: FALLBACK_ENTRY_PCT,
    exitRatio: FALLBACK_EXIT_RATIO,
    stopLossFactor: FALLBACK_STOP_LOSS_FACTOR,
    leverage: FALLBACK_LEVERAGE,
    eligible: false,
    reason,
    computedAt: now,
  };
}
