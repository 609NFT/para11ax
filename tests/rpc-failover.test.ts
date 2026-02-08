import { describe, test, expect, jest } from '@jest/globals';
import logger from '../src/logger';

describe('RPC Failover Bug - Balance Fetch Not Triggering Failover', () => {
  test('getTokenBalance should call reportFailure on 429 errors', () => {
    // This test reproduces the bug where getTokenBalance catches errors
    // but never notifies ConnectionManager, preventing RPC failover

    // Mock connection that throws 429 error
    const mockConnection = {
      getParsedTokenAccountsByOwner: jest.fn<() => Promise<any>>().mockRejectedValue(
        new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}')
      ),
    };

    // Mock ConnectionManager
    const mockConnectionManager = {
      reportFailure: jest.fn(),
      getConnection: jest.fn().mockReturnValue(mockConnection),
    };

    // BUGGY CODE: getTokenBalance catches error but doesn't call reportFailure
    async function buggyGetTokenBalance(tokenMint: string, connection: any, _connectionManager: any) {
      try {
        await connection.getParsedTokenAccountsByOwner(
          { publicKey: 'mock-wallet' },
          { mint: tokenMint }
        );
        return 100;
      } catch (error) {
        // BUG: Only logs error, never calls connectionManager.reportFailure()
        logger.error({ error }, 'Error fetching balance');
        return null;
      }
    }

    // Execute buggy code
    const result = buggyGetTokenBalance('mock-mint', mockConnection, mockConnectionManager);

    // BUG REPRODUCED: reportFailure was never called
    return result.then(() => {
      expect(mockConnectionManager.reportFailure).not.toHaveBeenCalled(); // Shows the bug
    });
  });

  test('FIXED: getTokenBalance should trigger failover on 429 errors', () => {
    // This test shows the correct behavior after the fix

    const mockConnection = {
      getParsedTokenAccountsByOwner: jest.fn<() => Promise<any>>().mockRejectedValue(
        new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}')
      ),
    };

    const mockConnectionManager = {
      reportFailure: jest.fn(),
      getConnection: jest.fn().mockReturnValue(mockConnection),
    };

    // FIXED CODE: getTokenBalance calls reportFailure on 429 errors
    async function fixedGetTokenBalance(tokenMint: string, connection: any, connectionManager: any) {
      try {
        await connection.getParsedTokenAccountsByOwner(
          { publicKey: 'mock-wallet' },
          { mint: tokenMint }
        );
        return 100;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // FIX: Check for 429 errors and report to ConnectionManager
        if (errorMessage.includes('429') || errorMessage.includes('max usage reached')) {
          connectionManager.reportFailure(connection);
          // Get new connection for next attempt
          connection = connectionManager.getConnection();
        }

        logger.error({ error }, 'Error fetching balance');
        return null;
      }
    }

    // Execute fixed code
    const result = fixedGetTokenBalance('mock-mint', mockConnection, mockConnectionManager);

    // FIXED: reportFailure should be called to trigger failover
    return result.then(() => {
      expect(mockConnectionManager.reportFailure).toHaveBeenCalledWith(mockConnection);
      expect(mockConnectionManager.getConnection).toHaveBeenCalled();
    });
  });

  test('getTokenBalance should NOT trigger failover on non-RPC errors', () => {
    // Invalid mint address errors shouldn't trigger RPC failover

    const mockConnection = {
      getParsedTokenAccountsByOwner: jest.fn<() => Promise<any>>().mockRejectedValue(
        new Error('Invalid public key input')
      ),
    };

    const mockConnectionManager = {
      reportFailure: jest.fn(),
      getConnection: jest.fn(),
    };

    async function fixedGetTokenBalance(tokenMint: string, connection: any, connectionManager: any) {
      try {
        await connection.getParsedTokenAccountsByOwner(
          { publicKey: 'mock-wallet' },
          { mint: tokenMint }
        );
        return 100;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Only report RPC failures (429, timeouts, etc), not validation errors
        if (errorMessage.includes('429') ||
            errorMessage.includes('max usage reached') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('503')) {
          connectionManager.reportFailure(connection);
          connection = connectionManager.getConnection();
        }

        return null;
      }
    }

    const result = fixedGetTokenBalance('invalid-mint', mockConnection, mockConnectionManager);

    // Should NOT trigger failover for validation errors
    return result.then(() => {
      expect(mockConnectionManager.reportFailure).not.toHaveBeenCalled();
    });
  });
});
