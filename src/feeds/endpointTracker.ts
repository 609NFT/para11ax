/**
 * Endpoint Usage Tracker
 * Tracks API calls per endpoint for monitoring and rate limit awareness
 */

import { MS_PER_MINUTE, MS_PER_HOUR } from '../constants';

interface EndpointStats {
  name: string;
  url: string;
  callsLastMinute: number;
  callsLastHour: number;
  lastCallTime: number | null;
  lastStatus: 'ok' | 'error' | 'unknown';
  lastError?: string;
  avgResponseMs: number;
}

interface CallRecord {
  timestamp: number;
  success: boolean;
  responseMs: number;
  error?: string;
}

class EndpointTracker {
  private endpoints: Map<string, {
    name: string;
    url: string;
    calls: CallRecord[];
  }> = new Map();

  /**
   * Register an endpoint for tracking
   */
  register(id: string, name: string, url: string): void {
    if (!this.endpoints.has(id)) {
      this.endpoints.set(id, { name, url, calls: [] });
    }
  }

  /**
   * Record an API call
   */
  recordCall(id: string, success: boolean, responseMs: number, error?: string): void {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return;

    const now = Date.now();
    endpoint.calls.push({
      timestamp: now,
      success,
      responseMs,
      error,
    });

    // Keep only last hour of calls
    const oneHourAgo = now - MS_PER_HOUR;
    endpoint.calls = endpoint.calls.filter(c => c.timestamp > oneHourAgo);
  }

  /**
   * Calculate average response time from recent calls
   */
  private calculateAvgResponseMs(calls: CallRecord[]): number {
    const recentForAvg = calls.slice(-10);
    if (recentForAvg.length === 0) {
      return 0;
    }
    return recentForAvg.reduce((sum, c) => sum + c.responseMs, 0) / recentForAvg.length;
  }

  /**
   * Get stats for all endpoints
   */
  getStats(): EndpointStats[] {
    const now = Date.now();
    const oneMinuteAgo = now - MS_PER_MINUTE;
    const oneHourAgo = now - MS_PER_HOUR;

    const stats: EndpointStats[] = [];

    for (const [, endpoint] of this.endpoints) {
      const recentCalls = endpoint.calls.filter(c => c.timestamp > oneMinuteAgo);
      const hourCalls = endpoint.calls.filter(c => c.timestamp > oneHourAgo);
      const lastCall = endpoint.calls.length > 0
        ? endpoint.calls[endpoint.calls.length - 1]
        : null;

      const avgResponseMs = this.calculateAvgResponseMs(endpoint.calls);

      stats.push({
        name: endpoint.name,
        url: endpoint.url,
        callsLastMinute: recentCalls.length,
        callsLastHour: hourCalls.length,
        lastCallTime: lastCall?.timestamp || null,
        lastStatus: lastCall ? (lastCall.success ? 'ok' : 'error') : 'unknown',
        lastError: lastCall?.error,
        avgResponseMs: Math.round(avgResponseMs),
      });
    }

    return stats.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get stats for a specific endpoint
   */
  getEndpointStats(id: string): EndpointStats | null {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return null;

    const now = Date.now();
    const oneMinuteAgo = now - MS_PER_MINUTE;
    const oneHourAgo = now - MS_PER_HOUR;

    const recentCalls = endpoint.calls.filter(c => c.timestamp > oneMinuteAgo);
    const hourCalls = endpoint.calls.filter(c => c.timestamp > oneHourAgo);
    const lastCall = endpoint.calls.length > 0
      ? endpoint.calls[endpoint.calls.length - 1]
      : null;

    const avgResponseMs = this.calculateAvgResponseMs(endpoint.calls);

    return {
      name: endpoint.name,
      url: endpoint.url,
      callsLastMinute: recentCalls.length,
      callsLastHour: hourCalls.length,
      lastCallTime: lastCall?.timestamp || null,
      lastStatus: lastCall ? (lastCall.success ? 'ok' : 'error') : 'unknown',
      lastError: lastCall?.error,
      avgResponseMs: Math.round(avgResponseMs),
    };
  }
}

// Singleton instance
const tracker = new EndpointTracker();

// Register known endpoints
tracker.register('alpaca', 'Alpaca', 'data.alpaca.markets');
tracker.register('finnhub', 'Finnhub', 'finnhub.io');
tracker.register('polygon', 'Polygon', 'api.polygon.io');
tracker.register('dexscreener', 'DexScreener', 'api.dexscreener.com');
tracker.register('jupiter-price', 'Jupiter Price', 'api.jup.ag/price');
tracker.register('jupiter-quote', 'Jupiter Quote', 'api.jup.ag/swap');
tracker.register('swissquote', 'Swissquote', 'forex-data-feed.swissquote.com');
tracker.register('geckoterminal', 'GeckoTerminal', 'api.geckoterminal.com');
tracker.register('raydium', 'Raydium', 'api-v3.raydium.io');

export function getEndpointTracker(): EndpointTracker {
  return tracker;
}

export function recordApiCall(
  endpointId: string,
  success: boolean,
  responseMs: number,
  error?: string
): void {
  tracker.recordCall(endpointId, success, responseMs, error);
}

export function getEndpointStats(): EndpointStats[] {
  return tracker.getStats();
}
