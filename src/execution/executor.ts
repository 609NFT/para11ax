/**
 * Trade Executor
 * Handles actual trade execution on Solana
 *
 * WALLET SAFETY:
 * - Read-only mode by default
 * - No signing unless LIVE_TRADING=true
 * - Hot wallet contains only trading capital
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionConfirmationStrategy,
  PublicKey,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';

import { TradeResult, QuoteInfo, FeeBreakdown } from '../types';
import {
  USDC_MINT as USDC_MINT_STRING,
  USDC_DECIMALS,
  SOL_MINT as SOL_MINT_STRING,
  PRIORITY_FEE_ESCALATION,
  JUPITER_COMPUTE_UNITS,
  getSolPriceUsd,
  calculatePriorityFeeUsd,
  calculateNetworkFeeUsd,
} from '../constants';

// Convert to PublicKey for Solana operations
const USDC_MINT = new PublicKey(USDC_MINT_STRING);
import { executionLogger, logTrade } from '../logger';
import { getConfigSync } from '../config';
import { getJupiterClient, JupiterClient } from './jupiterClient';
import { getRaydiumClient, RaydiumClient } from './raydiumClient';
import { getConnectionManager } from './connectionManager';
import { getJupiterUltraClient, JupiterUltraClient } from './jupiterUltraClient';

// Error patterns that Ultra API may handle better than regular Swap API
const ULTRA_FALLBACK_ERRORS = [
  'BitmapExtensionAccountIsNotProvided',  // Meteora DLMM bitmap issue
  'Simulation failed',                     // Generic simulation failures
  '6036',                                  // Meteora error code
  '0x1794',                                // Hex version of 6036
  'custom program error',                  // Generic program errors
  'AccountNotFound',                       // Missing account errors
];

export class Executor {
  private connection: Connection;
  private jupiterClient: JupiterClient;
  private jupiterUltraClient: JupiterUltraClient;
  private raydiumClient: RaydiumClient;
  private wallet: Keypair | null = null;
  private isLiveEnabled: boolean = false;
  private raydiumInitialized: boolean = false;

  // Retry configuration
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  // Track repeated balance fetch failures to reduce log noise
  private balanceFetchFailures: Map<string, number> = new Map();

  constructor() {
    const config = getConfigSync();
    // Use connection manager for failover support
    this.connection = getConnectionManager().getConnection();
    this.jupiterClient = getJupiterClient();
    this.jupiterUltraClient = getJupiterUltraClient();
    this.raydiumClient = getRaydiumClient();

    // Only load wallet if live trading is enabled
    this.isLiveEnabled = config.mode === 'live' && process.env.LIVE_TRADING === 'true';

    if (this.isLiveEnabled) {
      this.loadWallet();
    }

    executionLogger.info({
      mode: config.mode,
      liveEnabled: this.isLiveEnabled,
      hasWallet: this.wallet !== null,
    }, 'Executor initialized');
  }

  /**
   * Load wallet from environment (only for live mode)
   */
  private loadWallet(): void {
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey) {
      executionLogger.error('SOLANA_PRIVATE_KEY not set but live trading enabled');
      this.isLiveEnabled = false;
      return;
    }

    try {
      // Try both base58 and JSON array formats
      let secretKey: Uint8Array;
      if (privateKey.startsWith('[')) {
        secretKey = new Uint8Array(JSON.parse(privateKey));
      } else {
        secretKey = bs58.decode(privateKey);
      }
      this.wallet = Keypair.fromSecretKey(secretKey);
      executionLogger.info({
        publicKey: this.wallet.publicKey.toBase58(),
      }, 'Wallet loaded for live trading');

      // Initialize Raydium client with wallet
      this.initializeRaydium();
    } catch (error) {
      executionLogger.error({ error }, 'Failed to load wallet');
      this.isLiveEnabled = false;
    }
  }

  /**
   * Initialize Raydium client (async, runs in background)
   */
  private async initializeRaydium(): Promise<void> {
    if (!this.wallet) return;

    try {
      const success = await this.raydiumClient.initialize(this.wallet);
      if (success) {
        this.raydiumInitialized = true;
        executionLogger.info('Raydium client initialized for direct swaps');
      }
    } catch (error) {
      executionLogger.warn({ error }, 'Failed to initialize Raydium - will use Jupiter fallback');
    }
  }

  /**
   * Execute a buy trade
   */
  async executeBuy(
    _tokenMint: string,
    usdcAmount: number,
    quote: QuoteInfo
  ): Promise<TradeResult> {
    return this.executeSwap(quote, usdcAmount, 'buy');
  }

  /**
   * Execute a sell trade
   */
  async executeSell(
    _tokenMint: string,
    tokenAmount: number,
    quote: QuoteInfo
  ): Promise<TradeResult> {
    return this.executeSwap(quote, tokenAmount, 'sell');
  }

  /**
   * Core swap execution with retries
   */
  private async executeSwap(
    quote: QuoteInfo,
    amount: number,
    side: 'buy' | 'sell'
  ): Promise<TradeResult> {
    const config = getConfigSync();

    // Validate quote first
    const validation = this.jupiterClient.validateQuote(quote);
    if (!validation.valid) {
      return {
        success: false,
        inputAmount: amount,
        outputAmount: 0,
        expectedOutput: quote.outputAmount,
        slippageActual: 0,
        error: `Quote validation failed: ${validation.reasons.join(', ')}`,
        timestamp: Date.now(),
      };
    }

    // Check mode
    if (config.mode === 'paper') {
      return this.simulateTrade(quote, amount, side);
    }

    // Live mode - must have wallet and be enabled
    if (!this.isLiveEnabled || !this.wallet) {
      return {
        success: false,
        inputAmount: amount,
        outputAmount: 0,
        expectedOutput: quote.outputAmount,
        slippageActual: 0,
        error: 'Live trading not enabled or wallet not loaded',
        timestamp: Date.now(),
      };
    }

    // Execute with retries
    return this.executeWithRetry(quote, amount, side);
  }

  /**
   * Execute trade with retry logic, RPC failover, and dynamic priority fees
   * Starts with 0 priority fee and escalates on each retry
   */
  private async executeWithRetry(
    quote: QuoteInfo,
    amount: number,
    side: 'buy' | 'sell'
  ): Promise<TradeResult> {
    let lastError: Error | null = null;
    const connectionManager = getConnectionManager();

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // Get priority fee for this attempt (escalates with each retry)
      const priorityFee = PRIORITY_FEE_ESCALATION[Math.min(attempt - 1, PRIORITY_FEE_ESCALATION.length - 1)];

      if (attempt > 1) {
        executionLogger.info({
          attempt,
          priorityFee,
          side,
        }, 'Retrying Jupiter swap with increased priority fee');
      }

      try {
        const result = await this.executeOnce(quote, amount, side, priorityFee);
        if (result.success) {
          // Report success to connection manager
          connectionManager.reportSuccess(this.connection);
          if (attempt > 1) {
            executionLogger.info({
              attempt,
              priorityFee,
            }, 'Jupiter swap succeeded after retry with increased priority fee');
          }
          return result;
        }
        lastError = new Error(result.error || 'Unknown error');

        // Check for rate limit error
        if (result.error?.includes('429') || result.error?.includes('Too Many Requests')) {
          connectionManager.reportFailure(this.connection);
          // Switch to next available connection
          this.connection = connectionManager.getConnection();
          executionLogger.info('Switched to next RPC endpoint due to rate limit');
        }
      } catch (error) {
        lastError = error as Error;

        // Check for rate limit error
        if (lastError.message?.includes('429') || lastError.message?.includes('Too Many Requests')) {
          connectionManager.reportFailure(this.connection);
          // Switch to next available connection
          this.connection = connectionManager.getConnection();
          executionLogger.info('Switched to next RPC endpoint due to rate limit');
        }

        const nextPriorityFee = PRIORITY_FEE_ESCALATION[Math.min(attempt, PRIORITY_FEE_ESCALATION.length - 1)];
        executionLogger.warn({
          attempt,
          maxRetries: this.maxRetries,
          currentPriorityFee: priorityFee,
          nextPriorityFee,
          error: lastError.message,
        }, 'Trade attempt failed, will retry with higher priority fee');
      }

      // Wait before retry
      if (attempt < this.maxRetries) {
        await this.delay(this.retryDelayMs * attempt);
      }
    }

    // Check if this error type could be fixed by Ultra API
    const errorMsg = lastError?.message || '';
    const shouldTryUltra = ULTRA_FALLBACK_ERRORS.some(pattern => errorMsg.includes(pattern));

    if (shouldTryUltra && this.wallet) {
      executionLogger.info({
        errorType: errorMsg.slice(0, 100),
        side,
        amount,
        tokenMint: side === 'buy' ? quote.outputMint : quote.inputMint,
      }, 'Jupiter Swap API failed with recoverable error, trying Ultra API fallback');

      try {
        const ultraResult = side === 'buy'
          ? await this.jupiterUltraClient.executeBuy(quote.outputMint, amount, this.wallet)
          : await this.jupiterUltraClient.executeSell(quote.inputMint, amount, this.wallet);

        if (ultraResult.success) {
          executionLogger.info({
            txSignature: ultraResult.txSignature,
            side,
            outputAmount: ultraResult.outputAmount,
          }, 'Ultra API fallback succeeded');
          return ultraResult;
        }

        executionLogger.warn({
          error: ultraResult.error,
          side,
        }, 'Ultra API fallback also failed');

        // Return Ultra's error since it was the last attempt
        return {
          success: false,
          inputAmount: amount,
          outputAmount: 0,
          expectedOutput: quote.outputAmount,
          slippageActual: 0,
          error: `Failed after ${this.maxRetries} attempts + Ultra fallback: ${ultraResult.error}`,
          timestamp: Date.now(),
        };
      } catch (ultraError) {
        const ultraErrMsg = ultraError instanceof Error ? ultraError.message : String(ultraError);
        executionLogger.error({ error: ultraErrMsg }, 'Ultra API fallback threw exception');

        return {
          success: false,
          inputAmount: amount,
          outputAmount: 0,
          expectedOutput: quote.outputAmount,
          slippageActual: 0,
          error: `Failed after ${this.maxRetries} attempts + Ultra fallback: ${ultraErrMsg}`,
          timestamp: Date.now(),
        };
      }
    }

    return {
      success: false,
      inputAmount: amount,
      outputAmount: 0,
      expectedOutput: quote.outputAmount,
      slippageActual: 0,
      error: `Failed after ${this.maxRetries} attempts: ${lastError?.message}`,
      timestamp: Date.now(),
    };
  }

  /**
   * Execute a single trade attempt
   * @param priorityFee - Priority fee in microLamports per compute unit (0 = no priority fee)
   */
  private async executeOnce(
    quote: QuoteInfo,
    amount: number,
    side: 'buy' | 'sell',
    priorityFee: number = 0
  ): Promise<TradeResult> {
    if (!this.wallet) {
      throw new Error('Wallet not available');
    }

    // Get fresh quote for execution
    // For buys: amount is in USDC (human readable)
    // For sells: amount is in raw token units (already multiplied by decimals)
    const freshQuote = side === 'buy'
      ? await this.jupiterClient.getBuyQuote(quote.outputMint, amount)
      : await this.jupiterClient.getSellQuoteRaw(quote.inputMint, amount);

    if (!freshQuote) {
      throw new Error('Failed to get fresh quote');
    }

    // Get swap transaction with dynamic priority fee
    const swapResponse = await this.jupiterClient.getSwapTransaction(
      freshQuote,
      this.wallet.publicKey.toBase58(),
      priorityFee
    );

    if (!swapResponse) {
      throw new Error('Failed to get swap transaction');
    }

    // Deserialize and sign transaction
    const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([this.wallet]);

    // SIMULATE TRANSACTION before sending to verify expected output
    // This gives us confidence the swap will execute as expected
    const outputMintPubkey = new PublicKey(side === 'buy' ? freshQuote.outputMint : USDC_MINT_STRING);
    let simulatedOutputAmount: number | null = null;

    try {
      // Get our output token account address to check simulated balance
      const outputTokenAccount = await getAssociatedTokenAddress(
        outputMintPubkey,
        this.wallet.publicKey
      );

      // Get current balance before simulation for comparison
      let preSimBalance = 0;
      try {
        const accountInfo = await getAccount(this.connection, outputTokenAccount);
        preSimBalance = Number(accountInfo.amount);
      } catch {
        // Account may not exist yet (first buy of this token)
        preSimBalance = 0;
      }

      // Simulate with accounts option to get post-state of our token account
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: 'confirmed',
        replaceRecentBlockhash: true,
        accounts: {
          encoding: 'base64',
          addresses: [outputTokenAccount.toBase58()],
        },
      });

      if (simulation.value.err) {
        const errStr = JSON.stringify(simulation.value.err);
        executionLogger.warn({
          error: errStr,
          logs: simulation.value.logs?.slice(-10),
          side,
          quotedOutput: freshQuote.outputAmount,
        }, 'Transaction simulation failed');
        throw new Error(`Simulation failed: ${errStr}`);
      }

      // Parse the simulated account state to get post-swap balance
      // The accounts array contains base64-encoded account data after simulation
      if (simulation.value.accounts && simulation.value.accounts.length > 0) {
        const accountData = simulation.value.accounts[0];
        if (accountData && accountData.data) {
          // SPL Token account data structure:
          // - bytes 0-31: mint
          // - bytes 32-63: owner
          // - bytes 64-71: amount (u64 little-endian)
          const data = Buffer.from(accountData.data[0], 'base64');
          if (data.length >= 72) {
            const postSimBalance = data.readBigUInt64LE(64);
            simulatedOutputAmount = Number(postSimBalance) - preSimBalance;

            // Compare simulated output vs quoted output
            const quotedOutput = freshQuote.outputAmount;
            const simVsQuoteDiff = ((quotedOutput - simulatedOutputAmount) / quotedOutput) * 100;

            executionLogger.info({
              quotedOutput,
              simulatedOutput: simulatedOutputAmount,
              diffPct: simVsQuoteDiff.toFixed(3),
              preBalance: preSimBalance,
              postBalance: Number(postSimBalance),
            }, 'Simulation balance check');

            // If simulated output is significantly worse than quote, abort
            const maxSimulationDiffPct = 0.5; // 0.5% max difference allowed
            if (simVsQuoteDiff > maxSimulationDiffPct) {
              executionLogger.warn({
                quotedOutput,
                simulatedOutput: simulatedOutputAmount,
                diffPct: simVsQuoteDiff.toFixed(3),
                maxAllowedPct: maxSimulationDiffPct,
                side,
              }, 'Simulation output worse than quote - aborting swap');
              throw new Error(`Simulation output ${simVsQuoteDiff.toFixed(2)}% worse than quote`);
            }
          }
        }
      }

      executionLogger.info({
        unitsConsumed: simulation.value.unitsConsumed,
        simulatedOutput: simulatedOutputAmount,
        quotedOutput: freshQuote.outputAmount,
      }, 'Simulation passed - proceeding with execution');

    } catch (simError) {
      executionLogger.warn({
        error: simError instanceof Error ? simError.message : String(simError),
        side,
        amount,
      }, 'Transaction simulation failed - aborting swap');
      throw new Error(`Simulation failed: ${simError instanceof Error ? simError.message : String(simError)}`);
    }

    // Send transaction (still skip preflight since we already simulated)
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: true,
        maxRetries: 3,
      }
    );

    executionLogger.info({ signature, side, amount }, 'Transaction sent (simulation passed)');

    // Wait for confirmation
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: swapResponse.lastValidBlockHeight,
      } as TransactionConfirmationStrategy,
      'confirmed'
    );

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    // Get actual output amount from transaction
    // Parse the confirmed transaction to get real token balance changes
    let actualOutputAmount = freshQuote.outputAmount; // Fallback to quote
    try {
      const txDetails = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (txDetails?.meta) {
        const outputMint = side === 'buy' ? freshQuote.outputMint : USDC_MINT_STRING;

        // Find the token balance change for our wallet
        const preBalances = txDetails.meta.preTokenBalances || [];
        const postBalances = txDetails.meta.postTokenBalances || [];

        // Find the output token balance change for our wallet
        for (const post of postBalances) {
          if (post.mint === outputMint && post.owner === this.wallet!.publicKey.toBase58()) {
            const pre = preBalances.find(
              p => p.accountIndex === post.accountIndex && p.mint === outputMint
            );
            const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
            const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
            const balanceChange = postAmount - preAmount;

            if (balanceChange > 0) {
              // Convert to raw units for consistency with quote format
              const decimals = post.uiTokenAmount?.decimals ?? 6;
              actualOutputAmount = balanceChange * Math.pow(10, decimals);
              executionLogger.info({
                signature: signature.slice(0, 8),
                side,
                quotedOutput: freshQuote.outputAmount,
                actualOutput: actualOutputAmount,
                diffPct: ((actualOutputAmount - freshQuote.outputAmount) / freshQuote.outputAmount * 100).toFixed(3),
              }, 'Parsed actual output from transaction');
            }
            break;
          }
        }
      }
    } catch (parseError) {
      executionLogger.warn({
        signature: signature.slice(0, 8),
        error: parseError instanceof Error ? parseError.message : String(parseError),
      }, 'Failed to parse transaction for actual output, using quote amount');
    }

    // Calculate fees
    const solPriceUsd = await getSolPriceUsd();
    const priorityFeeCalc = calculatePriorityFeeUsd(priorityFee, JUPITER_COMPUTE_UNITS, solPriceUsd);
    const networkFeeCalc = calculateNetworkFeeUsd(solPriceUsd);

    // Calculate execution slippage in USD using ACTUAL output vs quoted
    // For buys: amount is USDC spent, output is tokens
    // For sells: amount is raw tokens, output is USDC (in lamports)
    const expectedOutputUsd = side === 'buy'
      ? (quote.outputAmount / 1e6) * amount / (quote.inputAmount / 1e6)  // Estimate token value
      : quote.outputAmount / 1e6;  // USDC output
    const realOutputUsd = side === 'buy'
      ? (actualOutputAmount / 1e6) * amount / (freshQuote.inputAmount / 1e6)
      : actualOutputAmount / 1e6;

    const executionSlippagePct = freshQuote.outputAmount > 0
      ? ((freshQuote.outputAmount - actualOutputAmount) / freshQuote.outputAmount) * 100
      : 0;

    // Calculate execution slippage with sanity check
    // Slippage should never exceed the trade size (would mean >100% loss)
    const rawSlippageUsd = Math.abs(expectedOutputUsd - realOutputUsd);
    const tradeSizeUsd = side === 'buy' ? amount : expectedOutputUsd;
    const maxReasonableSlippage = tradeSizeUsd * 1.0; // Cap at 100% of trade size

    const executionSlippageUsd = Math.min(rawSlippageUsd, maxReasonableSlippage);

    if (rawSlippageUsd > maxReasonableSlippage) {
      executionLogger.warn({
        side,
        rawSlippageUsd: rawSlippageUsd.toFixed(2),
        cappedSlippageUsd: executionSlippageUsd.toFixed(2),
        tradeSizeUsd: tradeSizeUsd.toFixed(2),
        expectedOutputUsd: expectedOutputUsd.toFixed(2),
        realOutputUsd: realOutputUsd.toFixed(2),
      }, 'Detected unrealistic slippage value - capping to trade size (likely parsing error)');
    }

    // Price impact from quote (already calculated by Jupiter)
    const priceImpactPct = freshQuote.priceImpactPct;
    const priceImpactUsd = tradeSizeUsd * (priceImpactPct / 100);

    // CRITICAL FIX: Include DEX pool fees from Jupiter quote
    // Jupiter's quote.totalFeePct includes swap fees charged by DEXes (0.25-1.00%)
    // This was previously missing, causing NAV degradation to be unaccounted for
    const platformFeeUsd = freshQuote.totalFeePct
      ? tradeSizeUsd * (freshQuote.totalFeePct / 100)
      : 0;

    // Total fees (NOW INCLUDING PLATFORM/DEX FEES)
    const totalFeeUsd = priorityFeeCalc.usd + networkFeeCalc.usd + executionSlippageUsd + priceImpactUsd + platformFeeUsd;
    const totalFeePct = tradeSizeUsd > 0 ? (totalFeeUsd / tradeSizeUsd) * 100 : 0;

    const fees: FeeBreakdown = {
      priorityFeeLamports: priorityFeeCalc.lamports,
      priorityFeeUsd: priorityFeeCalc.usd,
      networkFeeLamports: networkFeeCalc.lamports,
      networkFeeUsd: networkFeeCalc.usd,
      priceImpactPct,
      priceImpactUsd,
      executionSlippagePct,
      executionSlippageUsd,
      platformFeeUsd,  // NEW: DEX/platform fees from quote
      totalFeeUsd,
      totalFeePct,
      route: 'jupiter',
      computeUnitsUsed: JUPITER_COMPUTE_UNITS,
      solPriceUsd,
    };

    // Log successful trade
    const result: TradeResult = {
      success: true,
      txSignature: signature,
      inputAmount: amount,
      outputAmount: actualOutputAmount,  // Use ACTUAL on-chain output, not quote
      expectedOutput: freshQuote.outputAmount,  // What we expected from quote
      slippageActual: executionSlippagePct,
      timestamp: Date.now(),
      fees,
    };

    logTrade({
      type: 'live_execution',
      side,
      ...result,
      fees: {
        priorityFeeUsd: fees.priorityFeeUsd,
        networkFeeUsd: fees.networkFeeUsd,
        slippageUsd: fees.executionSlippageUsd,
        priceImpactUsd: fees.priceImpactUsd,
        platformFeeUsd: fees.platformFeeUsd,
        totalFeeUsd: fees.totalFeeUsd,
      },
    });

    executionLogger.info({
      signature,
      side,
      inputAmount: amount,
      outputAmount: freshQuote.outputAmount,
      slippageActual: result.slippageActual,
      fees: {
        priorityFeeUsd: fees.priorityFeeUsd.toFixed(6),
        networkFeeUsd: fees.networkFeeUsd.toFixed(6),
        slippageUsd: fees.executionSlippageUsd.toFixed(4),
        priceImpactUsd: fees.priceImpactUsd.toFixed(4),
        platformFeeUsd: (fees.platformFeeUsd || 0).toFixed(4),
        totalFeeUsd: fees.totalFeeUsd.toFixed(4),
        totalFeePct: fees.totalFeePct.toFixed(4),
      },
    }, 'Trade executed successfully with fee tracking');

    return result;
  }

  /**
   * Simulate a trade (for paper/shadow modes)
   */
  private simulateTrade(
    quote: QuoteInfo,
    amount: number,
    _side: 'buy' | 'sell'
  ): TradeResult {
    // Add small random slippage for realism
    const randomSlippage = Math.random() * 0.002; // 0-0.2%
    const simulatedOutput = quote.outputAmount * (1 - randomSlippage);

    return {
      success: true,
      inputAmount: amount,
      outputAmount: simulatedOutput,
      expectedOutput: quote.outputAmount,
      slippageActual: randomSlippage * 100,
      timestamp: Date.now(),
    };
  }

  /**
   * Get wallet balance (SOL + USDC)
   */
  async getBalance(): Promise<{ sol: number; usdc: number } | null> {
    if (!this.wallet) {
      return null;
    }

    try {
      // Get SOL balance
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);

      // Get USDC token account balance
      let usdcBalance = 0;
      try {
        const usdcAta = await getAssociatedTokenAddress(
          USDC_MINT,
          this.wallet.publicKey
        );
        const usdcAccount = await getAccount(this.connection, usdcAta);
        usdcBalance = Number(usdcAccount.amount) / Math.pow(10, USDC_DECIMALS);
      } catch (ataError) {
        // Token account may not exist yet - that's okay, balance is 0
        executionLogger.debug('USDC token account not found or empty');
      }

      return {
        sol: solBalance / 1e9,
        usdc: usdcBalance,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is an RPC failure that should trigger failover
      const isRpcFailure = errorMessage.includes('429') ||
        errorMessage.includes('Too Many Requests') ||
        errorMessage.includes('max usage reached') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('503') ||
        errorMessage.includes('Service Unavailable');

      if (isRpcFailure) {
        const connectionManager = getConnectionManager();
        connectionManager.reportFailure(this.connection);
        // Switch to next available connection
        this.connection = connectionManager.getConnection();
        executionLogger.info({
          error: errorMessage.slice(0, 100),
        }, 'RPC failure in getBalance - switched to next endpoint');
      }

      executionLogger.error({ error }, 'Failed to get balance');
      return null;
    }
  }

  /**
   * Get public key (read-only)
   */
  getPublicKey(): string | null {
    return this.wallet?.publicKey.toBase58() || null;
  }

  /**
   * Get token balance for a specific mint
   * Returns the actual on-chain balance (important for sells to avoid insufficient funds errors)
   * Returns null on errors (not 0) to distinguish from actual zero balance
   * Supports both SPL Token and Token-2022 programs
   */
  async getTokenBalance(tokenMint: string, decimals: number): Promise<number | null> {
    if (!this.wallet) {
      return null;
    }

    try {
      // Use getTokenAccountsByOwner to support both SPL Token and Token-2022
      // (getAssociatedTokenAddress only works for standard SPL Token program)
      const mintPubkey = new PublicKey(tokenMint);

      const response = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: mintPubkey }
      );

      if (response?.value?.length > 0) {
        // Sum all accounts for this mint (usually just one)
        let totalBalance = 0;
        for (const account of response.value) {
          const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
          if (amount) {
            totalBalance += Number(amount);
          }
        }
        // Reset failure count on success
        this.balanceFetchFailures.delete(tokenMint);
        return totalBalance / Math.pow(10, decimals);
      }
      // Reset failure count on success (even if balance is 0)
      this.balanceFetchFailures.delete(tokenMint);
      return 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is an RPC failure that should trigger failover
      // Do NOT trigger failover for validation errors (invalid mint, etc.)
      const isRpcFailure = errorMessage.includes('429') ||
        errorMessage.includes('Too Many Requests') ||
        errorMessage.includes('max usage reached') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('503') ||
        errorMessage.includes('Service Unavailable');

      if (isRpcFailure) {
        const connectionManager = getConnectionManager();
        connectionManager.reportFailure(this.connection);
        // Switch to next available connection
        this.connection = connectionManager.getConnection();

        // Track repeated failures to reduce log noise
        const failCount = (this.balanceFetchFailures.get(tokenMint) || 0) + 1;
        this.balanceFetchFailures.set(tokenMint, failCount);

        // Only log on first failure, then every 10th failure
        if (failCount === 1 || failCount % 10 === 0) {
          executionLogger.info({
            tokenMint: tokenMint.slice(0, 8),
            error: errorMessage.slice(0, 100),
            failCount,
          }, 'RPC failure in getTokenBalance - switched to next endpoint');
        }
      } else {
        // Non-RPC error (validation, etc.) - just track and log
        const failCount = (this.balanceFetchFailures.get(tokenMint) || 0) + 1;
        this.balanceFetchFailures.set(tokenMint, failCount);

        // Only log warning on first failure, then every 10th failure
        if (failCount === 1 || failCount % 10 === 0) {
          executionLogger.warn({ tokenMint, error: errorMessage, failCount }, 'Error fetching token balance - returning null');
        } else {
          executionLogger.debug({ tokenMint, error: errorMessage, failCount }, 'Error fetching token balance - returning null');
        }
      }

      return null;
    }
  }

  /**
   * Get all token balances in the wallet using Helius DAS API
   * Returns array of { mint, symbol, balance, decimals }
   */
  async getAllTokenBalances(): Promise<Array<{ mint: string; symbol: string; balance: number; decimals: number }>> {
    if (!this.wallet) {
      return [];
    }

    const config = getConfigSync();
    const rpcEndpoint = config.rpcEndpoint;

    try {
      // Use Helius DAS API for comprehensive token list
      const response = await fetch(rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'searchAssets',
          params: {
            ownerAddress: this.wallet.publicKey.toBase58(),
            tokenType: 'fungible',
          },
        }),
        signal: AbortSignal.timeout(15000), // 15 second timeout for RPC call
      });

      const data = await response.json() as {
        result?: {
          items?: Array<{
            id: string;
            token_info?: { balance?: number; decimals?: number };
            content?: { metadata?: { symbol?: string } };
          }>;
        };
      };

      if (!data.result?.items) {
        executionLogger.warn('No token data returned from Helius DAS API', { response: JSON.stringify(data) });
        return [];
      }

      const tokens: Array<{ mint: string; symbol: string; balance: number; decimals: number }> = [];

      for (const item of data.result.items) {
        const balance = item.token_info?.balance || 0;
        const decimals = item.token_info?.decimals || 0;
        const mint = item.id;
        const symbol = item.content?.metadata?.symbol || 'UNKNOWN';

        // Only include tokens with non-zero balance
        if (balance > 0) {
          tokens.push({
            mint,
            symbol,
            balance: balance / Math.pow(10, decimals),
            decimals,
          });
        }
      }

      return tokens;
    } catch (error) {
      executionLogger.error({ error }, 'Failed to fetch all token balances');
      return [];
    }
  }

  /**
   * Check if live trading is enabled
   */
  isLive(): boolean {
    return this.isLiveEnabled;
  }

  /**
   * Check if Raydium direct swaps are available
   */
  isRaydiumReady(): boolean {
    return this.raydiumInitialized && this.raydiumClient.isReady();
  }

  /**
   * Get a Raydium sell quote (no execution)
   * Returns the expected USDC output for selling a given amount of tokens
   */
  async getRaydiumSellQuote(
    poolAddress: string,
    tokenMint: string,
    tokenAmount: number,
    tokenDecimals: number
  ): Promise<{ amountOut: number; priceImpact: number } | null> {
    if (!this.isRaydiumReady()) {
      return null;
    }

    const quote = await this.raydiumClient.getQuote(
      poolAddress,
      tokenMint,
      tokenAmount,
      tokenDecimals
    );

    if (!quote) {
      return null;
    }

    // amountOut is in USDC (6 decimals), already converted to human-readable by getQuote
    return {
      amountOut: quote.amountOut,
      priceImpact: quote.priceImpact,
    };
  }

  /**
   * Get a Raydium buy quote (no execution)
   * Returns the expected token output for buying with a given amount of USDC
   */
  async getRaydiumBuyQuote(
    poolAddress: string,
    usdcAmount: number
  ): Promise<{ amountOut: number; priceImpact: number } | null> {
    if (!this.isRaydiumReady()) {
      return null;
    }

    const quote = await this.raydiumClient.getQuote(
      poolAddress,
      USDC_MINT_STRING,
      usdcAmount,
      USDC_DECIMALS
    );

    if (!quote) {
      return null;
    }

    return {
      amountOut: quote.amountOut,
      priceImpact: quote.priceImpact,
    };
  }

  /**
   * Execute buy via Raydium direct (if pool address available)
   * Falls back to Jupiter if Raydium fails
   * @param tokenPriceUsd - Current market price of output token (for accurate fee calculation)
   */
  async executeBuyDirect(
    tokenMint: string,
    poolAddress: string,
    usdcAmount: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<TradeResult> {
    const config = getConfigSync();

    // Paper mode - simulate
    if (config.mode === 'paper') {
      return this.simulateDirectTrade(usdcAmount, 'buy');
    }

    // Check if Raydium is ready
    if (!this.isRaydiumReady()) {
      executionLogger.warn('Raydium not ready, falling back to Jupiter');
      // Fall back to Jupiter
      const quote = await this.jupiterClient.getBuyQuote(tokenMint, usdcAmount, slippageBps);
      if (!quote) {
        return {
          success: false,
          inputAmount: usdcAmount,
          outputAmount: 0,
          expectedOutput: 0,
          slippageActual: 0,
          error: 'Failed to get Jupiter quote',
          timestamp: Date.now(),
        };
      }
      return this.executeBuy(tokenMint, usdcAmount, quote);
    }

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      usdcAmount,
      slippageBps,
      tokenPriceUsd,
    }, 'Executing direct Raydium buy');

    // Execute via Raydium with token price for accurate fee calculation
    const result = await this.raydiumClient.buy(poolAddress, tokenMint, usdcAmount, slippageBps, tokenPriceUsd);

    if (result.success) {
      logTrade({
        type: 'raydium_direct',
        side: 'buy',
        txSignature: result.txSignature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        timestamp: Date.now(),
        fees: result.fees ? {
          priorityFeeUsd: result.fees.priorityFeeUsd,
          networkFeeUsd: result.fees.networkFeeUsd,
          slippageUsd: result.fees.executionSlippageUsd,
          totalFeeUsd: result.fees.totalFeeUsd,
        } : undefined,
      });

      return {
        success: result.success,
        txSignature: result.txSignature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        expectedOutput: result.outputAmount,
        slippageActual: result.fees?.executionSlippagePct ?? 0,
        timestamp: Date.now(),
        fees: result.fees,
      };
    }

    // Raydium failed - fall back to Jupiter
    executionLogger.warn({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      raydiumError: result.error,
    }, 'Raydium buy failed, falling back to Jupiter');

    const quote = await this.jupiterClient.getBuyQuote(tokenMint, usdcAmount, slippageBps);
    if (!quote) {
      return {
        success: false,
        inputAmount: usdcAmount,
        outputAmount: 0,
        expectedOutput: 0,
        slippageActual: 0,
        error: `Raydium failed: ${result.error}; Jupiter quote also failed`,
        timestamp: Date.now(),
      };
    }

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      usdcAmount,
      jupiterOutput: quote.outputAmount,
    }, 'Got Jupiter fallback quote for buy');

    return this.executeBuy(tokenMint, usdcAmount, quote);
  }

  /**
   * Execute buy via Raydium direct with specified quote token (USDC or SOL)
   * For SOL pools: First swaps USDC→SOL, then SOL→TOKEN
   * Falls back to Jupiter if Raydium fails
   * @param tokenPriceUsd - Current market price of output token (for accurate fee calculation)
   */
  async executeBuyWithQuote(
    tokenMint: string,
    poolAddress: string,
    usdcAmount: number,
    quoteToken: 'USDC' | 'SOL',
    _quoteMint: string,  // Reserved for future use (other quote tokens)
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<TradeResult> {
    const config = getConfigSync();

    // Paper mode - simulate
    if (config.mode === 'paper') {
      return this.simulateDirectTrade(usdcAmount, 'buy');
    }

    // If quote token is USDC, use the standard buy method
    if (quoteToken === 'USDC') {
      return this.executeBuyDirect(tokenMint, poolAddress, usdcAmount, slippageBps, tokenPriceUsd);
    }

    // SOL pool: swap SOL → TOKEN directly (single hop using existing SOL balance)
    // Check if Raydium is ready
    if (!this.isRaydiumReady()) {
      executionLogger.warn('Raydium not ready for SOL swap, falling back to Jupiter');
      // Fall back to Jupiter which will handle the routing
      const quote = await this.jupiterClient.getBuyQuote(tokenMint, usdcAmount, slippageBps);
      if (!quote) {
        return {
          success: false,
          inputAmount: usdcAmount,
          outputAmount: 0,
          expectedOutput: 0,
          slippageActual: 0,
          error: 'Failed to get Jupiter quote for SOL routing',
          timestamp: Date.now(),
        };
      }
      return this.executeBuy(tokenMint, usdcAmount, quote);
    }

    // Get current SOL price to calculate how much SOL we need for the USD amount
    const solPriceQuote = await this.jupiterClient.getBuyQuote(SOL_MINT_STRING, 1, 50); // $1 worth of SOL
    if (!solPriceQuote) {
      executionLogger.warn('Failed to get SOL price, falling back to Jupiter');
      const quote = await this.jupiterClient.getBuyQuote(tokenMint, usdcAmount, slippageBps);
      if (!quote) {
        return {
          success: false,
          inputAmount: usdcAmount,
          outputAmount: 0,
          expectedOutput: 0,
          slippageActual: 0,
          error: 'Failed to get Jupiter quote',
          timestamp: Date.now(),
        };
      }
      return this.executeBuy(tokenMint, usdcAmount, quote);
    }

    // Calculate SOL amount: outputAmount is in lamports for $1, so (output/1e9) SOL per $1
    const solPerUsd = solPriceQuote.outputAmount / 1e9;
    const solAmount = usdcAmount * solPerUsd;

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      usdcEquivalent: usdcAmount,
      solAmount: solAmount.toFixed(6),
      solPerUsd: solPerUsd.toFixed(6),
      quoteToken,
      slippageBps,
      tokenPriceUsd,
    }, 'Executing direct SOL → TOKEN buy (single hop)');

    // Direct SOL → TOKEN via Raydium with token price for accurate fee calculation
    const tokenResult = await this.raydiumClient.buyWithSol(
      poolAddress,
      tokenMint,
      solAmount,
      slippageBps,
      tokenPriceUsd
    );

    if (tokenResult.success) {
      logTrade({
        type: 'raydium_sol_direct',
        side: 'buy',
        txSignature: tokenResult.txSignature,
        inputSOL: solAmount,
        inputUsdEquivalent: usdcAmount,
        outputAmount: tokenResult.outputAmount,
        timestamp: Date.now(),
        fees: tokenResult.fees ? {
          trueFeeUsd: tokenResult.fees.trueFeeUsd,
          totalFeeUsd: tokenResult.fees.totalFeeUsd,
        } : undefined,
      });

      executionLogger.info({
        solSpent: solAmount.toFixed(6),
        tokenReceived: tokenResult.outputAmount,
        trueFeeUsd: tokenResult.fees?.trueFeeUsd?.toFixed(4),
      }, 'SOL → TOKEN complete (single hop)');

      return {
        success: tokenResult.success,
        txSignature: tokenResult.txSignature,
        inputAmount: usdcAmount,
        outputAmount: tokenResult.outputAmount,
        expectedOutput: tokenResult.outputAmount,
        slippageActual: tokenResult.fees?.executionSlippagePct ?? 0,
        timestamp: Date.now(),
        fees: tokenResult.fees,
      };
    }

    // Raydium SOL swap failed - fall back to Jupiter (which has Ultra fallback)
    executionLogger.warn({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      raydiumError: tokenResult.error,
      quoteToken,
    }, 'Raydium SOL buy failed, falling back to Jupiter');

    const quote = await this.jupiterClient.getBuyQuote(tokenMint, usdcAmount, slippageBps);
    if (!quote) {
      return {
        success: false,
        inputAmount: usdcAmount,
        outputAmount: 0,
        expectedOutput: 0,
        slippageActual: 0,
        error: `Raydium SOL failed: ${tokenResult.error}; Jupiter quote also failed`,
        timestamp: Date.now(),
      };
    }

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      usdcAmount,
      jupiterOutput: quote.outputAmount,
    }, 'Got Jupiter fallback quote for SOL pool buy');

    return this.executeBuy(tokenMint, usdcAmount, quote);
  }

  /**
   * Execute sell via Raydium direct (if pool address available)
   * Falls back to Jupiter if Raydium fails
   * @param tokenPriceUsd - Current market price of input token (for accurate fee calculation)
   */
  async executeSellDirect(
    tokenMint: string,
    poolAddress: string,
    tokenAmount: number,
    tokenDecimals: number,
    slippageBps: number = 100,
    tokenPriceUsd?: number
  ): Promise<TradeResult> {
    const config = getConfigSync();

    // Paper mode - simulate
    if (config.mode === 'paper') {
      return this.simulateDirectTrade(tokenAmount, 'sell');
    }

    // Check if Raydium is ready
    if (!this.isRaydiumReady()) {
      executionLogger.warn('Raydium not ready, falling back to Jupiter');
      // Fall back to Jupiter
      const rawAmount = tokenAmount * Math.pow(10, tokenDecimals);
      const quote = await this.jupiterClient.getSellQuoteRaw(tokenMint, rawAmount, slippageBps);
      if (!quote) {
        return {
          success: false,
          inputAmount: tokenAmount,
          outputAmount: 0,
          expectedOutput: 0,
          slippageActual: 0,
          error: 'Failed to get Jupiter quote',
          timestamp: Date.now(),
        };
      }
      return this.executeSell(tokenMint, rawAmount, quote);
    }

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      tokenAmount,
      tokenDecimals,
      slippageBps,
      tokenPriceUsd,
    }, 'Executing direct Raydium sell');

    // Execute via Raydium with token price for accurate fee calculation
    const result = await this.raydiumClient.sell(poolAddress, tokenMint, tokenAmount, tokenDecimals, slippageBps, tokenPriceUsd);

    if (result.success) {
      logTrade({
        type: 'raydium_direct',
        side: 'sell',
        txSignature: result.txSignature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        timestamp: Date.now(),
        fees: result.fees ? {
          priorityFeeUsd: result.fees.priorityFeeUsd,
          networkFeeUsd: result.fees.networkFeeUsd,
          slippageUsd: result.fees.executionSlippageUsd,
          totalFeeUsd: result.fees.totalFeeUsd,
        } : undefined,
      });

      return {
        success: result.success,
        txSignature: result.txSignature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        expectedOutput: result.outputAmount,
        slippageActual: result.fees?.executionSlippagePct ?? 0,
        timestamp: Date.now(),
        fees: result.fees,
      };
    }

    // Raydium failed - fall back to Jupiter
    executionLogger.warn({
      tokenMint: tokenMint.slice(0, 8),
      poolAddress: poolAddress.slice(0, 8),
      raydiumError: result.error,
    }, 'Raydium sell failed, falling back to Jupiter');

    const rawAmount = tokenAmount * Math.pow(10, tokenDecimals);
    const quote = await this.jupiterClient.getSellQuoteRaw(tokenMint, rawAmount, slippageBps);
    if (!quote) {
      return {
        success: false,
        inputAmount: tokenAmount,
        outputAmount: 0,
        expectedOutput: 0,
        slippageActual: 0,
        error: `Raydium failed: ${result.error}; Jupiter quote also failed`,
        timestamp: Date.now(),
      };
    }

    executionLogger.info({
      tokenMint: tokenMint.slice(0, 8),
      rawAmount,
      jupiterOutput: quote.outputAmount,
    }, 'Got Jupiter fallback quote for sell');

    return this.executeSell(tokenMint, rawAmount, quote);
  }

  /**
   * Simulate direct trade for paper mode
   */
  private simulateDirectTrade(amount: number, side: 'buy' | 'sell'): TradeResult {
    // Simple simulation - assume 0.1% slippage
    const slippage = 0.001;
    const outputAmount = side === 'buy'
      ? amount * (1 - slippage)  // Slightly less tokens for buy
      : amount * (1 - slippage); // Slightly less USDC for sell

    return {
      success: true,
      inputAmount: amount,
      outputAmount,
      expectedOutput: amount,
      slippageActual: slippage * 100,
      timestamp: Date.now(),
    };
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
let executorInstance: Executor | null = null;

export function getExecutor(): Executor {
  if (!executorInstance) {
    executorInstance = new Executor();
  }
  return executorInstance;
}
