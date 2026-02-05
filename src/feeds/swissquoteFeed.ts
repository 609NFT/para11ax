/**
 * Swissquote Forex Data Feed
 * Provides real-time forex/commodity prices including gold (XAU), silver (XAG), etc.
 * Free API with no rate limits detected
 */

import logger from '../logger';
import { StockPrice } from '../types';
import { recordApiCall } from './endpointTracker';

const feedLogger = logger.child({ module: 'swissquote-feed' });

const SWISSQUOTE_BASE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument';

// Cache for prices to avoid hammering the API
interface PriceCache {
  price: StockPrice;
  timestamp: number;
}

const priceCache: Map<string, PriceCache> = new Map();
const CACHE_TTL_MS = 5000; // 5 second cache

/**
 * Parse Swissquote symbol format (e.g., "XAU/USD" -> ["XAU", "USD"])
 */
function parseSymbol(symbol: string): { base: string; quote: string } {
  const parts = symbol.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid Swissquote symbol format: ${symbol}. Expected format: BASE/QUOTE (e.g., XAU/USD)`);
  }
  return { base: parts[0], quote: parts[1] };
}

/**
 * Fetch price from Swissquote API
 * Returns the mid price from the "standard" or "premium" spread profile
 */
export async function fetchSwissquotePrice(symbol: string): Promise<StockPrice | null> {
  // Check cache first
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.price;
  }

  const startTime = Date.now();
  try {
    const { base, quote } = parseSymbol(symbol);
    const url = `${SWISSQUOTE_BASE_URL}/${base}/${quote}`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });

    const responseMs = Date.now() - startTime;

    if (!response.ok) {
      recordApiCall('swissquote', false, responseMs, `HTTP ${response.status}`);
      feedLogger.warn({ symbol, status: response.status }, 'Swissquote API error');
      return null;
    }

    const data = await response.json() as SwissquoteResponse[];

    if (!data || data.length === 0) {
      feedLogger.warn({ symbol }, 'Swissquote returned empty data');
      return null;
    }

    // Find the best spread profile (prefer "standard" or "premium")
    let bestBid = 0;
    let bestAsk = 0;
    let foundPrice = false;

    for (const platform of data) {
      if (!platform.spreadProfilePrices) continue;

      for (const profile of platform.spreadProfilePrices) {
        // Prefer standard or premium profiles
        if (profile.spreadProfile === 'standard' || profile.spreadProfile === 'premium') {
          if (profile.bid > 0 && profile.ask > 0) {
            bestBid = profile.bid;
            bestAsk = profile.ask;
            foundPrice = true;
            break;
          }
        }
      }
      if (foundPrice) break;
    }

    // Fallback to any profile with valid prices
    if (!foundPrice) {
      for (const platform of data) {
        if (!platform.spreadProfilePrices) continue;
        for (const profile of platform.spreadProfilePrices) {
          if (profile.bid > 0 && profile.ask > 0) {
            bestBid = profile.bid;
            bestAsk = profile.ask;
            foundPrice = true;
            break;
          }
        }
        if (foundPrice) break;
      }
    }

    if (!foundPrice) {
      recordApiCall('swissquote', false, responseMs, 'No valid prices');
      feedLogger.warn({ symbol }, 'No valid prices in Swissquote response');
      return null;
    }

    // Calculate mid price
    const midPrice = (bestBid + bestAsk) / 2;

    const result: StockPrice = {
      symbol,
      price: midPrice,
      timestamp: Date.now(),
      source: 'swissquote',
      isStale: false,
    };

    // Update cache
    priceCache.set(symbol, { price: result, timestamp: Date.now() });

    recordApiCall('swissquote', true, responseMs);
    feedLogger.debug({ symbol, price: midPrice, bid: bestBid, ask: bestAsk }, 'Swissquote price fetched');

    return result;
  } catch (error) {
    const responseMs = Date.now() - startTime;
    recordApiCall('swissquote', false, responseMs, String(error));
    feedLogger.error({ symbol, error }, 'Failed to fetch Swissquote price');
    return null;
  }
}

/**
 * Get cached price without fetching (for quick lookups)
 */
export function getCachedSwissquotePrice(symbol: string): StockPrice | null {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS * 2) {
    return cached.price;
  }
  return null;
}

// Swissquote API response types
interface SwissquoteSpreadProfile {
  spreadProfile: string;  // "standard", "premium", "prime", "elite"
  bidSpread: number;
  askSpread: number;
  bid: number;
  ask: number;
}

interface SwissquoteResponse {
  topo: {
    platform: string;
    server: string;
  };
  spreadProfilePrices: SwissquoteSpreadProfile[];
  ts: number;
}
