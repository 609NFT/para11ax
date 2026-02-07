/**
 * Enhanced Quote Optimization
 *
 * Improves on existing Raydium vs Jupiter comparison by:
 * 1. Better tip estimation based on network congestion
 * 2. Route scoring that factors in execution probability
 * 3. Historical success rate tracking per route
 */

import { signalLogger } from '../logger';
import { getRaydiumClient, getJupiterClient } from './index';
import { USDC_MINT } from '../constants';

// Price impact scoring constants
const PRICE_IMPACT_THRESHOLDS = {
  EXCELLENT: 0.1,    // < 0.1% price impact
  GOOD: 0.5,         // < 0.5% price impact
  MODERATE: 1.0,     // < 1.0% price impact
  HIGH: 2.0,         // > 2.0% price impact
} as const;

// Network congestion time thresholds (UTC hours)
const CONGESTION_HOURS = {
  PEAK_START: 14,     // Market hours start
  PEAK_END: 21,       // Market hours end
  MEDIUM_START: 12,   // Pre-market activity
  MEDIUM_END: 22,     // After-hours activity
} as const;

const PRICE_IMPACT_SCORES = {
  EXCELLENT: 10,
  GOOD: 5,
  MODERATE_PENALTY: -10,
  HIGH_PENALTY: -20,
} as const;

// Tip scaling constants
const TIP_SCALING = {
  MAX_MULTIPLIER: 2.0,      // Maximum tip multiplier for large trades
  MIN_MULTIPLIER: 0.5,      // Minimum tip multiplier for small trades
  REFERENCE_TRADE_USD: 50,  // Reference trade size for tip scaling ($50)
} as const;

export interface OptimizedQuote {
  source: 'raydium' | 'jupiter';
  outputAmount: number;
  priceImpact: number | null;
  netOutput: number; // After estimated tips and fees
  executionScore: number; // 0-100, higher = better execution probability
  estimatedTip: number; // Estimated priority fee in USDC
  route?: string; // Route description for debugging
}

export interface QuoteRequest {
  tokenMint: string;
  tokenSymbol: string;
  inputAmountUsd: number;
  poolAddress?: string;
  isExit?: boolean;
  tokenDecimals?: number;
  tokenAmount?: number; // For sell quotes
}

/**
 * Network congestion levels for tip estimation
 */
enum CongestionLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high'
}

/**
 * Estimate priority fee based on network congestion and trade size
 */
function estimateTip(tradeUsd: number, congestion: CongestionLevel): number {
  const baseTip = {
    [CongestionLevel.LOW]: 0.0001,    // $0.0001
    [CongestionLevel.MEDIUM]: 0.0005, // $0.0005
    [CongestionLevel.HIGH]: 0.002,    // $0.002
  }[congestion];

  // Scale tip with trade size (larger trades worth higher tips)
  const sizeFactor = Math.min(
    TIP_SCALING.MAX_MULTIPLIER,
    Math.max(TIP_SCALING.MIN_MULTIPLIER, tradeUsd / TIP_SCALING.REFERENCE_TRADE_USD)
  );

  return baseTip * sizeFactor;
}

/**
 * Get current network congestion level based on UTC time heuristics
 *
 * Uses simple time-based rules since most Solana activity follows Western trading hours.
 * TODO: Could integrate with Solana RPC for real congestion metrics
 *
 * @returns {CongestionLevel} Current estimated congestion level
 */
function getNetworkCongestion(): CongestionLevel {
  const hour = new Date().getUTCHours();

  // Simple heuristic based on time of day
  if (hour >= CONGESTION_HOURS.PEAK_START && hour <= CONGESTION_HOURS.PEAK_END) {
    return CongestionLevel.HIGH;
  } else if (hour >= CONGESTION_HOURS.MEDIUM_START && hour <= CONGESTION_HOURS.MEDIUM_END) {
    return CongestionLevel.MEDIUM;
  }
  return CongestionLevel.LOW;
}

/**
 * Calculate execution score based on route characteristics
 */
function calculateExecutionScore(
  source: 'raydium' | 'jupiter',
  priceImpact: number | null,
  hasDirectPool: boolean,
  tvl?: number
): number {
  let score = 50; // Base score

  // Raydium direct pools are generally more reliable
  if (source === 'raydium' && hasDirectPool) {
    score += 20;
  }

  // Jupiter has better aggregation but more complex routing
  if (source === 'jupiter') {
    score += 10; // Aggregation benefit
  }

  // Penalize high price impact
  if (priceImpact !== null) {
    if (priceImpact < PRICE_IMPACT_THRESHOLDS.EXCELLENT) score += PRICE_IMPACT_SCORES.EXCELLENT;
    else if (priceImpact < PRICE_IMPACT_THRESHOLDS.GOOD) score += PRICE_IMPACT_SCORES.GOOD;
    else if (priceImpact > PRICE_IMPACT_THRESHOLDS.HIGH) score += PRICE_IMPACT_SCORES.HIGH_PENALTY;
    else if (priceImpact > PRICE_IMPACT_THRESHOLDS.MODERATE) score += PRICE_IMPACT_SCORES.MODERATE_PENALTY;
  }

  // High TVL pools are more reliable
  if (tvl && tvl > 1_000_000) score += 10;
  else if (tvl && tvl < 100_000) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Get optimized quotes from multiple sources with enhanced comparison
 */
export async function getOptimizedQuotes(request: QuoteRequest): Promise<OptimizedQuote[]> {
  const { tokenMint, tokenSymbol, inputAmountUsd, poolAddress, isExit, tokenDecimals, tokenAmount } = request;
  const quotes: OptimizedQuote[] = [];
  const congestion = getNetworkCongestion();

  try {
    // Get Raydium quote if direct pool available
    if (poolAddress) {
      const raydiumClient = getRaydiumClient();
      if (raydiumClient.isReady()) {
        try {
          let raydiumQuote;

          if (isExit && tokenAmount && tokenDecimals) {
            // Exit quote (sell tokens for USDC)
            raydiumQuote = await raydiumClient.getQuote(
              poolAddress,
              tokenMint,
              tokenAmount,
              tokenDecimals
            );
          } else {
            // Entry quote (buy tokens with USDC)
            raydiumQuote = await raydiumClient.getQuote(
              poolAddress,
              USDC_MINT,
              inputAmountUsd,
              6 // USDC decimals
            );
          }

          if (raydiumQuote && raydiumQuote.amountOut > 0) {
            const estimatedTip = estimateTip(inputAmountUsd, congestion);
            const executionScore = calculateExecutionScore('raydium', raydiumQuote.priceImpact, true);

            quotes.push({
              source: 'raydium',
              outputAmount: raydiumQuote.amountOut,
              priceImpact: raydiumQuote.priceImpact,
              netOutput: raydiumQuote.amountOut, // Raydium fees already included in quote
              executionScore,
              estimatedTip,
              route: `Raydium direct (pool: ${poolAddress.slice(0, 8)})`
            });
          }
        } catch (error) {
          signalLogger.warn({
            tokenSymbol,
            error: error instanceof Error ? error.message : String(error)
          }, 'Failed to get Raydium quote');
        }
      }
    }

    // Always get Jupiter quote for comparison
    const jupiterClient = getJupiterClient();
    try {
      let jupiterQuote;

      if (isExit && tokenAmount && tokenDecimals) {
        // Exit quote (sell tokens for USDC)
        const rawAmount = tokenAmount * Math.pow(10, tokenDecimals);
        jupiterQuote = await jupiterClient.getSellQuoteRaw(tokenMint, rawAmount);

        if (jupiterQuote) {
          // Convert from USDC lamports to USDC
          const usdcOut = jupiterQuote.outputAmount / 1e6;
          const estimatedTip = estimateTip(inputAmountUsd, congestion);
          const executionScore = calculateExecutionScore('jupiter', jupiterQuote.priceImpactPct, false);

          quotes.push({
            source: 'jupiter',
            outputAmount: usdcOut,
            priceImpact: jupiterQuote.priceImpactPct,
            netOutput: usdcOut - estimatedTip,
            executionScore,
            estimatedTip,
            route: `Jupiter (route: ${jupiterQuote.route?.length || 'unknown'} hops)`
          });
        }
      } else {
        // Entry quote (buy tokens with USDC)
        jupiterQuote = await jupiterClient.getBuyQuote(tokenMint, inputAmountUsd);

        if (jupiterQuote && jupiterQuote.outputAmount > 0) {
          const tokenOut = jupiterQuote.outputAmount / Math.pow(10, tokenDecimals || 9);
          const estimatedTip = estimateTip(inputAmountUsd, congestion);
          const executionScore = calculateExecutionScore('jupiter', jupiterQuote.priceImpactPct, false);

          quotes.push({
            source: 'jupiter',
            outputAmount: tokenOut,
            priceImpact: jupiterQuote.priceImpactPct,
            netOutput: tokenOut, // For buy quotes, tip doesn't reduce token output directly
            executionScore,
            estimatedTip,
            route: `Jupiter (route: ${jupiterQuote.route?.length || 'unknown'} hops)`
          });
        }
      }
    } catch (error) {
      signalLogger.warn({
        tokenSymbol,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to get Jupiter quote');
    }

    // Log quote comparison for debugging
    if (quotes.length > 1) {
      signalLogger.info({
        tokenSymbol,
        congestion,
        quotes: quotes.map(q => ({
          source: q.source,
          output: isExit ? q.outputAmount.toFixed(2) : q.outputAmount.toFixed(6),
          priceImpact: q.priceImpact?.toFixed(3),
          score: q.executionScore,
          tip: q.estimatedTip.toFixed(4)
        }))
      }, 'Enhanced quote comparison');
    }

  } catch (error) {
    signalLogger.error({
      tokenSymbol,
      error: error instanceof Error ? error.message : String(error)
    }, 'Failed to get optimized quotes');
  }

  return quotes;
}

/**
 * Select the best quote based on net output and execution probability
 */
export function selectBestQuote(quotes: OptimizedQuote[], isExit = false): OptimizedQuote | null {
  if (quotes.length === 0) return null;
  if (quotes.length === 1) return quotes[0];

  // Score quotes: 80% net output, 20% execution probability
  const scoredQuotes = quotes.map(quote => {
    const outputScore = isExit
      ? quote.netOutput / Math.max(...quotes.map(q => q.netOutput)) // Higher USDC better for exit
      : quote.outputAmount / Math.max(...quotes.map(q => q.outputAmount)); // More tokens better for entry

    const executionScore = quote.executionScore / 100;
    const totalScore = outputScore * 0.8 + executionScore * 0.2;

    return { ...quote, totalScore };
  });

  // Sort by total score, return best
  scoredQuotes.sort((a, b) => b.totalScore - a.totalScore);

  const winner = scoredQuotes[0];
  signalLogger.debug({
    winner: winner.source,
    totalScore: winner.totalScore.toFixed(3),
    outputScore: (winner.netOutput / Math.max(...quotes.map(q => q.netOutput))).toFixed(3),
    executionScore: (winner.executionScore / 100).toFixed(3)
  }, 'Quote selection result');

  return winner;
}