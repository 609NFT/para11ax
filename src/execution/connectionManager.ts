/**
 * Connection Manager
 * Manages multiple RPC endpoints with round-robin and failover
 */

import { Connection } from '@solana/web3.js';
import { getConfigSync } from '../config';
import { executionLogger } from '../logger';

class ConnectionManager {
  private connections: Connection[] = [];
  private endpoints: string[] = [];
  private currentIndex: number = 0;
  private failureCounts: Map<number, number> = new Map();
  private lastFailureTime: Map<number, number> = new Map();

  // Config
  private readonly maxFailures = 3;
  private readonly cooldownMs = 30000; // 30 seconds cooldown after max failures

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const config = getConfigSync();

    // Use rpcEndpoints array if available, otherwise fall back to single endpoint
    this.endpoints = config.rpcEndpoints.length > 0
      ? config.rpcEndpoints
      : [config.rpcEndpoint];

    // Create connections for each endpoint
    this.connections = this.endpoints.map(endpoint =>
      new Connection(endpoint, 'confirmed')
    );

    // Initialize failure tracking
    this.endpoints.forEach((_, i) => {
      this.failureCounts.set(i, 0);
      this.lastFailureTime.set(i, 0);
    });

    executionLogger.info({
      endpointCount: this.endpoints.length,
      endpoints: this.endpoints.map(e => e.split('?')[0]), // Log without API keys
    }, 'ConnectionManager initialized with multiple RPC endpoints');
  }

  /**
   * Get the next available connection (round-robin with failover)
   */
  getConnection(): Connection {
    const startIndex = this.currentIndex;
    let attempts = 0;

    while (attempts < this.connections.length) {
      const index = (startIndex + attempts) % this.connections.length;

      if (this.isEndpointAvailable(index)) {
        this.currentIndex = (index + 1) % this.connections.length;
        return this.connections[index];
      }

      attempts++;
    }

    // All endpoints exhausted - reset and return first one
    executionLogger.warn('All RPC endpoints in cooldown, resetting...');
    this.resetAllEndpoints();
    return this.connections[0];
  }

  /**
   * Check if an endpoint is available (not in cooldown)
   */
  private isEndpointAvailable(index: number): boolean {
    const failures = this.failureCounts.get(index) || 0;
    const lastFailure = this.lastFailureTime.get(index) || 0;

    if (failures >= this.maxFailures) {
      const elapsed = Date.now() - lastFailure;
      if (elapsed < this.cooldownMs) {
        return false;
      }
      // Cooldown expired, reset this endpoint
      this.failureCounts.set(index, 0);
    }

    return true;
  }

  /**
   * Report a failure for the current connection
   * Call this when you get a 429 or connection error
   */
  reportFailure(connection: Connection): void {
    const index = this.connections.indexOf(connection);
    if (index === -1) return;

    const failures = (this.failureCounts.get(index) || 0) + 1;
    this.failureCounts.set(index, failures);
    this.lastFailureTime.set(index, Date.now());

    executionLogger.warn({
      endpointIndex: index,
      failures,
      maxFailures: this.maxFailures,
    }, 'RPC endpoint failure recorded');

    if (failures >= this.maxFailures) {
      executionLogger.warn({
        endpointIndex: index,
        cooldownMs: this.cooldownMs,
      }, 'RPC endpoint entering cooldown');
    }
  }

  /**
   * Report success - resets failure count
   */
  reportSuccess(connection: Connection): void {
    const index = this.connections.indexOf(connection);
    if (index === -1) return;

    this.failureCounts.set(index, 0);
  }

  /**
   * Reset all endpoints (emergency recovery)
   */
  private resetAllEndpoints(): void {
    this.endpoints.forEach((_, i) => {
      this.failureCounts.set(i, 0);
      this.lastFailureTime.set(i, 0);
    });
  }

  /**
   * Get all connections for parallel operations
   */
  getAllConnections(): Connection[] {
    return [...this.connections];
  }

  /**
   * Get endpoint count
   */
  getEndpointCount(): number {
    return this.endpoints.length;
  }

  /**
   * Get status of all endpoints
   */
  getStatus(): { endpoint: string; failures: number; available: boolean }[] {
    return this.endpoints.map((endpoint, i) => ({
      endpoint: endpoint.split('?')[0], // Hide API key
      failures: this.failureCounts.get(i) || 0,
      available: this.isEndpointAvailable(i),
    }));
  }
}

// Singleton instance
let connectionManagerInstance: ConnectionManager | null = null;

export function getConnectionManager(): ConnectionManager {
  if (!connectionManagerInstance) {
    connectionManagerInstance = new ConnectionManager();
  }
  return connectionManagerInstance;
}
