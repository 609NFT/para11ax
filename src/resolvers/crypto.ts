/**
 * Crypto Price Resolver (Time-Aware)
 * Fetches real-time crypto prices and calculates confidence
 * based on distance from threshold AND time to resolution
 * 
 * Data sources:
 * - CoinGecko (free, no API key needed)
 * 
 * Confidence model:
 * - Distance: How far is current price from threshold in std devs?
 * - Time: How close are we to resolution? Closer = more certain
 * - Combined: Both factors multiply — close in time AND far from threshold = max confidence
 */

import https from 'https';
import { DFlowMarket, ResolverResult } from '../dflow/types';
import {
  parseMarketThreshold,
  parseResolutionTimeFromRules,
  getDistanceConfidence,
  getTimeScaledConfidence,
  hoursUntilResolution,
  MarketThreshold,
} from './utils';
import logger from '../logger';

// CoinGecko API (free tier)
const COINGECKO_API = 'api.coingecko.com';

// Daily volatility estimates (decimal)
const DAILY_VOLATILITY: Record<string, number> = {
  BTC: 0.04,  // ~4% daily vol
  ETH: 0.05,  // ~5% daily vol
};

// Cache prices to avoid rate limits (60 second TTL)
const priceCache: Map<string, { price: number; timestamp: number }> = new Map();
const CACHE_TTL_MS = 60_000;

/**
 * Fetch current price from CoinGecko
 */
async function fetchCoinGeckoPrice(coinId: string): Promise<number | null> {
  const cached = priceCache.get(coinId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.price;
  }

  return new Promise((resolve) => {
    const path = `/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
    
    https.get({
      hostname: COINGECKO_API,
      path,
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'Parallax/1.0 (https://parallax.report)'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const price = json[coinId]?.usd;
          if (typeof price === 'number') {
            priceCache.set(coinId, { price, timestamp: Date.now() });
            resolve(price);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Get Bitcoin price
 */
export async function getBTCPrice(): Promise<ResolverResult | null> {
  const price = await fetchCoinGeckoPrice('bitcoin');
  if (!price) return null;

  return {
    category: 'crypto',
    dataValue: `$${price.toLocaleString()}`,
    numericValue: price,
    confidence: 0.95,
    source: 'CoinGecko',
    sourceUrl: 'https://www.coingecko.com/en/coins/bitcoin',
    timestamp: Date.now(),
  };
}

/**
 * Get Ethereum price
 */
export async function getETHPrice(): Promise<ResolverResult | null> {
  const price = await fetchCoinGeckoPrice('ethereum');
  if (!price) return null;

  return {
    category: 'crypto',
    dataValue: `$${price.toLocaleString()}`,
    numericValue: price,
    confidence: 0.95,
    source: 'CoinGecko',
    sourceUrl: 'https://www.coingecko.com/en/coins/ethereum',
    timestamp: Date.now(),
  };
}

/**
 * Detect which crypto asset a market is about
 */
function detectCryptoAsset(title: string, ticker: string): 'BTC' | 'ETH' | null {
  const combined = (title + ' ' + ticker).toLowerCase();
  if (combined.includes('bitcoin') || combined.includes('btc') || combined.includes('kxbtc')) {
    return 'BTC';
  }
  if (combined.includes('ethereum') || combined.includes('eth') || combined.includes('kxeth')) {
    return 'ETH';
  }
  return null;
}

/**
 * Parse threshold and condition from market data
 * Tries multiple sources: ticker, rules, title
 */
function parseCryptoThreshold(market: DFlowMarket): MarketThreshold | null {
  return parseMarketThreshold(market.ticker, market.rulesPrimary || '', market.title);
}

/**
 * Get the resolution time for a crypto market
 * Priority: rules text > expirationTime from API
 */
function getResolutionTime(market: DFlowMarket): Date {
  // Try parsing from rules first (more precise, includes timezone)
  if (market.rulesPrimary) {
    const parsed = parseResolutionTimeFromRules(market.rulesPrimary);
    if (parsed) return parsed.date;
  }

  // Fallback to API expirationTime (unix seconds)
  return new Date(market.expirationTime * 1000);
}

/**
 * Resolve a crypto price market with time-aware confidence
 */
export async function resolveCryptoMarket(market: DFlowMarket): Promise<{
  outcome: 'yes' | 'no';
  confidence: number;
  data: ResolverResult;
} | null> {
  // Detect asset
  const asset = detectCryptoAsset(market.title, market.ticker);
  if (!asset) {
    logger.debug({ ticker: market.ticker }, 'Could not detect crypto asset');
    return null;
  }

  // Parse threshold
  const threshold = parseCryptoThreshold(market);
  if (!threshold) {
    logger.debug({ ticker: market.ticker }, 'Could not parse crypto threshold');
    return null;
  }

  // Get current price
  let priceData: ResolverResult | null = null;
  if (asset === 'BTC') {
    priceData = await getBTCPrice();
  } else if (asset === 'ETH') {
    priceData = await getETHPrice();
  }

  if (!priceData) {
    logger.warn({ asset }, 'Failed to get crypto price');
    return null;
  }

  const currentPrice = priceData.numericValue;
  const resolutionTime = getResolutionTime(market);
  const hoursLeft = hoursUntilResolution(resolutionTime);
  const vol = DAILY_VOLATILITY[asset] || 0.04;

  // Handle 'between' markets
  if (threshold.comparison === 'between' && threshold.upperValue !== undefined) {
    return resolveBetweenMarket(currentPrice, threshold.value, threshold.upperValue, vol, hoursLeft, priceData);
  }

  // Distance-based confidence (between is already handled above)
  const distResult = getDistanceConfidence(
    currentPrice,
    threshold.value,
    threshold.comparison as 'above' | 'below',
    vol,
    hoursLeft
  );

  // Time-scaled confidence
  const finalConfidence = getTimeScaledConfidence(hoursLeft, distResult.confidence);

  logger.info({
    asset,
    currentPrice,
    threshold: threshold.value,
    comparison: threshold.comparison,
    hoursLeft: hoursLeft.toFixed(1),
    distanceConfidence: distResult.confidence.toFixed(3),
    finalConfidence: finalConfidence.toFixed(3),
    outcome: distResult.outcome,
  }, 'Crypto market resolved');

  return {
    outcome: distResult.outcome,
    confidence: finalConfidence,
    data: {
      ...priceData,
      confidence: finalConfidence,
    },
  };
}

/**
 * Resolve a "between X and Y" crypto market
 */
function resolveBetweenMarket(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
  _vol: number,
  hoursLeft: number,
  priceData: ResolverResult,
): { outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } {
  const isInRange = currentPrice >= lowerBound && currentPrice <= upperBound;

  // Distance from nearest boundary
  const distToLower = Math.abs(currentPrice - lowerBound);
  const distToUpper = Math.abs(currentPrice - upperBound);
  const minDist = Math.min(distToLower, distToUpper);
  const rangeWidth = upperBound - lowerBound;

  // Confidence based on distance from boundaries relative to range
  let baseConfidence: number;
  if (isInRange) {
    // Inside range — confidence that it stays inside
    const relDist = minDist / rangeWidth; // 0 = at boundary, 0.5 = center
    baseConfidence = 0.55 + relDist * 0.60; // 0.55 at boundary → 0.85 at center
  } else {
    // Outside range — confidence that it stays outside
    const relDist = minDist / (currentPrice * 0.01); // Distance as % of price
    baseConfidence = 0.55 + Math.min(relDist * 0.10, 0.40); // Scale up with distance
  }

  const finalConfidence = getTimeScaledConfidence(hoursLeft, baseConfidence);

  return {
    outcome: isInRange ? 'yes' : 'no',
    confidence: finalConfidence,
    data: {
      ...priceData,
      confidence: finalConfidence,
    },
  };
}

// Legacy exports for backward compatibility
export { parseCryptoThreshold as parseCryptoTarget };
export { getResolutionTime as parseExpirationFromTitle };
