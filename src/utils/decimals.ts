/**
 * Token Decimals Utility
 * Handles dynamic decimal lookups to avoid hardcoding
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { USDC_DECIMALS, SOL_DECIMALS, USDC_MINT, SOL_MINT } from '../constants';
import logger from '../logger';

// Cache for token decimals to avoid repeated RPC calls
const decimalCache: Map<string, number> = new Map();

// Known decimals for common tokens (avoid RPC calls)
const KNOWN_DECIMALS: Record<string, number> = {
  [USDC_MINT]: USDC_DECIMALS,
  [SOL_MINT]: SOL_DECIMALS,
};

/**
 * Get decimals for a token mint (sync version using cache/known values)
 * Returns undefined if not cached - caller should use async version
 */
export function getTokenDecimalsSync(mintAddress: string): number | undefined {
  if (KNOWN_DECIMALS[mintAddress]) {
    return KNOWN_DECIMALS[mintAddress];
  }
  return decimalCache.get(mintAddress);
}

/**
 * Get decimals for a token mint
 * Uses cache and known values to minimize RPC calls
 */
export async function getTokenDecimals(
  connection: Connection,
  mintAddress: string
): Promise<number> {
  // Check known decimals first
  if (KNOWN_DECIMALS[mintAddress]) {
    return KNOWN_DECIMALS[mintAddress];
  }

  // Check cache
  if (decimalCache.has(mintAddress)) {
    return decimalCache.get(mintAddress)!;
  }

  // Fetch from chain
  try {
    const mintInfo = await getMint(connection, new PublicKey(mintAddress));
    const decimals = mintInfo.decimals;
    decimalCache.set(mintAddress, decimals);
    return decimals;
  } catch (error) {
    // Default to 9 (most Solana tokens) if lookup fails
    logger.warn({ error, mintAddress }, 'Failed to get decimals, defaulting to 9');
    return 9;
  }
}

/**
 * Cache decimals for a token (call after getting quote with decimals info)
 */
export function cacheTokenDecimals(mintAddress: string, decimals: number): void {
  decimalCache.set(mintAddress, decimals);
}

/**
 * Convert raw amount to human-readable using decimals
 */
export function toHumanAmount(rawAmount: number, decimals: number): number {
  return rawAmount / Math.pow(10, decimals);
}

/**
 * Convert human-readable amount to raw using decimals
 */
export function toRawAmount(humanAmount: number, decimals: number): number {
  return humanAmount * Math.pow(10, decimals);
}

/**
 * Safe slippage calculation using token amounts (decimal-agnostic)
 * Returns percentage difference between expected and actual
 */
export function calculateSlippagePct(expected: number, actual: number): number {
  if (expected <= 0) return 0;
  return ((expected - actual) / expected) * 100;
}
