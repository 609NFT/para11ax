/**
 * Standalone Dashboard Server
 *
 * Runs independently of the trading bot for zero-downtime deploys.
 * Reads all data from Supabase instead of in-memory state.
 *
 * Start with: pm2 start dist/standalone-dashboard.js --name parallax-dashboard
 */

import 'dotenv/config';
import { startWebServer } from './web/server';
import logger from './logger';

// Set flag indicating we're running in standalone mode
// The web server will use Supabase data instead of in-memory state
process.env.DASHBOARD_STANDALONE = 'true';

const PORT = parseInt(process.env.WEB_PORT || '3001');

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('        PARALLAX - STANDALONE DASHBOARD');
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('Mode: STANDALONE (reading from Supabase)');
  logger.info(`Port: ${PORT}`);

  try {
    await startWebServer(PORT);
    logger.info({ port: PORT, mode: 'standalone' }, 'Dashboard server started');

    // Signal PM2 that we're ready (instant startup)
    if (process.send) {
      process.send('ready');
      logger.info('Sent ready signal to PM2');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to start dashboard server');
    process.exit(1);
  }
}

main();
