/**
 * Stock price feed - fetches real stock prices
 * Supports multiple data sources with fallback
 */

import axios from 'axios';
import { StockPrice, TokenConfig } from '../types';
import { feedLogger } from '../logger';
import { getConfigSync } from '../config';
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../constants';
import { fetchSwissquotePrice } from './swissquoteFeed';
import { recordApiCall } from './endpointTracker';

interface PriceCache {
  price: number;
  timestamp: number;
  source: string;
}

interface MarketStatus {
  isOpen: boolean;
  session: string | null;  // 'pre-market', 'regular', 'post-market', or null
  holiday: string | null;
  timestamp: number;
}

interface MarketHoliday {
  atDate: string;       // YYYY-MM-DD format
  eventName: string;    // e.g., "Martin Luther King Day", "Christmas"
  tradingHour: string;  // e.g., "" for full day close, "09:30-13:00" for early close
}

interface HolidayCache {
  holidays: MarketHoliday[];
  fetchedAt: number;
}

interface HolidayApiResponse {
  atDate: string;
  eventName: string;
  tradingHour?: string;
}

const ALPACA_RATE_LIMIT_PER_MIN = 200;

// Alternate between Alpaca and Finnhub for fresher prices
let useAlpacaNext: boolean = true;

export class StockFeed {
  private priceCache: Map<string, PriceCache> = new Map();
  private connected: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private subscribers: Map<string, Set<(price: StockPrice) => void>> = new Map();

  // API configurations
  private readonly alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
  private readonly finnhubKeys: string[] = [];
  private readonly polygonKey = process.env.POLYGON_API_KEY;

  // Alpaca API configuration
  private readonly alpacaKeyId = process.env.ALPACA_KEY_ID;
  private readonly alpacaSecretKey = process.env.ALPACA_SECRET_KEY;
  private readonly alpacaDataUrl = 'https://data.alpaca.markets';

  // Rate limiting for Finnhub (60 calls/min per key = 1 call per second per key)
  private finnhubKeyIndex: number = 0;
  private lastFinnhubCallPerKey: Map<number, number> = new Map();
  private readonly finnhubMinDelayMs: number = 1100; // 1.1 seconds between calls per key

  // Market status cache (refresh every 15 minutes)
  private marketStatusCache: MarketStatus | null = null;
  private readonly marketStatusCacheDurationMs: number = 15 * MS_PER_MINUTE;

  // Holiday calendar cache (refresh daily - holidays don't change often)
  private holidayCache: HolidayCache | null = null;
  private readonly holidayCacheDurationMs: number = 24 * MS_PER_HOUR; // 24 hours

  constructor() {
    // Load all Finnhub API keys
    if (process.env.FINNHUB_API_KEY) {
      this.finnhubKeys.push(process.env.FINNHUB_API_KEY);
    }
    if (process.env.FINNHUB_API_KEY_2) {
      this.finnhubKeys.push(process.env.FINNHUB_API_KEY_2);
    }
    if (process.env.FINNHUB_API_KEY_3) {
      this.finnhubKeys.push(process.env.FINNHUB_API_KEY_3);
    }

    feedLogger.info({ finnhubKeyCount: this.finnhubKeys.length }, 'StockFeed initialized');
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    feedLogger.info('Connecting stock feed...');

    // Test API connectivity
    const hasValidSource = await this.testConnectivity();
    if (!hasValidSource) {
      feedLogger.warn('No valid stock price API configured. Using mock data for paper trading.');
    }

    this.connected = true;
    this.startPolling();
    feedLogger.info('Stock feed connected');
  }

  async disconnect(): Promise<void> {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    feedLogger.info('Stock feed disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current price for a stock symbol
   * @param symbol Stock symbol to fetch
   * @param forceFetch If true, bypass cache and fetch fresh price from API
   */
  async getPrice(symbol: string, forceFetch: boolean = false): Promise<StockPrice | null> {
    const config = getConfigSync();
    const cached = this.priceCache.get(symbol);

    // Return cached if fresh (unless forceFetch is set)
    // Use current time as timestamp since the price is still considered fresh
    // This prevents double-staleness-check issues where the signal generator
    // rejects prices that the feed considers fresh
    if (!forceFetch && cached && Date.now() - cached.timestamp < config.priceStalenessMs) {
      return {
        symbol,
        price: cached.price,
        timestamp: Date.now(), // Use current time since we're vouching the price is fresh
        source: cached.source,
        isStale: false,
      };
    }

    feedLogger.info({ symbol, forceFetch }, 'Stock price fetch (single)');

    // Fetch new price with fallback chain
    const price = await this.fetchPriceWithFallback(symbol);
    if (price !== null) {
      feedLogger.info({ symbol, price: price.price, source: price.source, forceFetch }, `Stock price fetched: ${symbol} $${price.price.toFixed(2)}`);
      return {
        symbol,
        price: price.price,
        timestamp: price.timestamp,
        source: price.source,
        isStale: false,
      };
    }

    // Return stale cache if available
    if (cached) {
      feedLogger.warn({ symbol, forceFetch }, 'Returning stale stock price');
      return {
        symbol,
        price: cached.price,
        timestamp: cached.timestamp,
        source: cached.source,
        isStale: true,
      };
    }

    feedLogger.warn({ symbol }, 'No stock price available from any source');
    return null;
  }

  /**
   * Get price for a token, routing to the appropriate price source
   * This handles custom price feeds (e.g., Swissquote for gold) vs stock feeds
   */
  async getPriceForToken(token: TokenConfig, forceFetch: boolean = false): Promise<StockPrice | null> {
    // Route based on price source
    if (token.priceSource === 'swissquote' && token.priceSymbol) {
      const price = await fetchSwissquotePrice(token.priceSymbol);
      if (price) {
        // Map the Swissquote symbol back to stockTicker for consistency
        return {
          ...price,
          symbol: token.stockTicker,
        };
      }
      feedLogger.warn({ token: token.symbol, priceSymbol: token.priceSymbol }, 'Swissquote price unavailable');
      return null;
    }

    // Default: use stock price feed (Alpaca/Finnhub/etc)
    return this.getPrice(token.stockTicker, forceFetch);
  }

  /**
   * Get cached price regardless of staleness (for lenient exit decisions)
   * Returns null only if no cache exists at all
   */
  getCachedPrice(symbol: string): { price: number; timestamp: number; ageMs: number } | null {
    const cached = this.priceCache.get(symbol);
    if (!cached) {
      return null;
    }

    const ageMs = Date.now() - cached.timestamp;
    return {
      price: cached.price,
      timestamp: cached.timestamp,
      ageMs,
    };
  }

  /**
   * Subscribe to price updates for a symbol
   */
  subscribe(symbol: string, callback: (price: StockPrice) => void): void {
    if (!this.subscribers.has(symbol)) {
      this.subscribers.set(symbol, new Set());
    }
    this.subscribers.get(symbol)!.add(callback);
    feedLogger.debug({ symbol }, 'Subscribed to stock price');
  }

  /**
   * Unsubscribe from price updates
   */
  unsubscribe(symbol: string, callback: (price: StockPrice) => void): void {
    const subs = this.subscribers.get(symbol);
    if (subs) {
      subs.delete(callback);
    }
  }

  /**
   * Fetch price with API fallback chain
   * NO MOCK DATA - if real APIs fail, return null and skip the token
   */
  private async fetchPriceWithFallback(symbol: string): Promise<PriceCache | null> {
    // Try each REAL source in order - NO MOCK FALLBACK
    // Alpaca first (fastest, batch-capable), then Finnhub, then others
    const sources = [
      () => this.fetchFromAlpaca(symbol),
      () => this.fetchFromFinnhub(symbol),
      () => this.fetchFromPolygon(symbol),
      () => this.fetchFromAlphaVantage(symbol),
      // REMOVED: Mock prices cause massive losses when stale
    ];

    for (const fetchFn of sources) {
      try {
        const result = await fetchFn();
        if (result !== null) {
          this.priceCache.set(symbol, result);
          this.notifySubscribers(symbol, result);
          return result;
        }
      } catch (err) {
        feedLogger.debug({ symbol, error: err }, 'Price source failed');
      }
    }

    return null;
  }

  /**
   * Fetch from Alpaca (single symbol)
   */
  private async fetchFromAlpaca(symbol: string): Promise<PriceCache | null> {
    if (!this.alpacaKeyId || !this.alpacaSecretKey) return null;

    const startTime = Date.now();
    try {
      const response = await axios.get(
        `${this.alpacaDataUrl}/v2/stocks/trades/latest`,
        {
          params: { symbols: symbol },
          headers: {
            'APCA-API-KEY-ID': this.alpacaKeyId,
            'APCA-API-SECRET-KEY': this.alpacaSecretKey,
          },
          timeout: 5000,
        }
      );

      const responseMs = Date.now() - startTime;
      const trade = response.data?.trades?.[symbol];
      if (trade?.p && trade.p > 0) {
        recordApiCall('alpaca', true, responseMs);
        return {
          price: trade.p,
          timestamp: Date.now(),
          source: 'alpaca',
        };
      }
      recordApiCall('alpaca', false, responseMs, 'No price data');
    } catch (err) {
      const responseMs = Date.now() - startTime;
      recordApiCall('alpaca', false, responseMs, String(err));
      feedLogger.debug({ symbol, error: err }, 'Alpaca fetch failed');
    }

    return null;
  }

  /**
   * Fetch from Alpaca (batch - multiple symbols in one request)
   */
  private async fetchBatchFromAlpaca(symbols: string[]): Promise<Map<string, PriceCache>> {
    const results = new Map<string, PriceCache>();

    if (!this.alpacaKeyId || !this.alpacaSecretKey || symbols.length === 0) {
      return results;
    }

    const startTime = Date.now();
    try {
      const response = await axios.get(
        `${this.alpacaDataUrl}/v2/stocks/trades/latest`,
        {
          params: { symbols: symbols.join(',') },
          headers: {
            'APCA-API-KEY-ID': this.alpacaKeyId,
            'APCA-API-SECRET-KEY': this.alpacaSecretKey,
          },
          timeout: 10000,
        }
      );

      const responseMs = Date.now() - startTime;
      const trades = response.data?.trades;
      if (trades) {
        for (const symbol of symbols) {
          const trade = trades[symbol];
          if (trade?.p && trade.p > 0) {
            const priceData: PriceCache = {
              price: trade.p,
              timestamp: Date.now(),
              source: 'alpaca',
            };
            results.set(symbol, priceData);
            this.priceCache.set(symbol, priceData);
          }
        }
      }

      recordApiCall('alpaca', true, responseMs);
      feedLogger.debug({ requested: symbols.length, fetched: results.size }, 'Alpaca batch fetch completed');
    } catch (err) {
      const responseMs = Date.now() - startTime;
      recordApiCall('alpaca', false, responseMs, String(err));
      feedLogger.debug({ symbols: symbols.slice(0, 5), error: err }, 'Alpaca batch fetch failed');
    }

    return results;
  }

  /**
   * Fetch from Polygon.io
   */
  private async fetchFromPolygon(symbol: string): Promise<PriceCache | null> {
    if (!this.polygonKey) return null;

    try {
      const response = await axios.get(
        `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev`,
        {
          params: { apiKey: this.polygonKey },
          timeout: 5000,
        }
      );

      if (response.data?.results?.[0]) {
        const result = response.data.results[0];
        return {
          price: result.c, // Close price
          timestamp: Date.now(),
          source: 'polygon',
        };
      }
    } catch (err) {
      feedLogger.debug({ symbol, error: err }, 'Polygon fetch failed');
    }

    return null;
  }

  /**
   * Fetch from Finnhub with key rotation (rate limited to 60 calls/min per key)
   * With 3 keys, we get 180 calls/min total throughput
   */
  private async fetchFromFinnhub(symbol: string): Promise<PriceCache | null> {
    if (this.finnhubKeys.length === 0) return null;

    // Find the next available key (one that hasn't been called recently)
    const now = Date.now();
    let selectedKeyIndex = -1;
    let minWaitTime = Infinity;

    // Check all keys to find one that's ready or has shortest wait
    for (let i = 0; i < this.finnhubKeys.length; i++) {
      const keyIndex = (this.finnhubKeyIndex + i) % this.finnhubKeys.length;
      const lastCall = this.lastFinnhubCallPerKey.get(keyIndex) || 0;
      const timeSinceLastCall = now - lastCall;

      if (timeSinceLastCall >= this.finnhubMinDelayMs) {
        // This key is ready to use immediately
        selectedKeyIndex = keyIndex;
        break;
      } else {
        // Track which key has shortest wait
        const waitTime = this.finnhubMinDelayMs - timeSinceLastCall;
        if (waitTime < minWaitTime) {
          minWaitTime = waitTime;
          selectedKeyIndex = keyIndex;
        }
      }
    }

    // If no key is ready immediately, wait for the one with shortest wait
    const lastCall = this.lastFinnhubCallPerKey.get(selectedKeyIndex) || 0;
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall < this.finnhubMinDelayMs) {
      const waitTime = this.finnhubMinDelayMs - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Mark this key as used and rotate to next for future calls
    this.lastFinnhubCallPerKey.set(selectedKeyIndex, Date.now());
    this.finnhubKeyIndex = (selectedKeyIndex + 1) % this.finnhubKeys.length;

    const apiKey = this.finnhubKeys[selectedKeyIndex];

    const startTime = Date.now();
    try {
      const response = await axios.get(
        `https://finnhub.io/api/v1/quote`,
        {
          params: { symbol, token: apiKey },
          timeout: 5000,
        }
      );

      const responseMs = Date.now() - startTime;
      if (response.data?.c && response.data.c > 0) {
        recordApiCall('finnhub', true, responseMs);
        return {
          price: response.data.c, // Current price
          timestamp: Date.now(),
          source: 'finnhub',
        };
      }
      recordApiCall('finnhub', false, responseMs, 'No price data');
    } catch (err) {
      const responseMs = Date.now() - startTime;
      recordApiCall('finnhub', false, responseMs, String(err));
      feedLogger.debug({ symbol, keyIndex: selectedKeyIndex, error: err }, 'Finnhub fetch failed');
    }

    return null;
  }

  /**
   * Fetch from Alpha Vantage
   */
  private async fetchFromAlphaVantage(symbol: string): Promise<PriceCache | null> {
    if (!this.alphaVantageKey) return null;

    try {
      const response = await axios.get(
        `https://www.alphavantage.co/query`,
        {
          params: {
            function: 'GLOBAL_QUOTE',
            symbol,
            apikey: this.alphaVantageKey,
          },
          timeout: 10000,
        }
      );

      const quote = response.data?.['Global Quote'];
      if (quote?.['05. price']) {
        return {
          price: parseFloat(quote['05. price']),
          timestamp: Date.now(),
          source: 'alphavantage',
        };
      }
    } catch (err) {
      feedLogger.debug({ symbol, error: err }, 'Alpha Vantage fetch failed');
    }

    return null;
  }

  // REMOVED: fetchMockPrice() - Mock prices are dangerous and cause massive losses
  // If real APIs fail, the token should be skipped, not traded with fake data

  /**
   * Check if US stock market is currently open
   * Uses Finnhub market status API, cached for 15 minutes
   */
  async isMarketOpen(): Promise<boolean> {
    const status = await this.getMarketStatus();
    return status?.isOpen ?? false;
  }

  /**
   * Get detailed market status (open/closed, session type, holiday info)
   */
  async getMarketStatus(): Promise<MarketStatus | null> {
    // Return cached if fresh
    if (this.marketStatusCache &&
        Date.now() - this.marketStatusCache.timestamp < this.marketStatusCacheDurationMs) {
      return this.marketStatusCache;
    }

    // Need a Finnhub key
    if (this.finnhubKeys.length === 0) {
      feedLogger.warn('No Finnhub API key available for market status check');
      return null;
    }

    try {
      const apiKey = this.finnhubKeys[0];  // Use first key for status checks
      const response = await axios.get(
        'https://finnhub.io/api/v1/stock/market-status',
        {
          params: { exchange: 'US', token: apiKey },
          timeout: 5000,
        }
      );

      if (response.data) {
        this.marketStatusCache = {
          isOpen: response.data.isOpen ?? false,
          session: response.data.session ?? null,
          holiday: response.data.holiday ?? null,
          timestamp: Date.now(),
        };

        feedLogger.info({
          isOpen: this.marketStatusCache.isOpen,
          session: this.marketStatusCache.session,
          holiday: this.marketStatusCache.holiday,
        }, 'Market status updated');

        return this.marketStatusCache;
      }
    } catch (err) {
      feedLogger.warn({ error: err }, 'Failed to fetch market status');
    }

    return this.marketStatusCache;  // Return stale cache if available
  }

  /**
   * Fetch market holidays from Finnhub calendar API
   * Cached for 24 hours since holiday schedules rarely change
   */
  async fetchMarketHolidays(): Promise<MarketHoliday[]> {
    // Return cached if fresh
    if (this.holidayCache &&
        Date.now() - this.holidayCache.fetchedAt < this.holidayCacheDurationMs) {
      return this.holidayCache.holidays;
    }

    // Need a Finnhub key
    if (this.finnhubKeys.length === 0) {
      feedLogger.warn('No Finnhub API key available for holiday calendar');
      return this.holidayCache?.holidays ?? [];
    }

    try {
      const apiKey = this.finnhubKeys[0]; // Use first key for calendar checks
      const response = await axios.get(
        'https://finnhub.io/api/v1/stock/market-holiday',
        {
          params: { exchange: 'US', token: apiKey },
          timeout: 5000,
        }
      );

      if (response.data?.data && Array.isArray(response.data.data)) {
        const holidays: MarketHoliday[] = response.data.data.map((h: HolidayApiResponse) => ({
          atDate: h.atDate,
          eventName: h.eventName,
          tradingHour: h.tradingHour || '',
        }));

        this.holidayCache = {
          holidays,
          fetchedAt: Date.now(),
        };

        feedLogger.info({ count: holidays.length }, 'Market holiday calendar fetched');
        return holidays;
      }
    } catch (err) {
      feedLogger.warn({ error: err }, 'Failed to fetch market holidays');
    }

    return this.holidayCache?.holidays ?? [];
  }

  /**
   * Check if a specific date is a market holiday
   * @param date Date to check (defaults to today in ET)
   * @returns Holiday info if it's a holiday, null otherwise
   */
  async isMarketHoliday(date?: Date): Promise<{ isHoliday: boolean; eventName?: string; isEarlyClose?: boolean; tradingHours?: string }> {
    const holidays = await this.fetchMarketHolidays();

    // Convert to ET and format as YYYY-MM-DD
    const checkDate = date || new Date();
    const etDateStr = checkDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format

    const holiday = holidays.find(h => h.atDate === etDateStr);

    if (!holiday) {
      return { isHoliday: false };
    }

    // Check if it's a full day close or early close
    const isEarlyClose = holiday.tradingHour !== '';

    return {
      isHoliday: true,
      eventName: holiday.eventName,
      isEarlyClose,
      tradingHours: holiday.tradingHour || undefined,
    };
  }

  /**
   * Get upcoming holidays (next 30 days)
   */
  async getUpcomingHolidays(): Promise<MarketHoliday[]> {
    const holidays = await this.fetchMarketHolidays();
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * MS_PER_DAY);

    return holidays.filter(h => {
      const holidayDate = new Date(h.atDate + 'T00:00:00');
      return holidayDate >= now && holidayDate <= thirtyDaysFromNow;
    });
  }

  /**
   * Test API connectivity
   */
  private async testConnectivity(): Promise<boolean> {
    const testSymbol = 'AAPL';

    if (this.polygonKey) {
      try {
        const result = await this.fetchFromPolygon(testSymbol);
        if (result) return true;
      } catch (error) {
        feedLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Polygon connectivity test failed');
        // Continue to next source
      }
    }

    if (this.finnhubKeys.length > 0) {
      try {
        const result = await this.fetchFromFinnhub(testSymbol);
        if (result) return true;
      } catch (error) {
        feedLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Finnhub connectivity test failed');
        // Continue to next source
      }
    }

    if (this.alphaVantageKey) {
      try {
        const result = await this.fetchFromAlphaVantage(testSymbol);
        if (result) return true;
      } catch (error) {
        feedLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Alpha Vantage connectivity test failed');
        // Continue to next source
      }
    }

    return false;
  }

  /**
   * Start polling for price updates
   */
  private startPolling(): void {
    const config = getConfigSync();
    const baseIntervalMs = Math.min(config.priceStalenessMs / 2, 30000); // Poll at half staleness or 30s

    const scheduleNext = () => {
      if (!this.connected) return;
      const subscriberCount = this.subscribers.size;
      const minIntervalMs = this.getMinBatchIntervalMs(subscriberCount);
      const intervalMs = Math.max(baseIntervalMs, minIntervalMs);

      this.pollInterval = setTimeout(async () => {
        const symbols = Array.from(this.subscribers.keys());
        await this.getBatchPrices(symbols);
        scheduleNext();
      }, intervalMs);
    };

    const symbols = Array.from(this.subscribers.keys());
    void this.getBatchPrices(symbols).finally(scheduleNext);
  }

  /**
   * Compute a conservative minimum interval for batch fetches
   * based on the number of symbols and API rate limits.
   */
  getMinBatchIntervalMs(symbolCount: number): number {
    if (symbolCount <= 0) return 0;

    const keyCount = this.finnhubKeys.length;

    // Finnhub: 60/min per key, keys run in parallel per batch
    // Each batch processes `keyCount` symbols, need ceil(symbolCount/keyCount) batches
    // Each batch takes finnhubMinDelayMs (1.1s)
    const finnhubIntervalMs = keyCount > 0
      ? Math.ceil(Math.ceil(symbolCount / keyCount) * this.finnhubMinDelayMs)
      : Infinity;

    // Alpaca: single batch request handles ALL symbols at once (no matter how many)
    // Rate limit is 200 requests/min, each request gets all symbols
    const alpacaIntervalMs = (this.alpacaKeyId && this.alpacaSecretKey)
      ? Math.ceil(MS_PER_MINUTE / ALPACA_RATE_LIMIT_PER_MIN) // 300ms
      : Infinity;

    // Use the faster available source's interval
    const fasterInterval = Math.min(finnhubIntervalMs, alpacaIntervalMs);

    // Minimum 1s floor to avoid API abuse, but otherwise use calculated interval
    return Math.max(1000, fasterInterval);
  }

  /**
   * Notify subscribers of price update
   */
  private notifySubscribers(symbol: string, priceData: PriceCache): void {
    const subs = this.subscribers.get(symbol);
    if (!subs) return;

    const stockPrice: StockPrice = {
      symbol,
      price: priceData.price,
      timestamp: priceData.timestamp,
      source: priceData.source,
      isStale: false,
    };

    for (const callback of subs) {
      try {
        callback(stockPrice);
      } catch (err) {
        feedLogger.error({ symbol, error: err }, 'Subscriber callback error');
      }
    }
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, StockPrice> {
    const config = getConfigSync();
    const result = new Map<string, StockPrice>();

    for (const [symbol, cached] of this.priceCache) {
      result.set(symbol, {
        symbol,
        price: cached.price,
        timestamp: cached.timestamp,
        source: cached.source,
        isStale: Date.now() - cached.timestamp > config.priceStalenessMs,
      });
    }

    return result;
  }

  /**
   * Fetch prices for multiple symbols using optimal parallel strategy:
   * 1. Return cached prices immediately
   * 2. Alternates between Alpaca and Finnhub as primary source for fresher prices
   * 3. Falls back to the other source for any failures
   * 4. Polygon as last resort fallback
   *
   * Alternating between sources ensures we get the freshest possible prices
   */
  async getBatchPrices(symbols: string[]): Promise<Map<string, StockPrice>> {
    const config = getConfigSync();
    const results = new Map<string, StockPrice>();
    const now = Date.now();

    // Capture which source to use this cycle, then flip for next time
    const useAlpaca = useAlpacaNext;
    useAlpacaNext = !useAlpacaNext;

    const primarySource = useAlpaca ? 'alpaca' : 'finnhub';

    // Step 0: Handle custom price sources (e.g., Swissquote for GOLD)
    // Build a map of stockTicker -> token config for custom sources
    const customSourceTokens = new Map<string, { priceSource: string; priceSymbol: string }>();
    for (const token of config.tokens) {
      if (token.priceSource && token.priceSource !== 'stock' && token.priceSymbol) {
        customSourceTokens.set(token.stockTicker, {
          priceSource: token.priceSource,
          priceSymbol: token.priceSymbol,
        });
      }
    }

    // Separate custom source symbols from regular stock symbols
    const customSymbols: string[] = [];
    const stockSymbols: string[] = [];
    for (const symbol of symbols) {
      if (customSourceTokens.has(symbol)) {
        customSymbols.push(symbol);
      } else {
        stockSymbols.push(symbol);
      }
    }

    // Fetch custom source prices (e.g., Swissquote for gold)
    if (customSymbols.length > 0) {
      for (const symbol of customSymbols) {
        const customConfig = customSourceTokens.get(symbol)!;
        if (customConfig.priceSource === 'swissquote') {
          const price = await fetchSwissquotePrice(customConfig.priceSymbol);
          if (price) {
            const mappedPrice: StockPrice = {
              ...price,
              symbol, // Map back to stockTicker
            };
            results.set(symbol, mappedPrice);
            // Update cache
            this.priceCache.set(symbol, {
              price: mappedPrice.price,
              timestamp: mappedPrice.timestamp,
              source: mappedPrice.source,
            });
          } else {
            feedLogger.warn({ symbol, priceSymbol: customConfig.priceSymbol }, 'Custom price source returned null');
          }
        }
      }
    }

    feedLogger.info({ count: symbols.length, stockCount: stockSymbols.length, customCount: customSymbols.length, primarySource }, 'Stock price fetch (batch)');

    // If no stock symbols need fetching, return early
    if (stockSymbols.length === 0) {
      return results;
    }

    // Step 1: Separate symbols into fresh (cached) and stale (need fetch)
    const needsFetch: string[] = [];

    for (const symbol of stockSymbols) {
      const cached = this.priceCache.get(symbol);
      if (cached && now - cached.timestamp < config.priceStalenessMs) {
        // Use cached price
        results.set(symbol, {
          symbol,
          price: cached.price,
          timestamp: Date.now(), // Current time since we vouch it's fresh
          source: cached.source,
          isStale: false,
        });
      } else {
        needsFetch.push(symbol);
      }
    }

    if (needsFetch.length === 0) {
      feedLogger.debug({ cached: stockSymbols.length }, 'All stock prices served from cache');
      return results;
    }

    let remaining = [...needsFetch];
    let alpacaCount = 0;
    let finnhubCount = 0;

    // Step 2: Primary source (alternates between Alpaca and Finnhub)
    if (useAlpaca && this.alpacaKeyId && this.alpacaSecretKey) {
      // Alpaca as primary
      const alpacaPrices = await this.fetchBatchFromAlpaca(needsFetch);

      for (const [symbol, priceData] of alpacaPrices) {
        results.set(symbol, {
          symbol,
          price: priceData.price,
          timestamp: priceData.timestamp,
          source: priceData.source,
          isStale: false,
        });
      }

      alpacaCount = alpacaPrices.size;
      remaining = needsFetch.filter(s => !alpacaPrices.has(s));
    } else if (!useAlpaca && this.finnhubKeys.length > 0) {
      // Finnhub as primary
      const finnhubPrices = await this.fetchParallelFinnhub(needsFetch);

      for (const [symbol, price] of finnhubPrices) {
        results.set(symbol, price);
      }

      finnhubCount = finnhubPrices.size;
      remaining = needsFetch.filter(s => !finnhubPrices.has(s));
    }

    // Step 3: Secondary source for any remaining symbols
    if (remaining.length > 0) {
      if (useAlpaca && this.finnhubKeys.length > 0) {
        // Finnhub as fallback
        const finnhubPrices = await this.fetchParallelFinnhub(remaining);

        for (const [symbol, price] of finnhubPrices) {
          results.set(symbol, price);
        }

        finnhubCount = finnhubPrices.size;
        remaining = remaining.filter(s => !finnhubPrices.has(s));
      } else if (!useAlpaca && this.alpacaKeyId && this.alpacaSecretKey) {
        // Alpaca as fallback
        const alpacaPrices = await this.fetchBatchFromAlpaca(remaining);

        for (const [symbol, priceData] of alpacaPrices) {
          results.set(symbol, {
            symbol,
            price: priceData.price,
            timestamp: priceData.timestamp,
            source: priceData.source,
            isStale: false,
          });
        }

        alpacaCount = alpacaPrices.size;
        remaining = remaining.filter(s => !alpacaPrices.has(s));
      }
    }

    // Step 4: Polygon fallback for stragglers (if configured)
    if (remaining.length > 0 && this.polygonKey) {
      for (const symbol of remaining) {
        const price = await this.fetchFromPolygon(symbol);
        if (price) {
          results.set(symbol, {
            symbol,
            price: price.price,
            timestamp: price.timestamp,
            source: price.source,
            isStale: false,
          });
        }
      }
    }

    const cachedCount = symbols.length - needsFetch.length;
    const fetchedCount = results.size - cachedCount;
    const failedCount = needsFetch.length - fetchedCount;

    feedLogger.info({
      total: symbols.length,
      cached: cachedCount,
      fetched: fetchedCount,
      failed: failedCount,
      primarySource,
      sources: {
        alpaca: alpacaCount,
        finnhub: finnhubCount,
      },
    }, `Batch stock prices: ${fetchedCount} fetched, ${cachedCount} cached, ${failedCount} failed`);

    return results;
  }

  /**
   * Fetch multiple symbols in parallel using all Finnhub API keys
   * Processes N symbols at a time where N = number of keys
   */
  private async fetchParallelFinnhub(symbols: string[]): Promise<Map<string, StockPrice>> {
    const results = new Map<string, StockPrice>();
    const numKeys = this.finnhubKeys.length;

    if (numKeys === 0) return results;

    // Process in parallel batches (one symbol per key)
    for (let i = 0; i < symbols.length; i += numKeys) {
      const batch = symbols.slice(i, i + numKeys);

      // Create parallel fetch promises, one per key
      const fetchPromises = batch.map(async (symbol, keyIndex) => {
        const apiKey = this.finnhubKeys[keyIndex];
        const startTime = Date.now();

        try {
          const response = await axios.get(
            'https://finnhub.io/api/v1/quote',
            {
              params: { symbol, token: apiKey },
              timeout: 5000,
            }
          );

          const responseMs = Date.now() - startTime;

          if (response.data?.c && response.data.c > 0) {
            const priceData: PriceCache = {
              price: response.data.c,
              timestamp: Date.now(),
              source: 'finnhub',
            };

            // Update cache
            this.priceCache.set(symbol, priceData);
            recordApiCall('finnhub', true, responseMs);

            return {
              symbol,
              price: {
                symbol,
                price: priceData.price,
                timestamp: priceData.timestamp,
                source: priceData.source,
                isStale: false,
              } as StockPrice,
            };
          }
          recordApiCall('finnhub', false, responseMs, 'No price data');
        } catch (err) {
          const responseMs = Date.now() - startTime;
          recordApiCall('finnhub', false, responseMs, String(err));
          feedLogger.debug({ symbol, keyIndex, error: err }, 'Parallel Finnhub fetch failed');
        }

        return null;
      });

      // Wait for all parallel fetches to complete
      const batchResults = await Promise.all(fetchPromises);

      // Collect successful results
      for (const result of batchResults) {
        if (result) {
          results.set(result.symbol, result.price);
        }
      }

      // Rate limit: wait 1.1 seconds between batches to respect per-key limits
      if (i + numKeys < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, this.finnhubMinDelayMs));
      }
    }

    return results;
  }
}

// Singleton instance
let stockFeedInstance: StockFeed | null = null;

export function getStockFeed(): StockFeed {
  if (!stockFeedInstance) {
    stockFeedInstance = new StockFeed();
  }
  return stockFeedInstance;
}
