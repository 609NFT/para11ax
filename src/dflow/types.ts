/**
 * DFlow Prediction Markets Types
 * Tokenized Kalshi markets on Solana via DFlow
 */

// Collateral types
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CASH_MINT = 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH';

// Market account structure (per collateral type)
export interface MarketAccount {
  marketLedger: string;
  yesMint: string;
  noMint: string;
  isInitialized: boolean;
  redemptionStatus: 'pending' | 'redeemable' | 'redeemed';
}

// DFlow market from API
export interface DFlowMarket {
  ticker: string;              // "KXHIGHNY-260210-36"
  eventTicker: string;         // "KXHIGHNY-260210"
  marketType: 'binary';
  title: string;               // "Will the high temp in NYC be 36-37°..."
  subtitle: string;
  yesSubTitle: string;
  noSubTitle: string;
  openTime: number;            // Unix seconds
  closeTime: number;           // Unix seconds
  expirationTime: number;      // Unix seconds
  status: 'active' | 'closed' | 'settled';
  volume: number;              // In cents
  result: string;              // "yes" | "no" | "" (empty if unsettled)
  openInterest: number;
  canCloseEarly: boolean;
  earlyCloseCondition?: string;
  rulesPrimary: string;
  rulesSecondary?: string;
  
  // Prices (as strings, need to parse)
  yesBid: string;              // "0.0300" = 3¢
  yesAsk: string;              // "0.0400" = 4¢
  noBid: string;
  noAsk: string;
  
  // Token accounts per collateral
  accounts: {
    [collateralMint: string]: MarketAccount;
  };
}

// DFlow event (group of related markets)
export interface DFlowEvent {
  ticker: string;              // "KXHIGHNY-260210"
  seriesTicker: string;        // "KXHIGHNY"
  title: string;
  subtitle: string;
  imageUrl?: string;
  competition?: string;
  competitionScope?: string;
  settlementSources: SettlementSource[];
  volume: number;
  volume24h: number;
  liquidity: number;
  openInterest: number;
}

// Settlement source for verification
export interface SettlementSource {
  name: string;                // "National Weather Service"
  url: string;                 // "https://www.weather.gov"
}

// Series metadata
export interface DFlowSeries {
  ticker: string;              // "KXHIGHNY"
  title: string;               // "NYC high temperature"
  settlementSources: SettlementSource[];
  category?: string;
  subcategory?: string;
}

// Quote response from DFlow
export interface DFlowQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;         // In smallest units
  outputAmount: string;
  slippageBps: number;
  executionMode: 'sync' | 'async';
  priceImpactPct?: number;
}

// Trade execution result
export interface DFlowTradeResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  tokensReceived?: number;
  error?: string;
  timestamp: number;
  // Fees
  feeUsd?: number;              // Platform/routing fee in USD
  networkFeeSol?: number;       // Priority fee in SOL
  slippageBps?: number;         // Actual slippage in bps
  priceImpactPct?: number;      // Price impact percentage
}

// Predict position for database
export interface PredictPosition {
  id: string;
  marketTicker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  outcome: 'yes' | 'no';
  
  // Entry
  entryPrice: number;          // 0.01 = 1¢
  entryTimestamp: number;
  sizeUsd: number;
  tokensHeld: number;
  tokenMint: string;
  collateralMint: string;
  entryTxSignature?: string;
  entryFeeUsd?: number;        // Platform/routing fee
  networkFeeSol?: number;      // Priority fee in SOL
  priceImpactPct?: number;     // Price impact
  
  // Data edge at entry
  dataSource: string;          // "NWS"
  dataValue: string;           // "33°F"
  dataTimestamp: number;
  dataConfidence: number;      // 0.95
  marketImpliedProb: number;   // 0.01
  edgePct: number;             // 0.94
  
  // Settlement
  expirationTime: number;
  status: 'open' | 'settled' | 'expired' | 'sold';
  settlementResult?: 'win' | 'loss';
  pnlUsd?: number;
  pnlPct?: number;
  exitTimestamp?: number;
  exitTxSignature?: string;
  
  // Metadata
  createdAt: number;
  updatedAt: number;
}

// Predict opportunity from scanner
export interface PredictOpportunity {
  market: DFlowMarket;
  event?: DFlowEvent;
  series?: DFlowSeries;
  outcome: 'yes' | 'no';
  
  // Data
  dataSource: string;
  dataValue: string;
  dataTimestamp: number;
  dataConfidence: number;      // How sure we are about the data
  
  // Market pricing
  marketPrice: number;         // Current ask for the outcome
  marketImpliedProb: number;   // Same as price for binary
  
  // Edge calculation
  fairValue: number;           // Our estimate of true probability
  edgePct: number;             // fairValue - marketPrice
  expectedValue: number;       // (fairValue * payoff) - cost
  kellyFraction: number;       // Optimal bet size
  
  // Sizing
  suggestedSizeUsd: number;
  maxSizeUsd: number;
  
  // Context
  hoursToExpiry: number;
  reasons: string[];
}

// Category for market classification
export type MarketCategory = 'weather' | 'crypto' | 'stocks' | 'sports' | 'politics' | 'other';

// Resolver result
export interface ResolverResult {
  category: MarketCategory;
  dataValue: string;           // Human readable: "33°F", "$98,500", "7-3"
  numericValue: number;        // For comparison: 33, 98500, etc.
  confidence: number;          // 0-1, how sure we are
  source: string;              // "NWS", "Pyth", "ESPN"
  sourceUrl?: string;
  timestamp: number;
  expiresAt?: number;          // When this data becomes stale
}
