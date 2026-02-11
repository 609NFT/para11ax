/**
 * Data Resolvers Index
 * Maps market categories to their respective data resolvers
 */

import { DFlowMarket, MarketCategory, ResolverResult, PredictOpportunity } from '../dflow/types';
import { classifyMarket, getBuyPrice } from '../dflow/client';
import { resolveWeatherMarket } from './weather';
import { resolveCryptoMarket } from './crypto';
import { resolveStockMarket } from './stocks';
import { resolveSportsMarket } from './sports';
import logger from '../logger';

// Resolver function type
type MarketResolver = (
  market: DFlowMarket
) => Promise<{ outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } | null>;

// Registry of resolvers by category
// All resolvers receive the full DFlowMarket object for time-aware resolution
const RESOLVERS: Partial<Record<MarketCategory, MarketResolver>> = {
  weather: async (market) => resolveWeatherMarket(market),
  crypto: async (market) => resolveCryptoMarket(market),
  stocks: async (market) => resolveStockMarket(market),
  sports: async (market) => resolveSportsMarket(market),
};

/**
 * Check if we have a resolver for a market category
 */
export function hasResolver(category: MarketCategory): boolean {
  return category in RESOLVERS;
}

/**
 * Get supported categories
 */
export function getSupportedCategories(): MarketCategory[] {
  return Object.keys(RESOLVERS) as MarketCategory[];
}

/**
 * Resolve a market using the appropriate resolver
 */
export async function resolveMarket(
  market: DFlowMarket
): Promise<{ outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } | null> {
  const category = classifyMarket(market);
  const resolver = RESOLVERS[category];

  if (!resolver) {
    return null;
  }

  try {
    return await resolver(market);
  } catch (e) {
    logger.warn({ ticker: market.ticker, category, error: e }, 'Resolver failed');
    return null;
  }
}

/**
 * Analyze a market and generate a predict opportunity if edge exists
 */
export async function analyzeMarket(market: DFlowMarket): Promise<PredictOpportunity | null> {
  const category = classifyMarket(market);
  
  // Check if we have a resolver
  if (!hasResolver(category)) {
    return null;
  }

  // Get resolution
  const resolution = await resolveMarket(market);
  if (!resolution) {
    return null;
  }

  const { outcome, confidence, data } = resolution;

  // Get market price for the predicted outcome
  const marketPrice = getBuyPrice(market, outcome);
  if (marketPrice <= 0 || marketPrice >= 1) {
    return null; // No valid price
  }

  // Calculate edge
  // Our fair value = confidence (probability we're right)
  // Market price = what we pay
  // Edge = fairValue - marketPrice
  const fairValue = confidence;
  const edgePct = fairValue - marketPrice;

  // Only interesting if positive edge
  if (edgePct <= 0) {
    return null;
  }

  // Calculate expected value per dollar bet
  // If we're right (prob = confidence), we get $1
  // If we're wrong (prob = 1 - confidence), we get $0
  // Cost = marketPrice
  // EV = (confidence * 1) + ((1 - confidence) * 0) - marketPrice
  //    = confidence - marketPrice = edgePct
  const expectedValue = edgePct;

  // Kelly criterion for optimal bet sizing
  // Kelly = (bp - q) / b where:
  // b = odds (payout per $1 wagered) = (1 - marketPrice) / marketPrice
  // p = probability of winning = confidence
  // q = probability of losing = 1 - confidence
  const b = (1 - marketPrice) / marketPrice;
  const p = confidence;
  const q = 1 - confidence;
  const kellyFraction = Math.max(0, (b * p - q) / b);

  // Hours to expiry
  const hoursToExpiry = (market.expirationTime * 1000 - Date.now()) / (1000 * 60 * 60);

  // Build reasons
  const reasons: string[] = [];
  reasons.push(`Data: ${data.dataValue} from ${data.source}`);
  reasons.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);
  reasons.push(`Market price: ${(marketPrice * 100).toFixed(1)}¢`);
  reasons.push(`Edge: ${(edgePct * 100).toFixed(1)}%`);
  if (hoursToExpiry < 24) {
    reasons.push(`Expires in ${hoursToExpiry.toFixed(1)}h`);
  }

  return {
    market,
    outcome,
    dataSource: data.source,
    dataValue: data.dataValue,
    dataTimestamp: data.timestamp,
    dataConfidence: confidence,
    marketPrice,
    marketImpliedProb: marketPrice,
    fairValue,
    edgePct,
    expectedValue,
    kellyFraction,
    suggestedSizeUsd: Math.min(20, kellyFraction * 100), // Cap at $20, scale kelly
    maxSizeUsd: 50,
    hoursToExpiry,
    reasons,
  };
}

/**
 * Scan all markets and find opportunities
 */
export async function scanForOpportunities(
  markets: DFlowMarket[],
  minEdgePct: number = 0.10,
  minConfidence: number = 0.80,
  minMarketPrice: number = 0.03,
  maxEdgePct: number = 0.50,
  maxMarketPrice: number = 0.95
): Promise<PredictOpportunity[]> {
  const opportunities: PredictOpportunity[] = [];

  for (const market of markets) {
    try {
      const opp = await analyzeMarket(market);
      if (opp && opp.edgePct >= minEdgePct && opp.dataConfidence >= minConfidence) {
        // Skip markets with very low prices (no real liquidity, inflated edge)
        if (opp.marketPrice < minMarketPrice) {
          logger.debug({ ticker: market.ticker, price: opp.marketPrice, edge: opp.edgePct }, 'Skipping low-price market (fake edge)');
          continue;
        }
        // Skip markets priced too high (near-certain, no upside)
        if (opp.marketPrice > maxMarketPrice) {
          logger.debug({ ticker: market.ticker, price: opp.marketPrice }, 'Skipping high-price market (no upside)');
          continue;
        }
        // Skip absurdly high edge — means market is illiquid/mispriced, not real alpha
        if (opp.edgePct > maxEdgePct) {
          logger.debug({ ticker: market.ticker, edge: opp.edgePct, price: opp.marketPrice }, 'Skipping excessive edge (illiquid market)');
          continue;
        }
        opportunities.push(opp);
      }
    } catch (e) {
      logger.debug({ ticker: market.ticker, error: e }, 'Failed to analyze market');
    }
  }

  // Sort by edge (highest first)
  opportunities.sort((a, b) => b.edgePct - a.edgePct);

  return opportunities;
}

// Re-export resolvers
export { resolveWeatherMarket } from './weather';
export { resolveSportsMarket } from './sports';
