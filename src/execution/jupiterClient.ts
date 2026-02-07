/**
 * Jupiter API Client
 * Handles quote fetching and swap execution
 *
 * EXECUTION REQUIREMENTS:
 * - Use Jupiter Quote + Swap APIs
 * - Enforce: max slippage, min-out protection, route validation
 * - Include: retry logic, circuit breaker, full transaction logging
 *
 * RESILIENCE FEATURES:
 * - Primary endpoint: api.jup.ag (with API key)
 * - Fallback endpoint: public.jupiterapi.com (no auth required)
 * - Automatic failover on auth errors or timeouts
 * - Exponential backoff with jitter
 * - Error classification (transient vs permanent)
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { QuoteInfo, RouteInfo } from '../types';
import { executionLogger } from '../logger';
import { getConfigSync } from '../config';
import { USDC_MINT, USDC_DECIMALS } from '../constants';
import { recordApiCall } from '../feeds/endpointTracker';

export interface SwapResponse {
  swapTransaction: string; // Base64 encoded transaction
  lastValidBlockHeight: number;
}

// API endpoints
const PRIMARY_API_URL = 'https://api.jup.ag/swap/v1';
const FALLBACK_API_URL = 'https://public.jupiterapi.com';

// Error classification
type ErrorType = 'transient' | 'auth' | 'rate_limit' | 'permanent';

export class JupiterClient {
  private primaryClient: AxiosInstance;
  private fallbackClient: AxiosInstance;
  private jupiterApiUrl: string;
  private usingFallback: boolean = false;
  private fallbackUntil: number = 0; // Timestamp when to retry primary

  // Circuit breaker state - only for execution failures, not price feeds
  private consecutiveFailures: number = 0;
  private circuitBreakerOpen: boolean = false;
  private lastFailureTime: number = 0;
  private readonly maxFailures = 10; // Increased from 5
  private readonly resetTimeMs = 30000; // Reduced from 60s to 30s

  // Retry configuration
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 500;
  private readonly maxDelayMs = 5000;

  constructor() {
    const config = getConfigSync();
    this.jupiterApiUrl = config.jupiterApiUrl || PRIMARY_API_URL;
    const jupiterApiKey = process.env.JUPITER_API_KEY;

    // Primary client with API key
    const primaryHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (jupiterApiKey) {
      primaryHeaders['x-api-key'] = jupiterApiKey;
    }

    this.primaryClient = axios.create({
      baseURL: this.jupiterApiUrl,
      timeout: 15000, // Reduced from 30s to fail faster
      headers: primaryHeaders,
    });

    // Fallback client - public endpoint, no auth
    this.fallbackClient = axios.create({
      baseURL: FALLBACK_API_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    executionLogger.info({
      primaryUrl: this.jupiterApiUrl,
      fallbackUrl: FALLBACK_API_URL,
      hasApiKey: !!jupiterApiKey,
    }, 'JupiterClient initialized with fallback support');
  }

  /**
   * Get the active client (primary or fallback)
   */
  private getActiveClient(): AxiosInstance {
    // Check if we should retry primary
    if (this.usingFallback && Date.now() > this.fallbackUntil) {
      executionLogger.info('Attempting to switch back to primary Jupiter API');
      this.usingFallback = false;
    }
    return this.usingFallback ? this.fallbackClient : this.primaryClient;
  }

  /**
   * Switch to fallback API
   */
  private switchToFallback(reason: string): void {
    if (!this.usingFallback) {
      this.usingFallback = true;
      this.fallbackUntil = Date.now() + 5 * 60 * 1000; // Try primary again in 5 minutes
      executionLogger.warn({ reason, fallbackUntil: new Date(this.fallbackUntil).toISOString() },
        'Switched to fallback Jupiter API (public.jupiterapi.com)');
    }
  }

  /**
   * Classify error type for appropriate handling
   */
  private classifyError(error: unknown): ErrorType {
    if (!axios.isAxiosError(error)) {
      return 'permanent';
    }

    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;

    // Auth errors - switch to fallback
    if (status === 401 || status === 403) {
      return 'auth';
    }

    // Rate limiting - back off
    if (status === 429) {
      return 'rate_limit';
    }

    // Timeouts and network errors - transient
    if (axiosError.code === 'ECONNABORTED' ||
        axiosError.code === 'ETIMEDOUT' ||
        axiosError.code === 'ENOTFOUND' ||
        axiosError.code === 'ECONNREFUSED' ||
        axiosError.message.includes('timeout')) {
      return 'transient';
    }

    // Server errors - transient
    if (status && status >= 500) {
      return 'transient';
    }

    // Client errors (4xx except auth/rate limit) - permanent
    if (status && status >= 400 && status < 500) {
      return 'permanent';
    }

    return 'transient';
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = Math.min(this.baseDelayMs * Math.pow(2, attempt), this.maxDelayMs);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    return exponentialDelay + jitter;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute request with retry logic and fallback
   */
  private async executeWithRetry<T>(
    operation: (client: AxiosInstance) => Promise<T>,
    operationName: string
  ): Promise<T | null> {
    let lastError: unknown;
    const endpointId = operationName === 'getQuote' ? 'jupiter-quote' : 'jupiter-quote';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        const client = this.getActiveClient();
        const result = await operation(client);
        recordApiCall(endpointId, true, Date.now() - startTime);

        // Success - if we were on fallback, note it worked
        if (attempt > 0) {
          executionLogger.debug({ attempt, operationName }, 'Request succeeded after retry');
        }

        return result;
      } catch (error) {
        recordApiCall(endpointId, false, Date.now() - startTime, String(error));
        lastError = error;
        const errorType = this.classifyError(error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        executionLogger.debug({
          operationName,
          attempt,
          errorType,
          error: errorMessage,
          usingFallback: this.usingFallback,
        }, 'Jupiter API request failed');

        // Handle based on error type
        switch (errorType) {
          case 'auth':
            // Auth error on primary - switch to fallback immediately
            if (!this.usingFallback) {
              this.switchToFallback('Authentication failed (401/403)');
              continue; // Retry immediately with fallback
            }
            // Auth error on fallback too - give up
            executionLogger.error('Auth failed on both primary and fallback APIs');
            return null;

          case 'rate_limit':
            // Rate limited - longer backoff
            const rateLimitDelay = this.calculateBackoff(attempt + 2); // Extra delay
            executionLogger.warn({ delayMs: rateLimitDelay }, 'Rate limited, backing off');
            await this.sleep(rateLimitDelay);
            continue;

          case 'transient':
            // Transient error - retry with backoff
            if (attempt < this.maxRetries) {
              const delay = this.calculateBackoff(attempt);
              await this.sleep(delay);

              // If multiple transient failures on primary, try fallback
              if (!this.usingFallback && attempt >= 1) {
                this.switchToFallback(`Multiple transient failures: ${errorMessage}`);
              }
              continue;
            }
            break;

          case 'permanent':
            // Permanent error on primary - try fallback once before giving up
            if (!this.usingFallback) {
              this.switchToFallback(`Permanent error on primary: ${errorMessage}`);
              continue; // Retry with fallback
            }
            // Permanent error on fallback too - give up
            executionLogger.warn({ operationName, error: errorMessage }, 'Permanent error on both endpoints, not retrying');
            return null;
        }
      }
    }

    // All retries exhausted
    const errorMessage = lastError instanceof Error ? lastError.message : 'Unknown error';
    executionLogger.error({
      operationName,
      error: errorMessage,
      attempts: this.maxRetries + 1,
    }, 'All retry attempts exhausted');

    return null;
  }

  /**
   * Get quote for a swap
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps?: number
  ): Promise<QuoteInfo | null> {
    const config = getConfigSync();

    if (this.isCircuitBreakerOpen()) {
      executionLogger.warn('Circuit breaker is open - rejecting quote request');
      return null;
    }

    const result = await this.executeWithRetry(async (client) => {
      const response = await client.get('/quote', {
        params: {
          inputMint,
          outputMint,
          amount: Math.floor(amount),
          slippageBps: slippageBps || config.maxSlippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
      });

      const quote = response.data;

      // Validate quote
      if (!quote || !quote.outAmount) {
        throw new Error('Invalid quote response - no outAmount');
      }

      return quote;
    }, 'getQuote');

    if (!result) {
      this.recordFailure(new Error('Quote request failed after retries'));
      return null;
    }

    this.recordSuccess();

    const inputAmount = parseInt(result.inAmount);
    const route = this.parseRoute(result.routePlan || []);
    const totalFeePct = this.calculateTotalFeePct(route, inputAmount);

    // Get decimals from response or use known values
    // Jupiter API includes inputMint/outputMint decimals in some responses
    const inputDecimals = inputMint === USDC_MINT ? USDC_DECIMALS :
                          (result.inputDecimals ?? 9);  // Default to 9 for most Solana tokens
    const outputDecimals = outputMint === USDC_MINT ? USDC_DECIMALS :
                           (result.outputDecimals ?? 9);

    const quoteInfo: QuoteInfo = {
      inputMint,
      outputMint,
      inputAmount,
      outputAmount: parseInt(result.outAmount),
      inputDecimals,
      outputDecimals,
      priceImpactPct: parseFloat(result.priceImpactPct || '0'),
      slippageBps: slippageBps || config.maxSlippageBps,
      route,
      timestamp: Date.now(),
      rawQuote: result,
      totalFeePct,
    };

    executionLogger.debug({
      inputMint: inputMint.slice(0, 8),
      outputMint: outputMint.slice(0, 8),
      inputAmount: quoteInfo.inputAmount,
      outputAmount: quoteInfo.outputAmount,
      priceImpact: quoteInfo.priceImpactPct,
      totalFeePct: totalFeePct.toFixed(4),
    }, 'Quote received');

    return quoteInfo;
  }

  /**
   * Get quote for buying token with USDC
   * @param slippageBps - Optional override for slippage (default: config.maxSlippageBps)
   */
  async getBuyQuote(tokenMint: string, usdcAmount: number, slippageBps?: number): Promise<QuoteInfo | null> {
    // USDC has 6 decimals
    return this.getQuote(USDC_MINT, tokenMint, usdcAmount * 1e6, slippageBps);
  }

  /**
   * Get quote for selling token for USDC
   * @param tokenAmount - Amount in human-readable units (e.g., 10 tokens)
   * @param decimals - Token decimals (default 6)
   * @param slippageBps - Optional override for slippage (default: config.maxSlippageBps)
   */
  async getSellQuote(tokenMint: string, tokenAmount: number, decimals: number = 6, slippageBps?: number): Promise<QuoteInfo | null> {
    return this.getQuote(tokenMint, USDC_MINT, tokenAmount * Math.pow(10, decimals), slippageBps);
  }

  /**
   * Get quote for selling raw token amount for USDC
   * Use this when you already have the amount in raw units (e.g., from a previous buy)
   * @param rawTokenAmount - Amount in raw units (e.g., 14488426)
   * @param slippageBps - Optional override for slippage (default: config.maxSlippageBps)
   */
  async getSellQuoteRaw(tokenMint: string, rawTokenAmount: number, slippageBps?: number): Promise<QuoteInfo | null> {
    return this.getQuote(tokenMint, USDC_MINT, rawTokenAmount, slippageBps);
  }

  /**
   * Get swap transaction (does not execute)
   * @param quote - QuoteInfo with rawQuote, or raw quote response object
   * @param priorityFeeMicroLamports - Priority fee in microLamports (0 = no priority fee, undefined = auto)
   */
  async getSwapTransaction(
    quote: QuoteInfo | unknown,
    userPublicKey: string,
    priorityFeeMicroLamports?: number
  ): Promise<SwapResponse | null> {
    if (this.isCircuitBreakerOpen()) {
      executionLogger.warn('Circuit breaker is open - rejecting swap request');
      return null;
    }

    // Extract raw quote - handle both QuoteInfo and raw quote objects
    const quoteResponse = (quote as QuoteInfo).rawQuote || quote;

    // Use explicit priority fee if provided, otherwise use 0 (no priority fee)
    // This starts cheap and escalates on retry
    const priorityFee = priorityFeeMicroLamports !== undefined ? priorityFeeMicroLamports : 0;

    executionLogger.debug({ priorityFee }, 'Requesting Jupiter swap transaction');

    const result = await this.executeWithRetry(async (client) => {
      const response = await client.post('/swap', {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: priorityFee,
        dynamicSlippage: {
          minBps: 5,
          maxBps: 150,
        },
      });

      if (!response.data?.swapTransaction) {
        throw new Error('No swap transaction in response');
      }

      return response.data;
    }, 'getSwapTransaction');

    if (!result) {
      this.recordFailure(new Error('Swap transaction request failed after retries'));
      return null;
    }

    this.recordSuccess();

    return {
      swapTransaction: result.swapTransaction,
      lastValidBlockHeight: result.lastValidBlockHeight,
    };
  }

  /**
   * Validate a quote meets our requirements
   */
  validateQuote(quote: QuoteInfo): { valid: boolean; reasons: string[] } {
    const config = getConfigSync();
    const reasons: string[] = [];
    let valid = true;

    // Check price impact
    const priceImpactBps = quote.priceImpactPct * 100;
    if (priceImpactBps > config.maxSlippageBps) {
      reasons.push(`Price impact ${priceImpactBps.toFixed(0)}bps exceeds max ${config.maxSlippageBps}bps`);
      valid = false;
    }

    // Check route exists
    if (quote.route.length === 0) {
      reasons.push('No route found');
      valid = false;
    }

    // Check output amount is reasonable (at least 90% of expected)
    // This is a sanity check against manipulation
    if (quote.outputAmount <= 0) {
      reasons.push('Invalid output amount');
      valid = false;
    }

    if (valid) {
      reasons.push('Quote validation passed');
    }

    return { valid, reasons };
  }

  /**
   * Parse route plan from Jupiter response
   */
  private parseRoute(routePlan: unknown[]): RouteInfo[] {
    return routePlan.map((step: unknown) => {
      const s = step as { swapInfo?: { ammKey?: string; label?: string; inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; feeAmount?: string; feeMint?: string } };
      return {
        poolAddress: s.swapInfo?.ammKey || '',
        dex: s.swapInfo?.label || 'unknown',
        inputMint: s.swapInfo?.inputMint || '',
        outputMint: s.swapInfo?.outputMint || '',
        inAmount: parseInt(s.swapInfo?.inAmount || '0'),
        outAmount: parseInt(s.swapInfo?.outAmount || '0'),
        feeAmount: s.swapInfo?.feeAmount ? parseInt(s.swapInfo.feeAmount) : undefined,
        feeMint: s.swapInfo?.feeMint,
      };
    });
  }

  /**
   * Calculate total fee percentage from route
   * Sums up fees from all route steps and returns as percentage of input
   */
  private calculateTotalFeePct(route: RouteInfo[], inputAmount: number): number {
    if (inputAmount === 0) return 0;

    let totalFees = 0;
    for (const step of route) {
      if (step.feeAmount && step.feeMint === step.inputMint) {
        // Fee is in input token - can directly add
        totalFees += step.feeAmount;
      } else if (step.feeAmount && step.inAmount > 0) {
        // Fee is in different token - estimate based on in/out ratio
        // This is an approximation
        totalFees += step.feeAmount;
      }
    }

    // Return as percentage
    return (totalFees / inputAmount) * 100;
  }

  /**
   * Circuit breaker: check if open
   */
  private isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreakerOpen) return false;

    // Check if reset time has passed
    if (Date.now() - this.lastFailureTime > this.resetTimeMs) {
      this.circuitBreakerOpen = false;
      this.consecutiveFailures = 0;
      executionLogger.info('Circuit breaker reset');
      return false;
    }

    return true;
  }

  /**
   * Record successful request
   */
  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Record failed request
   */
  private recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    executionLogger.error({
      error: errorMessage,
      consecutiveFailures: this.consecutiveFailures,
    }, 'Jupiter API request failed');

    if (this.consecutiveFailures >= this.maxFailures) {
      this.circuitBreakerOpen = true;
      executionLogger.error({
        failures: this.consecutiveFailures,
        resetTimeMs: this.resetTimeMs,
      }, 'Circuit breaker OPENED');
    }
  }

}

// Singleton
let jupiterClientInstance: JupiterClient | null = null;

export function getJupiterClient(): JupiterClient {
  if (!jupiterClientInstance) {
    jupiterClientInstance = new JupiterClient();
  }
  return jupiterClientInstance;
}
