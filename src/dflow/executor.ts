/**
 * DFlow Trade Executor
 * Executes prediction market trades via DFlow's quote API
 */

import { Connection, Transaction, VersionedTransaction, Keypair } from '@solana/web3.js';
import { 
  DFlowMarket, 
  DFlowTradeResult, 
  PredictPosition,
  USDC_MINT 
} from './types';
import { getYesBuyQuote, getNoBuyQuote, parsePrice } from './client';
import logger from '../logger';
import { v4 as uuidv4 } from 'uuid';

// RPC endpoint from environment
function getRpcEndpoint(): string {
  return process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
}

// Get wallet keypair from environment
function getWalletKeypair(): Keypair {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY environment variable not set');
  }
  
  // Support both base58 and JSON array format
  try {
    if (privateKey.startsWith('[')) {
      const keyArray = JSON.parse(privateKey);
      return Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } else {
      // Assume base58
      const bs58 = require('bs58');
      return Keypair.fromSecretKey(bs58.decode(privateKey));
    }
  } catch (e) {
    throw new Error(`Failed to parse wallet private key: ${e}`);
  }
}

/**
 * Execute a DFlow swap transaction
 * DFlow returns a transaction in their quote response that we need to sign and send
 */
async function executeSwap(
  quote: { transaction: string } & Record<string, unknown>
): Promise<DFlowTradeResult> {
  const connection = new Connection(getRpcEndpoint(), 'confirmed');
  const wallet = getWalletKeypair();
  const now = Date.now();

  try {
    // Decode the transaction from base64
    const txBuffer = Buffer.from(quote.transaction as string, 'base64');
    
    // Try versioned transaction first, fall back to legacy
    let txSignature: string;
    try {
      const versionedTx = VersionedTransaction.deserialize(txBuffer);
      versionedTx.sign([wallet]);
      txSignature = await connection.sendTransaction(versionedTx);
    } catch {
      // Legacy transaction
      const legacyTx = Transaction.from(txBuffer);
      legacyTx.sign(wallet);
      txSignature = await connection.sendRawTransaction(legacyTx.serialize());
    }

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(txSignature, 'confirmed');
    
    if (confirmation.value.err) {
      return {
        success: false,
        error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        inputAmount: 0,
        outputAmount: 0,
        timestamp: now,
      };
    }

    logger.info({ txSignature }, 'DFlow swap executed successfully');

    return {
      success: true,
      txSignature,
      inputAmount: parseInt(quote.inputAmount as string) / 1_000_000, // USDC decimals
      outputAmount: parseInt(quote.outputAmount as string) / 1_000_000_000, // Outcome token decimals (9)
      tokensReceived: parseInt(quote.outputAmount as string) / 1_000_000_000,
      timestamp: now,
    };
  } catch (e) {
    const error = e as Error;
    logger.error({ error: error.message }, 'DFlow swap failed');
    return {
      success: false,
      error: error.message,
      inputAmount: 0,
      outputAmount: 0,
      timestamp: now,
    };
  }
}

/**
 * Buy YES tokens for a market
 */
export async function buyYes(
  market: DFlowMarket,
  amountUsd: number
): Promise<DFlowTradeResult> {
  logger.info({ ticker: market.ticker, amount: amountUsd }, 'Buying YES tokens');

  const quote = await getYesBuyQuote(market, amountUsd);
  if (!quote) {
    return {
      success: false,
      error: 'Failed to get quote',
      inputAmount: 0,
      outputAmount: 0,
      timestamp: Date.now(),
    };
  }

  // Check if quote has transaction (DFlow should return executable tx)
  if (!('transaction' in quote)) {
    // If no transaction, we need to build it ourselves
    // For now, return quote info for paper trading
    logger.warn({ ticker: market.ticker }, 'Quote does not include transaction - paper trade only');
    return {
      success: true,
      txSignature: `paper_${uuidv4().slice(0, 8)}`,
      inputAmount: amountUsd,
      outputAmount: parseFloat(quote.outputAmount) / 1_000_000_000,
      tokensReceived: parseFloat(quote.outputAmount) / 1_000_000_000,
      timestamp: Date.now(),
    };
  }

  return executeSwap(quote as { transaction: string } & Record<string, unknown>);
}

/**
 * Buy NO tokens for a market
 */
export async function buyNo(
  market: DFlowMarket,
  amountUsd: number
): Promise<DFlowTradeResult> {
  logger.info({ ticker: market.ticker, amount: amountUsd }, 'Buying NO tokens');

  const quote = await getNoBuyQuote(market, amountUsd);
  if (!quote) {
    return {
      success: false,
      error: 'Failed to get quote',
      inputAmount: 0,
      outputAmount: 0,
      timestamp: Date.now(),
    };
  }

  if (!('transaction' in quote)) {
    return {
      success: true,
      txSignature: `paper_${uuidv4().slice(0, 8)}`,
      inputAmount: amountUsd,
      outputAmount: parseFloat(quote.outputAmount) / 1_000_000_000,
      tokensReceived: parseFloat(quote.outputAmount) / 1_000_000_000,
      timestamp: Date.now(),
    };
  }

  return executeSwap(quote as { transaction: string } & Record<string, unknown>);
}

/**
 * Buy outcome tokens (YES or NO)
 */
export async function buyOutcome(
  market: DFlowMarket,
  outcome: 'yes' | 'no',
  amountUsd: number
): Promise<DFlowTradeResult> {
  if (outcome === 'yes') {
    return buyYes(market, amountUsd);
  } else {
    return buyNo(market, amountUsd);
  }
}

/**
 * Create a new predict position record
 */
export function createPredictPosition(
  market: DFlowMarket,
  outcome: 'yes' | 'no',
  sizeUsd: number,
  tokensHeld: number,
  tokenMint: string,
  dataSource: string,
  dataValue: string,
  dataConfidence: number,
  txSignature?: string,
  collateralMint: string = USDC_MINT
): PredictPosition {
  const now = Date.now();
  const marketPrice = outcome === 'yes' 
    ? parsePrice(market.yesAsk) 
    : parsePrice(market.noAsk);

  // Extract series ticker from event ticker
  const seriesTicker = market.eventTicker.replace(/-\d+$/, '');

  return {
    id: uuidv4(),
    marketTicker: market.ticker,
    eventTicker: market.eventTicker,
    seriesTicker,
    title: market.title,
    outcome,
    
    entryPrice: marketPrice,
    entryTimestamp: now,
    sizeUsd,
    tokensHeld,
    tokenMint,
    collateralMint,
    entryTxSignature: txSignature,
    
    dataSource,
    dataValue,
    dataTimestamp: now,
    dataConfidence,
    marketImpliedProb: marketPrice,
    edgePct: dataConfidence - marketPrice,
    
    expirationTime: market.expirationTime * 1000,
    status: 'open',
    
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Calculate PnL for a settled position
 */
export function calculateSettledPnL(
  position: PredictPosition,
  marketResult: 'yes' | 'no'
): { pnlUsd: number; pnlPct: number; result: 'win' | 'loss' } {
  const won = position.outcome === marketResult;
  
  if (won) {
    // Each token pays out $1 on win
    const payout = position.tokensHeld;
    const cost = position.sizeUsd;
    const pnlUsd = payout - cost;
    const pnlPct = (pnlUsd / cost) * 100;
    return { pnlUsd, pnlPct, result: 'win' };
  } else {
    // Tokens are worthless
    return { 
      pnlUsd: -position.sizeUsd, 
      pnlPct: -100, 
      result: 'loss' 
    };
  }
}

// Paper trading mode check
export function isPaperMode(): boolean {
  const mode = process.env.TRADING_MODE || 'paper';
  return mode !== 'live';
}

/**
 * Execute a predict trade (paper or live)
 */
export async function executePredictTrade(
  market: DFlowMarket,
  outcome: 'yes' | 'no',
  sizeUsd: number,
  dataSource: string,
  dataValue: string,
  dataConfidence: number
): Promise<{ position: PredictPosition; result: DFlowTradeResult }> {
  // Get market's collateral (CASH or USDC)
  const { getMarketCollateral } = await import('./client');
  const collateral = getMarketCollateral(market);
  if (!collateral) {
    throw new Error('Market has no initialized collateral');
  }
  
  const account = market.accounts[collateral];
  if (!account) {
    throw new Error('Market account not found');
  }

  const tokenMint = outcome === 'yes' ? account.yesMint : account.noMint;
  const marketPrice = outcome === 'yes' 
    ? parsePrice(market.yesAsk) 
    : parsePrice(market.noAsk);

  // Calculate expected tokens (before slippage)
  const expectedTokens = sizeUsd / marketPrice;

  if (isPaperMode()) {
    // Paper trade - simulate execution
    const result: DFlowTradeResult = {
      success: true,
      txSignature: `paper_${uuidv4().slice(0, 8)}`,
      inputAmount: sizeUsd,
      outputAmount: expectedTokens,
      tokensReceived: expectedTokens,
      timestamp: Date.now(),
    };

    const position = createPredictPosition(
      market,
      outcome,
      sizeUsd,
      expectedTokens,
      tokenMint,
      dataSource,
      dataValue,
      dataConfidence,
      result.txSignature
    );

    logger.info({
      mode: 'paper',
      ticker: market.ticker,
      outcome,
      sizeUsd,
      tokens: expectedTokens,
      edge: (dataConfidence - marketPrice) * 100,
    }, 'Paper predict trade executed');

    return { position, result };
  }

  // Live trade
  const result = await buyOutcome(market, outcome, sizeUsd);
  
  if (!result.success) {
    throw new Error(`Trade failed: ${result.error}`);
  }

  const position = createPredictPosition(
    market,
    outcome,
    sizeUsd,
    result.tokensReceived || expectedTokens,
    tokenMint,
    dataSource,
    dataValue,
    dataConfidence,
    result.txSignature
  );

  return { position, result };
}
