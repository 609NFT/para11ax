/**
 * CLI Dashboard for Mean Reversion Trading
 * Real-time monitoring of mean reversion trading system
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { getConfigSync, getModeDescription } from '../config';
import { getRiskManager } from '../risk';
import { getDatabase } from '../db';
import logger from '../logger';

const DEFAULT_UPDATE_INTERVAL_MS = 5000; // 5 seconds

export class Dashboard {
  private updateInterval: NodeJS.Timeout | null = null;
  private loopCount: number = 0;

  /**
   * Display single-line status (default mode)
   */
  async displayStatusLine(): Promise<void> {
    const config = getConfigSync();
    const database = getDatabase();
    const riskManager = getRiskManager();

    this.loopCount++;

    // Get mean reversion stats
    const stats = await database.getStats();
    const openPositions = await database.getOpenPositions();
    const summary = riskManager.getSummary();

    // Build status components
    const time = new Date().toLocaleTimeString();
    const mode = config.mode.toUpperCase();
    const modeColor = config.mode === 'live' ? chalk.red : chalk.green;

    // Open positions
    const openCount = openPositions.length;
    const openStr = openCount > 0 ? chalk.yellow(`${openCount}`) : chalk.gray('0');

    // PnL
    const pnl = stats.totalPnlUsd;
    const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlStr = `${pnlSign}$${pnl.toFixed(2)}`;
    const tradesStr = `${stats.totalTrades} trades`;
    const winRateStr = stats.totalTrades > 0 ? `, ${(stats.winRate * 100).toFixed(0)}% win` : '';

    // Kill switch warning
    const killSwitchStr = summary.killSwitch ? chalk.red.bold(' [KILL SWITCH]') : '';

    // Build the line
    const statusLine = [
      chalk.gray(`[${time}]`),
      modeColor(mode),
      `Open:${openStr}`,
      `PnL:${pnlColor(pnlStr)} (${tradesStr}${winRateStr})`,
      killSwitchStr,
    ].filter(Boolean).join(' | ');

    console.log(statusLine);
  }

  /**
   * Display full dashboard (clearing mode)
   */
  async displayFullStatus(): Promise<void> {
    const config = getConfigSync();

    console.clear();
    console.log(chalk.bold.cyan('\n══════════════════════════════════════════════════════'));
    console.log(chalk.bold.cyan('              PARALLAX MEAN REVERSION'));
    console.log(chalk.bold.cyan('══════════════════════════════════════════════════════\n'));

    // Mode indicator
    const modeColor = config.mode === 'live' ? chalk.red : chalk.green;
    console.log(modeColor(getModeDescription(config.mode)));
    console.log();

    // Risk status
    this.displayRiskStatus();

    // Positions
    this.displayPositions();

    // PnL Summary
    this.displayPnL();

    // Recent trades
    this.displayRecentTrades();

    console.log(chalk.gray('\nPress Ctrl+C to exit'));
  }

  /**
   * Display risk status
   */
  private displayRiskStatus(): void {
    const riskManager = getRiskManager();
    const summary = riskManager.getSummary();

    console.log(chalk.bold.yellow('RISK STATUS'));
    console.log('─'.repeat(50));

    const killSwitchStatus = summary.killSwitch
      ? chalk.red.bold('ACTIVE - ALL TRADING HALTED')
      : chalk.green('Normal');
    console.log(`Kill Switch:     ${killSwitchStatus}`);

    console.log(`Daily Loss:      $${summary.dailyLoss.toFixed(2)}`);
    console.log(`Daily Trades:    ${summary.dailyTrades}`);

    if (summary.disabledTokens.length > 0) {
      console.log(`Disabled Tokens: ${chalk.yellow(summary.disabledTokens.join(', '))}`);
    }

    console.log();
  }

  /**
   * Display open positions
   */
  private async displayPositions(): Promise<void> {
    const database = getDatabase();
    const positions = await database.getOpenPositions();

    console.log(chalk.bold.green('OPEN POSITIONS'));
    console.log('─'.repeat(50));

    if (positions.length === 0) {
      console.log(chalk.gray('No open positions'));
      console.log();
      return;
    }

    const table = new Table({
      head: [
        chalk.white('Ticker'),
        chalk.white('Buy'),
        chalk.white('Sell'),
        chalk.white('Entry Spread'),
        chalk.white('Size $'),
        chalk.white('Hold Time'),
      ],
      style: { head: [], border: [] },
    });

    for (const position of positions) {
      const holdTime = this.formatHoldTime(Date.now() - position.entryTimestamp);

      table.push([
        position.stockTicker,
        position.buySymbol,
        position.sellSymbol,
        position.entrySpreadPct.toFixed(2) + '%',
        position.sizeUsd.toFixed(2),
        holdTime,
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Display PnL summary
   */
  private async displayPnL(): Promise<void> {
    const database = getDatabase();
    const stats = await database.getStats();

    console.log(chalk.bold.blue('PNL SUMMARY'));
    console.log('─'.repeat(50));

    const totalPnL = stats.totalPnlUsd;
    const totalPnLColor = totalPnL >= 0 ? chalk.green : chalk.red;

    console.log(`Total PnL:       ${totalPnLColor(`$${totalPnL.toFixed(2)}`)}`);
    console.log();

    // Stats
    if (stats.totalTrades > 0) {
      console.log(chalk.bold.magenta('STATISTICS'));
      console.log('─'.repeat(50));
      console.log(`Total Trades:    ${stats.totalTrades}`);
      console.log(`Win Rate:        ${(stats.winRate * 100).toFixed(1)}%`);
      console.log(`Largest Win:     ${chalk.green(`$${stats.largestWin.toFixed(2)}`)}`);
      console.log(`Largest Loss:    ${chalk.red(`$${stats.largestLoss.toFixed(2)}`)}`);
      console.log();
    }
  }

  /**
   * Display recent trades
   */
  private async displayRecentTrades(): Promise<void> {
    const database = getDatabase();
    const closedPositions = await database.getClosedPositions(5);

    console.log(chalk.bold.white('RECENT TRADES'));
    console.log('─'.repeat(50));

    if (closedPositions.length === 0) {
      console.log(chalk.gray('No completed trades'));
      console.log();
      return;
    }

    const table = new Table({
      head: [
        chalk.white('Ticker'),
        chalk.white('Entry %'),
        chalk.white('Exit %'),
        chalk.white('PnL'),
        chalk.white('Reason'),
        chalk.white('Duration'),
      ],
      style: { head: [], border: [] },
    });

    for (const position of closedPositions) {
      const pnlStr = this.formatPnL(position.pnlUsd || 0, position.pnlPct || 0);
      const duration = this.formatHoldTime(
        (position.exitTimestamp || Date.now()) - position.entryTimestamp
      );

      const exitReason = position.exitReason
        ? this.formatExitReason(position.exitReason)
        : chalk.gray('N/A');

      table.push([
        position.stockTicker,
        position.entrySpreadPct.toFixed(2) + '%',
        (position.exitSpreadPct || 0).toFixed(2) + '%',
        pnlStr,
        exitReason,
        duration,
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Format PnL with color
   */
  private formatPnL(pnlUsd: number, pnlPct: number): string {
    const color = pnlUsd >= 0 ? chalk.green : chalk.red;
    const sign = pnlUsd >= 0 ? '+' : '';
    if (pnlPct !== 0) {
      return color(`${sign}$${pnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`);
    }
    return color(`${sign}$${pnlUsd.toFixed(2)}`);
  }

  /**
   * Format hold time
   */
  private formatHoldTime(ms: number): string {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format exit reason
   */
  private formatExitReason(reason: string): string {
    const colors: Record<string, typeof chalk.green> = {
      discount_normalized: chalk.green,
      profit_target: chalk.green,
      max_hold_time: chalk.yellow,
      stop_loss: chalk.red,
      price_stop_loss: chalk.red,
      rwa_stop_loss: chalk.red,
      manual_close: chalk.blue,
      kill_switch: chalk.red,
    };

    const labels: Record<string, string> = {
      profit_target: 'Profit',
      max_hold_time: 'Time Limit',
      stop_loss: 'Stop Loss',
      price_stop_loss: 'Price Stop',
      rwa_stop_loss: 'RWA Stop',
      manual_close: 'Manual',
      kill_switch: 'Kill Switch',
    };

    const color = colors[reason] || chalk.white;
    const label = labels[reason] || reason;
    return color(label);
  }

  /**
   * Start live updates
   */
  startLiveUpdates(intervalMs: number = DEFAULT_UPDATE_INTERVAL_MS): void {
    const fullMode = process.env.DASHBOARD_FULL === 'true';

    if (fullMode) {
      this.displayFullStatus();
      this.updateInterval = setInterval(() => {
        this.displayFullStatus();
      }, intervalMs);
    } else {
      this.displayStatusLine();
      this.updateInterval = setInterval(() => {
        this.displayStatusLine();
      }, intervalMs);
    }
  }

  /**
   * Stop live updates
   */
  stopLiveUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

// CLI entry point
async function main(): Promise<void> {
  if (process.env.DASHBOARD_ENABLED === 'false') {
    console.log('Dashboard disabled via DASHBOARD_ENABLED=false');
    return;
  }

  const dashboard = new Dashboard();

  process.on('SIGINT', () => {
    dashboard.stopLiveUpdates();
    console.log('\nExiting...');
    process.exit(0);
  });

  dashboard.startLiveUpdates();
}

if (require.main === module) {
  main().catch((error) => {
    logger.error({ error }, 'CLI dashboard failed');
    process.exit(1);
  });
}
