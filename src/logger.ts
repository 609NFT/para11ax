/**
 * Structured logging for the trading system
 */

import pino from 'pino';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const fileLevel = process.env.LOG_LEVEL_FILE || 'debug';

// Create logger - file only, no console output
// Console output is handled by explicit console.log in index.ts
const logger = pino({
  level: fileLevel,
  transport: {
    target: 'pino/file',
    options: {
      destination: path.join(logsDir, 'parallax.log'),
    },
  },
});

// Specialized loggers for different components
export const feedLogger = logger.child({ component: 'feed' });
export const signalLogger = logger.child({ component: 'signal' });
export const riskLogger = logger.child({ component: 'risk' });
export const executionLogger = logger.child({ component: 'execution' });
export const dbLogger = logger.child({ component: 'db' });

// Trade-specific logging (separate file for audit trail)
const tradeLogPath = path.join(logsDir, 'trades.log');
export function logTrade(tradeData: Record<string, unknown>): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...tradeData,
  };
  fs.appendFileSync(tradeLogPath, JSON.stringify(logEntry) + '\n');
  logger.info({ trade: tradeData }, 'Trade logged');
}

export default logger;
