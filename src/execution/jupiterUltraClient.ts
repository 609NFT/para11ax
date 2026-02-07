/**
 * Jupiter Ultra API Client
 * Fallback execution path when regular Jupiter Swap API fails
 *
 * Ultra API benefits:
 * - Server-side transaction building (handles complex account discovery)
 * - Predictive execution (simulates before sending)
 * - Jupiter Beam for better landing rates (0-1 blocks)
 * - Fixes issues like Meteora DLMM bitmap extension errors
 */

import axios, { AxiosInstance } from 'axios';
import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { executionLogger } from '../logger';
import { USDC_MINT, USDC_DECIMALS, getSolPriceUsd } from '../constants';
import { TradeResult, FeeBreakdown } from '../types';
import { recordApiCall } from '../feeds/endpointTracker';

const ULTRA_API_URL = 'https://api.jup.ag/ultra/v1';

export interface UltraPlatformFee {
  amount: string;           // Fee amount in smallest units
  feeBps: number;           // Fee in basis points (e.g., 20 = 0.2%)
}

export interface UltraOrderResponse {
  transaction: string;      // Base64 encoded unsigned transaction
  requestId: string;        // Required for execute endpoint
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  swapType: string;
  slippageBps: number;
  priceImpactPct?: string;
  platformFee?: UltraPlatformFee;  // Jupiter platform fee (20 bps = 0.2%)
  totalFeeAmount?: string;         // Total fees deducted
}

export interface UltraExecuteResponse {
  status: 'Success' | 'Failed' | 'Pending';
  signature?: string;
  error?: string;
  slot?: number;
}

// Singleton instance
let ultraClientInstance: JupiterUltraClient | null = null;

export function getJupiterUltraClient(): JupiterUltraClient {
  if (!ultraClientInstance) {
    ultraClientInstance = new JupiterUltraClient();
  }
  return ultraClientInstance;
}

export class JupiterUltraClient {
  private client: AxiosInstance;
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.JUPITER_API_KEY;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    this.client = axios.create({
      baseURL: ULTRA_API_URL,
      timeout: 30000, // Ultra can take longer due to predictive execution
      headers,
    });

    executionLogger.info({
      url: ULTRA_API_URL,
      hasApiKey: !!this.apiKey,
    }, 'JupiterUltraClient initialized');
  }

  /**
   * Get order (quote + unsigned transaction) from Ultra API
   */
  async getOrder(
    inputMint: string,
    outputMint: string,
    amount: number,
    takerWallet: string
  ): Promise<UltraOrderResponse | null> {
    const startTime = Date.now();

    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: Math.floor(amount).toString(),
        taker: takerWallet,
      });

      executionLogger.debug({
        inputMint: inputMint.slice(0, 8),
        outputMint: outputMint.slice(0, 8),
        amount,
        taker: takerWallet.slice(0, 8),
      }, 'Requesting Ultra order');

      const response = await this.client.get(`/order?${params.toString()}`);

      recordApiCall('jupiter-ultra-order', true, Date.now() - startTime);

      if (!response.data?.transaction || !response.data?.requestId) {
        executionLogger.warn({ response: response.data }, 'Invalid Ultra order response');
        return null;
      }

      executionLogger.info({
        requestId: response.data.requestId,
        inAmount: response.data.inAmount,
        outAmount: response.data.outAmount,
        swapType: response.data.swapType,
        slippageBps: response.data.slippageBps,
      }, 'Ultra order received');

      return response.data as UltraOrderResponse;
    } catch (error) {
      recordApiCall('jupiter-ultra-order', false, Date.now() - startTime);
      const errMsg = error instanceof Error ? error.message : String(error);
      executionLogger.error({ error: errMsg }, 'Ultra order request failed');
      return null;
    }
  }

  /**
   * Execute a signed transaction via Ultra API
   * Ultra handles transaction landing with Jupiter Beam
   */
  async execute(
    signedTransaction: string,
    requestId: string
  ): Promise<UltraExecuteResponse | null> {
    const startTime = Date.now();

    try {
      executionLogger.debug({ requestId }, 'Submitting to Ultra execute');

      const response = await this.client.post('/execute', {
        signedTransaction,
        requestId,
      });

      recordApiCall('jupiter-ultra-execute', true, Date.now() - startTime);

      executionLogger.info({
        requestId,
        status: response.data?.status,
        signature: response.data?.signature,
      }, 'Ultra execute response');

      return response.data as UltraExecuteResponse;
    } catch (error) {
      recordApiCall('jupiter-ultra-execute', false, Date.now() - startTime);
      const errMsg = error instanceof Error ? error.message : String(error);
      executionLogger.error({ error: errMsg, requestId }, 'Ultra execute request failed');
      return null;
    }
  }

  /**
   * Poll for transaction status (can retry with same requestId for up to 2 minutes)
   */
  async pollStatus(
    signedTransaction: string,
    requestId: string,
    maxAttempts: number = 10,
    intervalMs: number = 2000
  ): Promise<UltraExecuteResponse | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.execute(signedTransaction, requestId);

      if (!result) {
        executionLogger.warn({ attempt, requestId }, 'Ultra poll returned null');
        continue;
      }

      if (result.status === 'Success') {
        return result;
      }

      if (result.status === 'Failed') {
        executionLogger.warn({
          attempt,
          requestId,
          error: result.error,
        }, 'Ultra transaction failed');
        return result;
      }

      // Status is 'Pending', wait and retry
      if (attempt < maxAttempts) {
        executionLogger.debug({
          attempt,
          maxAttempts,
          requestId,
        }, 'Ultra transaction pending, polling...');
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    executionLogger.warn({ requestId, maxAttempts }, 'Ultra polling timed out');
    return null;
  }

  /**
   * Full swap execution via Ultra API
   * Handles: order -> sign -> execute -> poll
   */
  async executeSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    wallet: Keypair,
    side: 'buy' | 'sell'
  ): Promise<TradeResult> {
    const startTime = Date.now();

    // 1. Get order
    const order = await this.getOrder(
      inputMint,
      outputMint,
      amount,
      wallet.publicKey.toBase58()
    );

    if (!order) {
      return {
        success: false,
        inputAmount: side === 'buy' ? amount / Math.pow(10, USDC_DECIMALS) : amount, // Convert back to human readable for buys
        outputAmount: 0,
        expectedOutput: 0,
        slippageActual: 0,
        error: 'Failed to get Ultra order',
        timestamp: Date.now(),
      };
    }

    // 2. Deserialize and sign transaction
    let signedTxBase64: string;
    try {
      const txBuffer = Buffer.from(order.transaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([wallet]);
      signedTxBase64 = Buffer.from(transaction.serialize()).toString('base64');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      executionLogger.error({ error: errMsg }, 'Failed to sign Ultra transaction');
      return {
        success: false,
        inputAmount: side === 'buy' ? amount / Math.pow(10, USDC_DECIMALS) : amount,
        outputAmount: 0,
        expectedOutput: parseInt(order.outAmount),
        slippageActual: 0,
        error: `Failed to sign transaction: ${errMsg}`,
        timestamp: Date.now(),
      };
    }

    // 3. Execute and poll for result
    const result = await this.pollStatus(signedTxBase64, order.requestId, 15, 2000);

    if (!result) {
      return {
        success: false,
        inputAmount: side === 'buy' ? amount / Math.pow(10, USDC_DECIMALS) : amount,
        outputAmount: 0,
        expectedOutput: parseInt(order.outAmount),
        slippageActual: 0,
        error: 'Ultra execution timed out',
        timestamp: Date.now(),
      };
    }

    if (result.status !== 'Success') {
      return {
        success: false,
        inputAmount: side === 'buy' ? amount / Math.pow(10, USDC_DECIMALS) : amount,
        outputAmount: 0,
        expectedOutput: parseInt(order.outAmount),
        slippageActual: 0,
        error: result.error || 'Ultra execution failed',
        timestamp: Date.now(),
      };
    }

    // Success!
    const inAmount = parseInt(order.inAmount);
    const outAmount = parseInt(order.outAmount);
    const expectedOutput = outAmount;

    // Calculate fees from Ultra response
    const solPriceUsd = await getSolPriceUsd();
    const inputAmountUsd = side === 'buy' ? inAmount / Math.pow(10, USDC_DECIMALS) : 0; // For buys, input is USDC
    const priceImpactPct = order.priceImpactPct ? parseFloat(order.priceImpactPct) : 0;
    const priceImpactUsd = inputAmountUsd * (priceImpactPct / 100);

    // Platform fee (Jupiter takes ~20 bps = 0.2%)
    let platformFeeUsd = 0;
    if (order.platformFee) {
      // Platform fee is in input token units
      const platformFeeRaw = parseInt(order.platformFee.amount);
      platformFeeUsd = side === 'buy' ? platformFeeRaw / Math.pow(10, USDC_DECIMALS) : 0; // USDC decimals
    }

    // Build fee breakdown
    // Note: Ultra handles priority fees and network fees internally (gasless for some routes)
    // We report what we know - platform fee and price impact
    const fees: FeeBreakdown = {
      priorityFeeLamports: 0,           // Ultra handles internally
      priorityFeeUsd: 0,                // Gasless or handled by Ultra
      networkFeeLamports: 0,            // Ultra handles internally
      networkFeeUsd: 0,                 // Gasless or handled by Ultra
      priceImpactPct,
      priceImpactUsd,
      executionSlippagePct: 0,          // Ultra uses predictive execution
      executionSlippageUsd: 0,
      platformFeeUsd,                   // Jupiter Ultra platform fee (20 bps)
      totalFeeUsd: platformFeeUsd + priceImpactUsd,
      totalFeePct: inputAmountUsd > 0 ? ((platformFeeUsd + priceImpactUsd) / inputAmountUsd) * 100 : 0,
      route: 'jupiter-ultra',           // Track Ultra separately from regular Jupiter
      solPriceUsd,
    };

    executionLogger.info({
      signature: result.signature,
      side,
      inAmount,
      outAmount,
      platformFeeUsd,
      priceImpactPct,
      durationMs: Date.now() - startTime,
    }, 'Ultra swap executed successfully');

    return {
      success: true,
      txSignature: result.signature,
      inputAmount: side === 'buy' ? inAmount / Math.pow(10, USDC_DECIMALS) : inAmount, // USDC decimals for buys
      outputAmount: outAmount,
      expectedOutput,
      slippageActual: 0, // Ultra handles slippage internally with predictive execution
      timestamp: Date.now(),
      fees,
    };
  }

  /**
   * Execute buy via Ultra API (USDC -> Token)
   * @param tokenMint - Output token mint
   * @param usdcAmount - Amount in USDC (human readable, e.g., 10 for $10)
   * @param wallet - Signing wallet
   */
  async executeBuy(
    tokenMint: string,
    usdcAmount: number,
    wallet: Keypair
  ): Promise<TradeResult> {
    // Convert USDC to raw amount (6 decimals)
    const rawAmount = Math.floor(usdcAmount * Math.pow(10, USDC_DECIMALS));

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      usdcAmount,
      rawAmount,
    }, 'Executing Ultra buy');

    return this.executeSwap(USDC_MINT, tokenMint, rawAmount, wallet, 'buy');
  }

  /**
   * Execute sell via Ultra API (Token -> USDC)
   * @param tokenMint - Input token mint
   * @param rawTokenAmount - Amount in raw token units
   * @param wallet - Signing wallet
   */
  async executeSell(
    tokenMint: string,
    rawTokenAmount: number,
    wallet: Keypair
  ): Promise<TradeResult> {
    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      rawTokenAmount,
    }, 'Executing Ultra sell');

    return this.executeSwap(tokenMint, USDC_MINT, rawTokenAmount, wallet, 'sell');
  }
}
