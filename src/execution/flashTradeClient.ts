/**
 * Flash Trade Client - Perpetual futures trading
 *
 * Used to open SHORT positions on various assets (stocks, crypto, etc.)
 * when they trade at a premium to their oracle reference price.
 * Flash Trade perps are priced by Pyth oracles, so shorting captures
 * the premium as it collapses back to fair value.
 *
 * Available markets are dynamically discovered from the Flash SDK PoolConfig
 * by finding all non-stablecoin tokens that have short markets available.
 */

import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, TransactionInstruction, Signer } from '@solana/web3.js';
import { PerpetualsClient, PoolConfig, Side, OraclePrice, CustodyAccount, Privilege, BN_ZERO, uiDecimalsToNative } from 'flash-sdk';
import { PriceServiceConnection } from '@pythnetwork/price-service-client';
import logger from '../logger';
import { getConfigSync } from '../config';
import { getStockFeed } from '../feeds/stockFeed';

// Pyth Hermes connection for fetching live oracle prices with correct exponents
const pythConnection = new PriceServiceConnection('https://hermes.pyth.network', {
  priceFeedRequestConfig: {},
});

// Cache for oracle exponents (fetched once per symbol)
const oracleExponentCache: Map<string, number> = new Map();

// Remora pool config for rStock perps
const POOL_NAME = 'Remora.1';
const CLUSTER = 'mainnet-beta';

// Flash Trade symbol type (dynamically discovered from pool config)
// Includes equities (rStocks), crypto, metals, FX, etc.
export type FlashSymbol = string;

// Dynamically built maps - populated on initialization
let availableShortSymbols: Set<string> = new Set();
let tickerToFlashSymbol: Map<string, string> = new Map();
let flashSymbolToTicker: Map<string, string> = new Map();

/**
 * Extract ticker from pythTicker string
 * Supports various formats:
 * - "Equity.US.TSLA/USD" -> "TSLA"
 * - "Crypto.SOL/USD" -> "SOL"
 * - "Crypto.BTC/USD" -> "BTC"
 * - "Metal.XAU/USD" -> "XAU"
 * - "FX.EUR/USD" -> "EUR"
 */
function extractTickerFromPythTicker(pythTicker: string): string | null {
  // Match pattern: Category.Subcategory?.TICKER/USD or Category.TICKER/USD
  // Examples: "Equity.US.TSLA/USD", "Crypto.SOL/USD", "Crypto.JITOSOL/USD"
  const match = pythTicker.match(/^[A-Za-z]+(?:\.[A-Za-z]+)?\.([A-Z0-9]+)\/USD$/i);
  if (match) {
    return match[1].toUpperCase();
  }
  return null;
}

/**
 * Get the asset category from pythTicker
 * Returns: "Equity", "Crypto", "Metal", "FX", etc.
 */
function getAssetCategoryFromPythTicker(pythTicker: string): string | null {
  const match = pythTicker.match(/^([A-Za-z]+)\./);
  return match ? match[1] : null;
}

/**
 * Discover available short markets from pool config
 * Finds ALL tokens (not just equities) that have short markets available
 */
function discoverShortMarkets(): void {
  if (!poolConfig) {
    logger.warn('Cannot discover short markets - poolConfig not initialized');
    return;
  }

  // Clear existing maps
  availableShortSymbols.clear();
  tickerToFlashSymbol.clear();
  flashSymbolToTicker.clear();

  // Find all markets with side="short" to know which custodies support shorting
  const shortMarketCustodyIds = new Set<number>();
  for (const market of poolConfig.markets) {
    if (market.side === Side.Short) {
      shortMarketCustodyIds.add(market.targetCustodyId);
    }
  }

  // Find ALL tokens with short markets available (not just equities)
  for (const token of poolConfig.tokens) {
    // Skip stablecoins
    if (token.isStable) continue;

    // Get pythTicker to extract the underlying ticker
    const pythTicker = (token as any).pythTicker as string | undefined;
    if (!pythTicker) continue;

    // Find matching custody to check if short market exists
    const custody = poolConfig.custodies.find(c => c.symbol === token.symbol);
    if (!custody) continue;

    // Check if this custody has a short market
    if (!shortMarketCustodyIds.has(custody.custodyId)) continue;

    // Extract ticker from pythTicker (works for any asset type)
    const ticker = extractTickerFromPythTicker(pythTicker);
    if (!ticker) continue;

    const flashSymbol = token.symbol;
    const category = getAssetCategoryFromPythTicker(pythTicker);

    availableShortSymbols.add(flashSymbol);
    tickerToFlashSymbol.set(ticker, flashSymbol);
    flashSymbolToTicker.set(flashSymbol, ticker);

    logger.debug({
      ticker,
      flashSymbol,
      pythTicker,
      category,
      custodyId: custody.custodyId,
    }, 'Discovered short market');
  }

  logger.info({
    availableSymbols: Array.from(availableShortSymbols),
    tickerMappings: Object.fromEntries(tickerToFlashSymbol),
  }, `Discovered ${availableShortSymbols.size} short markets`);
}

/**
 * Get all available symbols that support shorting
 * Includes equities, crypto, metals, FX, etc.
 */
export function getAvailableShortSymbols(): string[] {
  return Array.from(availableShortSymbols);
}

/**
 * Get the Flash symbol to ticker mapping (for reverse lookup)
 */
export function getFlashSymbolToTickerMap(): Map<string, string> {
  return new Map(flashSymbolToTicker);
}

interface FlashTradePosition {
  symbol: FlashSymbol;
  side: 'long' | 'short';
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  leverage: number;
  unrealizedPnl: number;
  liquidationPrice: number;
  positionKey: string;
  openTime: number; // Unix timestamp in seconds
}

interface OpenPositionParams {
  symbol: FlashSymbol;
  side: 'long' | 'short';
  collateralUsd: number;
  leverage: number;
  slippageBps?: number;
  currentPriceUsd?: number; // Optional: pass current price to avoid refetch
}

interface ClosePositionParams {
  symbol: FlashSymbol;
  side: 'long' | 'short';
  slippageBps?: number;
  currentPriceUsd?: number;
}

let flashClient: PerpetualsClient | null = null;
let poolConfig: PoolConfig | null = null;

/**
 * Check if shorting feature is enabled via environment variable
 */
export function isShortingEnabled(): boolean {
  return process.env.ENABLE_SHORTING === 'true';
}

/**
 * Initialize the Flash Trade client
 */
export async function initializeFlashClient(): Promise<boolean> {
  // Check if shorting is enabled
  if (!isShortingEnabled()) {
    logger.info('Flash Trade shorting is disabled (ENABLE_SHORTING != true)');
    return false;
  }

  try {
    const config = getConfigSync();

    // Load wallet from private key
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) {
      logger.warn('SOLANA_PRIVATE_KEY not set - Flash Trade client disabled');
      return false;
    }

    // Parse private key (supports both array and base58 formats)
    let keypair: Keypair;
    try {
      if (privateKeyString.startsWith('[')) {
        const secretKey = Uint8Array.from(JSON.parse(privateKeyString));
        keypair = Keypair.fromSecretKey(secretKey);
      } else {
        const bs58 = await import('bs58');
        const secretKey = bs58.default.decode(privateKeyString);
        keypair = Keypair.fromSecretKey(secretKey);
      }
    } catch (e) {
      logger.error({ error: e }, 'Failed to parse SOLANA_PRIVATE_KEY');
      return false;
    }

    // Create connection and provider
    const connection = new Connection(config.rpcEndpoint, {
      commitment: 'confirmed',
    });

    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    // Load Remora pool config
    poolConfig = PoolConfig.fromIdsByName(POOL_NAME, CLUSTER);

    // Create the client
    // useExtOracleAccount = false: program validates oracle account against
    // custody's intOracleAccount (updated by Flash Trade keepers)
    flashClient = new PerpetualsClient(
      provider,
      poolConfig.programId,
      poolConfig.perpComposibilityProgramId,
      poolConfig.fbNftRewardProgramId,
      poolConfig.rewardDistributionProgram.programId,
      {
        prioritizationFee: 50000, // 50k microlamports
      },
    );

    // Load address lookup tables for efficient transactions
    await flashClient.loadAddressLookupTable(poolConfig);

    // Discover available short markets from pool config
    discoverShortMarkets();

    logger.info({
      poolName: POOL_NAME,
      programId: poolConfig.programId.toBase58(),
      wallet: wallet.publicKey.toBase58(),
      availableRStockMarkets: Array.from(availableShortSymbols),
    }, 'Flash Trade client initialized');

    return true;
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to initialize Flash Trade client');
    return false;
  }
}

/**
 * Check if Flash Trade is available and initialized
 */
export function isFlashTradeAvailable(): boolean {
  return flashClient !== null && poolConfig !== null;
}

/**
 * Check if a ticker has a corresponding Flash Trade market for shorting
 * Uses dynamically discovered markets from pool config
 * Supports equities, crypto, metals, FX, etc.
 */
export function hasFlashMarket(ticker: string): boolean {
  return tickerToFlashSymbol.has(ticker);
}

/**
 * Get the Flash Trade symbol for a ticker
 * Uses dynamically discovered markets from pool config
 */
export function getFlashSymbol(ticker: string): FlashSymbol | null {
  return tickerToFlashSymbol.get(ticker) || null;
}

/**
 * Get the underlying ticker for a Flash Trade symbol
 * Uses dynamically discovered markets from pool config
 */
export function getTickerFromFlashSymbol(flashSymbol: string): string | null {
  return flashSymbolToTicker.get(flashSymbol) || null;
}

/**
 * Build instructions and send transaction, then confirm on-chain
 */
async function sendFlashTransaction(
  instructions: TransactionInstruction[],
  additionalSigners: Signer[]
): Promise<string> {
  if (!flashClient) {
    throw new Error('Flash Trade client not initialized');
  }

  const txid = await flashClient.sendTransaction(instructions, {
    additionalSigners,
  });

  // Wait for confirmation and verify on-chain success
  const conn = flashClient.provider.connection;
  try {
    // Wait for transaction to be confirmed
    await conn.confirmTransaction(txid, 'confirmed');

    // Double-check the transaction didn't fail on-chain
    const txInfo = await conn.getTransaction(txid, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (txInfo?.meta?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}`);
    }
  } catch (error) {
    // If this is our own "failed on-chain" error, re-throw it
    if (error instanceof Error && error.message.startsWith('Transaction failed on-chain')) {
      throw error;
    }
    // Confirmation timeout or other network error - log but don't fail
    // The transaction may still land
    logger.warn({
      txid,
      error: error instanceof Error ? error.message : String(error),
    }, 'Transaction confirmation check failed (tx may still succeed)');
  }

  return txid;
}

// getOracleExponent removed — getOraclePrices() handles exponent caching now

/**
 * Fetch both price and EMA price from Pyth Hermes for a given symbol.
 * Returns OraclePrice objects suitable for Flash Trade SDK methods.
 */
async function getOraclePrices(symbol: FlashSymbol): Promise<{ price: OraclePrice; emaPrice: OraclePrice }> {
  if (!poolConfig) {
    throw new Error('Pool config not initialized');
  }

  const tokenConfig = poolConfig.tokens.find(t => t.symbol === symbol);
  if (!tokenConfig) {
    throw new Error(`Token ${symbol} not found in pool config`);
  }

  const pythPriceId = (tokenConfig as any).pythPriceId;
  if (!pythPriceId) {
    throw new Error(`No pythPriceId found for ${symbol}`);
  }

  const priceIdClean = pythPriceId.startsWith('0x') ? pythPriceId.slice(2) : pythPriceId;

  const priceFeeds = await pythConnection.getLatestPriceFeeds([priceIdClean]);
  if (!priceFeeds || priceFeeds.length === 0) {
    throw new Error(`No price feed returned for ${symbol}`);
  }

  const priceFeed = priceFeeds[0];
  const priceData = priceFeed.getPriceUnchecked();
  const emaPriceData = priceFeed.getEmaPriceUnchecked();

  // Cache the exponent while we're at it
  oracleExponentCache.set(symbol, priceData.expo);

  const price = new OraclePrice({
    price: new BN(priceData.price),
    exponent: new BN(priceData.expo),
    confidence: new BN(priceData.conf),
    timestamp: new BN(priceData.publishTime),
  });

  const emaPrice = new OraclePrice({
    price: new BN(emaPriceData.price),
    exponent: new BN(emaPriceData.expo),
    confidence: new BN(emaPriceData.conf),
    timestamp: new BN(emaPriceData.publishTime),
  });

  logger.debug({
    symbol,
    price: priceData.price,
    emaPrice: emaPriceData.price,
    exponent: priceData.expo,
  }, `Fetched oracle prices for ${symbol}`);

  return { price, emaPrice };
}

/**
 * Get the current oracle price for a Flash Trade symbol from Pyth
 * Returns the price in USD
 */
export async function getOraclePrice(symbol: FlashSymbol): Promise<number | null> {
  if (!poolConfig) {
    logger.warn('Pool config not initialized, cannot get oracle price');
    return null;
  }

  // Find the token config to get the pythPriceId
  const tokenConfig = poolConfig.tokens.find(t => t.symbol === symbol);
  if (!tokenConfig) {
    logger.warn({ symbol }, `Token ${symbol} not found in pool config`);
    return null;
  }

  // Get pythPriceId - need to strip '0x' prefix if present
  const pythPriceId = (tokenConfig as any).pythPriceId;
  if (!pythPriceId) {
    logger.warn({ symbol }, `No pythPriceId found for ${symbol}`);
    return null;
  }

  const priceIdClean = pythPriceId.startsWith('0x') ? pythPriceId.slice(2) : pythPriceId;

  try {
    const priceFeeds = await pythConnection.getLatestPriceFeeds([priceIdClean]);
    if (!priceFeeds || priceFeeds.length === 0) {
      return null;
    }

    const priceFeed = priceFeeds[0];
    const price = priceFeed.getPriceUnchecked();

    // Convert from fixed-point to USD
    // price.price is the scaled price, price.expo is the exponent (negative)
    const priceUsd = Number(price.price) * Math.pow(10, price.expo);

    return priceUsd;
  } catch (error) {
    logger.error({
      symbol,
      error: error instanceof Error ? error.message : String(error),
    }, `Failed to fetch oracle price for ${symbol}`);
    return null;
  }
}

/**
 * Open a perpetual position (long or short)
 *
 * @param params.symbol - The rStock symbol (e.g., 'TSLAr')
 * @param params.side - 'long' or 'short'
 * @param params.collateralUsd - Amount of USDC collateral
 * @param params.leverage - Leverage multiplier (max 10x for rStocks)
 * @param params.slippageBps - Slippage tolerance in basis points (default 100 = 1%)
 * @param params.currentPriceUsd - Current oracle price in USD (required)
 */
export async function openPerpPosition(params: OpenPositionParams): Promise<{
  success: boolean;
  txSignature?: string;
  positionKey?: string;
  error?: string;
}> {
  if (!flashClient || !poolConfig) {
    return { success: false, error: 'Flash Trade client not initialized' };
  }

  const { symbol, side, collateralUsd, leverage, slippageBps = 100, currentPriceUsd } = params;

  if (!currentPriceUsd) {
    return { success: false, error: 'currentPriceUsd is required' };
  }

  try {
    logger.info({
      symbol,
      side,
      collateralUsd,
      leverage,
      slippageBps,
      currentPriceUsd,
    }, `Opening ${side} perp position`);

    // Validate leverage for rStocks (max 10x)
    if (leverage > 10) {
      return { success: false, error: 'Maximum leverage for rStocks is 10x' };
    }

    // Find token configs for market (target) and collateral (USDC)
    const targetToken = poolConfig.tokens.find(t => t.symbol === symbol);
    if (!targetToken) {
      return { success: false, error: `Token ${symbol} not found in pool config` };
    }
    const collateralToken = poolConfig.tokens.find(t => t.symbol === 'USDC');
    if (!collateralToken) {
      return { success: false, error: 'USDC token not found in pool config' };
    }

    // Find custody configs
    const targetCustodyConfig = poolConfig.custodies.find(c => c.symbol === symbol);
    if (!targetCustodyConfig) {
      return { success: false, error: `Custody for ${symbol} not found in pool config` };
    }
    const collateralCustodyConfig = poolConfig.custodies.find(c => c.symbol === 'USDC');
    if (!collateralCustodyConfig) {
      return { success: false, error: 'USDC custody not found in pool config' };
    }

    // Fetch oracle prices (price + EMA) from Pyth for both target and collateral
    const [targetPrices, collateralPrices] = await Promise.all([
      getOraclePrices(symbol),
      getOraclePrices('USDC'),
    ]);

    logger.info({
      symbol,
      targetPrice: targetPrices.price.price.toString(),
      targetEmaPrice: targetPrices.emaPrice.price.toString(),
      targetExponent: targetPrices.price.exponent.toString(),
      collateralPrice: collateralPrices.price.price.toString(),
      currentPriceUsd,
    }, `Fetched oracle prices for ${symbol} and USDC`);

    // Fetch custody account data from chain
    const custodyAccounts = await flashClient.program.account.custody.fetchMultiple([
      collateralCustodyConfig.custodyAccount,
      targetCustodyConfig.custodyAccount,
    ]);
    if (!custodyAccounts[0] || !custodyAccounts[1]) {
      return { success: false, error: 'Failed to fetch custody accounts from chain' };
    }

    const collateralCustodyAccount = CustodyAccount.from(collateralCustodyConfig.custodyAccount, custodyAccounts[0]);
    const targetCustodyAccount = CustodyAccount.from(targetCustodyConfig.custodyAccount, custodyAccounts[1]);

    const perpSide = side === 'long' ? Side.Long : Side.Short;

    // Convert collateral using SDK utility (proper decimal handling)
    const collateralWithFee = uiDecimalsToNative(collateralUsd.toString(), collateralToken.decimals);

    // Calculate position size using the SDK's built-in function
    const sizeAmount = flashClient.getSizeAmountFromLeverageAndCollateral(
      collateralWithFee,
      leverage.toString(),
      targetToken,          // market/target token
      collateralToken,      // collateral token (USDC)
      perpSide,
      targetPrices.price,
      targetPrices.emaPrice,
      targetCustodyAccount,
      collateralPrices.price,
      collateralPrices.emaPrice,
      collateralCustodyAccount,
      BN_ZERO,              // discountBps
    );

    logger.info({
      symbol,
      collateralWithFee: collateralWithFee.toString(),
      sizeAmount: sizeAmount.toString(),
      leverage,
    }, `Calculated position size via SDK`);

    // Get price with slippage applied
    const priceWithSlippage = flashClient.getPriceAfterSlippage(
      true, // isEntry
      new BN(slippageBps),
      targetPrices.price,
      perpSide
    );

    // Build the transaction instructions
    const { instructions, additionalSigners } = await flashClient.openPosition(
      symbol,           // target symbol (e.g., 'TSLAr')
      'USDC',           // collateral symbol
      priceWithSlippage,
      collateralWithFee,
      sizeAmount,
      perpSide,
      poolConfig,
      Privilege.None,
    );

    // Send the transaction
    const txSignature = await sendFlashTransaction(instructions, additionalSigners);

    logger.info({
      symbol,
      side,
      collateralUsd,
      leverage,
      txSignature,
    }, `Successfully opened ${side} perp position`);

    return {
      success: true,
      txSignature,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({
      symbol,
      side,
      collateralUsd,
      error: errorMsg,
    }, `Failed to open ${side} perp position`);

    return { success: false, error: errorMsg };
  }
}

/**
 * Close a perpetual position
 */
export async function closePerpPosition(params: ClosePositionParams): Promise<{
  success: boolean;
  txSignature?: string;
  error?: string;
}> {
  if (!flashClient || !poolConfig) {
    return { success: false, error: 'Flash Trade client not initialized' };
  }

  const { symbol, side, slippageBps = 100, currentPriceUsd } = params;

  if (!currentPriceUsd) {
    return { success: false, error: 'currentPriceUsd is required' };
  }

  try {
    logger.info({ symbol, side, currentPriceUsd }, `Closing ${side} perp position`);

    // Fetch oracle prices from Pyth (price + EMA)
    const targetPrices = await getOraclePrices(symbol);

    const perpSide = side === 'long' ? Side.Long : Side.Short;

    // Get price with slippage for exit
    const priceWithSlippage = flashClient.getPriceAfterSlippage(
      false, // isEntry = false for exit
      new BN(slippageBps),
      targetPrices.price,
      perpSide
    );

    const { instructions, additionalSigners } = await flashClient.closePosition(
      symbol,           // market symbol
      'USDC',           // collateral/receiving symbol
      priceWithSlippage,
      perpSide,
      poolConfig,
      Privilege.None,
    );

    const txSignature = await sendFlashTransaction(instructions, additionalSigners);

    logger.info({
      symbol,
      side,
      txSignature,
    }, `Successfully closed ${side} perp position`);

    return {
      success: true,
      txSignature,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({
      symbol,
      side,
      error: errorMsg,
    }, `Failed to close ${side} perp position`);

    return { success: false, error: errorMsg };
  }
}

/**
 * Get all open perp positions for the wallet
 */
export async function getOpenPerpPositions(): Promise<FlashTradePosition[]> {
  if (!flashClient || !poolConfig) {
    return [];
  }

  try {
    const wallet = flashClient.provider.wallet.publicKey;
    const positions: FlashTradePosition[] = [];

    // Check each dynamically discovered shortable market
    // Get USDC custody account (not mint!) - required for correct position key derivation
    const usdcCustody = poolConfig.custodies.find(c => c.symbol === 'USDC');
    if (!usdcCustody) return [];

    for (const symbol of getAvailableShortSymbols()) {
      // Get the custody account for this symbol (not mint!)
      const targetCustody = poolConfig.custodies.find(c => c.symbol === symbol);
      if (!targetCustody) continue;

      // Check both long and short positions
      for (const side of [Side.Long, Side.Short]) {
        try {
          // Use custody accounts (not mints!) for position key derivation
          // custodyAccount is already a PublicKey, so use it directly
          const targetCustodyPk = (targetCustody as any).custodyAccount as PublicKey;
          const usdcCustodyPk = (usdcCustody as any).custodyAccount as PublicKey;

          const positionKey = flashClient.getPositionKey(
            wallet,
            targetCustodyPk,
            usdcCustodyPk,
            side
          );

          const position = await flashClient.getPosition(positionKey);

          if (position && position.sizeUsd && (position.sizeUsd as BN).gt(new BN(0))) {
            const sizeUsd = (position.sizeUsd as BN).toNumber() / 1e6;
            const collateralUsd = (position.collateralUsd as BN).toNumber() / 1e6;

            // entryPrice is a struct with {price, exponent}
            // price is in fixed-point format, exponent is negative (e.g., -5 means divide by 10^5)
            const entryPriceStruct = position.entryPrice as { price: BN; exponent: number };
            const entryPriceRaw = (entryPriceStruct.price as BN).toNumber();
            const entryPriceExponent = entryPriceStruct.exponent;
            const entryPrice = entryPriceRaw * Math.pow(10, entryPriceExponent);

            // openTime is a Unix timestamp in seconds
            const openTime = (position.openTime as BN).toNumber();

            positions.push({
              symbol,
              side: side === Side.Long ? 'long' : 'short',
              sizeUsd,
              collateralUsd,
              entryPrice,
              leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : 0,
              unrealizedPnl: 0, // Would need current price to calculate
              liquidationPrice: 0, // Would need to calculate
              positionKey: positionKey.toBase58(),
              openTime,
            });
          }
        } catch {
          // Position doesn't exist - that's fine
        }
      }
    }

    return positions;
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to get open perp positions');
    return [];
  }
}

/**
 * Check if US equity market is open for trading
 *
 * US Equity Market Hours (Eastern Time):
 * - Pre-market: 4:00 AM - 9:30 AM ET
 * - Regular: 9:30 AM - 4:00 PM ET
 * - Post-market: 4:00 PM - 8:00 PM ET
 *
 * Combined trading window: 4:00 AM - 8:00 PM ET (Monday-Friday)
 * In UTC: 9:00 AM - 1:00 AM next day (shifts by 1 hour for DST)
 *
 * Pyth oracle feeds are available during these extended hours.
 */
export function isEquityMarketOpen(): boolean {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();

  // Weekend: Saturday (6) and Sunday (0) - always closed
  if (utcDay === 0 || utcDay === 6) {
    return false;
  }

  // Convert current time to Eastern Time
  // Note: This is a simplified check. ET is UTC-5 (EST) or UTC-4 (EDT)
  // We use UTC-5 as a conservative estimate (actual hours may be slightly longer during EDT)
  const etHour = (utcHour - 5 + 24) % 24;
  const etDay = utcHour < 5 ? (utcDay - 1 + 7) % 7 : utcDay;

  // If day shifted to weekend due to timezone conversion, market is closed
  if (etDay === 0 || etDay === 6) {
    return false;
  }

  // Extended market hours: 4:00 AM - 8:00 PM ET
  // Pre-market starts at 4 AM ET, post-market ends at 8 PM ET
  const PRE_MARKET_OPEN_ET = 4;   // 4:00 AM ET
  const POST_MARKET_CLOSE_ET = 20; // 8:00 PM ET

  if (etHour < PRE_MARKET_OPEN_ET || etHour >= POST_MARKET_CLOSE_ET) {
    return false;
  }

  return true;
}

/**
 * Get time until market opens (for display when market is closed)
 * Returns a human-readable string like "Opens in 2h 30m" or "Opens Tuesday 4 AM ET"
 * Checks holidays to find the next actual trading day
 */
export async function getTimeUntilMarketOpen(): Promise<string> {
  if (isEquityMarketOpen()) {
    return '';
  }

  const now = new Date();
  const stockFeed = getStockFeed();
  const PRE_MARKET_OPEN_ET = 4; // 4:00 AM ET

  // Find the next trading day (skip weekends and holidays)
  let candidateDate = new Date(now);
  let daysChecked = 0;
  const maxDaysToCheck = 10; // Safety limit

  // Get current ET hour to determine if we need to start from today or tomorrow
  const utcHour = now.getUTCHours();
  const etHour = (utcHour - 5 + 24) % 24;

  // If it's after market close (8 PM ET) or it's currently closed, start checking from tomorrow
  if (etHour >= 20 || etHour < PRE_MARKET_OPEN_ET) {
    // Start from tomorrow if after close, or today if before open
    if (etHour >= 20) {
      candidateDate.setDate(candidateDate.getDate() + 1);
      daysChecked = 1;
    }
  }

  while (daysChecked < maxDaysToCheck) {
    const dayOfWeek = candidateDate.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      candidateDate.setDate(candidateDate.getDate() + 1);
      daysChecked++;
      continue;
    }

    // Check if it's a holiday (full day close only)
    try {
      const holidayCheck = await stockFeed.isMarketHoliday(candidateDate);
      if (holidayCheck.isHoliday && !holidayCheck.isEarlyClose) {
        // Full holiday, skip this day
        candidateDate.setDate(candidateDate.getDate() + 1);
        daysChecked++;
        continue;
      }
    } catch {
      // If holiday check fails, assume it's a trading day
    }

    // Found a trading day!
    break;
  }

  // Calculate time until that day opens
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const nextTradingDayName = dayNames[candidateDate.getDay()];

  // Calculate hours until open
  const nowMs = now.getTime();
  // Set candidate to 4 AM ET (9 AM UTC, simplified)
  const candidateOpen = new Date(candidateDate);
  candidateOpen.setUTCHours(9, 0, 0, 0); // 4 AM ET = 9 AM UTC (simplified, ignores DST)

  const msUntilOpen = candidateOpen.getTime() - nowMs;
  const hoursUntilOpen = Math.floor(msUntilOpen / (1000 * 60 * 60));
  const minutesUntilOpen = Math.floor((msUntilOpen % (1000 * 60 * 60)) / (1000 * 60));

  // Format the output
  if (hoursUntilOpen < 12 && hoursUntilOpen >= 0) {
    // Less than 12 hours - show countdown
    if (hoursUntilOpen === 0) {
      return `Opens in ${minutesUntilOpen}m`;
    }
    return `Opens in ${hoursUntilOpen}h ${minutesUntilOpen}m`;
  } else {
    // More than 12 hours - show day and time
    return `Opens ${nextTradingDayName} 4 AM ET`;
  }
}

/**
 * Check if we're in the weekend warning window for open shorts
 * Returns info about weekend gap risk
 */
export function getWeekendWarning(): { isWarning: boolean; message: string; hoursUntilClose: number } {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  // Convert to ET (UTC-5 for EST, simplified)
  const etHour = (utcHour - 5 + 24) % 24;
  const etDay = utcHour < 5 ? (utcDay - 1 + 7) % 7 : utcDay;

  // Friday = 5 in JS Date
  const isFriday = etDay === 5;
  const isSaturday = etDay === 6;
  const isSunday = etDay === 0;

  // Market closes at 8 PM ET on Friday
  const MARKET_CLOSE_ET = 20;

  if (isSaturday || isSunday) {
    return {
      isWarning: true,
      message: 'Weekend - market closed until Monday 4 AM ET',
      hoursUntilClose: 0,
    };
  }

  if (isFriday) {
    const hoursUntilClose = MARKET_CLOSE_ET - etHour - (utcMinute / 60);

    if (etHour >= MARKET_CLOSE_ET) {
      return {
        isWarning: true,
        message: 'Market closed - weekend gap risk until Monday',
        hoursUntilClose: 0,
      };
    }

    // Warning if less than 4 hours until close on Friday
    if (hoursUntilClose <= 4) {
      return {
        isWarning: true,
        message: `Friday close in ${hoursUntilClose.toFixed(1)}h - weekend gap risk`,
        hoursUntilClose,
      };
    }

    // Softer warning if afternoon Friday (after noon)
    if (etHour >= 12) {
      return {
        isWarning: true,
        message: `Friday afternoon - ${hoursUntilClose.toFixed(1)}h until weekend`,
        hoursUntilClose,
      };
    }
  }

  return {
    isWarning: false,
    message: '',
    hoursUntilClose: -1,
  };
}

/**
 * Holiday status info for trading decisions
 */
export interface HolidayStatus {
  isHoliday: boolean;
  eventName?: string;
  isEarlyClose?: boolean;
  tradingHours?: string;
}

/**
 * Check if today is a market holiday
 * Uses Finnhub calendar API (cached for 24 hours)
 */
export async function getMarketHolidayStatus(): Promise<HolidayStatus> {
  const stockFeed = getStockFeed();
  return await stockFeed.isMarketHoliday();
}

/**
 * Get pool config (for external use)
 */
export function getPoolConfig(): PoolConfig | null {
  return poolConfig;
}

/**
 * Get Flash Trade client (for external use)
 */
export function getFlashClient(): PerpetualsClient | null {
  return flashClient;
}
