/**
 * Web Dashboard Server for Parallax
 * Serves trading data and logs via HTTP for remote monitoring
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { getDatabase } from '../db';
import { fetchHeatmapSummary, fetchDiscountHeatmapFromSupabase, fetchRecentClosedPositions, fetchClosedPositions, fetchStatsFromSupabase, fetchPnlHistoryFromSupabase } from '../db/supabaseClient';
import { getRiskManager } from '../risk';
import { getConfigSync } from '../config';
import { getAllThresholds, getExitThreshold, getTokenFeeRate, getEntryThreshold } from '../liquidity/liquidityChecker';
import { getExecutor } from '../execution/executor';
import { getJupiterClient } from '../execution';
import { USDC_MINT } from '../constants';
import { getWatchlist, getTrailingStopState } from '../signals/meanReversionSignal';
import { getPremiumWatchlist, getOpenShortPositions, getClosedShortPositions, getPremiumThresholds } from '../signals/premiumShortSignal';
import { isShortingEnabled, isEquityMarketOpen, getTimeUntilMarketOpen, getOraclePrice, FlashSymbol, getWeekendWarning, getMarketHolidayStatus, HolidayStatus } from '../execution/flashTradeClient';
import { getEndpointStats } from '../feeds/endpointTracker';
import { getStockFeed } from '../feeds/stockFeed';
import logger from '../logger';
import { convertMarkdownToHtml } from './utils/markdown';
import {
  checkAdminAuth,
  hasValidSession,
  createSession,
  buildSessionCookie,
  buildClearSessionCookie,
} from './utils/auth';
import { getDashboardHTML } from './templates/dashboard';

// Cache wallet balance to avoid RPC spam (update every 5 minutes)
let cachedWalletBalance: { sol: number; usdc: number; solPriceUsd: number; totalUsd: number; timestamp: number } | null = null;
const WALLET_CACHE_MS = 5 * 60 * 1000; // 5 minutes

// Cache SOL price to avoid excessive API calls
let cachedSolPrice: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_MS = 60 * 1000; // 1 minute

/**
 * Fetch SOL price from Jupiter
 */
async function fetchSolPrice(): Promise<number> {
  const now = Date.now();

  // Return cached price if fresh
  if (cachedSolPrice && (now - cachedSolPrice.timestamp) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice.price;
  }

  try {
    // Use quote-based pricing: get how much SOL 1 USDC buys, then invert
    const headers: Record<string, string> = {};
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    if (jupiterApiKey) {
      headers['x-api-key'] = jupiterApiKey;
    }
    const response = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000', {
      headers,
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    const data = await response.json() as { outAmount?: string };
    const solLamports = parseInt(data?.outAmount || '0', 10);

    if (solLamports > 0) {
      // 1 USDC (1e6 lamports) buys X SOL lamports
      // Price = 1 / (solLamports / 1e9) = 1e9 / solLamports
      const price = 1_000_000_000 / solLamports;
      cachedSolPrice = { price, timestamp: now };
      return price;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch SOL price from Jupiter');
  }

  // Return cached price if available, otherwise use fallback
  return cachedSolPrice?.price || 180; // $180 fallback
}

/**
 * Get cached wallet balance or fetch fresh data
 */
async function getWalletBalance(): Promise<{ sol: number; usdc: number; solPriceUsd: number; totalUsd: number } | null> {
  const now = Date.now();

  // Return cached data if still fresh
  if (cachedWalletBalance && (now - cachedWalletBalance.timestamp) < WALLET_CACHE_MS) {
    return cachedWalletBalance;
  }

  try {
    const executor = getExecutor();
    const balance = await executor.getBalance();

    if (!balance) {
      return null;
    }

    const solPriceUsd = await fetchSolPrice();
    const solValueUsd = balance.sol * solPriceUsd;
    const totalUsd = balance.usdc + solValueUsd;

    cachedWalletBalance = {
      sol: balance.sol,
      usdc: balance.usdc,
      solPriceUsd,
      totalUsd,
      timestamp: now,
    };

    return cachedWalletBalance;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch wallet balance');
    return cachedWalletBalance; // Return stale cache on error
  }
}

const app = express();
const DEFAULT_PORT = 3000;

// Serve static files from public folder
app.use('/public', express.static(path.join(process.cwd(), 'public')));

/**
 * Calculate timestamp for time range filter
 */
function getTimeRangeTimestamp(range: string): number | undefined {
  const now = Date.now();
  switch (range) {
    case '6H': return now - 6 * 60 * 60 * 1000; // 6 hours
    case '12H': return now - 12 * 60 * 60 * 1000; // 12 hours
    case 'D': return now - 24 * 60 * 60 * 1000; // 1 day
    case 'W': return now - 7 * 24 * 60 * 60 * 1000; // 1 week
    case 'M': return now - 30 * 24 * 60 * 60 * 1000; // 30 days
    case 'Y': return now - 365 * 24 * 60 * 60 * 1000; // 1 year
    case 'ALL': return undefined; // All time
    default: return undefined;
  }
}

// Cache for oracle prices (to avoid spamming Pyth on every dashboard refresh)
const oraclePriceCache: Map<string, { price: number; timestamp: number }> = new Map();
const ORACLE_PRICE_CACHE_MS = 10 * 1000; // 10 seconds

/**
 * Get oracle price with caching
 */
async function getCachedOraclePrice(symbol: FlashSymbol): Promise<number | null> {
  const cached = oraclePriceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < ORACLE_PRICE_CACHE_MS) {
    return cached.price;
  }

  const price = await getOraclePrice(symbol);
  if (price !== null) {
    oraclePriceCache.set(symbol, { price, timestamp: Date.now() });
  }
  return price;
}

// Cache for exit quotes (to get real-time exit value estimates)
// Key: positionId, Value: { outputUsdc, timestamp }
const exitQuoteCache: Map<string, { outputUsdc: number; timestamp: number }> = new Map();
const EXIT_QUOTE_CACHE_MS = 30 * 1000; // 30 seconds

/**
 * Get cached exit quote for a position
 * Returns the estimated USDC output if we sold the tokens now
 */
async function getCachedExitQuote(
  positionId: string,
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals: number
): Promise<number | null> {
  const cached = exitQuoteCache.get(positionId);
  if (cached && Date.now() - cached.timestamp < EXIT_QUOTE_CACHE_MS) {
    return cached.outputUsdc;
  }

  try {
    const jupiterClient = getJupiterClient();
    const rawAmount = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));
    const quote = await jupiterClient.getQuote(tokenMint, USDC_MINT, rawAmount, 100); // 1% slippage

    if (quote && quote.outputAmount) {
      const outputUsdc = quote.outputAmount / 1e6; // USDC has 6 decimals
      exitQuoteCache.set(positionId, { outputUsdc, timestamp: Date.now() });
      return outputUsdc;
    }
  } catch (error) {
    logger.debug({ positionId, error }, 'Failed to get exit quote');
  }

  return null;
}

/**
 * Get API data for the dashboard
 */
async function getDashboardData(timeRange: string = 'ALL') {
  const database = getDatabase();
  const riskManager = getRiskManager();
  const config = getConfigSync();

  const sinceTimestamp = getTimeRangeTimestamp(timeRange);
  // Use Supabase for stats (production source of truth)
  const stats = await fetchStatsFromSupabase(sinceTimestamp);
  const rawOpenPositions = await database.getOpenPositions();
  // Fetch closed positions from Supabase (has correct exit reasons)
  const closedPositions = await fetchRecentClosedPositions(10, 24 * 60 * 60 * 1000); // 10 max, within 24h
  const closedShortPositions = await getClosedShortPositions(10);
  // Use Supabase for PnL history (production source of truth)
  const pnlHistory = await fetchPnlHistoryFromSupabase(sinceTimestamp);
  const riskSummary = riskManager.getSummary();
  const thresholds = getAllThresholds();

  // Get holiday status early (needed for market status)
  const holidayStatus: HolidayStatus = await getMarketHolidayStatus();
  const isFullDayHoliday = holidayStatus.isHoliday && !holidayStatus.isEarlyClose;
  const marketIsOpen = riskManager.isMarketOpen() && !isFullDayHoliday;
  const marketSession = isFullDayHoliday ? 'closed' : riskManager.getMarketSession();

  // Calculate return percentage
  const returnPct = stats.totalInvestedUsd > 0
    ? (stats.totalPnlUsd / stats.totalInvestedUsd) * 100
    : 0;

  // Get watchlist from signal generator (cached in memory during batch calculations)
  let watchlist = getWatchlist();

  // Sync watchlist discount values with database for tokens that have open positions
  // This ensures consistency between open positions panel and watchlist display
  const openPositionSymbols = new Set(rawOpenPositions.map(p => p.buySymbol));
  if (openPositionSymbols.size > 0) {
    watchlist = await Promise.all(watchlist.map(async (w) => {
      if (openPositionSymbols.has(w.symbol)) {
        const latestDiscount = await database.getLatestDiscount(w.ticker, w.symbol);
        if (latestDiscount) {
          return {
            ...w,
            discount: latestDiscount.discount,
            tokenPrice: latestDiscount.tokenPrice,
            stockPrice: latestDiscount.stockPrice,
            gap: w.entryThreshold - latestDiscount.discount,
          };
        }
      }
      return w;
    }));
  }

  // Get premium watchlist and short positions (for shorting feature)
  const premiumWatchlist = isShortingEnabled() ? getPremiumWatchlist() : [];
  const openShortPositions = isShortingEnabled() ? await getOpenShortPositions() : [];

  // Process long positions to get unrealized PnL (needed for chart)
  const processedLongPositions = await Promise.all(rawOpenPositions.map(async p => {
    const latestDiscount = await database.getLatestDiscount(p.stockTicker, p.buySymbol);
    const watchlistItem = watchlist.find(w => w.symbol === p.buySymbol);
    const currentDiscount = latestDiscount?.discount ?? watchlistItem?.discount ?? p.entrySpreadPct;
    const entryTokenPrice = p.buyAmount > 0 ? p.sizeUsd / p.buyAmount : 0;
    const exitThresholdPct = getExitThreshold(p.buySymbol);
    const exitTargetPrice = entryTokenPrice * (1 + exitThresholdPct / 100);
    const currentTokenPrice = latestDiscount?.tokenPrice ?? watchlistItem?.tokenPrice ?? entryTokenPrice;
    const tokenAppreciationPct = entryTokenPrice > 0
      ? ((currentTokenPrice - entryTokenPrice) / entryTokenPrice) * 100
      : 0;
    // Use stored entry stock price if available, otherwise look up historical data or back-calculate
    const entryDiscountData = await database.getDiscountAtTimestamp(p.stockTicker, p.buySymbol, p.entryTimestamp);
    const entryStockPrice = p.entryStockPrice ?? entryDiscountData?.stockPrice ?? (entryTokenPrice / (1 - p.entrySpreadPct / 100));
    // Get current stock price from discount history, watchlist, or stock feed cache
    const stockFeedPrice = getStockFeed().getCachedPrice(p.stockTicker);
    const currentStockPrice = latestDiscount?.stockPrice ?? watchlistItem?.stockPrice ?? stockFeedPrice?.price;
    const stockAppreciationPct = (entryStockPrice > 0 && currentStockPrice && currentStockPrice > 0)
      ? ((currentStockPrice - entryStockPrice) / entryStockPrice) * 100
      : 0;
    const actualEntryFeesUsd = p.entryFeesUsd ?? (p.sizeUsd * 0.003);
    const tokenDecimals = p.buyDecimals ?? 9;
    const exitQuoteUsdc = await getCachedExitQuote(p.id, p.buyMint, p.buyAmount, tokenDecimals);
    let unrealizedPnlUsd: number;
    if (exitQuoteUsdc !== null) {
      unrealizedPnlUsd = exitQuoteUsdc - p.sizeUsd - actualEntryFeesUsd;
    } else {
      const currentValue = p.buyAmount * currentTokenPrice;
      const tokenFeeRate = getTokenFeeRate(p.buySymbol);
      const exitFeeRate = tokenFeeRate + 0.002;
      const estimatedExitFeeUsd = currentValue * exitFeeRate;
      unrealizedPnlUsd = currentValue - p.sizeUsd - actualEntryFeesUsd - estimatedExitFeeUsd;
    }
    const unrealizedPnlPct = p.sizeUsd > 0 ? (unrealizedPnlUsd / p.sizeUsd) * 100 : 0;
    const trailingState = getTrailingStopState(p.id);
    return {
      id: p.id,
      type: 'long' as const,
      ticker: p.stockTicker,
      symbol: p.buySymbol,
      mint: p.buyMint,
      entryDiscount: p.entrySpreadPct,
      currentDiscount,
      entryTokenPrice,
      currentTokenPrice,
      exitTargetPrice,
      exitThresholdPct,
      tokenAppreciationPct,
      stockAppreciationPct,
      sizeUsd: p.sizeUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      holdTimeMs: Date.now() - p.entryTimestamp,
      entryTimestamp: p.entryTimestamp,
      entryTxSignature: p.entryTxSignature,
      trailingStopActive: trailingState?.active ?? false,
      trailingStopPeakPct: trailingState?.peakPct ?? null,
      leverage: 1,
    };
  }));

  // Process short positions to get unrealized PnL
  const processedShortPositions = await Promise.all(openShortPositions.map(async p => {
    const watchlistItem = premiumWatchlist.find(w => w.ticker === p.ticker);
    const currentPremiumPct = watchlistItem ? watchlistItem.premiumPct : Math.abs(p.entryPremiumPct);
    const entryPremiumPct = Math.abs(p.entryPremiumPct);
    const currentOraclePrice = await getCachedOraclePrice(p.flashSymbol as FlashSymbol);
    const currentStockPrice = watchlistItem?.stockPrice ?? p.entryStockPrice;
    const stockAppreciationPct = p.entryStockPrice > 0
      ? ((currentStockPrice - p.entryStockPrice) / p.entryStockPrice) * 100
      : 0;
    const premiumThresholds = getPremiumThresholds(p.ticker);
    const exitPremiumPct = Math.abs(premiumThresholds.exitPct);
    const premiumDropNeeded = entryPremiumPct - exitPremiumPct;
    const premiumDropAchieved = entryPremiumPct - currentPremiumPct;
    const sizeUsd = p.collateralUsd; // Show actual capital invested, not leveraged notional
    let pnlPct = 0;
    if (currentOraclePrice && p.entryStockPrice > 0) {
      const priceChange = (p.entryStockPrice - currentOraclePrice) / p.entryStockPrice;
      pnlPct = priceChange * p.leverage * 100;
    }
    const pnlUsd = p.collateralUsd * (pnlPct / 100);
    return {
      id: p.id,
      type: 'short' as const,
      ticker: p.ticker,
      symbol: p.flashSymbol,
      mint: '',
      entryDiscount: entryPremiumPct,
      currentDiscount: currentPremiumPct,
      entryTokenPrice: p.entryStockPrice,
      currentTokenPrice: currentOraclePrice ?? currentStockPrice,
      exitTargetPrice: exitPremiumPct,
      exitThresholdPct: premiumDropNeeded,
      tokenAppreciationPct: premiumDropAchieved,
      stockAppreciationPct,
      sizeUsd,
      unrealizedPnlUsd: pnlUsd,
      unrealizedPnlPct: pnlPct,
      holdTimeMs: Date.now() - p.entryTimestamp,
      entryTimestamp: p.entryTimestamp,
      entryTxSignature: p.entryTxSignature,
      trailingStopActive: false,
      trailingStopPeakPct: null,
      leverage: p.leverage,
    };
  }));

  // PnL chart shows only settled/realized PnL (no unrealized)
  // Unrealized PnL is shown separately in the open positions table

  return {
    timestamp: new Date().toISOString(),
    mode: config.mode,
    marketStatus: {
      isOpen: marketIsOpen,
      session: marketSession,
      source: 'local_schedule',
    },
    stats: {
      ...stats,
      returnPct,
    },
    pnlHistory,
    risk: {
      killSwitch: riskSummary.killSwitch,
      dailyLoss: riskSummary.dailyLoss,
      todayTrades: stats.todayTrades,
      avgDailyTrades: stats.avgDailyTrades,
      disabledTokens: riskSummary.disabledTokens,
    },
    watchlist,
    premiumWatchlist,
    openShortPositions,
    shortingEnabled: isShortingEnabled(),
    equityMarketOpen: isEquityMarketOpen() && !(holidayStatus.isHoliday && !holidayStatus.isEarlyClose),
    timeUntilMarketOpen: await getTimeUntilMarketOpen(),
    weekendWarning: getWeekendWarning(),
    holidayStatus,
    premiumThresholds: getPremiumThresholds(),
    // Use pre-processed positions (computed above for chart PnL)
    openPositions: [...processedLongPositions, ...processedShortPositions].sort((a, b) => {
      const progressA = a.exitThresholdPct > 0 ? a.tokenAppreciationPct / a.exitThresholdPct : 0;
      const progressB = b.exitThresholdPct > 0 ? b.tokenAppreciationPct / b.exitThresholdPct : 0;
      return progressB - progressA;
    }),
    recentTrades: [
      // Long trades (from Supabase - has correct exit reasons)
      ...closedPositions.map(p => ({
        id: p.id,
        type: 'long' as const,
        ticker: p.stock_ticker,
        symbol: p.buy_symbol,
        mint: p.buy_mint,
        entryDiscount: p.entry_spread_pct,
        exitDiscount: p.exit_spread_pct,
        sizeUsd: p.size_usd,
        pnlUsd: p.pnl_usd,
        pnlPct: p.pnl_pct,
        exitReason: p.exit_reason,
        holdTimeMs: (p.exit_timestamp || Date.now()) - p.entry_timestamp,
        entryTimestamp: p.entry_timestamp,
        exitTimestamp: p.exit_timestamp,
        entryTxSignature: p.entry_tx_signature,
        exitTxSignature: p.exit_tx_signature,
        leverage: 1, // Spot positions have no leverage
      })),
      // Short trades (from database)
      ...closedShortPositions.map(p => ({
        id: p.id,
        type: 'short' as const,
        ticker: p.ticker,
        symbol: p.flashSymbol,
        mint: '', // No mint for shorts
        entryDiscount: Math.abs(p.entryPremiumPct), // Show as positive premium
        exitDiscount: Math.abs(p.exitPremiumPct || 0),
        sizeUsd: p.collateralUsd, // Actual capital invested, not leveraged notional
        pnlUsd: p.pnlUsd || 0,
        pnlPct: p.pnlPct || 0,
        exitReason: p.exitReason || 'unknown',
        holdTimeMs: (p.exitTimestamp || Date.now()) - p.entryTimestamp,
        entryTimestamp: p.entryTimestamp,
        exitTimestamp: p.exitTimestamp,
        entryTxSignature: p.entryTxSignature,
        exitTxSignature: p.exitTxSignature,
        leverage: p.leverage,
      })),
    ].sort((a, b) => (b.exitTimestamp || 0) - (a.exitTimestamp || 0)).slice(0, 10),
    tokens: thresholds.map(t => ({
      symbol: t.symbol,
      enabled: t.enabled,
      tvl: t.tvl,
      entryThreshold: getEntryThreshold(t.symbol), // Use algorithmic threshold, not just TVL-based
    })),
  };
}

// API endpoint for dashboard data
app.get('/api/dashboard', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.range as string) || 'ALL';
    // Return cached dashboard data if fresh
    if (dashboardCache && dashboardCache.timeRange === timeRange && Date.now() - dashboardCache.timestamp < DASHBOARD_CACHE_MS) {
      return res.json(dashboardCache.data);
    }
    const data = await getDashboardData(timeRange);
    dashboardCache = { data, timestamp: Date.now(), timeRange };
    res.json(data);
  } catch (error) {
    logger.error({
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        code: (error as unknown as { code?: string }).code,
      } : error
    }, 'Error fetching dashboard data');
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// API endpoint for wallet balance
app.get('/api/wallet', async (_req: Request, res: Response) => {
  try {
    const balance = await getWalletBalance();
    res.json(balance || { sol: 0, usdc: 0, solPriceUsd: 0, totalUsd: 0 });
  } catch (error) {
    logger.error({ error }, 'Error fetching wallet balance');
    res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
});

// API endpoint for log file tail (last N lines from disk)
// Uses efficient tail-based reading for large files
app.get('/api/logs/file', (req: Request, res: Response) => {
  const lines = parseInt(req.query.lines as string) || 100;
  const minLevel = parseInt(req.query.level as string) || 0;
  const logPath = path.join(process.cwd(), 'logs', 'parallax.log');

  try {
    if (!fs.existsSync(logPath)) {
      res.json([]);
      return;
    }

    // Read last chunk of file (much faster for large files)
    const stats = fs.statSync(logPath);
    const fileSize = stats.size;
    // Read last 500KB max (enough for ~1000+ log lines)
    const chunkSize = Math.min(fileSize, 500 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, chunkSize, fileSize - chunkSize);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    // Find first complete line (skip partial line at start)
    const firstNewline = content.indexOf('\n');
    const cleanContent = firstNewline > 0 ? content.slice(firstNewline + 1) : content;
    const allLines = cleanContent.trim().split('\n');

    // Parse and filter by level if specified
    const parsedLogs: unknown[] = [];
    // Read from end of file to get most recent logs first
    for (let i = allLines.length - 1; i >= 0 && parsedLogs.length < lines; i--) {
      try {
        const log = JSON.parse(allLines[i]);
        if (log.level >= minLevel) {
          parsedLogs.push(log);
        }
      } catch {
        // Skip unparseable lines when filtering
        if (minLevel === 0) {
          parsedLogs.push({ msg: allLines[i], level: 30, time: Date.now() });
        }
      }
    }

    res.json(parsedLogs);
  } catch (error) {
    logger.error({ error }, 'Error reading log file');
    res.status(500).json({ error: 'Failed to read log file' });
  }
});

// ==================== ADMIN ENDPOINTS ====================
// Protected by ADMIN_TOKEN environment variable or valid session cookie

// POST /api/admin/login - Verify token and create session with cookie
app.post('/api/admin/login', express.json(), (req: Request, res: Response) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(500).json({ error: 'ADMIN_TOKEN not configured on server' });
    return;
  }

  const { token } = req.body as { token?: string };
  if (token !== adminToken) {
    res.status(401).json({ error: 'Invalid admin token' });
    return;
  }

  // Create new session and set cookie
  const sessionId = createSession();
  res.setHeader('Set-Cookie', buildSessionCookie(sessionId));
  res.json({ success: true, message: 'Logged in successfully', expiresIn: '30 days' });

  logger.info('Admin session created via login');
});

// POST /api/admin/logout - Clear session cookie
app.post('/api/admin/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', buildClearSessionCookie());
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/admin/check-session - Check if current session is valid
app.get('/api/admin/check-session', (req: Request, res: Response) => {
  const isValid = hasValidSession(req);
  res.json({ authenticated: isValid });
});

// GET /api/admin/status - Get kill switch and risk status
app.get('/api/admin/status', (req: Request, res: Response) => {
  if (!checkAdminAuth(req, res)) return;

  const riskManager = getRiskManager();
  const summary = riskManager.getSummary();

  res.json({
    killSwitchActive: summary.killSwitch,
    dailyLossUsd: summary.dailyLoss,
    dailyTradeCount: summary.dailyTrades,
    disabledTokens: summary.disabledTokens,
    timestamp: Date.now(),
  });
});

// POST /api/admin/reset-kill-switch - Reset the kill switch
app.post('/api/admin/reset-kill-switch', (req: Request, res: Response) => {
  if (!checkAdminAuth(req, res)) return;

  const riskManager = getRiskManager();
  const wasActive = riskManager.isKillSwitchActive();

  riskManager.deactivateKillSwitch();

  logger.warn({ wasActive }, 'Kill switch reset via admin API');

  res.json({
    success: true,
    message: wasActive ? 'Kill switch deactivated' : 'Kill switch was not active',
    killSwitchActive: false,
  });
});

// POST /api/admin/restart - Restart the PM2 process
app.post('/api/admin/restart', (req: Request, res: Response) => {
  if (!checkAdminAuth(req, res)) return;

  logger.warn('PM2 restart requested via admin API');

  // Send response before restarting
  res.json({
    success: true,
    message: 'Restart initiated - bot will restart in 2 seconds',
  });

  // Delay restart to allow response to be sent
  setTimeout(() => {
    exec('pm2 restart parallax', (error, stdout, stderr) => {
      if (error) {
        logger.error({ error, stderr }, 'PM2 restart failed');
      } else {
        logger.info({ stdout }, 'PM2 restart successful');
      }
    });
  }, 2000);
});

// POST /api/admin/enable-token - Re-enable a disabled token
app.post('/api/admin/enable-token', express.json(), (req: Request, res: Response) => {
  if (!checkAdminAuth(req, res)) return;

  const { symbol } = req.body as { symbol?: string };
  if (!symbol) {
    res.status(400).json({ error: 'Missing symbol parameter' });
    return;
  }

  const riskManager = getRiskManager();
  riskManager.enableToken(symbol);

  logger.warn({ symbol }, 'Token re-enabled via admin API');

  res.json({
    success: true,
    message: `Token ${symbol} re-enabled`,
  });
});

// GET /api/admin/endpoints - Get API endpoint usage stats
app.get('/api/admin/endpoints', (req: Request, res: Response) => {
  if (!checkAdminAuth(req, res)) return;

  const stats = getEndpointStats();
  res.json({
    endpoints: stats,
    timestamp: Date.now(),
  });
});

// API endpoint for blog content (MARKET_LEARNINGS.md)
app.get('/api/blog', (_req: Request, res: Response) => {
  try {
    const blogPath = path.join(process.cwd(), 'MARKET_LEARNINGS.md');
    if (!fs.existsSync(blogPath)) {
      res.json({ html: '<p>Blog content not found.</p>' });
      return;
    }

    const markdown = fs.readFileSync(blogPath, 'utf-8');
    const html = convertMarkdownToHtml(markdown);
    res.json({ html });
  } catch (error) {
    logger.error({ error }, 'Error reading blog content');
    res.status(500).json({ error: 'Failed to read blog content' });
  }
});

// Cache for GitHub commits (refresh every 5 minutes)
let cachedCommits: { data: unknown[]; timestamp: number } | null = null;
const COMMITS_CACHE_MS = 5 * 60 * 1000;

// API endpoint for GitHub commits
app.get('/api/commits', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();

    // Return cached data if fresh
    if (cachedCommits && (now - cachedCommits.timestamp) < COMMITS_CACHE_MS) {
      res.json({ commits: cachedCommits.data });
      return;
    }

    // Fetch commits from GitHub API (private repo, auth required)
    const ghToken = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Parallax-Dashboard'
    };
    if (ghToken) {
      headers['Authorization'] = `Bearer ${ghToken}`;
    }
    const response = await fetch('https://api.github.com/repos/609NFT/parallax/commits?per_page=30', {
      headers
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const commits = await response.json() as Array<{
      sha: string;
      commit: {
        message: string;
        author: { name: string; date: string };
      };
      author?: { login: string; avatar_url: string; html_url: string } | null;
      html_url: string;
    }>;

    // Transform to simpler format
    const simplifiedCommits = commits.map(c => ({
      sha: c.sha.substring(0, 7),
      fullSha: c.sha,
      message: c.commit.message.split('\n')[0], // First line only
      date: c.commit.author.date,
      author: c.author ? {
        login: c.author.login,
        avatar: c.author.avatar_url,
        url: c.author.html_url
      } : {
        login: c.commit.author.name,
        avatar: null,
        url: null
      },
      url: c.html_url
    }));

    // Cache the result
    cachedCommits = { data: simplifiedCommits, timestamp: now };

    res.json({ commits: simplifiedCommits });
  } catch (error) {
    logger.error({ error }, 'Error fetching GitHub commits');
    res.status(500).json({ error: 'Failed to fetch commits' });
  }
});

// Cache for heatmap data — longer TTL for older data ranges
const heatmapCache: Map<string, { data: unknown; timestamp: number }> = new Map();
const HEATMAP_CACHE_MS: Record<string, number> = {
  '1h': 2 * 60 * 1000,    // 2 min — needs freshness
  '4h': 5 * 60 * 1000,    // 5 min
  '24h': 10 * 60 * 1000,  // 10 min — old data doesn't change
  '7d': 30 * 60 * 1000,   // 30 min — heavy query, data is static
  'all': 30 * 60 * 1000,  // 30 min
};
const DEFAULT_HEATMAP_CACHE_MS = 5 * 60 * 1000;

// Cache for dashboard API data (avoid repeated Supabase queries)
let dashboardCache: { data: unknown; timestamp: number; timeRange: string } | null = null;
const DASHBOARD_CACHE_MS = 30 * 1000; // 30 seconds

// Pre-warm heatmap cache for instant loading
// Only prewarm 24H (default view) on startup - others lazy-load on demand
// 7d query is slow (~2s) on large datasets, so skip it for faster startup
async function prewarmHeatmapCache(): Promise<void> {
  const ranges = ['24h'];  // Only prewarm default view for fast startup
  const mobileOptions = [false, true];

  logger.info('Pre-warming heatmap cache (24H only for fast startup)...');

  for (const range of ranges) {
    for (const isMobile of mobileOptions) {
      try {
        const cacheKey = `${range}-${isMobile}`;

        let sinceTimestamp: number;
        let bucketMinutes: number;

        switch (range) {
          case '1h':
            sinceTimestamp = Date.now() - 60 * 60 * 1000;
            bucketMinutes = isMobile ? 5 : 1;
            break;
          case '4h':
            sinceTimestamp = Date.now() - 4 * 60 * 60 * 1000;
            bucketMinutes = isMobile ? 15 : 5;
            break;
          case '24h':
            sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000;
            bucketMinutes = isMobile ? 60 : 15;
            break;
          case '7d':
            sinceTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
            bucketMinutes = isMobile ? 240 : 60;
            break;
          default:
            sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000;
            bucketMinutes = isMobile ? 60 : 15;
        }

        const db = getDatabase();
        const data = await db.getDiscountHeatmapData(sinceTimestamp, bucketMinutes);

        // Filter to only show enabled tokens
        const enabledSymbols = new Set(
          getAllThresholds()
            .filter(t => t.enabled)
            .map(t => t.symbol)
        );

        const filteredIndices: number[] = [];
        const filteredSymbols: string[] = [];
        for (let i = 0; i < data.symbols.length; i++) {
          if (enabledSymbols.has(data.symbols[i])) {
            filteredIndices.push(i);
            filteredSymbols.push(data.symbols[i]);
          }
        }
        const filteredData = filteredIndices.map(i => data.data[i]);

        // Get holiday data
        const { getStockFeed } = await import('../feeds');
        const stockFeed = getStockFeed();
        const holidays = await stockFeed.fetchMarketHolidays();

        const holidayDates: { date: string; name: string; isEarlyClose: boolean; tradingHours?: string }[] = [];
        const startDate = new Date(sinceTimestamp || data.timestamps[0] || Date.now());
        const endDate = new Date();
        const startDateStr = startDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const endDateStr = endDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        for (const h of holidays) {
          if (h.atDate >= startDateStr && h.atDate <= endDateStr) {
            holidayDates.push({
              date: h.atDate,
              name: h.eventName,
              isEarlyClose: h.tradingHour !== '',
              tradingHours: h.tradingHour || undefined
            });
          }
        }

        const response = {
          symbols: filteredSymbols,
          timestamps: data.timestamps,
          data: filteredData,
          range,
          bucketMinutes,
          holidays: holidayDates
        };

        heatmapCache.set(cacheKey, { data: response, timestamp: Date.now() });
        logger.debug({ range, isMobile }, 'Pre-warmed heatmap cache');
      } catch (error) {
        logger.warn({ error, range, isMobile }, 'Failed to pre-warm heatmap cache');
      }
    }
  }

  logger.info({ ranges: ranges.length * mobileOptions.length }, 'Heatmap cache pre-warming complete');
}

// API endpoint for discount heatmap data
app.get('/api/heatmap', async (req: Request, res: Response) => {
  try {
    const range = req.query.range as string || '24h';
    const isMobile = req.query.mobile === 'true';
    const cacheKey = `${range}-${isMobile}`;

    // Check cache first
    const cached = heatmapCache.get(cacheKey);
    const cacheTtl = HEATMAP_CACHE_MS[range] || DEFAULT_HEATMAP_CACHE_MS;
    if (cached && Date.now() - cached.timestamp < cacheTtl) {
      return res.json(cached.data);
    }

    let sinceTimestamp: number;
    let bucketMinutes: number;
    let usePreAggregated: boolean;

    // All ranges now use Supabase (discount_history is only written to Supabase)
    // Short ranges (1h, 4h) query raw discount_history with custom bucket size
    // Long ranges (24h, 7d) use pre-aggregated hourly data for speed
    switch (range) {
      case '1h':
        sinceTimestamp = Date.now() - 60 * 60 * 1000;
        bucketMinutes = isMobile ? 5 : 2;  // 12 or 30 columns
        usePreAggregated = false;
        break;
      case '4h':
        sinceTimestamp = Date.now() - 4 * 60 * 60 * 1000;
        bucketMinutes = isMobile ? 15 : 5;  // 16 or 48 columns
        usePreAggregated = false;
        break;
      case '24h':
        sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000;
        bucketMinutes = 60;  // 24 columns (hourly from Supabase)
        usePreAggregated = true;
        break;
      case '7d':
        sinceTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
        bucketMinutes = 60;  // 168 columns (hourly from Supabase)
        usePreAggregated = true;
        break;
      case 'all':
        sinceTimestamp = 0;
        bucketMinutes = 60;
        usePreAggregated = true;
        break;
      default:
        // Default to 24h
        sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000;
        bucketMinutes = 60;
        usePreAggregated = true;
    }

    let data: { symbols: string[]; timestamps: number[]; data: (number | null)[][] };

    if (usePreAggregated) {
      // Use pre-aggregated Supabase data for long ranges (fast queries)
      data = await fetchHeatmapSummary(sinceTimestamp);
      logger.debug({ range, symbols: data.symbols.length, timestamps: data.timestamps.length }, 'Using pre-aggregated Supabase for heatmap');
    } else {
      // Query raw discount_history from Supabase with custom bucket size
      data = await fetchDiscountHeatmapFromSupabase(sinceTimestamp, bucketMinutes);
      logger.debug({ range, bucketMinutes, symbols: data.symbols.length, timestamps: data.timestamps.length }, 'Using raw Supabase for heatmap');
    }

    // Filter to only show enabled tokens (those with sufficient TVL/liquidity)
    const enabledSymbols = new Set(
      getAllThresholds()
        .filter(t => t.enabled)
        .map(t => t.symbol)
    );

    // Filter symbols and data arrays to only include enabled tokens
    const filteredIndices: number[] = [];
    const filteredSymbols: string[] = [];
    for (let i = 0; i < data.symbols.length; i++) {
      if (enabledSymbols.has(data.symbols[i])) {
        filteredIndices.push(i);
        filteredSymbols.push(data.symbols[i]);
      }
    }
    const filteredData = filteredIndices.map(i => data.data[i]);

    // Get holiday data for the date range
    const { getStockFeed } = await import('../feeds');
    const stockFeed = getStockFeed();
    const holidays = await stockFeed.fetchMarketHolidays();

    // Filter to relevant date range and format for client
    // Compare by date string only (not time) to ensure holidays are included regardless of time range
    const holidayDates: { date: string; name: string; isEarlyClose: boolean; tradingHours?: string }[] = [];
    const startDate = new Date(sinceTimestamp || data.timestamps[0] || Date.now());
    const endDate = new Date();

    // Get date strings in ET for proper comparison
    const startDateStr = startDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const endDateStr = endDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    for (const h of holidays) {
      // Compare date strings directly (h.atDate is already YYYY-MM-DD format)
      if (h.atDate >= startDateStr && h.atDate <= endDateStr) {
        holidayDates.push({
          date: h.atDate,
          name: h.eventName,
          isEarlyClose: h.tradingHour !== '',
          tradingHours: h.tradingHour || undefined
        });
      }
    }

    const response = {
      symbols: filteredSymbols,
      timestamps: data.timestamps,
      data: filteredData,
      range,
      bucketMinutes,
      holidays: holidayDates
    };

    // Cache the result
    heatmapCache.set(cacheKey, { data: response, timestamp: Date.now() });

    res.json(response);
  } catch (error) {
    logger.error({ error }, 'Error computing heatmap');
    res.status(500).json({ error: 'Failed to compute heatmap' });
  }
});

// Cache for trades endpoint (30s TTL)
const tradesCache: Map<string, { data: unknown; timestamp: number }> = new Map();
const TRADES_CACHE_MS = 30 * 1000; // 30 seconds

// Cache for analytics endpoint (60s TTL)
const analyticsCache: Map<string, { data: unknown; timestamp: number }> = new Map();
const ANALYTICS_CACHE_MS = 60 * 1000; // 60 seconds

// GET /api/trades - Trade history endpoint
app.get('/api/trades', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const token = req.query.token as string;
    const since = req.query.since ? Number(req.query.since) : undefined;
    
    const cacheKey = `${limit}-${token || 'all'}-${since || 'all'}`;
    
    // Check cache first
    const cached = tradesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TRADES_CACHE_MS) {
      return res.json(cached.data);
    }

    // Fetch positions with larger limit to filter afterwards
    const positions = await fetchClosedPositions(limit * 2);
    
    // Filter by token if specified
    let filteredPositions = positions;
    if (token) {
      filteredPositions = positions.filter(pos => 
        pos.buy_symbol?.toLowerCase().includes(token.toLowerCase()) ||
        pos.stock_ticker?.toLowerCase().includes(token.toLowerCase())
      );
    }
    
    // Filter by timestamp if specified
    if (since) {
      filteredPositions = filteredPositions.filter(pos => 
        pos.exit_timestamp && pos.exit_timestamp >= since
      );
    }
    
    // Sort by exit_timestamp descending and apply offset/limit
    filteredPositions.sort((a, b) => (b.exit_timestamp || 0) - (a.exit_timestamp || 0));
    const offset = Number(req.query.offset) || 0;
    filteredPositions = filteredPositions.slice(offset, offset + limit);
    
    // Format response with camelCase fields for frontend
    const trades = filteredPositions.map(pos => ({
      id: pos.id,
      ticker: pos.stock_ticker,
      symbol: pos.buy_symbol,
      entryDiscount: pos.entry_spread_pct,
      exitDiscount: pos.exit_spread_pct,
      entryTimestamp: pos.entry_timestamp,
      exitTimestamp: pos.exit_timestamp,
      sizeUsd: pos.size_usd,
      pnlUsd: pos.pnl_usd,
      pnlPct: pos.pnl_pct,
      holdTimeMs: pos.exit_timestamp && pos.entry_timestamp ? pos.exit_timestamp - pos.entry_timestamp : 0,
      exitReason: pos.exit_reason,
      entryTxSignature: pos.entry_tx_signature,
    }));

    // Cache the result
    tradesCache.set(cacheKey, { data: trades, timestamp: Date.now() });

    res.json(trades);
  } catch (error) {
    logger.error({ error }, 'Error fetching trades');
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// GET /api/analytics - Analytics endpoint
app.get('/api/analytics', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'analytics-7d';
    
    // Check cache first
    const cached = analyticsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ANALYTICS_CACHE_MS) {
      return res.json(cached.data);
    }

    // Fetch recent positions from last 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const positions = await fetchRecentClosedPositions(1000, sevenDaysMs);
    
    // Initialize analytics object
    const analytics = {
      byToken: {} as Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number; avgPnl: number; avgHoldTime: number }>,
      byHour: [] as { hour: number; trades: number; winRate: number; pnl: number }[],
      byDay: [] as { date: string; trades: number; winRate: number; pnl: number }[],
      exitReasons: { target: 0, max_hold: 0, stop_loss: 0, decay: 0 },
      spreadDistribution: { buckets: [] as { range: string; count: number }[] },
      summary: { totalTrades: 0, winRate: 0, avgPnl: 0, avgHoldTimeMin: 0, profitFactor: 0 }
    };

    if (positions.length === 0) {
      analyticsCache.set(cacheKey, { data: analytics, timestamp: Date.now() });
      return res.json(analytics);
    }

    // Process by token
    const tokenStats: Record<string, { trades: number; wins: number; totalPnl: number; totalHoldTime: number }> = {};
    positions.forEach(pos => {
      const token = pos.buy_symbol || pos.stock_ticker || 'unknown';
      if (!tokenStats[token]) {
        tokenStats[token] = { trades: 0, wins: 0, totalPnl: 0, totalHoldTime: 0 };
      }
      const holdTimeMs = pos.exit_timestamp && pos.entry_timestamp ? pos.exit_timestamp - pos.entry_timestamp : 0;
      tokenStats[token].trades++;
      if ((pos.pnl_usd || 0) > 0) tokenStats[token].wins++;
      tokenStats[token].totalPnl += pos.pnl_usd || 0;
      tokenStats[token].totalHoldTime += holdTimeMs;
    });

    for (const [token, stats] of Object.entries(tokenStats)) {
      analytics.byToken[token] = {
        trades: stats.trades,
        wins: stats.wins,
        losses: stats.trades - stats.wins,
        winRate: stats.trades > 0 ? stats.wins / stats.trades : 0,
        totalPnl: stats.totalPnl,
        avgPnl: stats.trades > 0 ? stats.totalPnl / stats.trades : 0,
        avgHoldTime: stats.trades > 0 ? stats.totalHoldTime / stats.trades : 0
      };
    }

    // Process by hour (24 hour buckets)
    const hourStats: Record<number, { trades: number; wins: number; totalPnl: number }> = {};
    for (let i = 0; i < 24; i++) hourStats[i] = { trades: 0, wins: 0, totalPnl: 0 };
    
    positions.forEach(pos => {
      if (pos.exit_timestamp) {
        const hour = new Date(pos.exit_timestamp).getHours();
        hourStats[hour].trades++;
        if ((pos.pnl_usd || 0) > 0) hourStats[hour].wins++;
        hourStats[hour].totalPnl += pos.pnl_usd || 0;
      }
    });

    for (let i = 0; i < 24; i++) {
      const stats = hourStats[i];
      analytics.byHour.push({
        hour: i,
        trades: stats.trades,
        winRate: stats.trades > 0 ? stats.wins / stats.trades : 0,
        pnl: stats.totalPnl
      });
    }

    // Process by day (last 7 days)
    const dayStats: Record<string, { trades: number; wins: number; totalPnl: number }> = {};
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      dayStats[dateStr] = { trades: 0, wins: 0, totalPnl: 0 };
    }

    positions.forEach(pos => {
      if (pos.exit_timestamp) {
        const dateStr = new Date(pos.exit_timestamp).toISOString().split('T')[0];
        if (dayStats[dateStr]) {
          dayStats[dateStr].trades++;
          if ((pos.pnl_usd || 0) > 0) dayStats[dateStr].wins++;
          dayStats[dateStr].totalPnl += pos.pnl_usd || 0;
        }
      }
    });

    for (const [date, stats] of Object.entries(dayStats)) {
      analytics.byDay.push({
        date,
        trades: stats.trades,
        winRate: stats.trades > 0 ? stats.wins / stats.trades : 0,
        pnl: stats.totalPnl
      });
    }
    analytics.byDay.sort((a, b) => a.date.localeCompare(b.date));

    // Exit reasons
    positions.forEach(pos => {
      const reason = pos.exit_reason;
      if (reason === 'target') analytics.exitReasons.target++;
      else if (reason === 'max_hold') analytics.exitReasons.max_hold++;
      else if (reason === 'stop_loss') analytics.exitReasons.stop_loss++;
      else if (reason === 'decay') analytics.exitReasons.decay++;
    });

    // Spread distribution
    const spreadBuckets = [
      { range: "0-1%", min: 0, max: 1 },
      { range: "1-2%", min: 1, max: 2 },
      { range: "2-3%", min: 2, max: 3 },
      { range: "3-5%", min: 3, max: 5 },
      { range: "5%+", min: 5, max: 100 }
    ];
    
    const bucketCounts = spreadBuckets.map(bucket => ({ range: bucket.range, count: 0 }));
    positions.forEach(pos => {
      const entryDiscount = Math.abs(pos.entry_spread_pct || 0);
      for (let i = 0; i < spreadBuckets.length; i++) {
        const bucket = spreadBuckets[i];
        if (entryDiscount >= bucket.min && entryDiscount < bucket.max) {
          bucketCounts[i].count++;
          break;
        }
      }
    });
    analytics.spreadDistribution.buckets = bucketCounts;

    // Summary
    const totalTrades = positions.length;
    const totalWins = positions.filter(pos => (pos.pnl_usd || 0) > 0).length;
    const totalPnl = positions.reduce((sum, pos) => sum + (pos.pnl_usd || 0), 0);
    const totalHoldTime = positions.reduce((sum, pos) => {
      const ht = pos.exit_timestamp && pos.entry_timestamp ? pos.exit_timestamp - pos.entry_timestamp : 0;
      return sum + ht;
    }, 0);
    const winningPnl = positions.filter(pos => (pos.pnl_usd || 0) > 0).reduce((sum, pos) => sum + (pos.pnl_usd || 0), 0);
    const losingPnl = Math.abs(positions.filter(pos => (pos.pnl_usd || 0) <= 0).reduce((sum, pos) => sum + (pos.pnl_usd || 0), 0));

    analytics.summary = {
      totalTrades,
      winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
      avgPnl: totalTrades > 0 ? totalPnl / totalTrades : 0,
      avgHoldTimeMin: totalTrades > 0 ? totalHoldTime / totalTrades / (1000 * 60) : 0,
      profitFactor: losingPnl > 0 ? winningPnl / losingPnl : (winningPnl > 0 ? 999 : 0)
    };

    // Cache the result
    analyticsCache.set(cacheKey, { data: analytics, timestamp: Date.now() });

    res.json(analytics);
  } catch (error) {
    logger.error({ error }, 'Error computing analytics');
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// Serve static HTML dashboard with tab-specific routes
app.get('/', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('dashboard'));
});

app.get('/heatmap', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('heatmap'));
});

app.get('/method', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('method'));
});

app.get('/trades', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('trades'));
});

app.get('/changelog', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('changelog'));
});

app.get('/admin', (_req: Request, res: Response) => {
  res.send(getDashboardHTML('admin'));
});


let server: ReturnType<typeof app.listen> | null = null;

/**
 * Start the web dashboard server
 */
export function startWebServer(port: number = DEFAULT_PORT): void {
  if (server) {
    logger.warn('Web server already running');
    return;
  }

  server = app.listen(port, '0.0.0.0', () => {
    console.log(`Web dashboard running at http://localhost:${port}`);
    logger.info({ port, url: `http://localhost:${port}` }, 'Web dashboard server started');

    // Pre-warm heatmap cache for instant loading (run in background)
    prewarmHeatmapCache().catch(err => {
      logger.warn({ error: err }, 'Heatmap cache pre-warming failed');
    });

    // Signal PM2 that the app is ready (for zero-downtime reloads)
    if (process.send) {
      process.send('ready');
      logger.info('Sent ready signal to PM2');
    }
  });

  // Handle port conflict gracefully - don't crash the whole app
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port }, 'Web server port already in use - dashboard will be unavailable but trading continues');
      console.log(`Warning: Port ${port} in use - dashboard unavailable but trading continues`);
      server = null;
      // Still signal ready to PM2 so the trading bot can run
      if (process.send) {
        process.send('ready');
      }
    } else {
      logger.error({ error: err }, 'Web server error');
      throw err;
    }
  });
}

/**
 * Stop the web dashboard server
 */
export async function stopWebServer(): Promise<void> {
  if (server) {
    server.close();
    server = null;
    logger.info('Web dashboard server stopped');
  }
}
