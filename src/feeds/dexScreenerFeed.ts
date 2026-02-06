/**
 * DexScreener Price Feed - Alternative to Jupiter for price and liquidity data
 *
 * Benefits:
 * - 300 requests/minute rate limit (vs Jupiter's stricter limits)
 * - Returns all pairs for a token (Raydium, Orca, etc.)
 * - Includes liquidity data directly
 * - Works for tokens without Jupiter price API coverage
 */

import axios from 'axios';
import { feedLogger } from '../logger';
import { USDC_MINT, SOL_MINT } from '../constants';
import { recordApiCall } from './endpointTracker';

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  priceNative: string;
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

export interface PairInfo {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  quoteToken: string;
  quoteMint: string;
  volume24h: number;
}

export interface DexScreenerPrice {
  mint: string;
  symbol: string;
  priceUsd: number;
  totalLiquidityUsd: number;
  bestPair: PairInfo | null;
  bestUsdcPair: PairInfo | null;  // Best USDC pair (for direct USDC swaps)
  bestSolPair: PairInfo | null;   // Best SOL pair (for routing through SOL)
  allPairs: Array<{
    pairAddress: string;
    dexId: string;
    liquidityUsd: number;
    quoteToken: string;
    quoteMint: string;
  }>;
  timestamp: number;
}

// Cache for DexScreener data
const priceCache: Map<string, DexScreenerPrice> = new Map();

// Rate limiting
let lastCallTime: number = 0;
const MIN_CALL_INTERVAL_MS = 200; // 300/min = 200ms between calls

/**
 * Wait for rate limit
 */
async function waitForRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastCallTime = Date.now();
}

/**
 * Fetch price and liquidity data from DexScreener for a token
 */
export async function fetchDexScreenerPrice(mint: string, symbol?: string): Promise<DexScreenerPrice | null> {
  try {
    feedLogger.info({ mint: mint.slice(0, 8), symbol }, 'Token price fetch (dexscreener single)');
    await waitForRateLimit();

    const startTime = Date.now();
    const response = await axios.get<DexScreenerResponse>(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 10000 }
    );
    recordApiCall('dexscreener', true, Date.now() - startTime);

    if (!response.data.pairs || response.data.pairs.length === 0) {
      feedLogger.debug({ mint }, 'No pairs found on DexScreener');
      return null;
    }

    // Filter for Solana pairs where this token is the base token
    const validPairs = response.data.pairs.filter(
      pair => pair.chainId === 'solana' &&
              pair.baseToken.address === mint &&
              pair.liquidity?.usd > 0
    );

    if (validPairs.length === 0) {
      feedLogger.debug({ mint }, 'No valid Solana pairs found on DexScreener');
      return null;
    }

    // Sort by liquidity (highest first)
    validPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    // Find best USDC pair
    const usdcPairs = validPairs.filter(
      pair => pair.quoteToken.address === USDC_MINT
    );
    const bestUsdcPair = usdcPairs.length > 0 ? usdcPairs[0] : null;

    // Find best SOL pair
    const solPairs = validPairs.filter(
      pair => pair.quoteToken.address === SOL_MINT
    );
    const bestSolPair = solPairs.length > 0 ? solPairs[0] : null;

    // Overall best pair: prefer USDC for price accuracy, then highest liquidity
    const bestPair = bestUsdcPair || validPairs[0];

    // Calculate total liquidity across all pairs
    const totalLiquidity = validPairs.reduce(
      (sum, pair) => sum + (pair.liquidity?.usd || 0),
      0
    );

    // Helper to create PairInfo from DexScreenerPair
    const toPairInfo = (pair: DexScreenerPair): PairInfo => ({
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      liquidityUsd: pair.liquidity?.usd || 0,
      quoteToken: pair.quoteToken.symbol,
      quoteMint: pair.quoteToken.address,
      volume24h: pair.volume?.h24 || 0,
    });

    const priceData: DexScreenerPrice = {
      mint,
      symbol: symbol || bestPair.baseToken.symbol,
      priceUsd: parseFloat(bestPair.priceUsd),
      totalLiquidityUsd: totalLiquidity,
      bestPair: toPairInfo(bestPair),
      bestUsdcPair: bestUsdcPair ? toPairInfo(bestUsdcPair) : null,
      bestSolPair: bestSolPair ? toPairInfo(bestSolPair) : null,
      allPairs: validPairs.map(pair => ({
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        liquidityUsd: pair.liquidity?.usd || 0,
        quoteToken: pair.quoteToken.symbol,
        quoteMint: pair.quoteToken.address,
      })),
      timestamp: Date.now(),
    };

    // Cache the result
    priceCache.set(mint, priceData);

    feedLogger.info({
      mint: mint.slice(0, 8),
      symbol: priceData.symbol,
      priceUsd: priceData.priceUsd.toFixed(2),
      totalLiquidity: totalLiquidity.toFixed(0),
      pairCount: validPairs.length,
      bestDex: bestPair.dexId,
      usdcLiquidity: bestUsdcPair?.liquidity?.usd?.toFixed(0) || '0',
      solLiquidity: bestSolPair?.liquidity?.usd?.toFixed(0) || '0',
    }, `Token price fetched: ${priceData.symbol} $${priceData.priceUsd.toFixed(2)}`);

    return priceData;
  } catch (error) {
    recordApiCall('dexscreener', false, 0, String(error));
    feedLogger.debug({ mint, error }, 'DexScreener fetch failed');
    return null;
  }
}

/**
 * Fetch prices for multiple tokens using batch API (up to 30 per request)
 * Much more efficient than sequential calls for large token lists
 */
export async function fetchBatchDexScreenerPrices(
  tokens: Array<{ mint: string; symbol: string }>
): Promise<Map<string, DexScreenerPrice>> {
  const results = new Map<string, DexScreenerPrice>();
  const BATCH_SIZE = 30; // DexScreener limit
  feedLogger.info({ count: tokens.length }, 'Token price fetch (dexscreener batch)');

  // Process in batches of 30
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const mints = batch.map(t => t.mint);

    // Create mint → symbol lookup for this batch
    const symbolLookup = new Map<string, string>();
    batch.forEach(t => symbolLookup.set(t.mint, t.symbol));

    try {
      await waitForRateLimit();

      // Batch API: comma-separated addresses
      // Note: /tokens/v1/ endpoint returns array directly, not { pairs: [...] }
      const batchStartTime = Date.now();
      const response = await axios.get<DexScreenerPair[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`,
        { timeout: 15000 }
      );
      recordApiCall('dexscreener', true, Date.now() - batchStartTime);

      const pairs = Array.isArray(response.data) ? response.data : [];

      if (pairs.length > 0) {
        // Group pairs by base token address
        const pairsByToken = new Map<string, DexScreenerPair[]>();

        for (const pair of pairs) {
          if (pair.chainId === 'solana' && pair.liquidity?.usd > 0) {
            const tokenAddr = pair.baseToken.address;
            if (!pairsByToken.has(tokenAddr)) {
              pairsByToken.set(tokenAddr, []);
            }
            pairsByToken.get(tokenAddr)!.push(pair);
          }
        }

        // Process each token's pairs
        for (const [mint, pairs] of pairsByToken) {
          if (pairs.length === 0) continue;

          // Sort by liquidity (highest first)
          pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

          // Find best USDC pair
          const usdcPairs = pairs.filter(pair => pair.quoteToken.address === USDC_MINT);
          const bestUsdcPair = usdcPairs.length > 0 ? usdcPairs[0] : null;

          // Find best SOL pair
          const solPairs = pairs.filter(pair => pair.quoteToken.address === SOL_MINT);
          const bestSolPair = solPairs.length > 0 ? solPairs[0] : null;

          // Overall best pair: prefer USDC for price accuracy
          const bestPair = bestUsdcPair || pairs[0];

          // Calculate total liquidity
          const totalLiquidity = pairs.reduce(
            (sum, pair) => sum + (pair.liquidity?.usd || 0),
            0
          );

          // Helper to create PairInfo
          const toPairInfo = (pair: DexScreenerPair): PairInfo => ({
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            liquidityUsd: pair.liquidity?.usd || 0,
            quoteToken: pair.quoteToken.symbol,
            quoteMint: pair.quoteToken.address,
            volume24h: pair.volume?.h24 || 0,
          });

          const priceData: DexScreenerPrice = {
            mint,
            symbol: symbolLookup.get(mint) || bestPair.baseToken.symbol,
            priceUsd: parseFloat(bestPair.priceUsd),
            totalLiquidityUsd: totalLiquidity,
            bestPair: toPairInfo(bestPair),
            bestUsdcPair: bestUsdcPair ? toPairInfo(bestUsdcPair) : null,
            bestSolPair: bestSolPair ? toPairInfo(bestSolPair) : null,
            allPairs: pairs.map(pair => ({
              pairAddress: pair.pairAddress,
              dexId: pair.dexId,
              liquidityUsd: pair.liquidity?.usd || 0,
              quoteToken: pair.quoteToken.symbol,
              quoteMint: pair.quoteToken.address,
            })),
            timestamp: Date.now(),
          };

          // Cache and store result
          priceCache.set(mint, priceData);
          results.set(mint, priceData);
        }
      }

      feedLogger.info({
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        totalBatches: Math.ceil(tokens.length / BATCH_SIZE),
        tokensInBatch: batch.length,
        pricesFound: results.size,
      }, 'DexScreener batch fetch complete');

    } catch (error) {
      recordApiCall('dexscreener', false, 0, String(error));
      feedLogger.warn({
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        error
      }, 'DexScreener batch fetch failed, trying individual fallback');

      // Fallback to individual fetches for this batch
      for (const token of batch) {
        const price = await fetchDexScreenerPrice(token.mint, token.symbol);
        if (price) {
          results.set(token.mint, price);
        }
      }
    }

    // Small delay between batches
    if (i + BATCH_SIZE < tokens.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const fetchedSymbols = tokens
    .filter(t => results.has(t.mint))
    .map(t => t.symbol)
    .slice(0, 10)
    .join(', ');
  feedLogger.info({
    totalTokens: tokens.length,
    pricesFound: results.size,
    symbols: fetchedSymbols,
  }, `Token prices fetched: ${fetchedSymbols}${results.size > 10 ? '...' : ''}`);

  return results;
}
