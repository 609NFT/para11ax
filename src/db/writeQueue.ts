/**
 * Write Queue for Supabase Migration
 *
 * Replaces the fire-and-forget write pattern (`.catch(() => {})`) with
 * proper retry logic and error handling.
 *
 * Features:
 * - Automatic retry with exponential backoff (1s, 2s, 4s)
 * - Max 3 retries before logging failure
 * - Non-blocking queue processing
 * - Prevents silent data loss
 */

import { dbLogger } from '../logger';
import { notifyError } from '../notifications/discord';

// Queue processing constants
const QUEUE_POLL_INTERVAL_MS = 100;

export interface WriteOperation {
  id: string;
  operation: () => Promise<void>;
  retryCount: number;
  maxRetries: number;
  timestamp: number;
}

export class WriteQueue {
  private queue: WriteOperation[] = [];
  private processing = false;

  /**
   * Add operation to queue and start processing if not already running
   * @param op Write operation to enqueue
   */
  async enqueue(op: WriteOperation): Promise<void> {
    this.queue.push(op);

    // Start processing if not already running (non-blocking)
    if (!this.processing) {
      this.process().catch((err) => {
        dbLogger.error({ error: err }, 'Write queue processing error');
      });
    }
  }

  /**
   * Process queued write operations with retry logic
   */
  private async process(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const op = this.queue.shift()!;

      try {
        // Attempt the write operation
        await op.operation();

        // Log success for high retry counts (indicates transient issues)
        if (op.retryCount > 0) {
          dbLogger.info(
            { id: op.id, retryCount: op.retryCount },
            'Write operation succeeded after retries'
          );
        }
      } catch (error) {
        if (op.retryCount < op.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = Math.pow(2, op.retryCount) * 1000;

          dbLogger.warn(
            {
              id: op.id,
              retryCount: op.retryCount + 1,
              maxRetries: op.maxRetries,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            'Write operation failed, retrying'
          );

          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          // Re-queue with incremented retry count
          op.retryCount++;
          this.queue.push(op);
        } else {
          // Max retries exceeded - log error and give up
          dbLogger.error(
            {
              id: op.id,
              retryCount: op.retryCount,
              timestamp: op.timestamp,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            'Write operation failed after max retries - DATA LOSS'
          );

          // Alert on critical data loss
          await notifyError('WriteQueue Data Loss', `Operation ${op.id} failed after ${op.maxRetries} retries: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    this.processing = false;
  }

  /**
   * Get queue statistics for monitoring
   */
  getStats(): { queueDepth: number; processing: boolean } {
    return {
      queueDepth: this.queue.length,
      processing: this.processing,
    };
  }

  /**
   * Wait for queue to be empty (useful for graceful shutdown)
   */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.processing) {
      await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
    }
  }
}

// Singleton instance
const queueInstance = new WriteQueue();

export const getWriteQueue = (): WriteQueue => queueInstance;
