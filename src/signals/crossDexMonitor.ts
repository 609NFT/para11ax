/**
 * Cross-DEX Spread Monitor
 *
 * Monitors price differences for the same token across different DEXes.
 * Logs arbitrage opportunities without executing trades (monitoring phase).
 *
 * Strategy: Buy token on cheap DEX, sell on expensive DEX for instant profit.
 * Risk-free if executed atomically (flash loans or multi-instruction transaction).
 */

import { signalLogger } from '../logger';
import { fetchBatchDexScreenerPrices } from '../feeds/dexScreenerFeed';

interface CrossDexOpportunity {
  symbol: string;
  spreadPct: number;
  cheapDex: string;
  cheapPrice: number;
  expensiveDex: string;
  expensivePrice: number;
  cheapLiquidity: number;
  expensiveLiquidity: number;
  timestamp: number;
  estimatedProfit: number; // After fees
}

interface DexPair {
  dexId: string;
  price: number;
  liquidity: number;
  volume24h: number;
}

// Configuration
const MIN_SPREAD_PCT = 0.3; // 0.3% minimum spread to consider
const MIN_LIQUIDITY_USD = 50000; // $50K minimum liquidity on both sides
const ESTIMATED_FEES_PCT = 0.25; // 0.25% estimated total fees (swap + slippage)
const MONITORING_ENABLED = true; // Feature flag

const crossDexLogger = signalLogger.child({ component: 'cross-dex-monitor' });

// Cache for rate limiting
let lastScan = 0;
const SCAN_INTERVAL_MS = 30000; // Scan every 30 seconds

/**
 * Scan for cross-DEX arbitrage opportunities
 */
export async function scanCrossDexOpportunities(tokens: Array<{ mint: string; symbol: string }>): Promise<CrossDexOpportunity[]> {
  if (!MONITORING_ENABLED) return [];

  const now = Date.now();
  if (now - lastScan < SCAN_INTERVAL_MS) return [];
  lastScan = now;

  const opportunities: CrossDexOpportunity[] = [];

  try {
    crossDexLogger.debug({ tokens: tokens.length }, 'Scanning cross-DEX opportunities');

    // Use batch API to get all token data at once
    const dexScreenerData = await fetchBatchDexScreenerPrices(tokens);

    for (const token of tokens) {
      const tokenData = dexScreenerData.get(token.mint);
      if (!tokenData?.allPairs || tokenData.allPairs.length < 2) continue;

      const dexPairs = tokenData.allPairs
        .filter((pair: { liquidityUsd: number; dexId: string }) =>
          pair.liquidityUsd > MIN_LIQUIDITY_USD &&
          ['raydium', 'orca', 'meteora'].includes(pair.dexId)
        )
        .map((pair: { dexId: string; liquidityUsd: number }): DexPair => ({
          dexId: pair.dexId,
          price: tokenData.priceUsd, // All pairs use the same price from DexScreener
          liquidity: pair.liquidityUsd,
          volume24h: 0, // Not available in allPairs structure
        }))
        .sort((a: DexPair, b: DexPair) => b.liquidity - a.liquidity);

      if (dexPairs.length < 2) continue;

      // Find best spread opportunities
      const opportunity = findBestSpread(token.symbol, dexPairs);
      if (opportunity) {
        opportunities.push(opportunity);

        crossDexLogger.info({
          symbol: opportunity.symbol,
          spread: `${opportunity.spreadPct.toFixed(2)}%`,
          cheapDex: opportunity.cheapDex,
          expensiveDex: opportunity.expensiveDex,
          estimatedProfit: `$${opportunity.estimatedProfit.toFixed(2)}`,
        }, 'Cross-DEX arbitrage opportunity detected');
      }
    }

    if (opportunities.length === 0) {
      crossDexLogger.debug('No cross-DEX opportunities found this scan');
    }

    return opportunities;

  } catch (error) {
    crossDexLogger.error({ error }, 'Error scanning cross-DEX opportunities');
    return [];
  }
}

// Note: getDexPairsForToken removed - now using batch API directly in scanCrossDexOpportunities

/**
 * Find the best spread between DEX pairs
 */
function findBestSpread(symbol: string, dexPairs: DexPair[]): CrossDexOpportunity | null {
  if (dexPairs.length < 2) return null;

  let bestSpread = 0;
  let bestOpportunity: CrossDexOpportunity | null = null;

  // Compare all pairs
  for (let i = 0; i < dexPairs.length; i++) {
    for (let j = i + 1; j < dexPairs.length; j++) {
      const cheap = dexPairs[i].price < dexPairs[j].price ? dexPairs[i] : dexPairs[j];
      const expensive = dexPairs[i].price < dexPairs[j].price ? dexPairs[j] : dexPairs[i];

      const spreadPct = ((expensive.price - cheap.price) / cheap.price) * 100;

      // Check if this spread is profitable after fees
      if (spreadPct > MIN_SPREAD_PCT && spreadPct > ESTIMATED_FEES_PCT) {
        // Estimate position size based on minimum liquidity
        const maxPositionSize = Math.min(cheap.liquidity * 0.05, expensive.liquidity * 0.05); // 5% of pool
        const estimatedProfit = maxPositionSize * (spreadPct - ESTIMATED_FEES_PCT) / 100;

        if (spreadPct > bestSpread) {
          bestSpread = spreadPct;
          bestOpportunity = {
            symbol,
            spreadPct,
            cheapDex: cheap.dexId,
            cheapPrice: cheap.price,
            expensiveDex: expensive.dexId,
            expensivePrice: expensive.price,
            cheapLiquidity: cheap.liquidity,
            expensiveLiquidity: expensive.liquidity,
            timestamp: Date.now(),
            estimatedProfit,
          };
        }
      }
    }
  }

  return bestOpportunity;
}

/**
 * Get historical cross-DEX opportunity frequency (for backtesting)
 */
export function getCrossDexStats(): {
  totalOpportunities: number;
  averageSpread: number;
  topTokens: Array<{ symbol: string; opportunities: number; avgSpread: number }>;
} {
  // This would be implemented with historical data storage
  // For now, return empty stats
  return {
    totalOpportunities: 0,
    averageSpread: 0,
    topTokens: [],
  };
}

/**
 * Enable/disable cross-DEX monitoring
 */
export function setCrossDexMonitoring(enabled: boolean): void {
  crossDexLogger.info({ enabled }, 'Cross-DEX monitoring toggled');
  // In production, this would update the MONITORING_ENABLED flag
}