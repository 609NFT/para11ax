/**
 * Time-of-Day Trading Optimizer
 * 
 * Provides dynamic time-of-day filtering based on historical performance.
 * Gradually learns optimal trading windows per token instead of static global filters.
 */

import { signalLogger } from '../logger';
import { getTradesPool } from '../db/supabaseClient';

interface HourlyStats {
  hour: number;
  trades: number;
  wins: number;
  winRate: number;
  avgPnL: number;
  lastUpdated: number;
}

interface TokenTimeProfile {
  symbol: string;
  hourlyStats: Map<number, HourlyStats>;
  lastRefresh: number;
  sampleSize: number;
}

// Cache token time profiles (refreshed weekly)
const timeProfiles: Map<string, TokenTimeProfile> = new Map();
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const MIN_TRADES_FOR_FILTERING = 10; // Need 10+ trades in an hour to filter
const MIN_WIN_RATE_THRESHOLD = 0.25; // Avoid hours with <25% win rate
const GLOBAL_BACKUP_THRESHOLD = 0.30; // If no token-specific data, use global 30% threshold

const timeLogger = signalLogger.child({ component: 'time-optimizer' });

/**
 * Check if current time is favorable for trading a specific token
 */
export async function isOptimalTradingTime(tokenSymbol: string): Promise<{
  allowed: boolean;
  reason?: string;
  globalWinRate?: number;
  tokenWinRate?: number;
}> {
  const currentHour = new Date().getUTCHours();
  
  // Get or refresh token profile
  let profile = timeProfiles.get(tokenSymbol);
  const now = Date.now();
  
  if (!profile || now - profile.lastRefresh > REFRESH_INTERVAL_MS) {
    profile = await refreshTokenTimeProfile(tokenSymbol);
    timeProfiles.set(tokenSymbol, profile);
  }
  
  // Check token-specific stats for this hour
  const hourStats = profile.hourlyStats.get(currentHour);
  
  if (hourStats && hourStats.trades >= MIN_TRADES_FOR_FILTERING) {
    // Have sufficient token-specific data
    const allowed = hourStats.winRate >= MIN_WIN_RATE_THRESHOLD;
    
    timeLogger.debug({
      token: tokenSymbol,
      hour: currentHour,
      winRate: hourStats.winRate,
      trades: hourStats.trades,
      avgPnL: hourStats.avgPnL,
      allowed,
    }, `Token-specific time filter: ${allowed ? 'ALLOWED' : 'BLOCKED'}`);
    
    return {
      allowed,
      reason: allowed ? undefined : `Low win rate (${(hourStats.winRate * 100).toFixed(1)}%) at ${currentHour}:00 UTC`,
      tokenWinRate: hourStats.winRate,
    };
  }
  
  // Fall back to global stats if insufficient token-specific data
  const globalStats = await getGlobalHourlyStats(currentHour);
  const allowed = globalStats.winRate >= GLOBAL_BACKUP_THRESHOLD;
  
  timeLogger.debug({
    token: tokenSymbol,
    hour: currentHour,
    globalWinRate: globalStats.winRate,
    globalTrades: globalStats.trades,
    allowed,
    reason: 'fallback-to-global',
  }, `Global time filter: ${allowed ? 'ALLOWED' : 'BLOCKED'}`);
  
  return {
    allowed,
    reason: allowed ? undefined : `Low global win rate (${(globalStats.winRate * 100).toFixed(1)}%) at ${currentHour}:00 UTC`,
    globalWinRate: globalStats.winRate,
  };
}

/**
 * Refresh time profile for a specific token
 */
async function refreshTokenTimeProfile(tokenSymbol: string): Promise<TokenTimeProfile> {
  try {
    // Query last 30 days of trades for this token
    const pool = getTradesPool();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const result = await pool.query(
      `SELECT entry_timestamp, net_pnl 
       FROM trades 
       WHERE buy_symbol = $1 
         AND entry_timestamp >= $2 
         AND net_pnl IS NOT NULL`,
      [tokenSymbol, thirtyDaysAgo]
    );
    
    const trades = result.rows;
    
    // Group by hour and calculate stats
    const hourlyStats = new Map<number, HourlyStats>();
    
    trades.forEach((trade: { entry_timestamp: string; net_pnl: number }) => {
      const hour = new Date(trade.entry_timestamp).getUTCHours();
      const isWin = trade.net_pnl > 0;
      
      if (!hourlyStats.has(hour)) {
        hourlyStats.set(hour, {
          hour,
          trades: 0,
          wins: 0,
          winRate: 0,
          avgPnL: 0,
          lastUpdated: Date.now(),
        });
      }
      
      const stats = hourlyStats.get(hour)!;
      stats.trades++;
      if (isWin) stats.wins++;
      stats.avgPnL = ((stats.avgPnL * (stats.trades - 1)) + trade.net_pnl) / stats.trades;
    });
    
    // Calculate win rates
    hourlyStats.forEach(stats => {
      stats.winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
    });
    
    timeLogger.info({
      token: tokenSymbol,
      totalTrades: trades.length,
      hoursWithData: hourlyStats.size,
    }, 'Refreshed token time profile');
    
    return {
      symbol: tokenSymbol,
      hourlyStats,
      lastRefresh: Date.now(),
      sampleSize: trades.length,
    };
    
  } catch (error) {
    timeLogger.error({ token: tokenSymbol, error }, 'Error refreshing token time profile');
    return createEmptyProfile(tokenSymbol);
  }
}

/**
 * Get global hourly stats as fallback
 */
async function getGlobalHourlyStats(hour: number): Promise<HourlyStats> {
  try {
    // Query last 14 days of all trades for this hour
    const pool = getTradesPool();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    
    const result = await pool.query(
      `SELECT entry_timestamp, net_pnl 
       FROM trades 
       WHERE entry_timestamp >= $1 
         AND net_pnl IS NOT NULL
         AND EXTRACT(HOUR FROM entry_timestamp AT TIME ZONE 'UTC') = $2`,
      [fourteenDaysAgo, hour]
    );
    
    const hourTrades = result.rows;
    
    const wins = hourTrades.filter((trade: { net_pnl: number }) => trade.net_pnl > 0).length;
    const winRate = hourTrades.length > 0 ? wins / hourTrades.length : 0.5;
    const avgPnL = hourTrades.length > 0 
      ? hourTrades.reduce((sum: number, trade: { net_pnl: number }) => sum + trade.net_pnl, 0) / hourTrades.length 
      : 0;
      
    return {
      hour,
      trades: hourTrades.length,
      wins,
      winRate,
      avgPnL,
      lastUpdated: Date.now(),
    };
    
  } catch (error) {
    timeLogger.error({ hour, error }, 'Error fetching global hourly stats');
    return { hour, trades: 0, wins: 0, winRate: 0.5, avgPnL: 0, lastUpdated: Date.now() };
  }
}

/**
 * Create empty profile for new tokens
 */
function createEmptyProfile(tokenSymbol: string): TokenTimeProfile {
  return {
    symbol: tokenSymbol,
    hourlyStats: new Map(),
    lastRefresh: Date.now(),
    sampleSize: 0,
  };
}

/**
 * Get summary of time profiles for all tokens (for debugging/dashboard)
 */
export function getTimeProfileSummary(): Array<{
  symbol: string;
  sampleSize: number;
  bestHours: number[];
  worstHours: number[];
}> {
  return Array.from(timeProfiles.entries()).map(([symbol, profile]) => {
    const hours = Array.from(profile.hourlyStats.entries())
      .filter(([, stats]) => stats.trades >= MIN_TRADES_FOR_FILTERING)
      .sort(([, a], [, b]) => b.winRate - a.winRate);
      
    return {
      symbol,
      sampleSize: profile.sampleSize,
      bestHours: hours.slice(0, 3).map(([hour]) => hour),
      worstHours: hours.slice(-3).map(([hour]) => hour),
    };
  });
}

/**
 * Force refresh of time profile for a token (for testing/debugging)
 */
export async function forceRefreshTimeProfile(tokenSymbol: string): Promise<void> {
  const profile = await refreshTokenTimeProfile(tokenSymbol);
  timeProfiles.set(tokenSymbol, profile);
}