/**
 * Weather Data Resolver
 * Fetches real-time weather data from NWS (National Weather Service)
 * Used for NYC and Chicago high temperature markets
 * 
 * Settlement source: NWS Climatological Report (CLI)
 * https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC
 */

import https from 'https';
import { DFlowMarket, ResolverResult } from '../dflow/types';
import logger from '../logger';

// NWS CLI report URLs by city
const NWS_CLI_URLS: Record<string, { site: string; issuedby: string }> = {
  NYC: { site: 'OKX', issuedby: 'NYC' },
  CHICAGO: { site: 'LOT', issuedby: 'ORD' },
  DENVER: { site: 'BOU', issuedby: 'DEN' },
  MIAMI: { site: 'MFL', issuedby: 'MIA' },
  LOS_ANGELES: { site: 'LOX', issuedby: 'LAX' },
};

// Open-Meteo API for forecast/current data (backup)
const OPEN_METEO_COORDS: Record<string, { lat: number; lon: number }> = {
  NYC: { lat: 40.7128, lon: -74.006 },
  CHICAGO: { lat: 41.8781, lon: -87.6298 },
  DENVER: { lat: 39.7392, lon: -104.9903 },
  MIAMI: { lat: 25.7617, lon: -80.1918 },
  LOS_ANGELES: { lat: 34.0522, lon: -118.2437 },
};

interface NWSCLIData {
  city: string;
  date: string;           // "FEBRUARY 10 2026"
  highTemp: number | null;
  lowTemp: number | null;
  precipitation: number | null;
  isObserved: boolean;    // true if actual, false if forecast
  rawText: string;
}

/**
 * Fetch NWS Climatological Report for a city
 * This is the official settlement source for Kalshi weather markets
 */
async function fetchNWSCLI(city: string): Promise<NWSCLIData | null> {
  const config = NWS_CLI_URLS[city.toUpperCase()];
  if (!config) {
    logger.warn({ city }, 'Unknown city for NWS CLI');
    return null;
  }

  const url = `https://forecast.weather.gov/product.php?site=${config.site}&product=CLI&issuedby=${config.issuedby}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = parseNWSCLI(data, city);
          resolve(parsed);
        } catch (e) {
          logger.warn({ city, error: e }, 'Failed to parse NWS CLI');
          resolve(null);
        }
      });
    }).on('error', (e) => {
      logger.warn({ city, error: e }, 'Failed to fetch NWS CLI');
      resolve(null);
    });
  });
}

/**
 * Parse NWS CLI report HTML to extract temperature data
 * 
 * Example format in the report:
 * WEATHER ITEM   OBSERVED    (...)
 * TEMPERATURE (F)
 *  YESTERDAY
 *   MAXIMUM         33
 *   MINIMUM         28
 *  TODAY
 *   MAXIMUM         37        (could be blank if not yet recorded)
 */
function parseNWSCLI(html: string, city: string): NWSCLIData | null {
  // Extract the pre-formatted text block
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!preMatch) return null;

  const text = preMatch[1];
  
  // Find the date line (e.g., "CLIMATE REPORT FOR FEBRUARY 10 2026")
  const dateMatch = text.match(/CLIMATE REPORT[^\n]*?(\w+ \d+ \d{4})/i);
  const date = dateMatch ? dateMatch[1] : 'UNKNOWN';

  // Look for temperature section
  // Pattern: MAXIMUM followed by a number
  const lines = text.split('\n');
  let highTemp: number | null = null;
  let lowTemp: number | null = null;
  let inTodaySection = false;
  let inYesterdaySection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toUpperCase();
    
    if (line.includes('TODAY')) {
      inTodaySection = true;
      inYesterdaySection = false;
    } else if (line.includes('YESTERDAY')) {
      inYesterdaySection = true;
      inTodaySection = false;
    }
    
    // Look for MAXIMUM line with a number
    if (line.includes('MAXIMUM')) {
      const tempMatch = line.match(/MAXIMUM\s+(\d+)/);
      if (tempMatch) {
        const temp = parseInt(tempMatch[1], 10);
        if (inTodaySection) {
          highTemp = temp;
        } else if (inYesterdaySection && highTemp === null) {
          // Use yesterday's if today's not available
          highTemp = temp;
        }
      }
    }
    
    if (line.includes('MINIMUM')) {
      const tempMatch = line.match(/MINIMUM\s+(\d+)/);
      if (tempMatch) {
        const temp = parseInt(tempMatch[1], 10);
        if (inTodaySection) {
          lowTemp = temp;
        }
      }
    }
  }

  return {
    city,
    date,
    highTemp,
    lowTemp,
    precipitation: null,
    isObserved: highTemp !== null,
    rawText: text.substring(0, 2000), // Truncate for logging
  };
}

/**
 * Fetch current/forecast temperature from Open-Meteo (backup source)
 */
async function fetchOpenMeteo(city: string): Promise<{ high: number; isActual: boolean } | null> {
  const coords = OPEN_METEO_COORDS[city.toUpperCase()];
  if (!coords) return null;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=auto&past_days=1`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Index 1 is today (index 0 is yesterday due to past_days=1)
          const todayHigh = json.daily?.temperature_2m_max?.[1];
          if (typeof todayHigh === 'number') {
            resolve({ high: todayHigh, isActual: true });
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
 * Get the high temperature for a city
 * Tries NWS CLI first (official settlement source), falls back to Open-Meteo
 */
export async function getHighTemperature(city: string): Promise<ResolverResult | null> {
  const now = Date.now();
  const cityUpper = city.toUpperCase();

  // Try NWS CLI first (official source)
  const nwsData = await fetchNWSCLI(cityUpper);
  if (nwsData && nwsData.highTemp !== null) {
    logger.info({ city: cityUpper, temp: nwsData.highTemp, source: 'NWS' }, 'Got temperature from NWS CLI');
    return {
      category: 'weather',
      dataValue: `${nwsData.highTemp}°F`,
      numericValue: nwsData.highTemp,
      confidence: nwsData.isObserved ? 1.0 : 0.8, // Full confidence for observed, less for forecast
      source: 'NWS',
      sourceUrl: `https://forecast.weather.gov/product.php?site=${NWS_CLI_URLS[cityUpper].site}&product=CLI&issuedby=${NWS_CLI_URLS[cityUpper].issuedby}`,
      timestamp: now,
    };
  }

  // Fallback to Open-Meteo
  const meteoData = await fetchOpenMeteo(cityUpper);
  if (meteoData) {
    logger.info({ city: cityUpper, temp: meteoData.high, source: 'OpenMeteo' }, 'Got temperature from Open-Meteo');
    return {
      category: 'weather',
      dataValue: `${Math.round(meteoData.high)}°F`,
      numericValue: Math.round(meteoData.high),
      confidence: 0.85, // Slightly lower confidence for non-official source
      source: 'OpenMeteo',
      sourceUrl: 'https://open-meteo.com',
      timestamp: now,
    };
  }

  logger.warn({ city: cityUpper }, 'Failed to get temperature from any source');
  return null;
}

/**
 * Parse a market title to extract target temperature range
 * Examples:
 * - "Will the high temp in NYC be 36-37° on Feb 10, 2026?" -> { min: 36, max: 37 }
 * - "Will the high temp in NYC be >39° on Feb 10, 2026?" -> { min: 40, max: 999 }
 */
export function parseTemperatureTarget(title: string): { min: number; max: number } | null {
  // Pattern: "XX-YY°" (range)
  const rangeMatch = title.match(/(\d+)-(\d+)°/);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1], 10),
      max: parseInt(rangeMatch[2], 10),
    };
  }

  // Pattern: ">XX°" (greater than)
  const gtMatch = title.match(/>(\d+)°/);
  if (gtMatch) {
    return {
      min: parseInt(gtMatch[1], 10) + 1,
      max: 999,
    };
  }

  // Pattern: "<XX°" (less than)
  const ltMatch = title.match(/<(\d+)°/);
  if (ltMatch) {
    return {
      min: -999,
      max: parseInt(ltMatch[1], 10) - 1,
    };
  }

  return null;
}

/**
 * Parse city from market title
 */
export function parseCityFromTitle(title: string): string | null {
  const titleLower = title.toLowerCase();
  
  if (titleLower.includes('nyc') || titleLower.includes('new york')) return 'NYC';
  if (titleLower.includes('chicago')) return 'CHICAGO';
  if (titleLower.includes('denver')) return 'DENVER';
  if (titleLower.includes('miami')) return 'MIAMI';
  if (titleLower.includes('los angeles') || titleLower.includes('la ')) return 'LOS_ANGELES';
  
  return null;
}

/**
 * Evaluate if a temperature falls within a market's target range
 */
export function evaluateTemperatureMarket(
  actualTemp: number,
  target: { min: number; max: number }
): { outcome: 'yes' | 'no'; confidence: number } {
  if (actualTemp >= target.min && actualTemp <= target.max) {
    return { outcome: 'yes', confidence: 1.0 };
  }
  
  // If close to boundary, lower confidence
  const distFromMin = Math.abs(actualTemp - target.min);
  const distFromMax = Math.abs(actualTemp - target.max);
  const minDist = Math.min(distFromMin, distFromMax);
  
  if (minDist <= 1) {
    // Within 1 degree of boundary - could go either way
    return { outcome: 'no', confidence: 0.7 };
  }
  
  return { outcome: 'no', confidence: 0.95 };
}

/**
 * Parse date from market title for time-aware confidence
 * "...on Feb 10, 2026?" → Date object
 */
function parseDateFromTitle(title: string): Date | null {
  const monthNames: Record<string, number> = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };

  const dateMatch = title.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i);
  if (dateMatch) {
    const month = monthNames[dateMatch[1].toLowerCase()];
    if (month !== undefined) {
      const day = parseInt(dateMatch[2], 10);
      const year = parseInt(dateMatch[3], 10);
      return new Date(year, month, day);
    }
  }
  return null;
}

/**
 * Get time-of-day confidence multiplier for weather
 * High temperatures are typically recorded mid-to-late afternoon (2-5 PM local)
 * After 5 PM the high is essentially locked in
 */
function getWeatherTimeConfidence(marketDate: Date | null): number {
  if (!marketDate) return 0.80; // Unknown date, moderate confidence

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(marketDate.getFullYear(), marketDate.getMonth(), marketDate.getDate());
  const diffDays = Math.round((targetDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    // Date has passed — high was already recorded
    return 1.0;
  }

  if (diffDays === 0) {
    // Today — check time of day (use UTC, rough approximation)
    const utcHour = now.getUTCHours();
    // US cities: ET=UTC-5, CT=UTC-6, MT=UTC-7, PT=UTC-8
    // For most weather markets (NYC, Chicago), 5PM ET = 22:00 UTC
    // After ~22 UTC, the high for the day is essentially known
    if (utcHour >= 22) return 0.98; // After 5 PM ET — high recorded
    if (utcHour >= 19) return 0.92; // After 2 PM ET — likely near peak
    if (utcHour >= 16) return 0.85; // After 11 AM ET — warming up
    return 0.75; // Morning — still uncertain
  }

  if (diffDays === 1) {
    // Tomorrow — moderate confidence from forecast
    return 0.70;
  }

  if (diffDays <= 3) {
    // 2-3 days out
    return 0.60;
  }

  // Further out — low confidence
  return 0.50;
}

/**
 * Full weather market resolver (time-aware)
 * Takes a DFlowMarket object and returns the predicted outcome with confidence
 * Falls back to title-only for backward compatibility
 */
export async function resolveWeatherMarket(
  marketOrTitle: DFlowMarket | string
): Promise<{ outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } | null> {
  const title = typeof marketOrTitle === 'string' ? marketOrTitle : marketOrTitle.title;
  const market = typeof marketOrTitle === 'string' ? null : marketOrTitle;

  const city = parseCityFromTitle(title);
  if (!city) {
    logger.debug({ title }, 'Could not parse city from weather market title');
    return null;
  }

  const target = parseTemperatureTarget(title);
  if (!target) {
    logger.debug({ title }, 'Could not parse temperature target from market title');
    return null;
  }

  const tempData = await getHighTemperature(city);
  if (!tempData) {
    return null;
  }

  const evaluation = evaluateTemperatureMarket(tempData.numericValue, target);

  // Time-aware confidence
  const marketDate = parseDateFromTitle(title);
  const timeConfidence = getWeatherTimeConfidence(marketDate);

  // Combine data confidence × evaluation confidence × time confidence
  // If data is from NWS (isObserved = confidence 1.0) and it's past the date,
  // we have very high overall confidence
  let totalConfidence = tempData.confidence * evaluation.confidence * timeConfidence;

  // If we have the market object, also factor in expiration proximity
  if (market) {
    const hoursToExpiry = (market.expirationTime * 1000 - Date.now()) / (1000 * 60 * 60);
    if (hoursToExpiry <= 0) {
      // Past expiry — data is definitive
      totalConfidence = Math.min(0.95, totalConfidence * 1.05);
    } else if (hoursToExpiry <= 1) {
      totalConfidence = Math.min(0.95, totalConfidence * 1.02);
    }
  }

  // Cap at 95%
  totalConfidence = Math.min(0.95, totalConfidence);

  logger.info({
    city,
    temp: tempData.numericValue,
    target: `${target.min}-${target.max}`,
    timeConfidence: timeConfidence.toFixed(3),
    totalConfidence: totalConfidence.toFixed(3),
    outcome: evaluation.outcome,
    date: marketDate?.toISOString().split('T')[0] || 'unknown',
  }, 'Weather market resolved (time-aware)');

  return {
    outcome: evaluation.outcome,
    confidence: totalConfidence,
    data: {
      ...tempData,
      confidence: totalConfidence,
    },
  };
}

// Export for testing
export { fetchNWSCLI, parseNWSCLI, fetchOpenMeteo };
