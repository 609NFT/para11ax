/**
 * Configuration management for Parallax Mean Reversion Bot
 * Trades tokenized stocks when they diverge from underlying stock prices
 * Paper mode is DEFAULT - live trading requires explicit enable
 */

import { z } from 'zod';
import { Config, TradingMode, TokenConfig } from './types';
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fetchTokensFromDb } from './db/supabaseClient';
import logger from './logger';

dotenvConfig();

// Cache for DB tokens (loaded once at startup)
let dbTokensCache: TokenConfig[] | null = null;

// Cache for custom tokens from config.json (gold, forex, etc.)
let customTokensCache: TokenConfig[] = [];

// Zod schema for validation
const TokenConfigSchema = z.object({
  symbol: z.string(),
  mint: z.string(),
  stockTicker: z.string(),
  enabled: z.boolean().default(true),
  poolAddress: z.string(),
  decimals: z.number().int().positive(),
  priceSource: z.enum(['stock', 'swissquote']).optional(),
  priceSymbol: z.string().optional(),
});

const ConfigSchema = z.object({
  mode: z.enum(['paper', 'live']).default('paper'),

  // Mean reversion thresholds (see constants.ts for entry thresholds - they're dynamic based on TVL)
  meanReversionExitSpreadPct: z.number().default(0.8),       // Exit when token price appreciates >= this %
  meanReversionStopLossSpreadPct: z.number().default(-3.0),  // Stop-loss when discount <= this (premium)

  // Timing (see constants.ts for dynamic hold times based on market open/closed)
  maxHoldTimeMs: z.number().positive().default(24 * 60 * 60 * 1000), // Base hold time (24h), extended to 72h when market closed
  entryCooldownMs: z.number().nonnegative().default(60 * 1000), // 1 minute between entries

  // Position sizing
  maxUsdPerTrade: z.number().positive().max(10000).default(20),
  liquidityFraction: z.number().positive().max(0.1).default(0.01), // 1% max
  maxSlippageBps: z.number().positive().max(500).default(300), // 3% max

  // Risk limits
  maxDailyLossUsd: z.number().positive().default(20),
  maxDailyTrades: z.number().int().positive().default(20),
  maxConsecutiveFailures: z.number().int().positive().default(3),
  priceStalenessMs: z.number().positive().default(30000), // 30 seconds
  exitPriceStalenessMs: z.number().positive().default(60000), // 60 seconds for exit decisions

  // Network
  rpcEndpoint: z.string().url().default('https://api.mainnet-beta.solana.com'),
  rpcEndpoints: z.array(z.string().url()).default([]),
  jupiterApiUrl: z.string().url().default('https://api.jup.ag/swap/v1'),

  // Tokens
  tokens: z.array(TokenConfigSchema).default([]),

  // Statistics
  rollingWindowSize: z.number().int().positive().default(100),

  // Paper trading simulation
  simulatedSlippageBps: z.number().nonnegative().default(5),
});

// Default configuration - SAFE BY DEFAULT
const DEFAULT_CONFIG: Config = {
  mode: 'paper', // NEVER default to live

  // Mean reversion thresholds
  meanReversionExitSpreadPct: 0.8,
  meanReversionStopLossSpreadPct: -3.0,

  // Timing
  maxHoldTimeMs: 24 * 60 * 60 * 1000, // Base hold time (24h)
  entryCooldownMs: 60 * 1000, // 1 minute

  // Position sizing - conservative
  maxUsdPerTrade: 40,
  liquidityFraction: 0.01, // Only 1% of pool
  maxSlippageBps: 150,     // 1.5% max slippage for entry (exit uses escalation)

  // Risk limits
  maxDailyLossUsd: 20,
  maxDailyTrades: 20,
  maxConsecutiveFailures: 3,
  priceStalenessMs: 30000,
  exitPriceStalenessMs: 60000,

  // Network
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  rpcEndpoints: [
    process.env.RPC_ENDPOINT,
    process.env.RPC_ENDPOINT_2,
  ].filter((url): url is string => !!url),
  jupiterApiUrl: 'https://api.jup.ag/swap/v1',

  // No tokens by default - must be configured
  tokens: [],

  // Statistics
  rollingWindowSize: 100,

  // Paper trading simulation
  simulatedSlippageBps: 5,
};

/**
 * Load configuration from file and environment
 * Fetches tokens from Supabase database
 */
export async function loadConfig(): Promise<Config> {
  let fileConfig: Partial<Config> = {};

  // Try to load config file (for non-token settings and custom tokens)
  let customTokens: TokenConfig[] = [];
  const configPath = path.join(process.cwd(), 'config', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Exclude tokens from file config - we get them from DB
      // But keep customTokens for non-stock assets (gold, forex, etc.)
      const { tokens, customTokens: configCustomTokens, ...rest } = rawConfig;
      fileConfig = rest;

      // Load custom tokens with their price sources
      if (Array.isArray(configCustomTokens)) {
        customTokens = configCustomTokens.map((ct: Partial<TokenConfig>) => ({
          symbol: ct.symbol || '',
          mint: ct.mint || '',
          stockTicker: ct.stockTicker || ct.symbol || '',
          enabled: ct.enabled !== false,
          poolAddress: ct.poolAddress || '',
          decimals: ct.decimals || 9,
          priceSource: ct.priceSource || 'stock',
          priceSymbol: ct.priceSymbol,
        }));
        // Cache custom tokens for use in refreshTokensFromDb()
        customTokensCache = customTokens;
      }
    } catch (error) {
      // Use defaults if config file parsing fails
      logger.warn({ error, configPath }, 'Failed to parse config file, using defaults');
    }
  }

  // Fetch tokens from Supabase (or use cache)
  if (!dbTokensCache) {
    try {
      dbTokensCache = await fetchTokensFromDb();
    } catch (error) {
      logger.warn({ error }, 'Failed to fetch tokens from database, using empty array');
      dbTokensCache = [];
    }
  }

  // Merge DB tokens with custom tokens
  // Custom tokens override DB tokens if same symbol exists
  const allTokens = [...dbTokensCache, ...customTokens];

  // Merge with defaults
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    tokens: allTokens,
  };

  // Environment overrides (safety-critical)
  const envMode = process.env.TRADING_MODE as TradingMode | undefined;
  if (envMode) {
    mergedConfig.mode = envMode;
  }

  // CRITICAL: Live trading requires explicit flag
  if (mergedConfig.mode === 'live' && process.env.LIVE_TRADING !== 'true') {
    mergedConfig.mode = 'paper';
  }

  // Validate configuration
  const validated = ConfigSchema.parse(mergedConfig);

  return validated;
}

/**
 * Validate that live trading prerequisites are met
 */
export function validateLiveReadiness(config: Config): { ready: boolean; issues: string[] } {
  const issues: string[] = [];

  if (config.mode !== 'live') {
    return { ready: false, issues: ['Mode is not set to live'] };
  }

  if (process.env.LIVE_TRADING !== 'true') {
    issues.push('LIVE_TRADING environment variable is not set to true');
  }

  if (!process.env.SOLANA_PRIVATE_KEY) {
    issues.push('SOLANA_PRIVATE_KEY is not configured');
  }

  if (config.tokens.length === 0) {
    issues.push('No tokens configured for trading');
  }

  return {
    ready: issues.length === 0,
    issues,
  };
}

/**
 * Get current trading mode with safety explanation
 */
export function getModeDescription(mode: TradingMode): string {
  switch (mode) {
    case 'paper':
      return 'PAPER MODE: Simulating trades with no real execution. Safe for testing.';
    case 'live':
      return 'LIVE MODE: Real trades will be executed. Capital at risk.';
  }
}

// Export singleton config
let _config: Config | null = null;

export async function getConfig(): Promise<Config> {
  if (!_config) {
    _config = await loadConfig();
  }
  return _config;
}

/**
 * Get config synchronously (must call getConfig() first to initialize)
 * Throws if config not initialized
 */
export function getConfigSync(): Config {
  if (!_config) {
    throw new Error('Config not initialized. Call await getConfig() first.');
  }
  return _config;
}

/**
 * Refresh tokens from database
 * Called periodically alongside liquidity refresh to pick up new tokens
 * Returns count of new tokens added (for logging)
 */
export async function refreshTokensFromDb(): Promise<{ added: number; removed: number; total: number }> {
  const oldTokens = dbTokensCache || [];
  const oldMints = new Set(oldTokens.map(t => t.mint));

  try {
    const newTokens = await fetchTokensFromDb();
    const newMints = new Set(newTokens.map(t => t.mint));

    // Count additions and removals
    const added = newTokens.filter(t => !oldMints.has(t.mint)).length;
    const removed = oldTokens.filter(t => !newMints.has(t.mint)).length;

    // Update cache
    dbTokensCache = newTokens;

    // Update the singleton config with new tokens + custom tokens
    if (_config) {
      _config = {
        ..._config,
        tokens: [...newTokens, ...customTokensCache],
      };
    }

    return { added, removed, total: newTokens.length + customTokensCache.length };
  } catch (error) {
    // Keep existing tokens on error
    return { added: 0, removed: 0, total: oldTokens.length };
  }
}
