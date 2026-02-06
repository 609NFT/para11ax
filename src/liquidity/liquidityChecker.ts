/**
 * Liquidity Checker - Fetches pool TVL and calculates dynamic entry thresholds
 *
 * ALWAYS checks ALL liquidity sources for EVERY token:
 * 1. Raydium API - for tokens with known pool addresses (direct swap, lower fees)
 * 2. DexScreener API - batch endpoint for all tokens (aggregated pool data)
 * 3. GeckoTerminal API - batch endpoint for all tokens (additional pool data)
 *
 * Then uses the pool with HIGHEST liquidity across all sources.
 * If Raydium has the best pool, use Raydium direct (lower fees).
 * Otherwise use Jupiter aggregator to route through the higher liquidity pool.
 *
 * RESILIENCE FEATURES:
 * - Primary endpoint: api.jup.ag (with API key)
 * - Fallback endpoint: public.jupiterapi.com (no auth required)
 * - Automatic failover on auth errors
 */

import { getConfigSync, refreshTokensFromDb } from '../config';
import logger from '../logger';
import {
  TVL_ENTRY_THRESHOLDS,
  MIN_TVL_FOR_TRADING,
  LIQUIDITY_REFRESH_INTERVAL_MS,
  API_BATCH_SIZE,
  API_BATCH_DELAY_MS,
  USDC_MINT,
  SOL_MINT,
  ENTRY_THRESHOLD_FORMULA,
  EXIT_THRESHOLD_FORMULA,
  POSITION_SIZE_FORMULA,
  PERCENTILE_THRESHOLD_FORMULA,
} from '../constants';
import { getDatabase } from '../db';
import { fetchBatchDexScreenerPrices, DexScreenerPrice } from '../feeds/dexScreenerFeed';
import { fetchBatchGeckoTerminalPrices, GeckoTerminalPrice } from '../feeds/geckoTerminalFeed';
import { recordApiCall } from '../feeds/endpointTracker';
import { calculateAllProfitableSpreads, TokenProfitableSpread } from '../db/profitableSpreadCalc';

interface PoolLiquidity {
  poolAddress: string;
  tvl: number;
  lastUpdated: number;
}

interface TokenThreshold {
  symbol: string;
  tvl: number;
  entryThresholdPct: number;       // TVL/fee-based minimum threshold
  exitThresholdPct: number;
  enabled: boolean;
  feeRate?: number;                // Pool fee rate (e.g., 0.0025 = 0.25%)
  percentileThresholdPct?: number; // Percentile-based adaptive threshold
  percentileSamples?: number;      // Number of samples used for percentile calculation
}

// Best pool info for a token - used for routing decisions
interface BestPoolInfo {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  quoteToken: 'USDC' | 'SOL' | 'OTHER';
  quoteMint: string;
  source: 'raydium' | 'dexscreener' | 'geckoterminal';
  isRaydium: boolean;  // true = can use Raydium direct, false = use Jupiter
  feeRate?: number;    // Pool fee rate (e.g., 0.0025 = 0.25%)
}

// Cache of pool liquidity data (for Raydium pools in config)
const liquidityCache: Map<string, PoolLiquidity> = new Map();

// Cache of computed thresholds per token
const thresholdCache: Map<string, TokenThreshold> = new Map();

// Best pool for each token (highest liquidity across all sources)
const bestPoolCache: Map<string, BestPoolInfo> = new Map();

// Cache of historically profitable spreads per token (stock ticker -> profitable spread data)
let profitableSpreadCache: Map<string, TokenProfitableSpread> = new Map();
let profitableSpreadLastRefresh = 0;
const PROFITABLE_SPREAD_REFRESH_MS = 60 * 60 * 1000; // Refresh every hour

// Best SOL pool for each token (for routing comparison)
interface BestSolPoolInfo {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  source: 'raydium' | 'dexscreener' | 'geckoterminal';
  isRaydium: boolean;
}
const bestSolPoolCache: Map<string, BestSolPoolInfo> = new Map();

// Jupiter tradability cache - tracks tokens that Jupiter can't trade
// Key: mint address, Value: timestamp of last check
const jupiterUntradableCache: Map<string, number> = new Map();
const JUPITER_UNTRADABLE_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours - don't keep retrying

// Best fee rate cache - stores the better of Raydium vs Jupiter fee for each token
// Key: symbol, Value: { feeRate, source, lastUpdated }
interface BestFeeInfo {
  feeRate: number;       // Best fee rate (e.g., 0.001 = 0.1%)
  source: 'raydium' | 'jupiter';
  lastUpdated: number;
}
const bestFeeCache: Map<string, BestFeeInfo> = new Map();
const BEST_FEE_CACHE_TTL_MS = 30_000; // 30 seconds - refresh with pool data

// Jupiter API fallback
const JUPITER_FALLBACK_API_URL = 'https://public.jupiterapi.com';
let usingJupiterFallback = false;
let jupiterFallbackUntil = 0;

function checkAndResetJupiterFallback(): void {
  if (usingJupiterFallback && Date.now() > jupiterFallbackUntil) {
    logger.info('Attempting to switch back to primary Jupiter API for liquidity checks');
    usingJupiterFallback = false;
  }
}

function switchToJupiterFallback(reason: string): void {
  if (!usingJupiterFallback) {
    usingJupiterFallback = true;
    jupiterFallbackUntil = Date.now() + 5 * 60 * 1000; // Retry primary in 5 minutes
    logger.warn({ reason }, 'Switched to fallback Jupiter API for liquidity checks');
  }
}

// Last full refresh timestamp
let lastRefreshTime = 0;

/**
 * Check if Jupiter can trade a token (quick quote check)
 * Uses fallback API if primary fails with auth error
 */
async function checkJupiterTradability(mint: string): Promise<boolean> {
  // Check cache first
  const cachedTime = jupiterUntradableCache.get(mint);
  if (cachedTime && Date.now() - cachedTime < JUPITER_UNTRADABLE_CACHE_MS) {
    return false; // Known untradable
  }

  // Check if we should reset fallback state
  checkAndResetJupiterFallback();

  const apiUrls = usingJupiterFallback
    ? [JUPITER_FALLBACK_API_URL, getConfigSync().jupiterApiUrl]
    : [getConfigSync().jupiterApiUrl, JUPITER_FALLBACK_API_URL];

  for (const apiUrl of apiUrls) {
    try {
      const jupiterApiKey = process.env.JUPITER_API_KEY;
      const headers: Record<string, string> = {};
      if (jupiterApiKey && apiUrl !== JUPITER_FALLBACK_API_URL) {
        headers['x-api-key'] = jupiterApiKey;
      }

      const response = await fetch(
        `${apiUrl}/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=1000000&slippageBps=100`,
        { signal: AbortSignal.timeout(5000), headers }
      );

      // Auth error - switch to fallback
      if (response.status === 401 || response.status === 403) {
        if (apiUrl !== JUPITER_FALLBACK_API_URL) {
          switchToJupiterFallback(`Auth error ${response.status}`);
        }
        continue;
      }

      const data = await response.json() as { error?: string; errorCode?: string };

      if (data.errorCode === 'TOKEN_NOT_TRADABLE' || data.error?.includes('not tradable')) {
        logger.warn({ mint: mint.slice(0, 8) }, 'Token not tradable via Jupiter - disabling');
        jupiterUntradableCache.set(mint, Date.now());
        return false;
      }

      // Tradable - remove from cache if present
      jupiterUntradableCache.delete(mint);
      return true;
    } catch {
      // Network error - try next API
      continue;
    }
  }

  // All APIs failed - assume tradable, will fail at execution time
  return true;
}

/**
 * Get Jupiter's effective fee rate for a token by fetching a quote
 * Returns the fee as a decimal (e.g., 0.001 = 0.1%)
 * Uses fallback API if primary fails with auth error
 */
async function getJupiterFeeRate(mint: string): Promise<number | null> {
  // Use $10 test amount to get realistic fee estimate
  const testAmountUsdc = 10_000_000; // 10 USDC in lamports

  // Check if we should reset fallback state
  checkAndResetJupiterFallback();

  const apiUrls = usingJupiterFallback
    ? [JUPITER_FALLBACK_API_URL, getConfigSync().jupiterApiUrl]
    : [getConfigSync().jupiterApiUrl, JUPITER_FALLBACK_API_URL];

  for (const apiUrl of apiUrls) {
    try {
      // Build headers with API key if available (only for primary)
      const headers: Record<string, string> = {};
      const jupiterApiKey = process.env.JUPITER_API_KEY;
      if (jupiterApiKey && apiUrl !== JUPITER_FALLBACK_API_URL) {
        headers['x-api-key'] = jupiterApiKey;
      }

      const response = await fetch(
        `${apiUrl}/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=${testAmountUsdc}&slippageBps=50`,
        {
          signal: AbortSignal.timeout(5000),
          headers,
        }
      );

      // Auth error - switch to fallback
      if (response.status === 401 || response.status === 403) {
        if (apiUrl !== JUPITER_FALLBACK_API_URL) {
          switchToJupiterFallback(`Auth error ${response.status}`);
        }
        continue;
      }

      if (!response.ok) {
        logger.debug({ mint: mint.slice(0, 8), status: response.status }, 'Jupiter quote HTTP error');
        continue;
      }

      const data = await response.json() as {
        inAmount?: string;
        outAmount?: string;
        otherAmountThreshold?: string;
        error?: string;
        routePlan?: Array<{
          swapInfo?: {
            feeAmount?: string;
            feeMint?: string;
            inAmount?: string;
          };
        }>;
      };

      if (!data.routePlan || data.routePlan.length === 0) {
        logger.debug({ mint: mint.slice(0, 8), error: data.error || 'no routePlan' }, 'Jupiter quote no route');
        continue;
      }

      // Calculate effective fee from the route
      let totalFeeInInput = 0;
      let totalInput = 0;

      for (const step of data.routePlan) {
        if (step.swapInfo?.feeAmount && step.swapInfo?.feeMint === USDC_MINT) {
          totalFeeInInput += parseInt(step.swapInfo.feeAmount);
        }
        if (step.swapInfo?.inAmount) {
          totalInput += parseInt(step.swapInfo.inAmount);
        }
      }

      // If we have explicit fee data, use it
      if (totalFeeInInput > 0 && totalInput > 0) {
        const feeRate = totalFeeInInput / totalInput;
        logger.debug({
          mint: mint.slice(0, 8),
          feeRate: (feeRate * 100).toFixed(3) + '%',
          totalFeeUsdc: (totalFeeInInput / 1e6).toFixed(4),
        }, 'Jupiter fee rate from explicit feeAmount');
        return feeRate;
      }

      // Fallback: estimate from price impact
      return 0.001; // 0.1% default for Jupiter routes

    } catch (error) {
      logger.debug({
        mint: mint.slice(0, 8),
        apiUrl,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to get Jupiter fee rate');
      continue;
    }
  }

  // All APIs failed
  return null;
}

/**
 * Get the best (lowest) fee rate for a token, comparing Raydium and Jupiter
 * Caches the result for 30 seconds
 */
async function getBestFeeRate(symbol: string, mint: string, raydiumFeeRate: number): Promise<number> {
  // Check cache first
  const cached = bestFeeCache.get(symbol);
  if (cached && (Date.now() - cached.lastUpdated) < BEST_FEE_CACHE_TTL_MS) {
    return cached.feeRate;
  }

  // Get Jupiter fee rate
  const jupiterFeeRate = await getJupiterFeeRate(mint);

  // Compare and cache the better one
  let bestFeeRate = raydiumFeeRate;
  let bestSource: 'raydium' | 'jupiter' = 'raydium';

  if (jupiterFeeRate !== null && jupiterFeeRate < raydiumFeeRate) {
    bestFeeRate = jupiterFeeRate;
    bestSource = 'jupiter';
    logger.info({
      symbol,
      jupiterFee: (jupiterFeeRate * 100).toFixed(3) + '%',
      raydiumFee: (raydiumFeeRate * 100).toFixed(3) + '%',
      savings: ((raydiumFeeRate - jupiterFeeRate) * 100).toFixed(3) + '%',
    }, `Jupiter has lower fee for ${symbol}`);
  } else {
    // Log when Raydium is used (either Jupiter failed or has higher fee)
    logger.debug({
      symbol,
      jupiterFee: jupiterFeeRate !== null ? (jupiterFeeRate * 100).toFixed(3) + '%' : 'null',
      raydiumFee: (raydiumFeeRate * 100).toFixed(3) + '%',
      reason: jupiterFeeRate === null ? 'jupiter_fetch_failed' : 'raydium_cheaper',
    }, `Using Raydium fee for ${symbol}`);
  }

  bestFeeCache.set(symbol, {
    feeRate: bestFeeRate,
    source: bestSource,
    lastUpdated: Date.now(),
  });

  return bestFeeRate;
}

/**
 * Calculate entry threshold dynamically based on pool fee rate and TVL
 *
 * Formula: max(roundTripFees + buffer, slippageBuffer / sqrt(tvl))
 *
 * - roundTripFees = feeRate × 2 (pay fee on entry and exit)
 * - buffer = 0.02% safety margin
 * - slippageBuffer = COEFFICIENT / sqrt(tvl) for low-liquidity pools
 *
 * This ensures break-even without juicing. Any trailing stop juice is pure profit.
 */
function calculateEntryThreshold(tvl: number, feeRate?: number): number {
  if (tvl < MIN_TVL_FOR_TRADING) {
    return 999; // Disabled
  }

  // Use provided fee rate (should be best of Raydium/Jupiter from getBestFeeRate)
  // Default to 0.1% if not provided (conservative for Jupiter routes)
  const effectiveFeeRate = feeRate ?? 0.001;

  // Round-trip fees + small buffer (in percentage points)
  // With 0.1% per leg: (0.001 * 2 * 100) + 0.02 = 0.22% threshold
  const roundTripFeesPct = (effectiveFeeRate * 2 * 100) + 0.02;

  // Slippage buffer for low-TVL pools
  const tvlInMillions = tvl / 1_000_000;
  const slippageBuffer = ENTRY_THRESHOLD_FORMULA.COEFFICIENT / Math.sqrt(tvlInMillions);

  // Take the higher of: fee-based floor, slippage-based threshold, or absolute minimum
  const minFloor = ENTRY_THRESHOLD_FORMULA.MIN_FLOOR ?? 0;
  const threshold = Math.max(roundTripFeesPct, slippageBuffer, minFloor);

  return Math.min(threshold, ENTRY_THRESHOLD_FORMULA.MAX_CAP);
}

/**
 * Calculate exit threshold using formula: max(MIN_FLOOR, COEFFICIENT / sqrt(tvl_in_millions))
 */
function calculateExitThreshold(tvl: number): number {
  if (tvl < MIN_TVL_FOR_TRADING) {
    return 999; // Disabled
  }
  const tvlInMillions = tvl / 1_000_000;
  const calculated = EXIT_THRESHOLD_FORMULA.COEFFICIENT / Math.sqrt(tvlInMillions);
  return Math.max(EXIT_THRESHOLD_FORMULA.MIN_FLOOR, Math.min(calculated, EXIT_THRESHOLD_FORMULA.MAX_CAP));
}

/**
 * Calculate position size multiplier using formula: min(MAX, sqrt(tvl_in_millions) * COEFFICIENT)
 * Higher liquidity = can trade larger amounts
 */
function calculatePositionMultiplier(tvl: number): number {
  if (tvl < MIN_TVL_FOR_TRADING) {
    return 0;
  }
  const tvlInMillions = tvl / 1_000_000;
  const calculated = Math.sqrt(tvlInMillions) * POSITION_SIZE_FORMULA.COEFFICIENT;
  return Math.max(POSITION_SIZE_FORMULA.MIN_MULTIPLIER, Math.min(calculated, POSITION_SIZE_FORMULA.MAX_MULTIPLIER));
}

/**
 * Calculate entry and exit thresholds based on TVL and fee rate
 * Entry threshold dynamically accounts for actual pool fees to ensure break-even
 */
function calculateThresholds(tvl: number, feeRate?: number): { entryThreshold: number; exitThreshold: number; enabled: boolean } {
  if (tvl < MIN_TVL_FOR_TRADING) {
    return { entryThreshold: TVL_ENTRY_THRESHOLDS.DISABLED.entryPct, exitThreshold: 999, enabled: false };
  }

  const entryThreshold = calculateEntryThreshold(tvl, feeRate);
  const exitThreshold = calculateExitThreshold(tvl);

  return {
    entryThreshold,
    exitThreshold,
    enabled: true,
  };
}

interface PoolInfo {
  tvl: number;
  feeRate: number;
}

/**
 * Fetch TVL and fee rates for multiple pools from Raydium API
 */
async function fetchPoolTVLs(poolAddresses: string[]): Promise<Map<string, PoolInfo>> {
  const result = new Map<string, PoolInfo>();

  if (poolAddresses.length === 0) {
    return result;
  }

  const startTime = Date.now();
  try {
    // Raydium API accepts comma-separated pool IDs
    const ids = poolAddresses.join(',');
    const url = `https://api-v3.raydium.io/pools/info/ids?ids=${ids}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });
    if (!response.ok) {
      throw new Error(`Raydium API error: ${response.status}`);
    }

    const data = await response.json() as { data?: Array<{ id?: string; tvl?: number; feeRate?: number }> };
    recordApiCall('raydium', true, Date.now() - startTime);

    if (data.data && Array.isArray(data.data)) {
      for (const pool of data.data) {
        if (pool.id && typeof pool.tvl === 'number') {
          result.set(pool.id, {
            tvl: pool.tvl,
            feeRate: pool.feeRate ?? 0.0025, // Default 0.25% if not provided
          });
        }
      }
    }

    logger.debug({ poolCount: result.size }, 'Fetched pool TVLs and fee rates from Raydium');
  } catch (error) {
    recordApiCall('raydium', false, Date.now() - startTime, String(error));
    logger.error({ error }, 'Failed to fetch pool TVLs from Raydium API');
  }

  return result;
}

/**
 * Refresh liquidity data for all configured tokens
 *
 * ALWAYS checks ALL sources for EVERY token, then uses the best pool.
 * This ensures we never miss a high-liquidity pool on any source.
 *
 * Also refreshes token list from database to pick up newly added tokens.
 */
export async function refreshLiquidity(): Promise<void> {
  logger.info('[LIQUIDITY] Step 1/6: Refreshing tokens from database...');
  // First, refresh tokens from database to pick up any new additions
  const tokenRefresh = await refreshTokensFromDb();
  logger.info(`[LIQUIDITY] Token refresh complete: ${tokenRefresh.total} tokens (${tokenRefresh.added} added, ${tokenRefresh.removed} removed)`);
  if (tokenRefresh.added > 0 || tokenRefresh.removed > 0) {
    logger.info({
      added: tokenRefresh.added,
      removed: tokenRefresh.removed,
      total: tokenRefresh.total,
    }, 'Token list refreshed from database');
  }

  const config = getConfigSync();
  const now = Date.now();

  // Get all enabled tokens
  const enabledTokens = config.tokens.filter(t => t.enabled);
  const allTokens = enabledTokens.map(t => ({ mint: t.mint, symbol: t.symbol }));
  logger.info(`[LIQUIDITY] Step 2/6: Processing ${enabledTokens.length} enabled tokens`);

  // Build lookups
  const symbolByMint = new Map<string, string>();
  const poolAddressBySymbol = new Map<string, String>();
  for (const token of enabledTokens) {
    symbolByMint.set(token.mint, token.symbol);
    if (token.poolAddress) {
      poolAddressBySymbol.set(token.symbol, token.poolAddress);
    }
  }

  logger.info('[LIQUIDITY] Step 3/6: Fetching from API sources (Raydium, DexScreener, GeckoTerminal)...');
  logger.info({ tokenCount: allTokens.length }, 'Starting liquidity refresh - checking ALL sources for ALL tokens');

  // ========================================
  // STEP 1: Fetch from ALL sources in parallel
  // ========================================

  // 1a. Raydium: Fetch TVLs for tokens with pool addresses
  const poolAddresses = enabledTokens
    .filter(t => t.poolAddress)
    .map(t => ({ symbol: t.symbol, poolAddress: t.poolAddress! }));

  const raydiumTvlPromise = (async () => {
    const infoBySymbol = new Map<string, { tvl: number; feeRate: number }>();
    if (poolAddresses.length === 0) return infoBySymbol;

    for (let i = 0; i < poolAddresses.length; i += API_BATCH_SIZE) {
      const batch = poolAddresses.slice(i, i + API_BATCH_SIZE);
      const addresses = batch.map(p => p.poolAddress);
      const batchInfo = await fetchPoolTVLs(addresses);

      for (const item of batch) {
        const poolInfo = batchInfo.get(item.poolAddress);
        const tvl = poolInfo?.tvl ?? 0;
        const feeRate = poolInfo?.feeRate ?? 0.0025;
        infoBySymbol.set(item.symbol, { tvl, feeRate });

        // Update liquidity cache
        liquidityCache.set(item.poolAddress, {
          poolAddress: item.poolAddress,
          tvl,
          lastUpdated: now,
        });
      }

      if (i + API_BATCH_SIZE < poolAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, API_BATCH_DELAY_MS));
      }
    }

    logger.info({ count: infoBySymbol.size }, 'Raydium TVL fetch complete');
    return infoBySymbol;
  })();

  // 1b. DexScreener: Fetch all tokens using batch endpoint
  const dexScreenerPromise = (async () => {
    try {
      const results = await fetchBatchDexScreenerPrices(allTokens);
      logger.info({ count: results.size }, 'DexScreener batch fetch complete');
      return results;
    } catch (error) {
      logger.warn({ error }, 'DexScreener batch fetch failed');
      return new Map<string, DexScreenerPrice>();
    }
  })();

  // 1c. GeckoTerminal: Fetch all tokens using batch endpoint
  const geckoTerminalPromise = (async () => {
    try {
      const results = await fetchBatchGeckoTerminalPrices(allTokens);
      logger.info({ count: results.size }, 'GeckoTerminal batch fetch complete');
      return results;
    } catch (error) {
      logger.warn({ error }, 'GeckoTerminal batch fetch failed');
      return new Map<string, GeckoTerminalPrice>();
    }
  })();

  // Wait for all sources (DexScreener and GeckoTerminal can run in parallel)
  // Note: Raydium runs first because it's faster and we need it for comparison
  logger.info('[LIQUIDITY] Waiting for API responses...');
  const [raydiumTvls, dexScreenerData, geckoTerminalData] = await Promise.all([
    raydiumTvlPromise,
    dexScreenerPromise,
    geckoTerminalPromise,
  ]);
  logger.info('[LIQUIDITY] API responses received successfully');

  // ========================================
  // STEP 2: For each token, compare ALL sources and use the BEST pool
  // ========================================
  logger.info(`[LIQUIDITY] Step 4/6: Processing ${enabledTokens.length} tokens individually...`);

  let raydiumBest = 0;
  let dexScreenerBest = 0;
  let geckoTerminalBest = 0;
  let enabledCount = 0;
  let disabledCount = 0;
  let processed = 0;

  for (const token of enabledTokens) {
    processed++;
    if (processed % 10 === 0 || processed === 1) {
      logger.info(`Processing token ${processed}/${enabledTokens.length}: ${token.symbol}`);
    }
    const { symbol, mint } = token;
    const configPoolAddress = token.poolAddress;

    // Gather liquidity from all sources
    interface PoolCandidate {
      source: 'raydium' | 'dexscreener' | 'geckoterminal';
      pairAddress: string;
      dexId: string;
      liquidityUsd: number;
      quoteToken: 'USDC' | 'SOL' | 'OTHER';
      quoteMint: string;
    }

    const candidates: PoolCandidate[] = [];
    const solCandidates: PoolCandidate[] = [];

    // Raydium (from config pool address)
    if (configPoolAddress) {
      const raydiumInfo = raydiumTvls.get(symbol);
      const raydiumTvl = raydiumInfo?.tvl ?? 0;
      if (raydiumTvl > 0) {
        candidates.push({
          source: 'raydium',
          pairAddress: configPoolAddress,
          dexId: 'raydium',
          liquidityUsd: raydiumTvl,
          quoteToken: 'USDC', // Config pools are assumed to be USDC pairs
          quoteMint: USDC_MINT,
        });
      }
    }

    // DexScreener
    const dexData = dexScreenerData.get(mint);
    if (dexData) {
      // Best USDC pool
      if (dexData.bestUsdcPair && dexData.bestUsdcPair.liquidityUsd > 0) {
        candidates.push({
          source: 'dexscreener',
          pairAddress: dexData.bestUsdcPair.pairAddress,
          dexId: dexData.bestUsdcPair.dexId,
          liquidityUsd: dexData.bestUsdcPair.liquidityUsd,
          quoteToken: 'USDC',
          quoteMint: USDC_MINT,
        });
      }
      // Best SOL pool (track separately for routing decisions)
      if (dexData.bestSolPair && dexData.bestSolPair.liquidityUsd > 0) {
        solCandidates.push({
          source: 'dexscreener',
          pairAddress: dexData.bestSolPair.pairAddress,
          dexId: dexData.bestSolPair.dexId,
          liquidityUsd: dexData.bestSolPair.liquidityUsd,
          quoteToken: 'SOL',
          quoteMint: SOL_MINT,
        });
        // Also add to main candidates for overall comparison
        candidates.push({
          source: 'dexscreener',
          pairAddress: dexData.bestSolPair.pairAddress,
          dexId: dexData.bestSolPair.dexId,
          liquidityUsd: dexData.bestSolPair.liquidityUsd,
          quoteToken: 'SOL',
          quoteMint: SOL_MINT,
        });
      }
    }

    // GeckoTerminal
    const geckoData = geckoTerminalData.get(mint);
    if (geckoData) {
      // Best USDC pool
      if (geckoData.bestUsdcPool && geckoData.bestUsdcPool.liquidityUsd > 0) {
        candidates.push({
          source: 'geckoterminal',
          pairAddress: geckoData.bestUsdcPool.pairAddress,
          dexId: geckoData.bestUsdcPool.dexId,
          liquidityUsd: geckoData.bestUsdcPool.liquidityUsd,
          quoteToken: 'USDC',
          quoteMint: USDC_MINT,
        });
      }
      // Best SOL pool
      if (geckoData.bestSolPool && geckoData.bestSolPool.liquidityUsd > 0) {
        solCandidates.push({
          source: 'geckoterminal',
          pairAddress: geckoData.bestSolPool.pairAddress,
          dexId: geckoData.bestSolPool.dexId,
          liquidityUsd: geckoData.bestSolPool.liquidityUsd,
          quoteToken: 'SOL',
          quoteMint: SOL_MINT,
        });
        candidates.push({
          source: 'geckoterminal',
          pairAddress: geckoData.bestSolPool.pairAddress,
          dexId: geckoData.bestSolPool.dexId,
          liquidityUsd: geckoData.bestSolPool.liquidityUsd,
          quoteToken: 'SOL',
          quoteMint: SOL_MINT,
        });
      }
      // If only has generic best pool (not USDC or SOL specifically)
      if (geckoData.bestPool && !geckoData.bestUsdcPool && !geckoData.bestSolPool) {
        candidates.push({
          source: 'geckoterminal',
          pairAddress: geckoData.bestPool.pairAddress,
          dexId: geckoData.bestPool.dexId,
          liquidityUsd: geckoData.bestPool.liquidityUsd,
          quoteToken: geckoData.bestPool.quoteToken,
          quoteMint: geckoData.bestPool.quoteMint,
        });
      }
    }

    // Sort by liquidity (highest first)
    candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    solCandidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    // No pools found anywhere
    if (candidates.length === 0) {
      thresholdCache.set(symbol, {
        symbol,
        tvl: 0,
        entryThresholdPct: TVL_ENTRY_THRESHOLDS.DISABLED.entryPct,
        exitThresholdPct: 999,
        enabled: false,
      });
      disabledCount++;
      logger.debug({ symbol }, 'No liquidity found on any source');
      continue;
    }

    // Use the BEST pool (highest liquidity across all sources)
    const best = candidates[0];
    const tvl = best.liquidityUsd;

    // Get fee rate for threshold calculation
    // Compare Raydium vs Jupiter and use the better (lower) fee
    const raydiumInfo = raydiumTvls.get(symbol);
    const raydiumFeeRate = raydiumInfo?.feeRate ?? 0.0025;
    const feeRate = await getBestFeeRate(symbol, mint, raydiumFeeRate);

    let { entryThreshold, exitThreshold, enabled } = calculateThresholds(tvl, feeRate);

    // Track which source won
    if (best.source === 'raydium') raydiumBest++;
    else if (best.source === 'dexscreener') dexScreenerBest++;
    else geckoTerminalBest++;

    // Check if this is a Raydium CLMM pool
    // Our SDK only supports CLMM - classic AMM pools have different interface
    // Accept 'raydium' from DexScreener as CLMM (they don't distinguish types well)
    const isRaydiumClmmPool = best.dexId === 'raydium-clmm' || best.dexId === 'raydium_clmm' || best.dexId === 'raydium';
    const canUseRaydiumDirect = isRaydiumClmmPool;

    // If NOT using Raydium direct, verify Jupiter can trade it
    // This prevents trying to trade tokens that Jupiter doesn't support
    if (enabled && !canUseRaydiumDirect) {
      const jupiterTradable = await checkJupiterTradability(mint);
      if (!jupiterTradable) {
        enabled = false;
        logger.warn({
          symbol,
          mint: mint.slice(0, 8),
          tvl: tvl.toFixed(0),
          source: best.source,
          dexId: best.dexId,
        }, `Token disabled: Jupiter cannot trade ${symbol} and not a Raydium pool`);
      }
    }

    // Log when we enable Raydium direct for non-config pools
    if (canUseRaydiumDirect && best.source !== 'raydium') {
      logger.info({
        symbol,
        dexId: best.dexId,
        source: best.source,
        poolAddress: best.pairAddress,
        tvl: tvl.toFixed(0),
      }, `Enabling Raydium direct for ${symbol} (discovered via ${best.source})`);
    }

    // Update threshold cache
    thresholdCache.set(symbol, {
      symbol,
      tvl,
      entryThresholdPct: entryThreshold,
      exitThresholdPct: exitThreshold,
      enabled,
      feeRate,
    });

    // Update best pool cache (for routing)
    // canUseRaydiumDirect already determined above for Jupiter tradability check
    bestPoolCache.set(symbol, {
      pairAddress: best.pairAddress,
      dexId: best.dexId,
      liquidityUsd: best.liquidityUsd,
      quoteToken: best.quoteToken,
      quoteMint: best.quoteMint,
      source: best.source,
      isRaydium: canUseRaydiumDirect,
      feeRate,
    });

    // Update best SOL pool cache (for routing comparison)
    if (solCandidates.length > 0) {
      const bestSol = solCandidates[0];
      // Check if Raydium CLMM by dexId (works for any discovery source)
      const isSolPoolRaydiumClmm = bestSol.dexId === 'raydium-clmm' || bestSol.dexId === 'raydium_clmm';
      bestSolPoolCache.set(symbol, {
        pairAddress: bestSol.pairAddress,
        dexId: bestSol.dexId,
        liquidityUsd: bestSol.liquidityUsd,
        source: bestSol.source,
        isRaydium: isSolPoolRaydiumClmm,
      });
    }

    if (enabled) {
      enabledCount++;

      // Log interesting cases where a non-Raydium source has better liquidity
      if (best.source !== 'raydium' && configPoolAddress) {
        const raydiumTvl = raydiumInfo?.tvl ?? 0;
        logger.info({
          symbol,
          bestSource: best.source,
          bestTvl: tvl.toFixed(0),
          bestDex: best.dexId,
          raydiumTvl: raydiumTvl.toFixed(0),
          entryThreshold: entryThreshold.toFixed(2),
          feeRate: (feeRate * 100).toFixed(2) + '%',
        }, `Better pool found: ${symbol} - ${best.source} has $${tvl.toFixed(0)} vs Raydium $${raydiumTvl.toFixed(0)}`);
      } else {
        logger.debug({
          symbol,
          bestSource: best.source,
          tvl: tvl.toFixed(0),
          entryThreshold: entryThreshold.toFixed(2),
        }, `Token enabled: ${symbol} via ${best.source}`);
      }
    } else {
      disabledCount++;
      logger.debug({ symbol, tvl: tvl.toFixed(0) }, `Token disabled (low liquidity): ${symbol}`);
    }
  }

  lastRefreshTime = now;
  logger.info(`Token processing complete: ${enabledCount} enabled, ${disabledCount} disabled`);

  // ========================================
  // STEP 3: Calculate percentile-based adaptive thresholds
  // ========================================
  if (PERCENTILE_THRESHOLD_FORMULA.ENABLED) {
    logger.info('Step 5/7: Calculating percentile thresholds from historical data...');
    try {
      // Add 45-second timeout to prevent hang on large historical dataset
      // Query takes ~32s on 7-day window with 11M rows
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Percentile threshold calculation timeout after 45s')), 45000)
      );
      await Promise.race([refreshPercentileThresholds(), timeoutPromise]);
      logger.info('Percentile thresholds calculated successfully');
    } catch (error) {
      logger.warn({ error }, 'Percentile threshold calculation failed or timed out - using TVL-based thresholds only');
      logger.info('Percentile calculation skipped (timeout or error) - using TVL-based thresholds');
    }
  }

  // ========================================
  // STEP 4: Calculate historically profitable spreads (algorithmic)
  // ========================================
  if (now - profitableSpreadLastRefresh > PROFITABLE_SPREAD_REFRESH_MS) {
    logger.info('Step 6/7: Calculating profitable spreads from trade history...');
    try {
      profitableSpreadCache = await calculateAllProfitableSpreads();
      profitableSpreadLastRefresh = now;
      logger.info({ tokenCount: profitableSpreadCache.size }, 'Profitable spreads calculated');
      // Log cache contents for debugging
      for (const [ticker, data] of profitableSpreadCache) {
        logger.info({ ticker, minProfitableSpread: data.minProfitableSpread, confidence: data.confidence, sampleSize: data.sampleSize }, 'Profitable spread calculated');
      }
    } catch (error) {
      logger.warn({ error }, 'Profitable spread calculation failed');
      logger.warn('Profitable spread calculation skipped due to error');
    }
  }

  // Log summary
  logger.info('Step 7/7: Finalizing and logging summary...');
  logger.info({
    totalTokens: enabledTokens.length,
    enabledTokens: enabledCount,
    disabledTokens: disabledCount,
    bestPools: {
      raydium: raydiumBest,
      dexScreener: dexScreenerBest,
      geckoTerminal: geckoTerminalBest,
    },
    refreshedAt: new Date(now).toISOString(),
  }, `Liquidity refresh complete: ${enabledCount} enabled, ${disabledCount} disabled (best pools: Raydium=${raydiumBest}, DexScreener=${dexScreenerBest}, GeckoTerminal=${geckoTerminalBest})`);

  // Initialize/reinitialize volatility refresh with only enabled stocks
  // This is called after liquidity refresh so we know which tokens passed TVL checks
  const { initIncrementalVolatilityRefresh } = await import('../feeds/volatilityFeed');
  const enabledStocks = getEnabledStockTickers();
  initIncrementalVolatilityRefresh(enabledStocks);
}

/**
 * Refresh percentile-based adaptive thresholds for all tokens
 *
 * Uses PostgreSQL's percentile_cont() function to calculate percentiles
 * directly in the database, avoiding memory issues from loading millions of rows.
 */
async function refreshPercentileThresholds(): Promise<void> {
  try {
    const db = getDatabase();
    const windowMs = PERCENTILE_THRESHOLD_FORMULA.ROLLING_WINDOW_HOURS * 60 * 60 * 1000;
    
    // Calculate percentiles in PostgreSQL (memory efficient)
    const percentileData = await db.getAllPercentileThresholds(
      windowMs,
      PERCENTILE_THRESHOLD_FORMULA.PERCENTILE
    );

    let tokensWithPercentile = 0;
    let tokensWithoutEnoughData = 0;

    for (const [symbol, data] of percentileData) {
      const cached = thresholdCache.get(symbol);
      if (!cached) continue; // Token not in threshold cache, skip

      if (data.sampleCount >= PERCENTILE_THRESHOLD_FORMULA.MIN_SAMPLES) {
        // Update cache with percentile data from PostgreSQL
        thresholdCache.set(symbol, {
          ...cached,
          percentileThresholdPct: data.percentileValue,
          percentileSamples: data.sampleCount,
        });

        tokensWithPercentile++;

        // Log if percentile is significantly different from TVL-based threshold
        const diff = data.percentileValue - cached.entryThresholdPct;
        if (Math.abs(diff) > 0.2) {
          logger.debug({
            symbol,
            tvlThreshold: cached.entryThresholdPct.toFixed(2),
            percentileThreshold: data.percentileValue.toFixed(2),
            samples: data.sampleCount,
            diff: diff.toFixed(2),
          }, `Percentile threshold differs from TVL: ${symbol}`);
        }
      } else {
        tokensWithoutEnoughData++;
        // Not enough data - keep existing threshold (no percentile override)
        thresholdCache.set(symbol, {
          ...cached,
          percentileThresholdPct: undefined,
          percentileSamples: data.sampleCount,
        });
      }
    }

    logger.info({
      tokensWithPercentile,
      tokensWithoutEnoughData,
      percentile: PERCENTILE_THRESHOLD_FORMULA.PERCENTILE,
      windowHours: PERCENTILE_THRESHOLD_FORMULA.ROLLING_WINDOW_HOURS,
      minSamples: PERCENTILE_THRESHOLD_FORMULA.MIN_SAMPLES,
    }, 'Percentile thresholds refreshed (PostgreSQL)');

  } catch (error) {
    logger.error({ error }, 'Failed to refresh percentile thresholds');
  }
}

/**
 * Check if liquidity needs refresh (called every loop iteration)
 */
export async function maybeRefreshLiquidity(): Promise<void> {
  const now = Date.now();
  if (now - lastRefreshTime >= LIQUIDITY_REFRESH_INTERVAL_MS) {
    await refreshLiquidity();
  }
}

/**
 * Get entry threshold for a specific token
 *
 * HYBRID APPROACH:
 * 1. TVL-based floor: Ensures break-even (covers fees + slippage)
 * 2. Percentile-based ceiling: Only enter when spread is exceptional for THIS token
 *
 * Effective threshold = max(TVL-based, percentile-based)
 *
 * This prevents entering mediocre opportunities that cover costs but aren't
 * genuinely exceptional moves for that specific token.
 *
 * Falls back to TVL-based threshold if:
 * - Not enough historical data for percentile calculation
 * - Percentile feature is disabled
 *
 * @param symbol - Token symbol (e.g., 'xSPY', 'SPYx')
 */
export function getEntryThreshold(symbol: string): number {
  const config = getConfigSync();
  const cached = thresholdCache.get(symbol);

  // Base threshold from TVL + fee calculation (ensures break-even)
  const tvlBasedThreshold = cached ? cached.entryThresholdPct : (config.meanReversionEntrySpreadPct ?? 1.5);

  // Get stock ticker from token symbol (e.g., 'xSPY' -> 'SPY', 'TSLAx' -> 'TSLA')
  // Note: this is a rough mapping for liquidity lookup only; authoritative mapping is in supabaseClient.ts
  const stockTicker = symbol.replace(/^[a-z]/, '').replace(/[a-z]+$/, ''); // Strip lowercase prefix/suffix
  
  // Check for historically profitable spread (algorithmic, data-driven)
  const historicalData = profitableSpreadCache.get(stockTicker);
  if (historicalData && (historicalData.confidence === 'high' || historicalData.confidence === 'medium')) {
    // Use historical minimum profitable spread + buffer, but never below TVL-based
    const buffer = historicalData.confidence === 'high' ? 0.5 : 0.75; // More buffer for medium confidence
    const historicalThreshold = historicalData.minProfitableSpread + buffer;
    const effectiveThreshold = Math.max(tvlBasedThreshold, historicalThreshold);
    return effectiveThreshold;
  }

  // Fall back to percentile-based threshold if no historical data
  if (PERCENTILE_THRESHOLD_FORMULA.ENABLED && cached?.percentileThresholdPct) {
    return Math.max(tvlBasedThreshold, cached.percentileThresholdPct);
  }

  return tvlBasedThreshold;
}

/**
 * Get entry threshold details for a specific token (for debugging/dashboard)
 * Returns both the TVL-based and percentile-based thresholds
 */
export function getEntryThresholdDetails(symbol: string): {
  effectiveThreshold: number;
  tvlBasedThreshold: number;
  percentileThreshold: number | null;
  percentileSamples: number;
  usingPercentile: boolean;
} {
  const config = getConfigSync();
  const cached = thresholdCache.get(symbol);

  const tvlBasedThreshold = cached ? cached.entryThresholdPct : (config.meanReversionEntrySpreadPct ?? 1.5);
  const percentileThreshold = cached?.percentileThresholdPct ?? null;
  const percentileSamples = cached?.percentileSamples ?? 0;

  const usingPercentile = PERCENTILE_THRESHOLD_FORMULA.ENABLED &&
    percentileThreshold !== null &&
    percentileThreshold > tvlBasedThreshold;

  const effectiveThreshold = usingPercentile ? percentileThreshold! : tvlBasedThreshold;

  return {
    effectiveThreshold,
    tvlBasedThreshold,
    percentileThreshold,
    percentileSamples,
    usingPercentile,
  };
}

/**
 * Get exit threshold for a specific token (TVL-based)
 * Lower liquidity = higher slippage = need more appreciation before exit
 * If hasRaydiumPool is false, no additional boost is applied
 */
export function getExitThreshold(symbol: string): number {
  const config = getConfigSync();
  const cached = thresholdCache.get(symbol);
  const baseThreshold = cached ? cached.exitThresholdPct : (config.meanReversionExitSpreadPct ?? 0.8);
  return baseThreshold;
}

/**
 * Get position size for a specific token (TVL-based formula)
 * Higher liquidity = can trade larger amounts with less slippage
 * Returns the USD amount to trade based on TVL and maxUsdPerTrade config
 * Uses formula: min(MAX, sqrt(tvl_in_millions) * COEFFICIENT)
 */
export function getPositionSize(symbol: string): number {
  const config = getConfigSync();
  const maxUsd = config.maxUsdPerTrade;
  const cached = thresholdCache.get(symbol);

  if (!cached) {
    // Unknown liquidity - use minimum multiplier for safety
    return maxUsd * POSITION_SIZE_FORMULA.MIN_MULTIPLIER;
  }

  const multiplier = calculatePositionMultiplier(cached.tvl);
  return maxUsd * multiplier;
}

/**
 * Check if a token is enabled based on liquidity
 */
export function isTokenEnabledByLiquidity(symbol: string): boolean {
  const cached = thresholdCache.get(symbol);
  if (cached) {
    return cached.enabled;
  }
  // If not in cache, token hasn't been evaluated yet - disable until refresh
  // This prevents price fetch spam for tokens without known liquidity status
  return false;
}

/**
 * Check if token should be enabled for a specific spread value
 * Uses tiered liquidity requirements: high spreads get relaxed TVL requirements
 * 
 * @param symbol Token symbol
 * @param spreadPct Current discount/spread percentage (positive = discount)
 * @returns true if token should be tradeable given this spread
 */
export function isTokenEnabledForSpread(symbol: string, spreadPct: number): boolean {
  const cached = thresholdCache.get(symbol);
  if (!cached) {
    // If not in cache, token hasn't been evaluated yet - disable until refresh
    return false;
  }
  
  const tvl = cached.tvl;
  
  // Tiered liquidity requirements based on spread size
  let minTvlRequired: number;
  
  if (spreadPct >= 6.0) {
    // High spread (6%+): Very relaxed requirements
    // Large spreads can absorb higher slippage and still be profitable
    minTvlRequired = 25_000; // 50% of standard requirement
  } else if (spreadPct >= 4.5) {
    // Medium spread (4.5-6%): Standard requirements
    minTvlRequired = MIN_TVL_FOR_TRADING; // 50K standard
  } else {
    // Low spread (<4.5%): Strict requirements
    // Marginal trades need perfect execution to be profitable
    minTvlRequired = MIN_TVL_FOR_TRADING * 1.5; // 75K for low spreads
  }
  
  return tvl >= minTvlRequired;
}

/**
 * Get TVL for a token
 */
export function getTokenTVL(symbol: string): number {
  const cached = thresholdCache.get(symbol);
  return cached?.tvl ?? 0;
}

/**
 * Get fee rate for a token (e.g., 0.001 = 0.1%)
 * Returns the best of Raydium/Jupiter fee rates
 */
export function getTokenFeeRate(symbol: string): number {
  const cached = thresholdCache.get(symbol);
  return cached?.feeRate ?? 0.001; // Default 0.1% if not found
}

/**
 * Get all token thresholds (for dashboard/debugging)
 */
export function getAllThresholds(): TokenThreshold[] {
  return Array.from(thresholdCache.values()).sort((a, b) => b.tvl - a.tvl);
}

/**
 * Get unique stock tickers for tokens that are enabled by liquidity (TVL checks passed)
 * Used to initialize volatility refresh with only the stocks we're actually trading
 */
export function getEnabledStockTickers(): string[] {
  const config = getConfigSync();
  const enabledTokens = getAllThresholds().filter(t => t.enabled);
  
  // Map enabled token symbols to their stock tickers
  const stockTickers = new Set<string>();
  for (const token of enabledTokens) {
    const tokenConfig = config.tokens.find(t => t.symbol === token.symbol);
    if (tokenConfig?.stockTicker && (!tokenConfig.priceSource || tokenConfig.priceSource === 'stock')) {
      stockTickers.add(tokenConfig.stockTicker);
    }
  }
  
  return Array.from(stockTickers);
}

/**
 * Routing decision for a token swap
 */
export interface SwapRouting {
  useRaydiumDirect: boolean;  // true = direct Raydium swap, false = use Jupiter
  poolAddress: string | null; // Pool address if using Raydium direct
  dexId: string;              // 'raydium' or 'jupiter' (or other DEX)
  liquidityUsd: number;       // Liquidity in the best pool
  source: 'raydium' | 'dexscreener' | 'geckoterminal' | 'jupiter';  // Which source found the best pool
  quoteToken: 'USDC' | 'SOL' | 'OTHER'; // Which token to swap through
  quoteMint: string;          // Mint address of quote token
}

/**
 * Get routing info for a token - determines whether to use Raydium direct or Jupiter
 *
 * Strategy:
 * 1. Use the BEST pool from bestPoolCache (highest liquidity across all sources)
 * 2. If SOL pool has more liquidity, use it (direct SOL swap, single hop)
 * 3. If best pool is on Raydium, use Raydium direct (lower fees)
 * 4. Otherwise use Jupiter aggregator
 */
export function getSwapRouting(symbol: string, storedPoolAddress?: string, storedDexId?: string): SwapRouting {
  // Get best pool from cache (already determined during liquidity refresh)
  const bestPool = bestPoolCache.get(symbol);
  const bestSolPool = bestSolPoolCache.get(symbol);

  if (!bestPool) {
    // No pool in cache - check if we have stored info from position entry
    // This allows exits to work even if the liquidity cache hasn't refreshed
    if (storedPoolAddress && storedDexId) {
      // Use Raydium direct for any Raydium pool (CLMM or legacy AMM)
      const isRaydium = storedDexId === 'raydium-clmm' || storedDexId === 'raydium_clmm' || storedDexId === 'raydium';
      logger.info({ symbol, storedPoolAddress, storedDexId, isRaydium }, 'Using stored pool info for routing (not in cache)');
      return {
        useRaydiumDirect: isRaydium,
        poolAddress: isRaydium ? storedPoolAddress : null,
        dexId: storedDexId,
        liquidityUsd: 0,
        source: isRaydium ? 'raydium' : 'jupiter',
        quoteToken: 'USDC',
        quoteMint: USDC_MINT,
      };
    }
    // No pool info - use Jupiter (defaults to USDC)
    return {
      useRaydiumDirect: false,
      poolAddress: null,
      dexId: 'jupiter',
      liquidityUsd: 0,
      source: 'jupiter',
      quoteToken: 'USDC',
      quoteMint: USDC_MINT,
    };
  }

  // If SOL pool has more liquidity, use it (direct SOL → TOKEN, single hop)
  if (bestSolPool && bestSolPool.liquidityUsd > bestPool.liquidityUsd) {
    logger.debug({
      symbol,
      bestPoolLiquidity: bestPool.liquidityUsd.toFixed(0),
      solPoolLiquidity: bestSolPool.liquidityUsd.toFixed(0),
      useRaydium: bestSolPool.isRaydium,
      choice: 'SOL',
    }, 'Routing through SOL pool (higher liquidity)');

    return {
      useRaydiumDirect: bestSolPool.isRaydium,
      poolAddress: bestSolPool.pairAddress,  // Always store pool address for tracking
      dexId: bestSolPool.dexId,
      liquidityUsd: bestSolPool.liquidityUsd,
      source: bestSolPool.source,
      quoteToken: 'SOL',
      quoteMint: SOL_MINT,
    };
  }

  // Use the best pool (USDC)
  return {
    useRaydiumDirect: bestPool.isRaydium,
    poolAddress: bestPool.pairAddress,  // Always store pool address for tracking
    dexId: bestPool.dexId,
    liquidityUsd: bestPool.liquidityUsd,
    source: bestPool.source,
    quoteToken: bestPool.quoteToken,
    quoteMint: bestPool.quoteMint,
  };
}
