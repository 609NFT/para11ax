/**
 * GeckoTerminal Price Feed - Batch liquidity lookups
 *
 * Uses multi-token endpoint for efficient batch lookups:
 * GET /api/v2/networks/solana/tokens/multi/{addresses}?include=top_pools
 *
 * Rate limit: 10 requests/minute (free tier)
 */

import axios from 'axios';
import { feedLogger } from '../logger';
import { USDC_MINT, SOL_MINT } from '../constants';
import { recordApiCall } from './endpointTracker';

interface GeckoTerminalPoolAttributes {
  address: string;
  name: string;
  base_token_price_usd: string;
  reserve_in_usd: string;
  volume_usd: {
    h24: string;
  };
}

interface GeckoTerminalPool {
  id: string;
  type: string;
  attributes: GeckoTerminalPoolAttributes;
  relationships: {
    base_token: {
      data: {
        id: string;
        type: string;
      };
    };
    quote_token: {
      data: {
        id: string;
        type: string;
      };
    };
    dex: {
      data: {
        id: string;
        type: string;
      };
    };
  };
}

interface GeckoTerminalToken {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    total_reserve_in_usd: string;
  };
  relationships: {
    top_pools: {
      data: Array<{ id: string; type: string }>;
    };
  };
}

interface GeckoTerminalMultiResponse {
  data: GeckoTerminalToken[];
  included?: GeckoTerminalPool[];
}

interface GeckoTerminalSingleResponse {
  data: GeckoTerminalPool[];
}

export interface GeckoTerminalPrice {
  mint: string;
  symbol: string;
  priceUsd: number;
  totalLiquidityUsd: number;
  bestPool: {
    pairAddress: string;
    dexId: string;
    liquidityUsd: number;
    quoteToken: 'USDC' | 'SOL' | 'OTHER';
    quoteMint: string;
  } | null;
  bestUsdcPool: {
    pairAddress: string;
    dexId: string;
    liquidityUsd: number;
  } | null;
  bestSolPool: {
    pairAddress: string;
    dexId: string;
    liquidityUsd: number;
  } | null;
  timestamp: number;
}

// Rate limiting - 20 requests/minute = 3000ms between calls
let lastCallTime: number = 0;
const MIN_CALL_INTERVAL_MS = 3000;

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
 * Extract mint address from GeckoTerminal token ID
 * Format: "solana_MINTADDRESS"
 */
function extractMint(tokenId: string): string {
  return tokenId.replace('solana_', '');
}

/**
 * Parse pool data into our format
 */
function parsePool(pool: GeckoTerminalPool): {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  quoteToken: 'USDC' | 'SOL' | 'OTHER';
  quoteMint: string;
  priceUsd: number;
} {
  const quoteMint = extractMint(pool.relationships.quote_token.data.id);
  let quoteToken: 'USDC' | 'SOL' | 'OTHER' = 'OTHER';
  if (quoteMint === USDC_MINT) {
    quoteToken = 'USDC';
  } else if (quoteMint === SOL_MINT) {
    quoteToken = 'SOL';
  }

  return {
    pairAddress: pool.attributes.address,
    dexId: pool.relationships.dex.data.id,
    liquidityUsd: parseFloat(pool.attributes.reserve_in_usd) || 0,
    quoteToken,
    quoteMint,
    priceUsd: parseFloat(pool.attributes.base_token_price_usd) || 0,
  };
}

/**
 * Fetch liquidity data for multiple tokens using batch endpoint
 * Much more efficient than individual calls - up to 30 tokens per request
 */
export async function fetchBatchGeckoTerminalPrices(
  tokens: Array<{ mint: string; symbol: string }>
): Promise<Map<string, GeckoTerminalPrice>> {
  const results = new Map<string, GeckoTerminalPrice>();
  const BATCH_SIZE = 30; // GeckoTerminal limit per request

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const mints = batch.map(t => t.mint);
    const symbolLookup = new Map(batch.map(t => [t.mint, t.symbol]));

    try {
      await waitForRateLimit();

      // Use multi-token endpoint with top_pools included
      const addresses = mints.join(',');
      const batchStartTime = Date.now();
      const response = await axios.get<GeckoTerminalMultiResponse>(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${addresses}?include=top_pools`,
        { timeout: 15000 }
      );
      recordApiCall('geckoterminal', true, Date.now() - batchStartTime);

      if (!response.data.data) {
        feedLogger.debug({ batchSize: batch.length }, 'No data from GeckoTerminal batch');
        continue;
      }

      // Build pool lookup from included data
      const poolLookup = new Map<string, GeckoTerminalPool>();
      if (response.data.included) {
        for (const pool of response.data.included) {
          if (pool.type === 'pool') {
            poolLookup.set(pool.id, pool);
          }
        }
      }

      // Process each token
      for (const tokenData of response.data.data) {
        const mint = extractMint(tokenData.id);
        const symbol = symbolLookup.get(mint) || tokenData.attributes.symbol;
        const totalLiquidity = parseFloat(tokenData.attributes.total_reserve_in_usd) || 0;

        // Get top pools for this token
        const topPoolIds = tokenData.relationships.top_pools?.data || [];
        const pools: GeckoTerminalPool[] = [];
        for (const poolRef of topPoolIds) {
          const pool = poolLookup.get(poolRef.id);
          if (pool) {
            pools.push(pool);
          }
        }

        if (pools.length === 0) {
          continue;
        }

        // Parse and sort pools by liquidity
        const parsedPools = pools.map(parsePool).sort((a, b) => b.liquidityUsd - a.liquidityUsd);

        // Find best USDC and SOL pools
        const bestUsdcPool = parsedPools.find(p => p.quoteToken === 'USDC') || null;
        const bestSolPool = parsedPools.find(p => p.quoteToken === 'SOL') || null;
        const bestPool = parsedPools[0];

        const priceData: GeckoTerminalPrice = {
          mint,
          symbol,
          priceUsd: bestPool.priceUsd,
          totalLiquidityUsd: totalLiquidity,
          bestPool: {
            pairAddress: bestPool.pairAddress,
            dexId: bestPool.dexId,
            liquidityUsd: bestPool.liquidityUsd,
            quoteToken: bestPool.quoteToken,
            quoteMint: bestPool.quoteMint,
          },
          bestUsdcPool: bestUsdcPool ? {
            pairAddress: bestUsdcPool.pairAddress,
            dexId: bestUsdcPool.dexId,
            liquidityUsd: bestUsdcPool.liquidityUsd,
          } : null,
          bestSolPool: bestSolPool ? {
            pairAddress: bestSolPool.pairAddress,
            dexId: bestSolPool.dexId,
            liquidityUsd: bestSolPool.liquidityUsd,
          } : null,
          timestamp: Date.now(),
        };

        results.set(mint, priceData);
      }

      feedLogger.info({
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        totalBatches: Math.ceil(tokens.length / BATCH_SIZE),
        tokensInBatch: batch.length,
        pricesFound: results.size,
      }, 'GeckoTerminal batch fetch complete');

    } catch (error) {
      recordApiCall('geckoterminal', false, 0, String(error));
      feedLogger.warn({ batchIndex: Math.floor(i / BATCH_SIZE) + 1, error }, 'GeckoTerminal batch fetch failed');
    }

    // Delay between batches
    if (i + BATCH_SIZE < tokens.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Fetch price and liquidity data from GeckoTerminal for a single token
 * Use fetchBatchGeckoTerminalPrices for multiple tokens (more efficient)
 */
export async function fetchGeckoTerminalPrice(mint: string, symbol?: string): Promise<GeckoTerminalPrice | null> {
  try {
    await waitForRateLimit();

    const startTime = Date.now();
    const response = await axios.get<GeckoTerminalSingleResponse>(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
      { timeout: 10000 }
    );
    recordApiCall('geckoterminal', true, Date.now() - startTime);

    if (!response.data.data || response.data.data.length === 0) {
      feedLogger.debug({ mint }, 'No pools found on GeckoTerminal');
      return null;
    }

    const pools = response.data.data;

    // Filter for pools where this token is the base token and has liquidity
    const validPools = pools.filter(pool => {
      const baseMint = extractMint(pool.relationships.base_token.data.id);
      const liquidity = parseFloat(pool.attributes.reserve_in_usd) || 0;
      return baseMint === mint && liquidity > 0;
    });

    if (validPools.length === 0) {
      feedLogger.debug({ mint }, 'No valid pools found on GeckoTerminal');
      return null;
    }

    // Parse and sort pools by liquidity
    const parsedPools = validPools.map(parsePool).sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    // Calculate total liquidity
    const totalLiquidity = parsedPools.reduce((sum, p) => sum + p.liquidityUsd, 0);

    // Find best USDC and SOL pools
    const bestUsdcPool = parsedPools.find(p => p.quoteToken === 'USDC') || null;
    const bestSolPool = parsedPools.find(p => p.quoteToken === 'SOL') || null;
    const bestPool = parsedPools[0];

    const priceData: GeckoTerminalPrice = {
      mint,
      symbol: symbol || validPools[0].attributes.name.split(' / ')[0],
      priceUsd: bestPool.priceUsd,
      totalLiquidityUsd: totalLiquidity,
      bestPool: {
        pairAddress: bestPool.pairAddress,
        dexId: bestPool.dexId,
        liquidityUsd: bestPool.liquidityUsd,
        quoteToken: bestPool.quoteToken,
        quoteMint: bestPool.quoteMint,
      },
      bestUsdcPool: bestUsdcPool ? {
        pairAddress: bestUsdcPool.pairAddress,
        dexId: bestUsdcPool.dexId,
        liquidityUsd: bestUsdcPool.liquidityUsd,
      } : null,
      bestSolPool: bestSolPool ? {
        pairAddress: bestSolPool.pairAddress,
        dexId: bestSolPool.dexId,
        liquidityUsd: bestSolPool.liquidityUsd,
      } : null,
      timestamp: Date.now(),
    };

    feedLogger.info({
      mint: mint.slice(0, 8),
      symbol: priceData.symbol,
      totalLiquidity: totalLiquidity.toFixed(0),
      poolCount: parsedPools.length,
      bestDex: bestPool.dexId,
    }, `GeckoTerminal: ${priceData.symbol} (${totalLiquidity.toFixed(0)} TVL)`);

    return priceData;
  } catch (error) {
    recordApiCall('geckoterminal', false, 0, String(error));
    feedLogger.debug({ mint, error }, 'GeckoTerminal fetch failed');
    return null;
  }
}
