/**
 * Feed aggregator - combines stock and onchain feeds
 * Manages feed lifecycle and health monitoring
 */

import { StockFeed, getStockFeed } from './stockFeed';
import { OnchainFeed, getOnchainFeed } from './onchainFeed';
import { TokenConfig } from '../types';
import { feedLogger } from '../logger';
import { getConfigSync } from '../config';

export class FeedAggregator {
  private stockFeed: StockFeed;
  private onchainFeed: OnchainFeed;
  private initialized: boolean = false;

  constructor() {
    this.stockFeed = getStockFeed();
    this.onchainFeed = getOnchainFeed();
  }

  /**
   * Initialize all feeds
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    feedLogger.info('Initializing feed aggregator...');

    await Promise.all([
      this.stockFeed.connect(),
      this.onchainFeed.connect(),
    ]);

    // Subscribe to all configured tokens
    const config = getConfigSync();
    for (const token of config.tokens) {
      if (token.enabled) {
        await this.subscribeToToken(token);
      }
    }

    this.initialized = true;
    feedLogger.info('Feed aggregator initialized');
  }

  /**
   * Subscribe to price updates for a token
   */
  private async subscribeToToken(token: TokenConfig): Promise<void> {
    // Fetch initial prices (routes to appropriate price source based on token config)
    await Promise.all([
      this.stockFeed.getPriceForToken(token),
      this.onchainFeed.getPrice(token.mint, token.symbol),
    ]);

    feedLogger.info({ symbol: token.symbol, priceSource: token.priceSource || 'stock' }, 'Subscribed to token prices');
  }

  /**
   * Check feed health
   */
  getHealthStatus(): {
    stockFeedConnected: boolean;
    onchainFeedConnected: boolean;
    overall: boolean;
  } {
    return {
      stockFeedConnected: this.stockFeed.isConnected(),
      onchainFeedConnected: this.onchainFeed.isConnected(),
      overall: this.stockFeed.isConnected() && this.onchainFeed.isConnected(),
    };
  }

  /**
   * Get token price by mint address
   * Returns the trading price (on-chain price) or null if not available
   */
  async getTokenPrice(mint: string): Promise<number | null> {
    const priceData = await this.onchainFeed.getPrice(mint);
    return priceData?.tradingPrice ?? null;
  }

  /**
   * Shutdown feeds
   */
  async shutdown(): Promise<void> {
    await Promise.all([
      this.stockFeed.disconnect(),
      this.onchainFeed.disconnect(),
    ]);
    this.initialized = false;
    feedLogger.info('Feed aggregator shutdown complete');
  }
}

// Singleton
let feedAggregatorInstance: FeedAggregator | null = null;

export function getFeedAggregator(): FeedAggregator {
  if (!feedAggregatorInstance) {
    feedAggregatorInstance = new FeedAggregator();
  }
  return feedAggregatorInstance;
}

// Re-export individual feeds
export { StockFeed, getStockFeed } from './stockFeed';
export { OnchainFeed, getOnchainFeed } from './onchainFeed';
