/**
 * Stock Price Resolver (Intraday-Aware)
 * Fetches real-time stock/index prices and calculates confidence
 * based on distance from threshold, time to resolution, AND market hours
 * 
 * Now handles INTRADAY markets resolving in hours:
 * - KXINXU-26FEB11H1600-T6949.9999 = "S&P above 6949.99 at 4pm EST"
 * - KXNASDAQ100U-26FEB11H1600-T25199.99 = "Nasdaq above 25199.99 at 4pm EST"
 * 
 * Data sources:
 * - Yahoo Finance (free, no API key)
 * 
 * Confidence model:
 * - Distance: How far is current price from threshold in std devs?
 * - Time: How close are we to resolution?
 * - Market hours: Higher confidence near market close (3:50 PM ET = very confident)
 * - Pre-market/after-hours: Use last close, moderate confidence
 */

import https from 'https';
import { DFlowMarket, ResolverResult } from '../dflow/types';
import {
  parseMarketThreshold,
  parseResolutionTimeFromRules,
  getDistanceConfidence,
  getTimeScaledConfidence,
  hoursUntilResolution,
} from './utils';
import logger from '../logger';

// Cache prices (60 second TTL)
const priceCache: Map<string, { price: number; timestamp: number }> = new Map();
const CACHE_TTL_MS = 60_000;

// Supported indices with metadata
const STOCK_INDICES: Record<string, { 
  yahooSymbol: string; 
  name: string; 
  volatility: number; 
  url: string; 
}> = {
  SP500: { 
    yahooSymbol: '^GSPC', 
    name: 'S&P 500', 
    volatility: 0.012, 
    url: 'https://finance.yahoo.com/quote/%5EGSPC' 
  },
  NDX: { 
    yahooSymbol: '^NDX', 
    name: 'Nasdaq-100', 
    volatility: 0.015, 
    url: 'https://finance.yahoo.com/quote/%5ENDX' 
  },
  NASDAQ100: { 
    yahooSymbol: '^NDX', 
    name: 'Nasdaq-100', 
    volatility: 0.015, 
    url: 'https://finance.yahoo.com/quote/%5ENDX' 
  },
  DJI: { 
    yahooSymbol: '^DJI', 
    name: 'Dow Jones', 
    volatility: 0.011, 
    url: 'https://finance.yahoo.com/quote/%5EDJI' 
  },
};

/**
 * Fetch current price from Yahoo Finance
 */
async function fetchYahooPrice(symbol: string): Promise<number | null> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.price;
  }

  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: { 
        'User-Agent': 'Parallax/1.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const quote = json.chart?.result?.[0];
          const price = quote?.meta?.regularMarketPrice;
          
          if (typeof price === 'number') {
            priceCache.set(symbol, { price, timestamp: Date.now() });
            resolve(price);
          } else {
            logger.debug({ symbol, response: data.substring(0, 200) }, 'No price in Yahoo response');
            resolve(null);
          }
        } catch (e) {
          logger.debug({ symbol, error: e }, 'Failed to parse Yahoo response');
          resolve(null);
        }
      });
    }).on('error', (e) => {
      logger.debug({ symbol, error: e.message }, 'Yahoo Finance request failed');
      resolve(null);
    });
  });
}

/**
 * Detect which stock index a market is about from ticker
 * Handles new intraday format: KXINXU-26FEB11H1600-T6949.9999, KXNASDAQ100U-26FEB11H1600-T25199.99
 */
function detectStockIndex(title: string, ticker: string): string | null {
  const combined = (title + ' ' + ticker).toLowerCase();
  const tickerUpper = ticker.toUpperCase();
  
  // Check ticker patterns first for precision
  if (tickerUpper.includes('KXINX')) return 'SP500';
  if (tickerUpper.includes('KXNASDAQ100')) return 'NASDAQ100';
  if (tickerUpper.includes('KXNASDAQ')) return 'NDX';
  if (tickerUpper.includes('KXDOW') || tickerUpper.includes('KXDJI')) return 'DJI';
  
  // Fallback to text patterns
  if (combined.includes('s&p') || combined.includes('sp500') || combined.includes('s&p 500')) return 'SP500';
  if (combined.includes('nasdaq-100') || combined.includes('nasdaq 100')) return 'NASDAQ100';
  if (combined.includes('nasdaq')) return 'NDX';
  if (combined.includes('dow') || combined.includes('dji')) return 'DJI';
  
  return null;
}

/**
 * Parse intraday stock ticker to extract resolution time
 * Examples:
 * - KXINXU-26FEB11H1600-T6949.9999 → Feb 11, 2026, 4pm EST (H1600 = 4:00pm EST)
 * - KXNASDAQ100U-26FEB11H1600-T25199.99 → Feb 11, 2026, 4pm EST
 */
function parseIntradayResolutionTime(ticker: string): Date | null {
  // Pattern: KXINDEX-DDMMMYYHttmm- where ttmm is time (1600 = 4:00pm EST)
  const match = ticker.match(/KX\w+-(\d{2})(\w{3})(\d{2})H(\d{2})(\d{2})-/);
  if (!match) return null;
  
  const day = parseInt(match[1], 10);
  const monthStr = match[2].toUpperCase();
  const year = 2000 + parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  
  // Month mapping
  const monthMap: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  
  const month = monthMap[monthStr];
  if (month === undefined) return null;
  
  // Convert EST to UTC (EST = UTC-5, so add 5 hours)
  // Note: Should handle EDT vs EST properly, but for February this is correct
  const utcHour = hour + 5;
  const utcMinute = minute;
  
  return new Date(Date.UTC(year, month, day, utcHour, utcMinute, 0));
}

/**
 * Get price data for a stock index
 */
async function getIndexPrice(index: string): Promise<ResolverResult | null> {
  const indexInfo = STOCK_INDICES[index];
  if (!indexInfo) {
    logger.debug({ index }, 'Unsupported stock index');
    return null;
  }

  const price = await fetchYahooPrice(indexInfo.yahooSymbol);
  if (!price) return null;

  return {
    category: 'stocks',
    dataValue: price.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    numericValue: price,
    confidence: 0.95,
    source: 'Yahoo Finance',
    sourceUrl: indexInfo.url,
    timestamp: Date.now(),
  };
}

/**
 * Check if US stock market is currently open
 * Market hours: 9:30 AM - 4:00 PM ET, Mon-Fri
 * Returns: 'open', 'premarket', 'afterhours', 'closed'
 */
function getMarketStatus(): 'open' | 'premarket' | 'afterhours' | 'closed' {
  const now = new Date();
  
  // Convert to ET (UTC-5 for EST, UTC-4 for EDT)
  // Approximate: Nov-Mar = EST (UTC-5), Mar-Nov = EDT (UTC-4)
  const month = now.getUTCMonth();
  const estOffset = (month >= 2 && month <= 10) ? 4 : 5; // Rough EDT/EST
  const etHour = (now.getUTCHours() - estOffset + 24) % 24;
  const etMinute = now.getUTCMinutes();
  const dayOfWeek = now.getUTCDay();

  // Weekend
  if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';

  const etTime = etHour * 60 + etMinute;
  const marketOpen = 9 * 60 + 30;  // 9:30 AM
  const marketClose = 16 * 60;      // 4:00 PM

  if (etTime >= marketOpen && etTime < marketClose) return 'open';
  if (etTime < marketOpen && etTime >= 4 * 60) return 'premarket'; // 4 AM premarket
  if (etTime >= marketClose && etTime < 20 * 60) return 'afterhours'; // Until 8 PM
  return 'closed';
}

/**
 * Get minutes until market close (during market hours)
 */
function minutesUntilClose(): number {
  const now = new Date();
  const month = now.getUTCMonth();
  const estOffset = (month >= 2 && month <= 10) ? 4 : 5;
  const etHour = (now.getUTCHours() - estOffset + 24) % 24;
  const etMinute = now.getUTCMinutes();
  const etTime = etHour * 60 + etMinute;
  const marketClose = 16 * 60;
  return marketClose - etTime;
}

/**
 * Get the resolution time for a stock market
 * Priority: intraday ticker parsing > rules text > expirationTime from API
 */
function getResolutionTime(market: DFlowMarket): Date {
  // Try intraday ticker parsing first (most precise for new markets)
  const intradayTime = parseIntradayResolutionTime(market.ticker);
  if (intradayTime) return intradayTime;
  
  // Fallback to rules text parsing
  if (market.rulesPrimary) {
    const parsed = parseResolutionTimeFromRules(market.rulesPrimary);
    if (parsed) return parsed.date;
  }
  
  // Last resort: API expirationTime
  return new Date(market.expirationTime * 1000);
}

/**
 * Resolve a stock/index market with time-aware confidence
 */
export async function resolveStockMarket(market: DFlowMarket): Promise<{
  outcome: 'yes' | 'no';
  confidence: number;
  data: ResolverResult;
} | null> {
  // Detect index
  const index = detectStockIndex(market.title, market.ticker);
  if (!index) {
    logger.debug({ ticker: market.ticker }, 'Could not detect stock index');
    return null;
  }

  // Parse threshold
  const threshold = parseMarketThreshold(market.ticker, market.rulesPrimary || '', market.title);
  if (!threshold) {
    logger.debug({ ticker: market.ticker }, 'Could not parse stock threshold');
    return null;
  }

  // Get current price
  const priceData = await getIndexPrice(index);
  if (!priceData) {
    logger.warn({ index }, 'Failed to get stock price');
    return null;
  }

  const currentPrice = priceData.numericValue;
  const resolutionTime = getResolutionTime(market);
  const hoursLeft = hoursUntilResolution(resolutionTime);
  const indexInfo = STOCK_INDICES[index];
  const vol = indexInfo?.volatility || 0.012;
  const marketStatus = getMarketStatus();

  // Handle 'between' markets
  if (threshold.comparison === 'between' && threshold.upperValue !== undefined) {
    return resolveBetweenStockMarket(currentPrice, threshold.value, threshold.upperValue, vol, hoursLeft, marketStatus, priceData);
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

  // Market hours bonus: if market is open and close to closing, boost confidence
  if (marketStatus === 'open') {
    const minsLeft = minutesUntilClose();
    if (minsLeft <= 10) {
      // Last 10 minutes — price is essentially the close
      finalConfidence = Math.min(0.95, finalConfidence * 1.08);
    } else if (minsLeft <= 30) {
      // Last 30 minutes — very unlikely to swing
      finalConfidence = Math.min(0.95, finalConfidence * 1.04);
    }
  } else if (marketStatus === 'closed' || marketStatus === 'afterhours') {
    // After market close — if resolving based on today's close, price is locked
    // Check if resolution is today or already past
    if (hoursLeft <= 0) {
      finalConfidence = Math.min(0.95, finalConfidence * 1.10);
    }
  }

  // Intraday bonus: if resolving in <2 hours and price is far from threshold, boost confidence
  if (hoursLeft <= 2 && distResult.confidence >= 0.85) {
    finalConfidence = Math.min(0.95, finalConfidence * 1.05);
    logger.debug({ index, hoursLeft, baseConf: distResult.confidence, boosted: finalConfidence }, 'Intraday confidence boost applied');
  }

  // Cap at 95%
  finalConfidence = Math.min(0.95, finalConfidence);

  logger.info({
    index,
    currentPrice,
    threshold: threshold.value,
    comparison: threshold.comparison,
    hoursLeft: hoursLeft.toFixed(1),
    marketStatus,
    distanceConfidence: distResult.confidence.toFixed(3),
    finalConfidence: finalConfidence.toFixed(3),
    outcome: distResult.outcome,
    resolutionTime: resolutionTime.toISOString(),
  }, 'Stock market resolved (intraday-aware)');

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
 * Resolve a "between X and Y" stock market
 */
function resolveBetweenStockMarket(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
  _vol: number,
  hoursLeft: number,
  _marketStatus: string,
  priceData: ResolverResult,
): { outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } {
  const isInRange = currentPrice >= lowerBound && currentPrice <= upperBound;

  // Distance from nearest boundary
  const distToLower = Math.abs(currentPrice - lowerBound);
  const distToUpper = Math.abs(currentPrice - upperBound);
  const minDist = Math.min(distToLower, distToUpper);
  const rangeWidth = upperBound - lowerBound;

  let baseConfidence: number;
  if (isInRange) {
    const relDist = minDist / rangeWidth;
    baseConfidence = 0.55 + relDist * 0.60;
  } else {
    const relDist = minDist / (currentPrice * 0.01);
    baseConfidence = 0.55 + Math.min(relDist * 0.10, 0.40);
  }

  const finalConfidence = Math.min(0.95, getTimeScaledConfidence(hoursLeft, baseConfidence));

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
export { detectStockIndex as parseStockTarget };
export { getIndexPrice as getSP500Price };
export { getIndexPrice as getNasdaq100Price };