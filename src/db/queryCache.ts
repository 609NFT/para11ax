/**
 * Query Cache for Supabase Migration
 *
 * Provides TTL-based in-memory caching to offset the 20x latency increase
 * when migrating from SQLite (1-5ms) to Supabase (20-100ms).
 *
 * Cache TTLs:
 * - Open positions: 30s (hot path, called every 10-30s)
 * - Latest discount: 10s (price data, needs to be fresh)
 * - Historical data: 5min (rarely changes)
 * - Volatility: 10min (calculated data, expensive to compute)
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class QueryCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  /**
   * Get cached value if it exists and hasn't expired
   * @param key Cache key
   * @returns Cached value or null if expired/missing
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Store value in cache with TTL
   * @param key Cache key
   * @param data Data to cache
   * @param ttl Time-to-live in milliseconds
   */
  set<T>(key: string, data: T, ttl: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
  }

  /**
   * Invalidate cache entries
   * @param pattern Optional prefix pattern (e.g., "positions:" to clear all position caches)
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      // Clear entire cache
      this.cache.clear();
      return;
    }

    // Clear entries matching pattern
    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Clean up expired entries (called periodically)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }
}

// Singleton instance
const cacheInstance = new QueryCache();

// Cleanup expired entries every minute
setInterval(() => cacheInstance.cleanup(), 60000);

export const getQueryCache = (): QueryCache => cacheInstance;
