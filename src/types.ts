/**
 * Core type definitions for the Parallax Mean Reversion Trading System
 * Trades tokenized stocks when they diverge from underlying stock prices
 */

// Trading modes - paper is default, live requires explicit enable
export type TradingMode = 'paper' | 'live';

// Price source types for custom feeds
export type PriceSource = 'stock' | 'swissquote';

// Token configuration for tradeable assets
export interface TokenConfig {
  symbol: string;           // e.g., "xSPY", "rSPY", "GOLD"
  mint: string;             // Solana token mint address
  stockTicker: string;      // Real stock ticker symbol (e.g., "SPY") or asset ID
  enabled: boolean;         // Per-token enable/disable
  poolAddress: string;      // DEX pool address for liquidity checks
  decimals: number;         // Token decimals
  priceSource?: PriceSource; // Price feed source (default: 'stock' for Finnhub/Alpaca)
  priceSymbol?: string;      // Symbol for custom price feed (e.g., "XAU/USD" for Swissquote)
}

// Price data from various sources
export interface StockPrice {
  symbol: string;
  price: number;
  timestamp: number;
  source: string;
  isStale: boolean;
}

export interface OnchainPrice {
  symbol: string;
  mint: string;
  price: number;            // Stock-equivalent price (for reference)
  tradingPrice: number;     // Actual on-chain trading price
  timestamp: number;
  source: string;           // e.g., "jupiter"
  poolLiquidity: number;    // USD liquidity in pool
  isStale: boolean;
}

// Jupiter quote information
export interface QuoteInfo {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  inputDecimals?: number;  // Decimals of input token (avoid hardcoding)
  outputDecimals?: number; // Decimals of output token (avoid hardcoding)
  priceImpactPct: number;
  slippageBps: number;
  route: RouteInfo[];
  timestamp: number;
  rawQuote?: unknown; // Raw Jupiter quote response for swap execution
  totalFeePct?: number; // Total fees as percentage of input (calculated from route)
}

export interface RouteInfo {
  poolAddress: string;
  dex: string;
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  feeAmount?: number;  // Fee amount in the fee token's smallest unit
  feeMint?: string;    // Mint of the token used for fees
}

// Fee breakdown for tracking all costs
export interface FeeBreakdown {
  // Priority fee (we control this - 100% accurate)
  priorityFeeLamports: number;           // microLamports * compute units
  priorityFeeUsd: number;                // Converted to USD

  // Network fee (Solana base fee - 100% accurate)
  networkFeeLamports: number;            // ~5000 lamports per signature
  networkFeeUsd: number;                 // Converted to USD

  // Price impact from quote (95% accurate - from Jupiter/Raydium)
  priceImpactPct: number;                // From quote
  priceImpactUsd: number;                // Calculated from trade size

  // Execution slippage (100% accurate - measured)
  executionSlippagePct: number;          // (expected - actual) / expected
  executionSlippageUsd: number;          // Actual USD lost to slippage

  // Platform fee (Jupiter Ultra only - 20 bps = 0.2%)
  platformFeeUsd?: number;               // Jupiter Ultra platform fee

  // True fee calculation (100% accurate - measured from actual execution)
  // For BUY: inputUsd - (tokensReceived * tokenPrice) = total cost of swap
  // For SELL: (tokensSold * tokenPrice) - outputUsd = total cost of swap
  trueFeeUsd?: number;                   // Actual USD lost in the swap (all-in)
  trueFeePct?: number;                   // As percentage of trade size

  // Totals (legacy - kept for backwards compatibility)
  totalFeeUsd: number;                   // Sum of all fees
  totalFeePct: number;                   // As percentage of trade size

  // Metadata
  route: 'jupiter' | 'jupiter-ultra' | 'raydium';  // Which execution path was used
  computeUnitsUsed?: number;             // Actual CU if available
  solPriceUsd: number;                   // SOL price used for conversion
}

// Trade execution result
export interface TradeResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  outputMint?: string;                   // Mint of output token (for SOL vs USDC detection)
  outputAmountUsd?: number;              // Output value in USD (for non-USDC outputs like SOL)
  expectedOutput: number;
  slippageActual: number;
  error?: string;
  timestamp: number;
  fees?: FeeBreakdown;                   // Fee tracking (when available)
}

// Risk state tracking
export interface RiskState {
  globalKillSwitch: boolean;
  disabledTokens: Set<string>;
  consecutiveFailures: Map<string, number>;
  lastPriceFeedTimestamp: Map<string, number>;
  dailyLossUsd: number;
  dailyTradeCount: number;
}

// Trade statistics
export interface TradeStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnlUsd: number;
  totalInvestedUsd: number;  // Total capital deployed across all closed trades
  averagePnlPct: number;
  averageHoldTime: number;
  largestWin: number;
  largestLoss: number;
  largestWinTrade?: { ticker: string; exitTimestamp: number; txSignature?: string };
  largestLossTrade?: { ticker: string; exitTimestamp: number; txSignature?: string };
  winRate: number;
  avgDailyTrades: number;
  todayTrades: number;

  // Fee statistics
  totalFeesUsd: number;               // Total fees paid across all trades
  avgFeePerTradeUsd: number;          // Average fee per trade
  totalPriorityFeesUsd: number;       // Total priority fees paid
  totalNetworkFeesUsd: number;        // Total Solana network fees
  totalSlippageUsd: number;           // Total execution slippage cost
  grossPnlUsd: number;                // PnL before fees (totalPnlUsd + totalFeesUsd)
}

// ==================== Mean Reversion Types ====================

// Token price info with discount calculation
export interface TokenPriceInfo {
  symbol: string;
  mint: string;
  price: number;
  liquidity: number;
  discountVsStock?: number;   // Positive = token cheaper than stock (buy opportunity)
}

// Token pair for mean reversion (tokenA === tokenB for single-token strategy)
export interface TokenPair {
  stockTicker: string;
  tokenA: TokenConfig;
  tokenB: TokenConfig;
}

// Spread/discount snapshot for a token vs its stock
export interface PairSpread {
  stockTicker: string;
  tokenA: TokenPriceInfo;
  tokenB: TokenPriceInfo;
  spreadPct: number;
  spreadAbsolute: number;
  cheaperToken: 'A' | 'B';
  stockPrice?: number;
  moreDiscounted?: 'A' | 'B';
  timestamp: number;
}

// Mean reversion trading signal
export interface MeanReversionSignal {
  shouldTrade: boolean;
  pair: TokenPair;
  spread: PairSpread;
  buyToken: TokenConfig;
  sellToken: TokenConfig;
  suggestedSizeUsd: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  reasons: string[];
  preferredRoute?: 'raydium' | 'jupiter';  // Which DEX gave the better quote
  tvlUsd?: number;                          // Pool TVL at signal time
}

// Exit reason for mean reversion positions
export type MeanReversionExitReason =
  | 'profit_target'           // Token appreciated enough
  | 'stop_loss'               // Token went to premium
  | 'price_stop_loss'         // Token price dropped too much
  | 'rwa_stop_loss'           // RWA price dropped too much
  | 'max_hold_time'           // Held too long
  | 'balance_zero'            // Already sold or failed buy
  | 'manual_close'            // Manual intervention
  | 'kill_switch'             // System shutdown
  | string;                   // Custom reasons like "profit: 1.0%→0.1%"

// Mean reversion position (database schema)
export interface MeanReversionPosition {
  id: string;
  stockTicker: string;
  buySymbol: string;          // Token symbol being bought
  buyMint: string;            // Token mint address
  buyPoolAddress?: string;    // Pool address for direct swaps
  buyDexId?: string;          // DEX/AMM type (e.g., 'raydium-clmm', 'jupiter')
  buyDecimals?: number;       // Token decimals
  sellSymbol: string;         // What we're selling (USDC for entry)
  sellMint: string;           // Sell token mint
  entrySpreadPct: number;     // Discount at entry (e.g., 1.5%)
  entryTimestamp: number;
  sizeUsd: number;
  buyAmount: number;          // Amount of token bought
  sellAmount: number;         // Amount of USDC spent
  status: 'open' | 'closed';
  exitSpreadPct?: number;     // Discount at exit
  exitTimestamp?: number;
  exitReason?: MeanReversionExitReason;
  pnlUsd?: number;
  pnlPct?: number;
  entryTxSignature?: string;  // Solana tx signature for entry
  exitTxSignature?: string;   // Solana tx signature for exit

  // Fee tracking (total for entry + exit)
  totalFeesUsd?: number;              // Total fees paid (entry + exit)
  entryFeesUsd?: number;              // Fees paid on entry trade
  exitFeesUsd?: number;               // Fees paid on exit trade
  priorityFeesUsd?: number;           // Priority fees component
  networkFeesUsd?: number;            // Network fees component
  slippageUsd?: number;               // Slippage component
  platformFeesUsd?: number;           // Jupiter Ultra platform fees (20 bps)

  // Execution route tracking
  entryRoute?: 'jupiter' | 'jupiter-ultra' | 'raydium';  // Which execution path for entry
  exitRoute?: 'jupiter' | 'jupiter-ultra' | 'raydium';   // Which execution path for exit

  // Liquidity tracking
  entryTvlUsd?: number;               // Pool TVL at time of entry

  // Entry price tracking for accurate NAV calculations
  entryStockPrice?: number;           // Stock price at time of entry (for NAV change calculations)
}

// Configuration schema
export interface Config {
  // Trading mode
  mode: TradingMode;

  // Mean reversion thresholds
  meanReversionEntrySpreadPct?: number;     // Enter when discount >= this (default: 1.5%)
  meanReversionExitSpreadPct?: number;      // Fallback exit appreciation % when TVL data missing (default: 0.8%)
  meanReversionStopLossSpreadPct?: number;  // Stop loss when discount <= this (default: -1%)

  // Timing
  maxHoldTimeMs: number;            // Maximum time to hold position
  entryCooldownMs: number;          // Minimum time between entries

  // Position sizing
  maxUsdPerTrade: number;           // Hard cap per trade
  liquidityFraction: number;        // Max % of pool liquidity to use
  maxSlippageBps: number;           // Max acceptable slippage in basis points

  // Risk limits
  maxDailyLossUsd: number;          // Daily loss limit
  maxDailyTrades: number;           // Max trades per day
  maxConsecutiveFailures: number;   // Auto-disable threshold
  priceStalenessMs: number;         // Max age of price data
  exitPriceStalenessMs: number;     // Max age of price data for exit decisions (longer threshold)

  // Network
  rpcEndpoint: string;
  rpcEndpoints: string[];  // Multiple RPC endpoints for failover
  jupiterApiUrl: string;

  // Tokens
  tokens: TokenConfig[];

  // Statistics window
  rollingWindowSize: number;        // Number of observations for rolling stats

  // Paper trading simulation
  simulatedSlippageBps: number;     // Simulated slippage for paper trades
}
