/**
 * Onchain price feed - fetches prices from Solana DEXes
 * Primary source: Jupiter Price API
 * Fallback: DexScreener API (for tokens without Jupiter coverage)
 * Includes liquidity information for sizing calculations
 *
 * RESILIENCE FEATURES:
 * - Primary endpoint: api.jup.ag (with API key)
 * - Fallback endpoint: public.jupiterapi.com (no auth required)
 * - Automatic failover on auth errors or timeouts
 * - Reduced timeouts for faster failover
 */

import axios, { AxiosError } from 'axios';
import { OnchainPrice, TokenConfig } from '../types';
import { feedLogger } from '../logger';
import { getConfigSync } from '../config';
import { USDC_MINT } from '../constants';
import { fetchDexScreenerPrice, fetchBatchDexScreenerPrices } from './dexScreenerFeed';

interface PriceCache {
  price: number;          // Stock-equivalent price (from stockData.price if available)
  tradingPrice: number;   // Actual on-chain trading price (usdPrice)
  liquidity: number;
  timestamp: number;
  source: string;
}

interface LiquidityCache {
  liquidity: number;
  timestamp: number;
}

// Cache liquidity for 5 minutes (don't need to check every price update)
const LIQUIDITY_CACHE_MS = 5 * 60 * 1000;

// Cache price fetch failures for 1 hour (avoid hammering APIs for tokens with no data)
const PRICE_FAILURE_CACHE_MS = 60 * 60 * 1000;

// Jupiter API endpoints
const JUPITER_PRICE_API_URL = 'https://api.jup.ag/price/v3';
const JUPITER_QUOTE_API_FALLBACK = 'https://public.jupiterapi.com';
const JUPITER_PRICE_BATCH_SIZE = 50;

// Rate limits for calculating optimal polling frequency
const DEXSCREENER_BATCH_SIZE = 30;
const DEXSCREENER_RATE_LIMIT_PER_MIN = 300;
const JUPITER_RATE_LIMIT_PER_MIN = 600; // Conservative estimate for price API

// Timeouts - reduced for faster failover
const JUPITER_TIMEOUT_MS = 5000; // 5s instead of 10s

export class OnchainFeed {
  private priceCache: Map<string, PriceCache> = new Map();
  private liquidityCache: Map<string, LiquidityCache> = new Map();
  private priceFailureCache: Map<string, number> = new Map(); // mint → timestamp of last failure
  private connected: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private subscribers: Map<string, Set<(price: OnchainPrice) => void>> = new Map();
  private jupiterApiUrl: string;
  private jupiterApiKey: string | undefined;

  // Mint → TokenConfig lookup cache (built once, avoids O(n) searches)
  private tokenByMint: Map<string, TokenConfig> = new Map();

  // Rate limiting for Jupiter API (avoid 429 errors)
  private lastJupiterCall: number = 0;
  private readonly jupiterMinDelayMs: number = 200; // 200ms between calls = 300/min max

  // Fallback state for quote API
  private usingFallbackQuoteApi: boolean = false;
  private fallbackQuoteApiUntil: number = 0;

  constructor() {
    const config = getConfigSync();
    this.jupiterApiUrl = config.jupiterApiUrl;
    this.jupiterApiKey = process.env.JUPITER_API_KEY;

    // Build mint lookup cache once
    for (const token of config.tokens) {
      this.tokenByMint.set(token.mint, token);
    }

    feedLogger.info({
      primaryQuoteApi: this.jupiterApiUrl,
      fallbackQuoteApi: JUPITER_QUOTE_API_FALLBACK,
      priceApi: JUPITER_PRICE_API_URL,
      hasApiKey: !!this.jupiterApiKey,
    }, 'OnchainFeed initialized with fallback support');
  }

  /**
   * Check if we should reset from fallback to primary
   */
  private checkAndResetFallback(): void {
    if (this.usingFallbackQuoteApi && Date.now() > this.fallbackQuoteApiUntil) {
      feedLogger.info('Attempting to switch back to primary Jupiter quote API');
      this.usingFallbackQuoteApi = false;
    }
  }

  /**
   * Switch to fallback quote API
   */
  private switchToFallbackQuoteApi(reason: string): void {
    if (!this.usingFallbackQuoteApi) {
      this.usingFallbackQuoteApi = true;
      this.fallbackQuoteApiUntil = Date.now() + 5 * 60 * 1000; // Retry primary in 5 minutes
      feedLogger.warn({ reason }, 'Switched to fallback Jupiter quote API (public.jupiterapi.com)');
    }
  }

  /**
   * Check if error should trigger fallback
   */
  private shouldSwitchToFallback(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      // Auth errors or DNS failures should trigger fallback
      if (status === 401 || status === 403 ||
          axiosError.code === 'ENOTFOUND' ||
          axiosError.code === 'ECONNREFUSED') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get token config by mint (O(1) lookup)
   */
  private getTokenConfig(mint: string): TokenConfig | undefined {
    return this.tokenByMint.get(mint);
  }

  /**
   * Wait for rate limit before making Jupiter API call
   */
  private async waitForRateLimit(): Promise<void> {
    const timeSinceLastCall = Date.now() - this.lastJupiterCall;
    if (timeSinceLastCall < this.jupiterMinDelayMs) {
      const waitTime = this.jupiterMinDelayMs - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastJupiterCall = Date.now();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    feedLogger.info('Connecting onchain feed...');

    // Test Jupiter API connectivity
    const isConnected = await this.testConnectivity();
    if (!isConnected) {
      feedLogger.warn('Jupiter API connectivity test failed');
    }

    this.connected = true;
    this.startPolling();
    feedLogger.info('Onchain feed connected');
  }

  async disconnect(): Promise<void> {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    feedLogger.info('Onchain feed disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current price for a token mint
   */
  async getPrice(mint: string, symbol?: string): Promise<OnchainPrice | null> {
    const config = getConfigSync();
    const cached = this.priceCache.get(mint);

    // Return cached if fresh
    if (cached && Date.now() - cached.timestamp < config.priceStalenessMs) {
      return {
        symbol: symbol || mint.slice(0, 8),
        mint,
        price: cached.price,
        tradingPrice: cached.tradingPrice,
        timestamp: cached.timestamp,
        source: cached.source,
        poolLiquidity: cached.liquidity,
        isStale: false,
      };
    }

    // Check if this token recently failed to get price from all sources
    // Skip API calls for 1 hour to avoid wasting rate limits
    const lastFailure = this.priceFailureCache.get(mint);
    if (lastFailure && Date.now() - lastFailure < PRICE_FAILURE_CACHE_MS) {
      // Still in failure cooldown - return stale cache if available, otherwise null
      if (cached) {
        return {
          symbol: symbol || mint.slice(0, 8),
          mint,
          price: cached.price,
          tradingPrice: cached.tradingPrice,
          timestamp: cached.timestamp,
          source: cached.source,
          poolLiquidity: cached.liquidity,
          isStale: true,
        };
      }
      return null;
    }

    // Fetch new price
    const priceData = await this.fetchPrice(mint);
    if (priceData) {
      // Success - clear any failure cache
      this.priceFailureCache.delete(mint);
      return {
        symbol: symbol || mint.slice(0, 8),
        mint,
        price: priceData.price,
        tradingPrice: priceData.tradingPrice,
        timestamp: priceData.timestamp,
        source: priceData.source,
        poolLiquidity: priceData.liquidity,
        isStale: false,
      };
    }

    // All sources failed - cache the failure to avoid hammering APIs
    this.priceFailureCache.set(mint, Date.now());
    feedLogger.debug({ mint: mint.slice(0, 8), symbol }, 'Price fetch failed from all sources, caching failure for 1 hour');

    // Return stale cache if available
    if (cached) {
      feedLogger.warn({ mint }, 'Returning stale onchain price');
      return {
        symbol: symbol || mint.slice(0, 8),
        mint,
        price: cached.price,
        tradingPrice: cached.tradingPrice,
        timestamp: cached.timestamp,
        source: cached.source,
        poolLiquidity: cached.liquidity,
        isStale: true,
      };
    }

    return null;
  }

  /**
   * Get cached price regardless of staleness (for lenient exit decisions)
   * Returns null only if no cache exists at all
   */
  getCachedPrice(mint: string, symbol?: string): { price: OnchainPrice; ageMs: number } | null {
    const cached = this.priceCache.get(mint);
    if (!cached) {
      return null;
    }

    const ageMs = Date.now() - cached.timestamp;
    return {
      price: {
        symbol: symbol || mint.slice(0, 8),
        mint,
        price: cached.price,
        tradingPrice: cached.tradingPrice,
        timestamp: cached.timestamp,
        source: cached.source,
        poolLiquidity: cached.liquidity,
        isStale: true, // Always mark as stale since this bypasses freshness checks
      },
      ageMs,
    };
  }

  /**
   * Get price with liquidity depth at specific size
   * Uses fallback API if primary fails
   */
  async getPriceWithDepth(mint: string, sizeUsd: number): Promise<{
    price: number;
    priceImpactPct: number;
    liquidity: number;
  } | null> {
    // Get token decimals from cache (O(1) lookup)
    const tokenConfig = this.getTokenConfig(mint);
    const decimals = tokenConfig?.decimals || 9; // Default to 9 if not found

    // Check if we should reset fallback state
    this.checkAndResetFallback();

    // Try primary API first, then fallback
    const apiUrls = this.usingFallbackQuoteApi
      ? [JUPITER_QUOTE_API_FALLBACK, this.jupiterApiUrl]
      : [this.jupiterApiUrl, JUPITER_QUOTE_API_FALLBACK];

    for (const apiUrl of apiUrls) {
      try {
        // Rate limit Jupiter API calls
        await this.waitForRateLimit();

        // Get quote for buying the token with USDC
        const headers: Record<string, string> = {};
        if (this.jupiterApiKey && apiUrl === this.jupiterApiUrl) {
          headers['x-api-key'] = this.jupiterApiKey;
        }

        const response = await axios.get(`${apiUrl}/quote`, {
          params: {
            inputMint: USDC_MINT,
            outputMint: mint,
            amount: Math.floor(sizeUsd * 1e6), // USDC has 6 decimals
            slippageBps: 100,
          },
          headers,
          timeout: JUPITER_TIMEOUT_MS,
        });

        if (response.data) {
          const quote = response.data;
          const outputAmount = parseInt(quote.outAmount);
          const priceImpact = parseFloat(quote.priceImpactPct || '0');

          // Calculate effective price using correct token decimals
          const price = sizeUsd / (outputAmount / Math.pow(10, decimals));

          return {
            price,
            priceImpactPct: priceImpact,
            liquidity: await this.estimateLiquidity(mint),
          };
        }
      } catch (err) {
        feedLogger.debug({ mint: mint.slice(0, 8), sizeUsd, apiUrl, error: err instanceof Error ? err.message : err }, 'Failed to get price with depth');

        // Check if we should switch to fallback
        if (this.shouldSwitchToFallback(err) && apiUrl === this.jupiterApiUrl) {
          this.switchToFallbackQuoteApi(err instanceof Error ? err.message : 'Unknown error');
        }
        continue;
      }
    }

    return null;
  }

  /**
   * Subscribe to price updates for a mint
   */
  subscribe(mint: string, callback: (price: OnchainPrice) => void): void {
    if (!this.subscribers.has(mint)) {
      this.subscribers.set(mint, new Set());
    }
    this.subscribers.get(mint)!.add(callback);
    feedLogger.debug({ mint }, 'Subscribed to onchain price');
  }

  /**
   * Unsubscribe from price updates
   */
  unsubscribe(mint: string, callback: (price: OnchainPrice) => void): void {
    const subs = this.subscribers.get(mint);
    if (subs) {
      subs.delete(callback);
    }
  }

  /**
   * Fetch price from Jupiter API v3
   */
  private async fetchPrice(mint: string): Promise<PriceCache | null> {
    feedLogger.info({ mint: mint.slice(0, 8) }, 'Token price fetch (single)');
    // Jupiter lite API doesn't have a price endpoint, use quote-based pricing directly
    return this.fetchPriceViaQuote(mint);
  }

  /**
   * Fetch prices in batches - DexScreener AND Jupiter in parallel for maximum throughput
   */
  private async fetchPricesBatch(mints: string[]): Promise<void> {
    if (mints.length === 0) return;

    // Filter out tokens that consistently fail price fetches
    const PROBLEMATIC_MINTS = new Set([
      'cJpUMp5R', // INTCon - consistent quote failures
      'XsSr8anD', // LINx - consistent quote failures
      'XsjQP3iM', // TQQQx - consistent quote failures
    ]);
    const filteredMints = mints.filter(mint => !PROBLEMATIC_MINTS.has(mint));

    if (filteredMints.length !== mints.length) {
      feedLogger.debug({
        originalCount: mints.length,
        filteredCount: filteredMints.length,
        filtered: mints.filter(mint => PROBLEMATIC_MINTS.has(mint))
      }, 'Filtered out problematic mints from price fetch');
    }

    feedLogger.debug({ totalMints: filteredMints.length }, 'Starting batch price fetch');

    // Build token list with symbols for DexScreener batch
    const tokens = filteredMints.map(mint => {
      const tokenConfig = this.getTokenConfig(mint);
      return { mint, symbol: tokenConfig?.symbol || mint.slice(0, 8) };
    });

    // Fetch from BOTH sources in parallel for maximum speed
    const [dexResults, jupiterResults] = await Promise.all([
      fetchBatchDexScreenerPrices(tokens),
      this.fetchPricesViaJupiterBatch(filteredMints),
    ]);

    // Merge results - prefer DexScreener (has liquidity data), use Jupiter as supplement
    let dexSuccessCount = 0;
    let jupiterOnlyCount = 0;
    const missingMints: string[] = [];

    for (const mint of filteredMints) {
      const dexData = dexResults.get(mint);

      if (dexData && dexData.priceUsd > 0) {
        // DexScreener has data - use it (includes liquidity)
        const priceData: PriceCache = {
          price: dexData.priceUsd,
          tradingPrice: dexData.priceUsd,
          liquidity: dexData.totalLiquidityUsd,
          timestamp: Date.now(),
          source: 'dexscreener',
        };
        this.priceCache.set(mint, priceData);
        this.notifySubscribers(mint, priceData);
        this.priceFailureCache.delete(mint);
        dexSuccessCount++;
      } else if (jupiterResults.has(mint)) {
        // Jupiter has data but DexScreener doesn't - already cached in fetchPricesViaJupiterBatch
        jupiterOnlyCount++;
      } else {
        // Both batch APIs failed - track for individual fallback
        missingMints.push(mint);
      }
    }

    // Fallback: try Jupiter Quote API for tokens that failed both batch APIs
    let quoteFallbackCount = 0;
    if (missingMints.length > 0) {
      feedLogger.debug({ missingCount: missingMints.length }, 'Trying Jupiter Quote API fallback for missing tokens');

      // Process in parallel but limit concurrency to avoid rate limits
      const QUOTE_CONCURRENCY = 5;
      for (let i = 0; i < missingMints.length; i += QUOTE_CONCURRENCY) {
        const batch = missingMints.slice(i, i + QUOTE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(mint => this.fetchPriceViaQuote(mint).catch(() => null))
        );
        quoteFallbackCount += results.filter(r => r !== null).length;
      }
    }

    feedLogger.debug({
      totalMints: filteredMints.length,
      dexScreenerSuccess: dexSuccessCount,
      jupiterOnlySuccess: jupiterOnlyCount,
      quoteFallbackSuccess: quoteFallbackCount,
      stillMissing: missingMints.length - quoteFallbackCount,
    }, 'Batch price fetch complete');
  }

  /**
   * Fetch prices via Jupiter Price API v3 (batch up to 50 tokens)
   * Returns Set of mints that were successfully fetched
   */
  private async fetchPricesViaJupiterBatch(mints: string[]): Promise<Set<string>> {
    const successfulMints = new Set<string>();
    if (mints.length === 0) return successfulMints;

    // Process in batches of 50
    for (let i = 0; i < mints.length; i += JUPITER_PRICE_BATCH_SIZE) {
      const batch = mints.slice(i, i + JUPITER_PRICE_BATCH_SIZE);

      try {
        const headers: Record<string, string> = {};
        if (this.jupiterApiKey) {
          headers['x-api-key'] = this.jupiterApiKey;
        }

        const response = await axios.get(JUPITER_PRICE_API_URL, {
          params: {
            ids: batch.join(','),
          },
          headers,
          timeout: 10000,
        });

        if (response.data?.data) {
          const priceData = response.data.data as Record<string, { price: string } | undefined>;

          for (const mint of batch) {
            const tokenPrice = priceData[mint];
            if (tokenPrice?.price) {
              const price = parseFloat(tokenPrice.price);
              if (price > 0) {
                const cached: PriceCache = {
                  price,
                  tradingPrice: price,
                  liquidity: 0, // Jupiter Price API doesn't return liquidity
                  timestamp: Date.now(),
                  source: 'jupiter-price',
                };
                this.priceCache.set(mint, cached);
                this.notifySubscribers(mint, cached);
                this.priceFailureCache.delete(mint);
                successfulMints.add(mint);
              }
            }
          }
        }

      } catch (err) {
        feedLogger.debug({ error: err, batchSize: batch.length }, 'Jupiter Price API batch failed');
      }
    }

    return successfulMints;
  }

  /**
   * Pre-fetch prices for a list of mints (batch)
   */
  async prefetchPrices(mints: string[]): Promise<void> {
    await this.fetchPricesBatch(mints);
  }

  /**
   * Fetch price by getting a small quote (backup method)
   * Uses fallback API if primary fails
   */
  private async fetchPriceViaQuote(mint: string): Promise<PriceCache | null> {
    // Get token decimals from cache (O(1) lookup)
    const tokenConfig = this.getTokenConfig(mint);
    const decimals = tokenConfig?.decimals || 9; // Default to 9 if not found

    // Check if we should reset fallback state
    this.checkAndResetFallback();

    // Try primary API first, then fallback
    const apiUrls = this.usingFallbackQuoteApi
      ? [JUPITER_QUOTE_API_FALLBACK, this.jupiterApiUrl]
      : [this.jupiterApiUrl, JUPITER_QUOTE_API_FALLBACK];

    for (const apiUrl of apiUrls) {
      try {
        // Rate limit Jupiter API calls
        await this.waitForRateLimit();

        // Quote for $100 worth
        const headers: Record<string, string> = {};
        // Only use API key for primary endpoint
        if (this.jupiterApiKey && apiUrl === this.jupiterApiUrl) {
          headers['x-api-key'] = this.jupiterApiKey;
        }

        const response = await axios.get(`${apiUrl}/quote`, {
          params: {
            inputMint: USDC_MINT,
            outputMint: mint,
            amount: 100 * 1e6, // $100 in USDC
            slippageBps: 100,
          },
          headers,
          timeout: JUPITER_TIMEOUT_MS,
        });

        if (response.data) {
          const quote = response.data;
          const outputAmount = parseInt(quote.outAmount);

          // Use correct token decimals from config
          const price = 100 / (outputAmount / Math.pow(10, decimals));
          const liquidity = await this.estimateLiquidity(mint);

          const priceData: PriceCache = {
            price,
            tradingPrice: price,
            liquidity,
            timestamp: Date.now(),
            source: apiUrl === JUPITER_QUOTE_API_FALLBACK ? 'jupiter-quote-fallback' : 'jupiter-quote',
          };

          this.priceCache.set(mint, priceData);
          this.notifySubscribers(mint, priceData);

          return priceData;
        }
      } catch (err) {
        feedLogger.debug({ mint: mint.slice(0, 8), apiUrl, error: err instanceof Error ? err.message : err }, 'Quote-based price fetch failed');

        // Check if we should switch to fallback for future requests
        if (this.shouldSwitchToFallback(err) && apiUrl === this.jupiterApiUrl) {
          this.switchToFallbackQuoteApi(err instanceof Error ? err.message : 'Unknown error');
        }

        // Continue to try next API URL
        continue;
      }
    }

    // All Jupiter APIs failed - try DexScreener
    return this.fetchPriceViaDexScreener(mint);
  }

  /**
   * Fetch price from DexScreener (final fallback)
   */
  private async fetchPriceViaDexScreener(mint: string): Promise<PriceCache | null> {
    try {
      const tokenConfig = this.getTokenConfig(mint);
      const dexData = await fetchDexScreenerPrice(mint, tokenConfig?.symbol);

      if (dexData && dexData.priceUsd > 0) {
        const priceData: PriceCache = {
          price: dexData.priceUsd,
          tradingPrice: dexData.priceUsd,
          liquidity: dexData.totalLiquidityUsd,
          timestamp: Date.now(),
          source: 'dexscreener',
        };

        this.priceCache.set(mint, priceData);
        this.notifySubscribers(mint, priceData);

        feedLogger.debug({
          mint: mint.slice(0, 8),
          symbol: dexData.symbol,
          price: dexData.priceUsd.toFixed(2),
          liquidity: dexData.totalLiquidityUsd.toFixed(0),
        }, 'Price fetched from DexScreener');

        return priceData;
      }
    } catch (err) {
      feedLogger.debug({ mint, error: err }, 'DexScreener price fetch failed');
    }

    return null;
  }

  /**
   * Estimate liquidity for a token
   * Returns cached value or 0 - liquidity check is now optional for Raydium pool tokens
   * This avoids rate limiting issues with Jupiter quote calls
   */
  private async estimateLiquidity(mint: string): Promise<number> {
    // Check cache first
    const cached = this.liquidityCache.get(mint);
    if (cached && Date.now() - cached.timestamp < LIQUIDITY_CACHE_MS) {
      return cached.liquidity;
    }

    // For now, return 0 - liquidity check is skipped for Raydium pool tokens
    // This avoids 3 Jupiter API calls per token which causes rate limiting
    // The signal generator skips liquidity check for tokens with poolAddress
    return 0;
  }

  /**
   * Test API connectivity using quote endpoint
   * Tries primary first, then fallback
   */
  private async testConnectivity(): Promise<boolean> {
    const apiUrls = [this.jupiterApiUrl, JUPITER_QUOTE_API_FALLBACK];

    for (const apiUrl of apiUrls) {
      try {
        await this.waitForRateLimit();

        const headers: Record<string, string> = {};
        if (this.jupiterApiKey && apiUrl === this.jupiterApiUrl) {
          headers['x-api-key'] = this.jupiterApiKey;
        }

        const response = await axios.get(`${apiUrl}/quote`, {
          params: {
            inputMint: USDC_MINT,
            outputMint: 'So11111111111111111111111111111111111111112', // SOL
            amount: 1000000, // 1 USDC
            slippageBps: 100,
          },
          headers,
          timeout: JUPITER_TIMEOUT_MS,
        });

        if (response.status === 200 && response.data?.outAmount) {
          if (apiUrl === JUPITER_QUOTE_API_FALLBACK) {
            this.switchToFallbackQuoteApi('Primary API failed connectivity test');
          }
          feedLogger.info({ apiUrl }, 'Jupiter API connectivity test passed');
          return true;
        }
      } catch (err) {
        feedLogger.debug({ apiUrl, error: err instanceof Error ? err.message : err }, 'Connectivity test failed for endpoint');
        // If primary fails with auth error, switch to fallback
        if (this.shouldSwitchToFallback(err) && apiUrl === this.jupiterApiUrl) {
          this.switchToFallbackQuoteApi(err instanceof Error ? err.message : 'Auth failed');
        }
        continue;
      }
    }

    feedLogger.error('All Jupiter API endpoints failed connectivity test');
    return false;
  }

  /**
   * Calculate optimal polling interval based on token count and rate limits
   * Uses both DexScreener (300/min, 30 tokens/batch) and Jupiter (600/min, 50 tokens/batch) in parallel
   */
  private calculatePollingInterval(tokenCount: number): number {
    if (tokenCount === 0) return 5000; // Default 5s if no tokens

    // Calculate calls needed per poll for each API
    const dexScreenerCallsPerPoll = Math.ceil(tokenCount / DEXSCREENER_BATCH_SIZE);
    const jupiterCallsPerPoll = Math.ceil(tokenCount / JUPITER_PRICE_BATCH_SIZE);

    // Calculate max polls per minute for each API (use 80% of limit for safety margin)
    const dexScreenerMaxPollsPerMin = Math.floor((DEXSCREENER_RATE_LIMIT_PER_MIN * 0.8) / dexScreenerCallsPerPoll);
    const jupiterMaxPollsPerMin = Math.floor((JUPITER_RATE_LIMIT_PER_MIN * 0.8) / jupiterCallsPerPoll);

    // Use the more restrictive limit (since we call both in parallel)
    const maxPollsPerMin = Math.min(dexScreenerMaxPollsPerMin, jupiterMaxPollsPerMin);

    // Convert to interval in ms (minimum 500ms to avoid hammering)
    const intervalMs = Math.max(500, Math.ceil(60000 / maxPollsPerMin));

    return intervalMs;
  }

  /**
   * Start polling for price updates
   * Dynamically adjusts polling frequency based on token count and rate limits
   */
  private startPolling(): void {
    const scheduleNext = () => {
      if (!this.connected) return;

      const mints = Array.from(this.subscribers.keys());
      const intervalMs = this.calculatePollingInterval(mints.length);

      this.pollInterval = setTimeout(async () => {
        const currentMints = Array.from(this.subscribers.keys());
        await this.fetchPricesBatch(currentMints);
        if (this.connected) {
          scheduleNext();
        }
      }, intervalMs);
    };

    const mints = Array.from(this.subscribers.keys());
    void this.fetchPricesBatch(mints).finally(scheduleNext);
  }

  /**
   * Notify subscribers of price update
   */
  private notifySubscribers(mint: string, priceData: PriceCache): void {
    const subs = this.subscribers.get(mint);
    if (!subs) return;

    // Get symbol from cache (O(1) lookup)
    const tokenConfig = this.getTokenConfig(mint);
    const symbol = tokenConfig?.symbol || mint.slice(0, 8);

    const onchainPrice: OnchainPrice = {
      symbol,
      mint,
      price: priceData.price,
      tradingPrice: priceData.tradingPrice,
      timestamp: priceData.timestamp,
      source: priceData.source,
      poolLiquidity: priceData.liquidity,
      isStale: false,
    };

    for (const callback of subs) {
      try {
        callback(onchainPrice);
      } catch (err) {
        feedLogger.error({ mint, error: err }, 'Subscriber callback error');
      }
    }
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, OnchainPrice> {
    const config = getConfigSync();
    const result = new Map<string, OnchainPrice>();

    for (const [mint, cached] of this.priceCache) {
      const tokenConfig = this.getTokenConfig(mint);
      result.set(mint, {
        symbol: tokenConfig?.symbol || mint.slice(0, 8),
        mint,
        price: cached.price,
        tradingPrice: cached.tradingPrice,
        timestamp: cached.timestamp,
        source: cached.source,
        poolLiquidity: cached.liquidity,
        isStale: Date.now() - cached.timestamp > config.priceStalenessMs,
      });
    }

    return result;
  }
}

// Singleton instance
let onchainFeedInstance: OnchainFeed | null = null;

export function getOnchainFeed(): OnchainFeed {
  if (!onchainFeedInstance) {
    onchainFeedInstance = new OnchainFeed();
  }
  return onchainFeedInstance;
}
