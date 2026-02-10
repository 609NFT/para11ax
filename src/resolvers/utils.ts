/**
 * Shared Utilities for Market Resolvers
 * Parsing thresholds, resolution times, and confidence calculations
 */

export interface MarketThreshold {
  value: number;               // The numerical threshold (e.g., 69999.99)
  comparison: 'above' | 'below' | 'between';
  upperValue?: number;         // For 'between' markets
}

export interface MarketResolutionTime {
  date: Date;                  // When the market resolves
  timezone: string;            // e.g., "EST", "ET"
}

/**
 * Parse threshold from ticker string
 * Examples:
 *   KXBTCD-26FEB1317-T69999.99 → 69999.99
 *   KXINXD-26FEB13-B5949.99    → 5949.99 (below)
 *   KXHIGHNY-260210-36         → 36
 */
export function parseThresholdFromTicker(ticker: string): MarketThreshold | null {
  // Pattern 1: T{number} = threshold (above)
  const tMatch = ticker.match(/-T(\d+(?:\.\d+)?)$/);
  if (tMatch) {
    return {
      value: parseFloat(tMatch[1]),
      comparison: 'above',
    };
  }

  // Pattern 2: B{number} = below threshold
  const bMatch = ticker.match(/-B(\d+(?:\.\d+)?)$/);
  if (bMatch) {
    return {
      value: parseFloat(bMatch[1]),
      comparison: 'below',
    };
  }

  // Pattern 3: plain number at end (weather markets like KXHIGHNY-260210-36)
  const numMatch = ticker.match(/-(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    return {
      value: parseFloat(numMatch[1]),
      comparison: 'above', // Default; caller should check title for actual condition
    };
  }

  return null;
}

/**
 * Parse threshold from rules text or title
 * Examples:
 *   "Will Bitcoin be above $69,999.99" → { value: 69999.99, comparison: 'above' }
 *   "S&P 500 be above 6845.5" → { value: 6845.5, comparison: 'above' }
 *   "between 7400 and 7599.99" → { value: 7400, comparison: 'between', upperValue: 7599.99 }
 */
export function parseThresholdFromText(text: string): MarketThreshold | null {
  // Between pattern
  const betweenMatch = text.match(/between\s+\$?([0-9,]+(?:\.\d+)?)\s+and\s+\$?([0-9,]+(?:\.\d+)?)/i);
  if (betweenMatch) {
    return {
      value: parseFloat(betweenMatch[1].replace(/,/g, '')),
      comparison: 'between',
      upperValue: parseFloat(betweenMatch[2].replace(/,/g, '')),
    };
  }

  // Above/below with dollar sign
  const dollarMatch = text.match(/(above|below|greater than|less than|at or above|at or below)\s+\$([0-9,]+(?:\.\d+)?)/i);
  if (dollarMatch) {
    const comparison = dollarMatch[1].toLowerCase().includes('below') ||
                       dollarMatch[1].toLowerCase().includes('less')
      ? 'below' as const
      : 'above' as const;
    return {
      value: parseFloat(dollarMatch[2].replace(/,/g, '')),
      comparison,
    };
  }

  // Above/below without dollar sign (stocks, weather)
  const plainMatch = text.match(/(above|below|greater than|less than|at or above|at or below)\s+([0-9,]+(?:\.\d+)?)/i);
  if (plainMatch) {
    const comparison = plainMatch[1].toLowerCase().includes('below') ||
                       plainMatch[1].toLowerCase().includes('less')
      ? 'below' as const
      : 'above' as const;
    return {
      value: parseFloat(plainMatch[2].replace(/,/g, '')),
      comparison,
    };
  }

  return null;
}

/**
 * Parse resolution date/time from rules text
 * Examples:
 *   "at 5 PM EST on February 13, 2026" → Date
 *   "as of 4:00 PM ET on Feb 13, 2026" → Date
 *   "at the end of trading on February 13, 2026" → Date (4PM ET)
 */
export function parseResolutionTimeFromRules(rules: string): MarketResolutionTime | null {
  // Pattern: "at H:MM PM TZ on Month Day, Year" or "at H PM TZ on Month Day, Year"
  const timeMatch = rules.match(
    /(?:at|as of)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(EST?|ET|CST?|CT|PST?|PT)\s+on\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i
  );
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3].toUpperCase();
    const tz = timeMatch[4].toUpperCase();
    const monthStr = timeMatch[5];
    const day = parseInt(timeMatch[6], 10);
    const year = parseInt(timeMatch[7], 10);

    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    const month = parseMonth(monthStr);
    if (month === null) return null;

    // Create date in UTC, adjusting for timezone offset
    const tzOffset = getTimezoneOffset(tz);
    const date = new Date(Date.UTC(year, month, day, hours + tzOffset, minutes, 0));

    return { date, timezone: tz };
  }

  // Pattern: "end of trading on Month Day, Year" → 4PM ET
  const eotMatch = rules.match(
    /end of (?:trading|the trading day)\s+(?:on\s+)?(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i
  );
  if (eotMatch) {
    const month = parseMonth(eotMatch[1]);
    if (month === null) return null;
    const day = parseInt(eotMatch[2], 10);
    const year = parseInt(eotMatch[3], 10);
    // 4PM ET = 21:00 UTC (EST+5) or 20:00 UTC (EDT+4)
    const date = new Date(Date.UTC(year, month, day, 21, 0, 0));
    return { date, timezone: 'ET' };
  }

  return null;
}

/**
 * Parse month name to number (0-indexed)
 */
function parseMonth(name: string): number | null {
  const months: Record<string, number> = {
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
  return months[name.toLowerCase()] ?? null;
}

/**
 * Get UTC offset for common US timezones (hours to add to local to get UTC)
 */
function getTimezoneOffset(tz: string): number {
  // NOTE: Using standard time offsets. In practice, EST/EDT distinction matters.
  // For February markets, EST is correct (UTC-5 = add 5).
  const offsets: Record<string, number> = {
    'EST': 5, 'ET': 5, 'E': 5,
    'CST': 6, 'CT': 6, 'C': 6,
    'MST': 7, 'MT': 7, 'M': 7,
    'PST': 8, 'PT': 8, 'P': 8,
    // Summer time
    'EDT': 4, 'CDT': 5, 'MDT': 6, 'PDT': 7,
  };
  return offsets[tz.toUpperCase()] ?? 5; // Default to EST
}

/**
 * Calculate hours remaining until resolution
 * Returns negative if past resolution
 */
export function hoursUntilResolution(resolutionTime: Date): number {
  return (resolutionTime.getTime() - Date.now()) / (1000 * 60 * 60);
}

/**
 * Get time-based confidence multiplier
 * Scales confidence based on how close we are to resolution
 *
 * @param hoursRemaining Hours until market resolves
 * @param baseConfidence The confidence from distance/data alone (0-1)
 * @returns Scaled confidence (0-0.95)
 */
export function getTimeScaledConfidence(hoursRemaining: number, baseConfidence: number): number {
  // Time factor: how much to boost confidence based on proximity to resolution
  let timeFactor: number;

  if (hoursRemaining <= 0) {
    // Past resolution — maximum time confidence
    timeFactor = 1.0;
  } else if (hoursRemaining < 1) {
    // <1h: very high — price/data is essentially known
    timeFactor = 0.95 + (1 - hoursRemaining) * 0.05; // 0.95 → 1.0
  } else if (hoursRemaining < 6) {
    // 1-6h: high — unlikely to swing dramatically
    timeFactor = 0.80 + ((6 - hoursRemaining) / 5) * 0.15; // 0.80 → 0.95
  } else if (hoursRemaining < 24) {
    // 6-24h: moderate — less time for big moves
    timeFactor = 0.65 + ((24 - hoursRemaining) / 18) * 0.15; // 0.65 → 0.80
  } else if (hoursRemaining < 72) {
    // 1-3 days: base — meaningful moves possible
    timeFactor = 0.50 + ((72 - hoursRemaining) / 48) * 0.15; // 0.50 → 0.65
  } else {
    // >3 days: low time confidence
    timeFactor = 0.50;
  }

  // Combined confidence: blend base (distance) confidence with time factor
  // Use the higher of: baseConfidence alone, or the time-boosted version
  // The formula: conf = base * timeFactor, but never below base * 0.5
  // and never above 0.95
  const combined = baseConfidence * timeFactor;

  return Math.min(0.95, Math.max(0.05, combined));
}

/**
 * Calculate distance-based confidence for price markets
 * Uses standard deviations from threshold
 *
 * @param currentPrice Current observed price
 * @param threshold Target threshold price
 * @param comparison 'above' or 'below'
 * @param dailyVolatilityPct Daily volatility as decimal (e.g., 0.04 for 4%)
 * @param hoursRemaining Hours until resolution
 * @returns { outcome, confidence } where confidence is 0-1
 */
export function getDistanceConfidence(
  currentPrice: number,
  threshold: number,
  comparison: 'above' | 'below',
  dailyVolatilityPct: number,
  hoursRemaining: number
): { outcome: 'yes' | 'no'; confidence: number } {
  // Scale volatility by time: vol_t = daily_vol * sqrt(hours / 24)
  const effectiveHours = Math.max(hoursRemaining, 0.1); // Minimum to avoid division by zero
  const timeScaledVol = dailyVolatilityPct * Math.sqrt(effectiveHours / 24);
  const oneStdDev = currentPrice * timeScaledVol;

  // Distance from threshold in standard deviations
  const distance = currentPrice - threshold;
  const stdDevsAway = oneStdDev > 0 ? Math.abs(distance) / oneStdDev : 10;

  // Determine outcome
  let outcome: 'yes' | 'no';
  if (comparison === 'above') {
    outcome = currentPrice > threshold ? 'yes' : 'no';
  } else {
    outcome = currentPrice < threshold ? 'yes' : 'no';
  }

  // Confidence based on standard deviations
  // 0 std devs = 50% (right at threshold)
  // 1 std dev = ~68% → we use 70%
  // 2 std devs = ~95% → we use 88%
  // 3+ std devs = ~99.7% → we cap at 95%
  let confidence: number;
  if (stdDevsAway < 0.5) {
    confidence = 0.50 + stdDevsAway * 0.20; // 0.50 → 0.60
  } else if (stdDevsAway < 1.0) {
    confidence = 0.60 + (stdDevsAway - 0.5) * 0.20; // 0.60 → 0.70
  } else if (stdDevsAway < 2.0) {
    confidence = 0.70 + (stdDevsAway - 1.0) * 0.18; // 0.70 → 0.88
  } else if (stdDevsAway < 3.0) {
    confidence = 0.88 + (stdDevsAway - 2.0) * 0.07; // 0.88 → 0.95
  } else {
    confidence = 0.95;
  }

  return { outcome, confidence };
}

/**
 * Comprehensive market threshold parser
 * Tries ticker first, then rules, then title
 */
export function parseMarketThreshold(
  ticker: string,
  rules: string,
  title: string
): MarketThreshold | null {
  // Try ticker first (most structured)
  const fromTicker = parseThresholdFromTicker(ticker);
  if (fromTicker) return fromTicker;

  // Try rules (most detailed)
  const fromRules = parseThresholdFromText(rules);
  if (fromRules) return fromRules;

  // Fallback to title
  return parseThresholdFromText(title);
}
