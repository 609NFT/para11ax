/**
 * Crypto Price Resolver (Intraday-Aware)
 * Fetches real-time crypto prices and calculates confidence
 * based on distance from threshold AND time to resolution
 * 
 * Now handles INTRADAY markets resolving in hours:
 * - KXBTCD-26FEB1117-T66999.99 = "BTC above $66,999.99 at 5pm EST Feb 11"
 * - KXETHD-26FEB1117-T1999.99 = "ETH above $1999.99 at 5pm EST"
 * - KXSOLD-26FEB1117-T84.9999 = "SOL above $84.99 at 5pm EST"
 * - KXBTC-26FEB1114-B66875 = "BTC in range at 2pm EST"
 * 
 * Data sources:
 * - CoinGecko (free, no API key needed)
 * 
 * Confidence model:
 * - Distance: How far is current price from threshold in std devs?
 * - Time: How close are we to resolution? Closer = more certain
 * - Key insight: markets resolving in <2 hours where current price is far from threshold = HIGH confidence
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

// Supported crypto assets with CoinGecko IDs
const CRYPTO_ASSETS: Record<string, { coinId: string; symbol: string; volatility: number }> = {
  BTC: { coinId: 'bitcoin', symbol: 'BTC', volatility: 0.04 },     // ~4% daily vol
  ETH: { coinId: 'ethereum', symbol: 'ETH', volatility: 0.05 },    // ~5% daily vol
  SOL: { coinId: 'solana', symbol: 'SOL', volatility: 0.08 },      // ~8% daily vol
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
 * Get price for any supported crypto asset
 */
export async function getCryptoPrice(asset: string): Promise<ResolverResult | null> {
  const assetInfo = CRYPTO_ASSETS[asset.toUpperCase()];
  if (!assetInfo) {
    logger.debug({ asset }, 'Unsupported crypto asset');
    return null;
  }

  const price = await fetchCoinGeckoPrice(assetInfo.coinId);
  if (!price) return null;

  return {
    category: 'crypto',
    dataValue: `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    numericValue: price,
    confidence: 0.95,
    source: 'CoinGecko',
    sourceUrl: `https://www.coingecko.com/en/coins/${assetInfo.coinId}`,
    timestamp: Date.now(),
  };
}

/**
 * Legacy getters for backward compatibility
 */
export async function getBTCPrice(): Promise<ResolverResult | null> {
  return getCryptoPrice('BTC');
}

export async function getETHPrice(): Promise<ResolverResult | null> {
  return getCryptoPrice('ETH');
}

/**
 * Detect which crypto asset a market is about from ticker
 * Handles new intraday format: KXBTCD-26FEB1117-T66999.99, KXETHD-26FEB1117-T1999.99, KXSOLD-26FEB1117-T84.9999
 */
function detectCryptoAsset(title: string, ticker: string): string | null {
  const combined = (title + ' ' + ticker).toLowerCase();
  
  // Check ticker first for precise matches
  const tickerUpper = ticker.toUpperCase();
  
  // Intraday patterns: KXBTCD, KXBTC, KXETHD, KXSOLD
  if (tickerUpper.includes('KXBTC')) return 'BTC';
  if (tickerUpper.includes('KXETH')) return 'ETH';
  if (tickerUpper.includes('KXSOL')) return 'SOL';
  
  // Fallback to text patterns
  if (combined.includes('bitcoin') || combined.includes('btc')) return 'BTC';
  if (combined.includes('ethereum') || combined.includes('eth')) return 'ETH';
  if (combined.includes('solana') || combined.includes('sol')) return 'SOL';
  
  return null;
}

/**
 * Parse intraday crypto ticker to extract resolution time
 * Examples:
 * - KXBTCD-26FEB1117-T66999.99 → Feb 11, 2026, 5pm EST (17 = 5pm EST)
 * - KXBTC-26FEB1114-B66875 → Feb 11, 2026, 2pm EST (14 = 2pm EST)
 */
function parseIntradayResolutionTime(ticker: string): Date | null {
  // Pattern: KXASSET[-D]-DDMMMYYTTsomething where TT is hour (14=2pm EST, 17=5pm EST)
  const match = ticker.match(/KX\w+D?-(\d{2})(\w{3})(\d{2})(\d{2})-/);
  if (!match) return null;
  
  const day = parseInt(match[1], 10);
  const monthStr = match[2].toUpperCase();
  const year = 2000 + parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  
  // Month mapping
  const monthMap: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  
  const month = monthMap[monthStr];
  if (month === undefined) return null;
  
  // Convert EST hour to UTC (EST = UTC-5, so add 5 hours)
  // Note: In practice, should handle EDT vs EST, but for February this is correct
  const utcHour = hour + 5;
  
  return new Date(Date.UTC(year, month, day, utcHour, 0, 0));
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
 * Priority: intraday ticker parsing > rules text > expirationTime from API
 */
function getResolutionTime(market: DFlowMarket): Date {
  // Try intraday ticker parsing first (most precise for new markets)
  const intradayTime = parseIntradayResolutionTime(market.ticker);
  if (intradayTime) return intradayTime;
  
  // Try parsing from rules text (fallback for older format)
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
  const priceData = await getCryptoPrice(asset);
  if (!priceData) {
    logger.warn({ asset }, 'Failed to get crypto price');
    return null;
  }

  const currentPrice = priceData.numericValue;
  const resolutionTime = getResolutionTime(market);
  const hoursLeft = hoursUntilResolution(resolutionTime);
  const assetInfo = CRYPTO_ASSETS[asset];
  const vol = assetInfo?.volatility || 0.04;

  // Handle 'between' markets (bracket trades)
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
  let finalConfidence = getTimeScaledConfidence(hoursLeft, distResult.confidence);
  
  // Intraday bonus: if resolving in <2 hours and price is far from threshold, boost confidence
  if (hoursLeft <= 2 && distResult.confidence >= 0.85) {
    finalConfidence = Math.min(0.95, finalConfidence * 1.05);
    logger.debug({ asset, hoursLeft, baseConf: distResult.confidence, boosted: finalConfidence }, 'Intraday confidence boost applied');
  }

  logger.info({
    asset,
    currentPrice,
    threshold: threshold.value,
    comparison: threshold.comparison,
    hoursLeft: hoursLeft.toFixed(1),
    distanceConfidence: distResult.confidence.toFixed(3),
    finalConfidence: finalConfidence.toFixed(3),
    outcome: distResult.outcome,
    resolutionTime: resolutionTime.toISOString(),
  }, 'Crypto market resolved (intraday-aware)');

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
 * Resolve a "between X and Y" crypto market (bracket trades)
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