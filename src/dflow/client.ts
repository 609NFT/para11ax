/**
 * DFlow Prediction Markets API Client
 * Connects to DFlow for Kalshi market data and quotes
 */

import https from 'https';
import { 
  DFlowMarket, 
  DFlowEvent, 
  DFlowSeries, 
  DFlowQuote,
  USDC_MINT,
  CASH_MINT,
  MarketCategory 
} from './types';
import logger from '../logger';

const PREDICTION_API = 'c.prediction-markets-api.dflow.net';
const QUOTE_API = 'c.quote-api.dflow.net';

// API key from environment
function getApiKey(): string {
  const key = process.env.DFLOW_API_KEY;
  if (!key) {
    throw new Error('DFLOW_API_KEY environment variable not set');
  }
  return key;
}

/**
 * Make an HTTPS GET request to DFlow API
 */
async function dflowGet<T>(host: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path,
      method: 'GET',
      headers: {
        'x-api-key': getApiKey(),
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`DFlow API error: ${res.statusCode} - ${data}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse DFlow response: ${e}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('DFlow API timeout'));
    });
    req.end();
  });
}

/**
 * Fetch all active markets with pagination
 */
export async function getActiveMarkets(_limit: number = 5000): Promise<DFlowMarket[]> {
  const allMarkets: DFlowMarket[] = [];
  
  // Fetch by category to avoid loading 6000+ markets
  // Focus on categories we have resolvers for
  const seriesPrefixes = [
    'KXNCAAMB',   // NCAA Men's Basketball
    'KXNCAAW',    // NCAA Women's Basketball
    'KXNBA',      // NBA
    'KXNFL',      // NFL
    'KXNHL',      // NHL
    'KXMLB',      // MLB
    'KXEPL',      // EPL Soccer
    'KXUCL',      // Champions League
    'KXHIGH',     // Weather highs
    'KXLOW',      // Weather lows
    'KXBTC',      // Bitcoin
    'KXETH',      // Ethereum
    'KXSPY',      // S&P 500
    'KXFED',      // Fed decisions
    'KXATP',      // Tennis
  ];
  
  for (const series of seriesPrefixes) {
    let cursor = '';
    let fetched = 0;
    while (fetched < 500) { // Max 500 per category
      const path = `/api/v1/markets?status=active&seriesTicker=${series}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
      try {
        const response = await dflowGet<{ markets: DFlowMarket[]; cursor?: string }>(PREDICTION_API, path);
        if (!response.markets || response.markets.length === 0) break;
        allMarkets.push(...response.markets);
        fetched += response.markets.length;
        if (!response.cursor) break;
        cursor = response.cursor;
      } catch {
        break; // Skip failed series
      }
    }
  }

  logger.info({ count: allMarkets.length }, 'Fetched DFlow markets');
  return allMarkets;
}

/**
 * Fetch markets expiring within the given hours
 */
export async function getNearTermMarkets(_hoursAhead: number = 24): Promise<DFlowMarket[]> {
  // DFlow sets expirationTime to the series end date (weeks/months out),
  // NOT the individual event time. Sports games finalize within hours
  // but are listed with long expirations. Return all active markets
  // and let the resolvers + confidence scoring handle time relevance.
  return await getActiveMarkets();
}

/**
 * Fetch a specific market by ticker
 */
export async function getMarketByTicker(ticker: string): Promise<DFlowMarket | null> {
  try {
    const response = await dflowGet<{ markets: DFlowMarket[] }>(
      PREDICTION_API,
      `/api/v1/markets?ticker=${encodeURIComponent(ticker)}`
    );
    return response.markets?.[0] || null;
  } catch (e) {
    logger.warn({ ticker, error: e }, 'Failed to fetch market');
    return null;
  }
}

/**
 * Fetch all events (for settlement sources)
 */
export async function getEvents(limit: number = 500): Promise<DFlowEvent[]> {
  const allEvents: DFlowEvent[] = [];
  let cursor = 0;
  const pageSize = 100;

  while (allEvents.length < limit) {
    const path = `/api/v1/events?limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}`;
    const response = await dflowGet<{ events: DFlowEvent[]; cursor?: number }>(PREDICTION_API, path);

    if (!response.events || response.events.length === 0) break;
    allEvents.push(...response.events);

    if (!response.cursor) break;
    cursor = response.cursor;
  }

  return allEvents;
}

/**
 * Fetch all series (for settlement source mapping)
 */
export async function getSeries(): Promise<DFlowSeries[]> {
  const response = await dflowGet<{ series: DFlowSeries[] }>(PREDICTION_API, '/api/v1/series');
  return response.series || [];
}

/**
 * Build a map of series ticker to settlement sources
 */
export async function getSettlementSourceMap(): Promise<Map<string, DFlowSeries>> {
  const series = await getSeries();
  const map = new Map<string, DFlowSeries>();
  for (const s of series) {
    map.set(s.ticker, s);
  }
  return map;
}

/**
 * Get a quote for swapping tokens
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountSmallestUnits: string,
  slippageBps: number = 100,
  userPublicKey?: string
): Promise<DFlowQuote> {
  let path = `/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountSmallestUnits}&slippageBps=${slippageBps}`;
  if (userPublicKey) {
    path += `&userPublicKey=${userPublicKey}`;
  }
  return dflowGet<DFlowQuote>(QUOTE_API, path);
}

/**
 * Get quote to buy YES tokens for a market
 * Uses USDC as input - DFlow routes through CASH if needed
 */
export async function getYesBuyQuote(
  market: DFlowMarket,
  amountUsd: number,
  userPublicKey?: string
): Promise<DFlowQuote | null> {
  // Get the market's collateral (CASH preferred)
  const collateral = getMarketCollateral(market);
  if (!collateral) {
    logger.warn({ ticker: market.ticker }, 'No initialized collateral for market');
    return null;
  }

  const account = market.accounts[collateral];
  if (!account?.yesMint) {
    logger.warn({ ticker: market.ticker }, 'No YES mint for market');
    return null;
  }

  // Always use USDC as input - DFlow routes through CASH if needed
  const amountSmallest = Math.floor(amountUsd * 1_000_000).toString();
  
  try {
    // Route USDC → YES token (DFlow handles USDC→CASH→YES internally)
    return await getQuote(USDC_MINT, account.yesMint, amountSmallest, 200, userPublicKey); // 2% slippage for routing
  } catch (e) {
    logger.warn({ ticker: market.ticker, error: e }, 'Failed to get YES buy quote');
    return null;
  }
}

/**
 * Get quote to buy NO tokens for a market
 * Uses USDC as input - DFlow routes through CASH if needed
 */
export async function getNoBuyQuote(
  market: DFlowMarket,
  amountUsd: number,
  userPublicKey?: string
): Promise<DFlowQuote | null> {
  const collateral = getMarketCollateral(market);
  if (!collateral) return null;

  const account = market.accounts[collateral];
  if (!account?.noMint) return null;

  const amountSmallest = Math.floor(amountUsd * 1_000_000).toString();
  
  try {
    return await getQuote(USDC_MINT, account.noMint, amountSmallest, 200, userPublicKey);
  } catch (e) {
    logger.warn({ ticker: market.ticker, error: e }, 'Failed to get NO buy quote');
    return null;
  }
}

/**
 * Classify a market by category based on title/series
 */
export function classifyMarket(market: DFlowMarket): MarketCategory {
  const title = market.title.toLowerCase();
  const ticker = market.ticker.toLowerCase();

  // Weather patterns
  if (
    title.includes('temperature') ||
    title.includes('temp ') ||
    title.includes('high temp') ||
    title.includes('weather') ||
    ticker.includes('highny') ||
    ticker.includes('highchi') ||
    ticker.includes('temp')
  ) {
    return 'weather';
  }

  // Crypto patterns
  if (
    title.includes('bitcoin') ||
    title.includes('btc') ||
    title.includes('ethereum') ||
    title.includes('eth ') ||
    title.includes('crypto')
  ) {
    return 'crypto';
  }

  // Stock patterns
  if (
    title.includes('s&p') ||
    title.includes('nasdaq') ||
    title.includes('dow ') ||
    title.includes('stock') ||
    ticker.includes('inx')
  ) {
    return 'stocks';
  }

  // Sports patterns
  if (
    title.includes('nfl') ||
    title.includes('nba') ||
    title.includes('mlb') ||
    title.includes('super bowl') ||
    title.includes(' vs ') ||
    title.includes(' at ') // "Team A at Team B"
  ) {
    return 'sports';
  }

  // Politics patterns
  if (
    title.includes('trump') ||
    title.includes('congress') ||
    title.includes('senate') ||
    title.includes('house ') ||
    title.includes('president') ||
    title.includes('fed chair') ||
    title.includes('election')
  ) {
    return 'politics';
  }

  return 'other';
}

/**
 * Parse price string to number (e.g., "0.0300" -> 0.03)
 */
export function parsePrice(priceStr: string | undefined): number {
  if (!priceStr) return 0;
  const parsed = parseFloat(priceStr);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Get the best price to buy an outcome
 */
export function getBuyPrice(market: DFlowMarket, outcome: 'yes' | 'no'): number {
  return outcome === 'yes' ? parsePrice(market.yesAsk) : parsePrice(market.noAsk);
}

/**
 * Get the best price to sell an outcome
 */
export function getSellPrice(market: DFlowMarket, outcome: 'yes' | 'no'): number {
  return outcome === 'yes' ? parsePrice(market.yesBid) : parsePrice(market.noBid);
}

/**
 * Check if a market is tradeable (has liquidity)
 * Prefers CASH collateral (most DFlow markets use CASH)
 */
export function isMarketTradeable(market: DFlowMarket): boolean {
  // Must be active (not finalized, closed, or settled)
  if (market.status && market.status !== 'active') return false;
  
  // Must not already have a result
  if (market.result) return false;
  
  // Check CASH first (most common), then USDC
  const cashAccount = market.accounts[CASH_MINT];
  const usdcAccount = market.accounts[USDC_MINT];
  
  const hasAccount = (cashAccount?.isInitialized) || (usdcAccount?.isInitialized);
  if (!hasAccount) return false;
  
  // Must have at least a YES or NO ask price
  const yesAsk = parsePrice(market.yesAsk);
  const noAsk = parsePrice(market.noAsk);
  
  return yesAsk > 0 || noAsk > 0;
}

/**
 * Get the best collateral mint for a market (prefers CASH)
 */
export function getMarketCollateral(market: DFlowMarket): string | null {
  if (market.accounts[CASH_MINT]?.isInitialized) return CASH_MINT;
  if (market.accounts[USDC_MINT]?.isInitialized) return USDC_MINT;
  return null;
}

// Export for testing
export { PREDICTION_API, QUOTE_API };
