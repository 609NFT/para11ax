/**
 * Raydium CLMM Direct Swap Client
 *
 * Executes swaps directly on Raydium Concentrated Liquidity pools
 * No Jupiter API dependency - pure on-chain execution
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import { Raydium, PoolUtils, TxVersion } from '@raydium-io/raydium-sdk-v2';
import type { ApiV3PoolInfoConcentratedItem, ComputeClmmPoolInfo, ReturnTypeFetchMultiplePoolTickArrays } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { executionLogger } from '../logger';
import { getConnectionManager } from './connectionManager';
import {
  USDC_MINT as USDC_MINT_STRING,
  USDC_DECIMALS,
  SOL_MINT as SOL_MINT_STRING,
  SOL_DECIMALS,
  RAYDIUM_COMPUTE_UNITS,
  PRIORITY_FEE_ESCALATION,
  getSolPriceUsd,
  calculatePriorityFeeUsd,
  calculateNetworkFeeUsd,
} from '../constants';
import { FeeBreakdown } from '../types';
import { sleep } from '../utils/time';

// Convert to PublicKey for Solana operations
const USDC_MINT = new PublicKey(USDC_MINT_STRING);
const SOL_MINT = new PublicKey(SOL_MINT_STRING);

export interface RaydiumSwapResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  outputMint?: string;           // Mint of output token (for SOL vs USDC detection)
  outputAmountUsd?: number;      // Output value in USD (handles SOL conversion)
  error?: string;
  fees?: FeeBreakdown;
}

interface PoolData {
  poolInfo: ApiV3PoolInfoConcentratedItem;
  computePoolInfo: ComputeClmmPoolInfo;
  tickData: ReturnTypeFetchMultiplePoolTickArrays;
  loadedAt: number;
}

// Pool cache TTL - refresh pool data after this time to get fresh quotes
const POOL_CACHE_TTL_MS = 30_000; // 30 seconds

// Default slippage for quotes (1% tolerance)
const DEFAULT_QUOTE_SLIPPAGE = 0.01;

export class RaydiumClient {
  private connection: Connection;
  private raydium: Raydium | null = null;
  private wallet: Keypair | null = null;
  private isInitialized: boolean = false;

  // Pool info cache
  private poolCache: Map<string, PoolData> = new Map();

  // Retry configuration
  private readonly maxSwapRetries = 3;
  private readonly retryDelayMs = 500;

  constructor() {
    // Use connection manager for failover support
    this.connection = getConnectionManager().getConnection();
    executionLogger.info('RaydiumClient created with connection manager');
  }

  /**
   * Initialize with wallet for signing
   */
  async initialize(wallet: Keypair): Promise<boolean> {
    try {
      this.wallet = wallet;

      // Initialize Raydium SDK
      this.raydium = await Raydium.load({
        connection: this.connection,
        owner: wallet,
        disableLoadToken: true, // We don't need full token list
      });

      this.isInitialized = true;
      executionLogger.info({
        wallet: wallet.publicKey.toBase58(),
      }, 'RaydiumClient initialized');

      return true;
    } catch (error) {
      executionLogger.error({ error }, 'Failed to initialize RaydiumClient');
      return false;
    }
  }

  /**
   * Check if client is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.raydium !== null && this.wallet !== null;
  }

  /**
   * Load pool info by pool address - fetches all required data for swaps
   */
  async loadPool(poolAddress: string): Promise<PoolData | null> {
    // Check cache first - with TTL
    const cached = this.poolCache.get(poolAddress);
    if (cached && (Date.now() - cached.loadedAt) < POOL_CACHE_TTL_MS) {
      return cached;
    }

    if (!this.raydium) {
      executionLogger.error('Raydium SDK not initialized');
      return null;
    }

    try {
      // Fetch complete pool info from RPC - this gets everything we need
      // Note: This only works for CLMM pools, not legacy AMM pools
      const data = await this.raydium.clmm.getPoolInfoFromRpc(poolAddress);

      if (data) {
        const poolData: PoolData = {
          poolInfo: data.poolInfo,
          computePoolInfo: data.computePoolInfo,
          tickData: data.tickData,
          loadedAt: Date.now(),
        };

        this.poolCache.set(poolAddress, poolData);
        executionLogger.debug({
          poolAddress,
          mintA: data.poolInfo.mintA.address,
          mintB: data.poolInfo.mintB.address,
          decimalsA: data.poolInfo.mintA.decimals,
          decimalsB: data.poolInfo.mintB.decimals,
          currentPrice: data.poolInfo.price,
        }, 'CLMM pool loaded from RPC');

        return poolData;
      }

      executionLogger.warn({ poolAddress }, 'Pool not found (may be legacy AMM, not CLMM)');
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executionLogger.error({
        poolAddress,
        error: errorMsg,
        hint: 'This may be a legacy AMM pool, not CLMM - our SDK only supports CLMM'
      }, 'Failed to load pool');
      return null;
    }
  }

  /**
   * Get quote for a swap (no execution)
   */
  async getQuote(
    poolAddress: string,
    inputMint: string,
    amountIn: number,
    inputDecimals: number
  ): Promise<{ amountOut: number; priceImpact: number; minAmountOut: number } | null> {
    if (!this.raydium) {
      executionLogger.error('Raydium SDK not initialized');
      return null;
    }

    try {
      const poolData = await this.loadPool(poolAddress);
      if (!poolData) return null;

      // Convert to BN with proper decimals
      const amountInBN = new BN(Math.floor(amountIn * Math.pow(10, inputDecimals)));

      // Get epoch info for fee calculation
      const epochInfo = await this.connection.getEpochInfo();

      // Compute swap output using PoolUtils
      const result = PoolUtils.computeAmountOut({
        poolInfo: poolData.computePoolInfo,
        tickArrayCache: poolData.tickData[poolAddress] || {},
        baseMint: new PublicKey(inputMint),
        epochInfo,
        amountIn: amountInBN,
        slippage: DEFAULT_QUOTE_SLIPPAGE, // 1% for quote
        priceLimit: undefined,
        catchLiquidityInsufficient: false,
      });

      // Determine output decimals based on which token is output
      const inputMintPubkey = new PublicKey(inputMint);
      const isInputA = inputMintPubkey.equals(new PublicKey(poolData.poolInfo.mintA.address));
      const outputDecimals = isInputA ? poolData.poolInfo.mintB.decimals : poolData.poolInfo.mintA.decimals;

      const amountOut = result.amountOut.amount.toNumber() / Math.pow(10, outputDecimals);
      const minAmountOut = result.minAmountOut.amount.toNumber() / Math.pow(10, outputDecimals);

      return {
        amountOut,
        minAmountOut,
        priceImpact: parseFloat(result.priceImpact.toFixed(4)) * 100, // Convert to percentage
      };
    } catch (error) {
      // Extract error message from various error types
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
        // Check for nested cause or logs
        if ('cause' in error && error.cause) {
          errorMessage += ` (cause: ${error.cause})`;
        }
        if ('logs' in error && Array.isArray((error as { logs?: string[] }).logs)) {
          const logs = (error as { logs: string[] }).logs;
          const errorLog = logs.find(l => l.includes('Error') || l.includes('failed') || l.includes('insufficient'));
          if (errorLog) {
            errorMessage += ` (log: ${errorLog})`;
          }
        }
      } else if (typeof error === 'object' && error !== null) {
        const err = error as Record<string, unknown>;
        // Try to extract useful info from complex Raydium/Solana errors
        if (typeof err.message === 'string' && err.message) {
          errorMessage = err.message;
        } else if (typeof err.msg === 'string' && err.msg) {
          errorMessage = err.msg;
        } else if (typeof err.error === 'string' && err.error) {
          errorMessage = err.error;
        } else if (typeof err.name === 'string' && err.name) {
          errorMessage = `${err.name}: ${err.code || 'unknown code'}`;
        } else if (err.logs && Array.isArray(err.logs)) {
          // Extract from transaction logs
          const logs = err.logs as string[];
          const errorLog = logs.find(l => l.includes('Error') || l.includes('failed'));
          errorMessage = errorLog || `Transaction failed (see logs): ${logs.slice(-3).join('; ')}`;
        } else {
          // Try to get something useful - check constructor name and enumerate properties
          const constructorName = (error as object).constructor?.name || 'UnknownError';
          const keys = Object.keys(err);
          if (keys.length > 0) {
            errorMessage = `${constructorName}: ${JSON.stringify(err)}`;
          } else {
            // Object with no enumerable properties - try toString or use constructor name
            const str = String(error);
            errorMessage = str !== '[object Object]' ? str : `${constructorName} (no details available)`;
          }
        }
      } else {
        errorMessage = String(error) || 'Unknown error';
      }
      executionLogger.error({ poolAddress, error: errorMessage }, 'Failed to get quote');
      return null;
    }
  }

  /**
   * Execute a swap on Raydium CLMM with retry logic and dynamic priority fees
   * Starts with 0 priority fee and escalates on each retry
   * @param tokenPriceUsd - Market price of the non-USDC token (for accurate fee calculation)
   *                        For BUY: price of output token. For SELL: price of input token.
   */
  async swap(
    poolAddress: string,
    inputMint: string,
    amountIn: number,
    inputDecimals: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<RaydiumSwapResult> {
    if (!this.raydium || !this.wallet) {
      return {
        success: false,
        inputAmount: amountIn,
        outputAmount: 0,
        error: 'Raydium SDK not initialized',
      };
    }

    let lastError: string = '';

    for (let attempt = 1; attempt <= this.maxSwapRetries; attempt++) {
      // Get priority fee for this attempt (escalates with each retry)
      const priorityFee = PRIORITY_FEE_ESCALATION[Math.min(attempt - 1, PRIORITY_FEE_ESCALATION.length - 1)];

      // Clear pool cache before each attempt to get fresh tick data
      // This helps when liquidity has moved since last fetch
      if (attempt > 1) {
        executionLogger.info({
          poolAddress,
          attempt,
          priorityFee,
          priorityFeeSol: (priorityFee * RAYDIUM_COMPUTE_UNITS / 1_000_000_000_000).toFixed(6),
        }, 'Retrying swap with increased priority fee');
        this.poolCache.delete(poolAddress);
        await sleep(this.retryDelayMs * attempt);
      } else {
        executionLogger.debug({ priorityFee }, 'Starting swap with minimal priority fee');
      }

      const result = await this.swapOnce(poolAddress, inputMint, amountIn, inputDecimals, slippageBps, priorityFee, tokenPriceUsd);

      if (result.success) {
        if (attempt > 1) {
          executionLogger.info({
            poolAddress,
            attempt,
            priorityFee,
          }, 'Swap succeeded after retry with increased priority fee');
        }
        return result;
      }

      lastError = result.error || 'Unknown error';

      // Check if error is retryable
      // - Custom:1, 6024 = slippage/liquidity issue
      // - timeout/txId = transaction confirmation timeout (Raydium SDK 60s timeout)
      // - blockhash = expired blockhash
      const isRetryable = lastError.includes('Custom') ||
                          lastError.includes('slippage') ||
                          lastError.includes('insufficient') ||
                          lastError.includes('6024') ||
                          lastError.includes('timeout') ||
                          lastError.includes('Timeout') ||
                          lastError.includes('txId') ||  // Raydium timeout error has txId field
                          lastError.includes('blockhash') ||
                          lastError.includes('BlockhashNotFound');

      if (!isRetryable) {
        executionLogger.warn({ poolAddress, error: lastError }, 'Non-retryable Raydium error');
        return result;
      }

      if (attempt < this.maxSwapRetries) {
        const nextPriorityFee = PRIORITY_FEE_ESCALATION[Math.min(attempt, PRIORITY_FEE_ESCALATION.length - 1)];
        executionLogger.warn({
          poolAddress,
          attempt,
          maxRetries: this.maxSwapRetries,
          currentPriorityFee: priorityFee,
          nextPriorityFee,
          error: lastError,
        }, 'Raydium swap failed, will retry with higher priority fee');
      }
    }

    return {
      success: false,
      inputAmount: amountIn,
      outputAmount: 0,
      error: `Failed after ${this.maxSwapRetries} attempts: ${lastError}`,
    };
  }

  /**
   * Execute a single swap attempt
   * @param tokenPriceUsd - Market price of the non-USDC token for accurate fee calculation
   */
  private async swapOnce(
    poolAddress: string,
    inputMint: string,
    amountIn: number,
    inputDecimals: number,
    slippageBps: number,
    priorityFee: number = 0,
    tokenPriceUsd?: number
  ): Promise<RaydiumSwapResult> {
    try {
      const poolData = await this.loadPool(poolAddress);
      if (!poolData) {
        return {
          success: false,
          inputAmount: amountIn,
          outputAmount: 0,
          error: 'Pool not found',
        };
      }

      // Convert to BN with proper decimals
      const amountInBN = new BN(Math.floor(amountIn * Math.pow(10, inputDecimals)));
      const slippage = slippageBps / 10000; // Convert bps to decimal

      // Get epoch info
      const epochInfo = await this.connection.getEpochInfo();

      // Compute swap output to get remainingAccounts and amountOutMin
      const computeResult = PoolUtils.computeAmountOut({
        poolInfo: poolData.computePoolInfo,
        tickArrayCache: poolData.tickData[poolAddress] || {},
        baseMint: new PublicKey(inputMint),
        epochInfo,
        amountIn: amountInBN,
        slippage,
        priceLimit: undefined,
        catchLiquidityInsufficient: false,
      });

      // Determine output info
      const inputMintPubkey = new PublicKey(inputMint);
      const isInputA = inputMintPubkey.equals(new PublicKey(poolData.poolInfo.mintA.address));
      const outputDecimals = isInputA ? poolData.poolInfo.mintB.decimals : poolData.poolInfo.mintA.decimals;

      executionLogger.info({
        poolAddress,
        inputMint: inputMint.slice(0, 8),
        amountIn,
        slippageBps,
        expectedOut: computeResult.amountOut.amount.toNumber() / Math.pow(10, outputDecimals),
        minOut: computeResult.minAmountOut.amount.toNumber() / Math.pow(10, outputDecimals),
        tokenPriceUsd,
      }, 'Executing Raydium CLMM swap');

      // Build swap transaction with dynamic priority fee (escalates on retry)
      // associatedOnly: false allows SDK to create ATAs if they don't exist
      // checkCreateATAOwner: true ensures ATAs are owned by the correct owner
      const { execute } = await this.raydium!.clmm.swap({
        poolInfo: poolData.poolInfo,
        inputMint: inputMintPubkey,
        amountIn: amountInBN,
        amountOutMin: computeResult.minAmountOut.amount,
        observationId: new PublicKey(poolData.computePoolInfo.observationId),
        ownerInfo: {
          useSOLBalance: false,
        },
        remainingAccounts: computeResult.remainingAccounts,
        associatedOnly: false,  // Allow creating ATAs for output tokens if they don't exist
        checkCreateATAOwner: true,  // Verify ATA ownership
        txVersion: TxVersion.V0,
        computeBudgetConfig: {
          units: RAYDIUM_COMPUTE_UNITS,
          microLamports: priorityFee,
        },
      });

      // Get output token balance BEFORE swap for accurate calculation
      // Use getParsedTokenAccountsByOwner to support both SPL Token and Token-2022
      const outputMint = isInputA
        ? new PublicKey(poolData.poolInfo.mintB.address)
        : new PublicKey(poolData.poolInfo.mintA.address);

      const preSwapBalance = await this.getTokenBalanceRaw(outputMint);

      // Execute the swap
      const txResult = await execute({ sendAndConfirm: true });
      const txSignature = txResult.txId;

      // Get actual output amount from balance change (more accurate than estimate)
      let actualOutputAmount: number;
      const postSwapBalance = await this.getTokenBalanceRaw(outputMint);

      if (preSwapBalance !== null && postSwapBalance !== null) {
        actualOutputAmount = (postSwapBalance - preSwapBalance) / Math.pow(10, outputDecimals);
        executionLogger.debug({
          outputMint: outputMint.toBase58().slice(0, 8),
          preSwapBalance,
          postSwapBalance,
          actualOutputAmount,
        }, 'Measured actual output from balance change');
      } else {
        // Fall back to estimated amount if we can't read balance
        actualOutputAmount = computeResult.amountOut.amount.toNumber() / Math.pow(10, outputDecimals);
        executionLogger.warn({
          preSwapBalance,
          postSwapBalance,
          estimatedOutput: actualOutputAmount,
        }, 'Could not measure balance change, using estimated output');
      }

      // Calculate fees
      const solPriceUsd = await getSolPriceUsd();
      const priorityFeeCalc = calculatePriorityFeeUsd(priorityFee, RAYDIUM_COMPUTE_UNITS, solPriceUsd);
      const networkFeeCalc = calculateNetworkFeeUsd(solPriceUsd);

      // Determine if this is a BUY (input is USDC) or SELL (output is USDC)
      const isInputUsdc = inputMintPubkey.equals(USDC_MINT);
      const isOutputUsdc = outputMint.equals(USDC_MINT);
      const isInputSol = inputMintPubkey.equals(SOL_MINT);
      const isOutputSol = outputMint.equals(SOL_MINT);

      // Calculate TRUE FEE based on market price (most accurate)
      // For BUY: trueFee = inputUsd - (tokensReceived * tokenPrice)
      // For SELL: trueFee = (tokensSold * tokenPrice) - outputUsd
      let trueFeeUsd: number | undefined;
      let trueFeePct: number | undefined;

      if (tokenPriceUsd && tokenPriceUsd > 0) {
        if (isInputUsdc) {
          // BUY via USDC: we spent USDC, received tokens
          const marketValueReceived = actualOutputAmount * tokenPriceUsd;
          trueFeeUsd = amountIn - marketValueReceived;
          trueFeePct = (trueFeeUsd / amountIn) * 100;
        } else if (isOutputUsdc) {
          // SELL via USDC: we sold tokens, received USDC
          const marketValueSold = amountIn * tokenPriceUsd;
          trueFeeUsd = marketValueSold - actualOutputAmount;
          trueFeePct = (trueFeeUsd / marketValueSold) * 100;
        } else if (isInputSol && solPriceUsd > 0) {
          // BUY via SOL: we spent SOL, received tokens
          const inputValueUsd = amountIn * solPriceUsd;
          const marketValueReceived = actualOutputAmount * tokenPriceUsd;
          trueFeeUsd = inputValueUsd - marketValueReceived;
          trueFeePct = inputValueUsd > 0 ? (trueFeeUsd / inputValueUsd) * 100 : 0;
        } else if (isOutputSol && solPriceUsd > 0) {
          // SELL via SOL: we sold tokens, received SOL
          const marketValueSold = amountIn * tokenPriceUsd;
          const outputValueUsd = actualOutputAmount * solPriceUsd;
          trueFeeUsd = marketValueSold - outputValueUsd;
          trueFeePct = marketValueSold > 0 ? (trueFeeUsd / marketValueSold) * 100 : 0;
        }
      }

      // Calculate execution slippage (legacy - for backwards compatibility)
      const expectedOutputAmount = computeResult.amountOut.amount.toNumber() / Math.pow(10, outputDecimals);
      const executionSlippagePct = expectedOutputAmount > 0
        ? ((expectedOutputAmount - actualOutputAmount) / expectedOutputAmount) * 100
        : 0;

      // Determine trade size in USD for percentage calculations
      // For USDC pools: use USDC amounts directly
      // For SOL pools: convert to USD using SOL price
      let tradeSizeUsd: number;
      if (isOutputUsdc) {
        tradeSizeUsd = actualOutputAmount;  // SELL: USDC output
      } else if (isInputUsdc) {
        tradeSizeUsd = amountIn;  // BUY via USDC: USDC input
      } else if (isInputSol && solPriceUsd > 0) {
        tradeSizeUsd = amountIn * solPriceUsd;  // BUY via SOL: convert SOL to USD
      } else if (isOutputSol && solPriceUsd > 0) {
        tradeSizeUsd = actualOutputAmount * solPriceUsd;  // SELL via SOL: convert SOL to USD
      } else {
        // Fallback: use input amount (may not be accurate for non-USD assets)
        tradeSizeUsd = amountIn;
      }

      const executionSlippageUsd = Math.abs(expectedOutputAmount - actualOutputAmount) * (isOutputUsdc ? 1 : tradeSizeUsd / amountIn);

      // Raydium pool fee (from pool config) - typically 0.01% to 1%
      const poolFeePct = poolData.poolInfo.config?.tradeFeeRate
        ? poolData.poolInfo.config.tradeFeeRate / 10000
        : 0.25;
      const priceImpactUsd = tradeSizeUsd * (poolFeePct / 100);

      // Total fees (legacy calculation for backwards compatibility)
      const totalFeeUsd = priorityFeeCalc.usd + networkFeeCalc.usd + executionSlippageUsd + priceImpactUsd;
      const totalFeePct = tradeSizeUsd > 0 ? (totalFeeUsd / tradeSizeUsd) * 100 : 0;

      const fees: FeeBreakdown = {
        priorityFeeLamports: priorityFeeCalc.lamports,
        priorityFeeUsd: priorityFeeCalc.usd,
        networkFeeLamports: networkFeeCalc.lamports,
        networkFeeUsd: networkFeeCalc.usd,
        priceImpactPct: poolFeePct,
        priceImpactUsd,
        executionSlippagePct: Math.max(0, executionSlippagePct),
        executionSlippageUsd: Math.max(0, executionSlippageUsd),
        // TRUE FEE - the actual all-in cost of the swap (can be negative for favorable execution)
        trueFeeUsd: trueFeeUsd,
        trueFeePct: trueFeePct,
        // Legacy totals (kept for backwards compatibility, but trueFeeUsd is more accurate)
        totalFeeUsd: trueFeeUsd !== undefined ? trueFeeUsd : totalFeeUsd,
        totalFeePct: trueFeePct !== undefined ? trueFeePct : totalFeePct,
        route: 'raydium',
        computeUnitsUsed: RAYDIUM_COMPUTE_UNITS,
        solPriceUsd,
      };

      executionLogger.info({
        txSignature,
        inputAmount: amountIn,
        outputAmount: actualOutputAmount,
        estimatedOutput: expectedOutputAmount,
        tokenPriceUsd,
        fees: {
          priorityFeeUsd: fees.priorityFeeUsd.toFixed(6),
          networkFeeUsd: fees.networkFeeUsd.toFixed(6),
          legacySlippageUsd: executionSlippageUsd.toFixed(4),
          poolFeePct: poolFeePct.toFixed(4),
          trueFeeUsd: fees.trueFeeUsd?.toFixed(4) ?? 'N/A',
          trueFeePct: fees.trueFeePct?.toFixed(4) ?? 'N/A',
          totalFeeUsd: fees.totalFeeUsd.toFixed(4),
        },
      }, 'Raydium swap executed successfully with TRUE fee tracking');

      return {
        success: true,
        txSignature,
        inputAmount: amountIn,
        outputAmount: actualOutputAmount,
        outputMint: outputMint.toBase58(),
        outputAmountUsd: tradeSizeUsd,  // USD value of output (handles SOL conversion)
        fees,
      };
    } catch (error) {
      // Handle various error types for better logging
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
        // Check for nested error details (common in Solana/Raydium errors)
        if ('logs' in error && Array.isArray((error as { logs?: string[] }).logs)) {
          const logs = (error as { logs: string[] }).logs;
          executionLogger.error({ poolAddress, logs: logs.slice(-10) }, 'Raydium swap error logs');
        }
      } else if (typeof error === 'object' && error !== null) {
        // Try to extract useful info from complex Solana/Raydium errors
        const err = error as Record<string, unknown>;
        // Check each property explicitly to avoid "undefined" string
        if (typeof err.message === 'string' && err.message) {
          errorMessage = err.message;
        } else if (typeof err.msg === 'string' && err.msg) {
          errorMessage = err.msg;
        } else if (typeof err.error === 'string' && err.error) {
          errorMessage = err.error;
        } else if (err.logs && Array.isArray(err.logs)) {
          // Extract error from transaction logs
          const logs = err.logs as string[];
          const errorLog = logs.find(l => l.includes('Error') || l.includes('failed'));
          errorMessage = errorLog || `Transaction failed (see logs): ${logs.slice(-3).join('; ')}`;
          executionLogger.error({ poolAddress, logs: logs.slice(-10) }, 'Raydium swap error logs');
        } else {
          // Last resort: stringify the whole object
          try {
            errorMessage = JSON.stringify(error, null, 2);
          } catch (stringifyError) {
            executionLogger.warn({ stringifyError: stringifyError instanceof Error ? stringifyError.message : String(stringifyError) }, 'Failed to stringify error object');
            errorMessage = `Unknown error object: ${Object.keys(error).join(', ')}`;
          }
        }
      } else {
        errorMessage = String(error) || 'Unknown error';
      }
      executionLogger.error({ poolAddress, error: errorMessage, errorType: typeof error }, 'Raydium swap failed');

      return {
        success: false,
        inputAmount: amountIn,
        outputAmount: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Get raw token balance (in smallest units) using getParsedTokenAccountsByOwner
   * This supports both SPL Token and Token-2022 programs
   */

  /**
   * Get raw token balance (in smallest units) using getParsedTokenAccountsByOwner
   * This supports both SPL Token and Token-2022 programs
   * Returns null on error, 0 if no accounts found
   */
  private async getTokenBalanceRaw(mint: PublicKey): Promise<number | null> {
    if (!this.wallet) return null;

    try {
      const response = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint }
      );

      if (response?.value?.length > 0) {
        let totalBalance = 0;
        for (const account of response.value) {
          const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
          if (amount) {
            totalBalance += Number(amount);
          }
        }
        return totalBalance;
      }
      return 0;
    } catch (error) {
      executionLogger.debug({ mint: mint.toBase58(), error }, 'Error fetching token balance');
      return null;
    }
  }

  /**
   * Buy token with USDC
   * @param poolAddress - Raydium CLMM pool address
   * @param _tokenMint - Token mint to buy (unused but kept for API compatibility)
   * @param usdcAmount - Amount of USDC to spend
   * @param slippageBps - Slippage tolerance in basis points
   * @param tokenPriceUsd - Current market price of output token (for accurate fee calculation)
   */
  async buy(
    poolAddress: string,
    _tokenMint: string,
    usdcAmount: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<RaydiumSwapResult> {
    return this.swap(
      poolAddress,
      USDC_MINT.toBase58(),
      usdcAmount,
      USDC_DECIMALS,
      slippageBps,
      tokenPriceUsd
    );
  }

  /**
   * Buy token with SOL
   * Used when SOL pools have better liquidity than USDC pools
   * @param poolAddress - Raydium CLMM pool address (TOKEN/SOL pair)
   * @param _tokenMint - Token mint to buy (unused but kept for API compatibility)
   * @param solAmount - Amount of SOL to spend
   * @param slippageBps - Slippage tolerance in basis points
   * @param tokenPriceUsd - Current market price of output token (for accurate fee calculation)
   */
  async buyWithSol(
    poolAddress: string,
    _tokenMint: string,
    solAmount: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<RaydiumSwapResult> {
    return this.swap(
      poolAddress,
      SOL_MINT.toBase58(),
      solAmount,
      SOL_DECIMALS,
      slippageBps,
      tokenPriceUsd
    );
  }

  /**
   * Sell token for USDC
   * @param poolAddress - Raydium CLMM pool address
   * @param tokenMint - Token mint to sell
   * @param tokenAmount - Amount of tokens to sell
   * @param tokenDecimals - Decimals of the token
   * @param slippageBps - Slippage tolerance in basis points
   * @param tokenPriceUsd - Current market price of input token (for accurate fee calculation)
   */
  async sell(
    poolAddress: string,
    tokenMint: string,
    tokenAmount: number,
    tokenDecimals: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<RaydiumSwapResult> {
    return this.swap(
      poolAddress,
      tokenMint,
      tokenAmount,
      tokenDecimals,
      slippageBps,
      tokenPriceUsd
    );
  }

  /**
   * Get pool liquidity in USD
   * Returns TVL (total value locked) from the pool
   */
  async getPoolLiquidity(poolAddress: string): Promise<number> {
    try {
      const poolData = await this.loadPool(poolAddress);
      if (!poolData) return 0;

      // Get TVL from pool info - Raydium provides this directly
      // tvl is the total value locked in USD
      const tvl = poolData.poolInfo.tvl || 0;

      executionLogger.debug({
        poolAddress: poolAddress.slice(0, 8),
        tvl,
      }, 'Pool liquidity fetched from Raydium');

      return tvl;
    } catch (error) {
      executionLogger.debug({ poolAddress, error }, 'Failed to get pool liquidity');
      return 0;
    }
  }
}

// Singleton
let raydiumClientInstance: RaydiumClient | null = null;

export function getRaydiumClient(): RaydiumClient {
  if (!raydiumClientInstance) {
    raydiumClientInstance = new RaydiumClient();
  }
  return raydiumClientInstance;
}
