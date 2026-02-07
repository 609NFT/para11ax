/**
 * Main Entry Point
 * Solana Tokenized Stock Mean Reversion Bot
 *
 * Buys tokens when discounted vs stock price,
 * sells when price returns to fair value.
 *
 * SAFETY FIRST:
 * - Paper mode is DEFAULT
 * - No live trades unless explicitly enabled
 * - All trades require risk gate approval
 */

import { getConfig } from './config';
import { getOrchestrator } from './orchestrator';
import { validateDatabaseConnections } from './db/supabaseClient';
import logger from './logger';

async function main(): Promise<void> {
  // Validate required environment variables
  const requiredEnvVars = ['DIRECT_URL', 'TRADES_DB_URL', 'SOLANA_PRIVATE_KEY', 'RPC_ENDPOINT'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    process.exit(1);
  }

  logger.info('Environment variables validated');

  // Validate database connections
  try {
    await validateDatabaseConnections();
  } catch (error) {
    logger.error({ error }, 'Database connection validation failed');
    process.exit(1);
  }

  const config = await getConfig();

  logger.info('Starting up bot...');

  // Safety warning for live mode
  if (config.mode === 'live') {
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  const orchestrator = getOrchestrator();

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    logger.error({ error }, 'Uncaught exception - activating kill switch');
    orchestrator.activateKillSwitch(`Uncaught exception: ${error.message}`);
    await shutdown();
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error({ reason }, 'Unhandled rejection - activating kill switch');
    orchestrator.activateKillSwitch(`Unhandled rejection: ${reason}`);
  });

  try {
    // Initialize
    await orchestrator.initialize();

    // Start trading loop
    await orchestrator.start();

    // Keep process running
    logger.info('Bot is running.');
  } catch (error) {
    const err = error as Error;
    logger.error({
      error: {
        message: err.message,
        stack: err.stack,
        name: err.name,
      }
    }, 'Failed to start bot');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error({ error }, 'Failed to start bot - uncaught error');
  process.exit(1);
});
