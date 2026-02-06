/**
 * Discord webhook notifications for trade events
 */

import logger from '../logger';

// Separate webhooks: trades go to #trades, alerts go to #alerts
const TRADES_WEBHOOK_URL = process.env.DISCORD_TRADES_WEBHOOK_URL;
const ALERTS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

interface TradeNotification {
  type: 'entry' | 'exit';
  ticker: string;
  token: string;
  spreadPct: number;
  sizeUsd: number;
  pnlUsd?: number;
  exitReason?: string;
  txSignature?: string;
}

/**
 * Send a notification to Discord
 * @param content - Message content
 * @param channel - 'trades' or 'alerts' (default: 'alerts')
 */
async function sendDiscordMessage(content: string, channel: 'trades' | 'alerts' = 'alerts'): Promise<void> {
  const webhookUrl = channel === 'trades' ? TRADES_WEBHOOK_URL : ALERTS_WEBHOOK_URL;
  
  if (!webhookUrl) {
    logger.debug({ channel }, 'Discord webhook not configured, skipping notification');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, channel }, 'Discord webhook failed');
    }
  } catch (error) {
    logger.warn({ error, channel }, 'Failed to send Discord notification');
  }
}

/**
 * Notify on trade entry
 */
export async function notifyEntry(trade: TradeNotification): Promise<void> {
  const solscanLink = trade.txSignature 
    ? `[tx](https://solscan.io/tx/${trade.txSignature})`
    : '';
  
  const message = [
    `📈 **ENTRY** | ${trade.ticker}`,
    `Token: \`${trade.token}\``,
    `Spread: ${trade.spreadPct.toFixed(2)}%`,
    `Size: $${trade.sizeUsd.toFixed(2)}`,
    solscanLink,
  ].filter(Boolean).join(' • ');

  await sendDiscordMessage(message, 'trades');
}

/**
 * Notify on trade exit
 */
export async function notifyExit(trade: TradeNotification): Promise<void> {
  const pnlEmoji = (trade.pnlUsd ?? 0) >= 0 ? '🟢' : '🔴';
  const pnlStr = trade.pnlUsd !== undefined 
    ? `${trade.pnlUsd >= 0 ? '+' : ''}$${trade.pnlUsd.toFixed(3)}`
    : 'n/a';
  
  const solscanLink = trade.txSignature 
    ? `[tx](https://solscan.io/tx/${trade.txSignature})`
    : '';

  const message = [
    `${pnlEmoji} **EXIT** | ${trade.ticker}`,
    `Token: \`${trade.token}\``,
    `P&L: ${pnlStr}`,
    `Reason: ${trade.exitReason || 'target'}`,
    solscanLink,
  ].filter(Boolean).join(' • ');

  await sendDiscordMessage(message, 'trades');
}

/**
 * Notify on bot startup
 */
export async function notifyStartup(): Promise<void> {
  await sendDiscordMessage('⊹ **Parallax online** — Monitoring for opportunities');
}

/**
 * Notify on circuit breaker trip
 */
export async function notifyCircuitBreaker(losses: number, amount: number): Promise<void> {
  await sendDiscordMessage(
    `🚨 **CIRCUIT BREAKER** — ${losses} consecutive losses, -$${Math.abs(amount).toFixed(2)} total. Bot paused.`
  );
}

/**
 * Notify on error
 */
export async function notifyError(context: string, error: string): Promise<void> {
  await sendDiscordMessage(`⚠️ **Error** | ${context}: ${error}`);
}

/**
 * Short position notification
 */
interface ShortNotification {
  ticker: string;
  flashSymbol: string;
  premiumPct: number;
  collateralUsd: number;
  leverage: number;
  pnlUsd?: number;
  exitReason?: string;
  txSignature?: string;
}

/**
 * Notify on short entry
 */
export async function notifyShortEntry(trade: ShortNotification): Promise<void> {
  const solscanLink = trade.txSignature 
    ? `[tx](https://solscan.io/tx/${trade.txSignature})`
    : '';
  
  const message = [
    `📉 **SHORT ENTRY** | ${trade.ticker}`,
    `Premium: ${trade.premiumPct.toFixed(2)}%`,
    `Collateral: $${trade.collateralUsd.toFixed(2)}`,
    `Leverage: ${trade.leverage}x`,
    solscanLink,
  ].filter(Boolean).join(' • ');

  await sendDiscordMessage(message, 'trades');
}

/**
 * Notify on short exit
 */
export async function notifyShortExit(trade: ShortNotification): Promise<void> {
  const pnlEmoji = (trade.pnlUsd ?? 0) >= 0 ? '🟢' : '🔴';
  const pnlStr = trade.pnlUsd !== undefined 
    ? `${trade.pnlUsd >= 0 ? '+' : ''}$${trade.pnlUsd.toFixed(3)}`
    : 'n/a';
  
  const solscanLink = trade.txSignature 
    ? `[tx](https://solscan.io/tx/${trade.txSignature})`
    : '';

  const message = [
    `${pnlEmoji} **SHORT EXIT** | ${trade.ticker}`,
    `P&L: ${pnlStr}`,
    `Reason: ${trade.exitReason || 'target'}`,
    solscanLink,
  ].filter(Boolean).join(' • ');

  await sendDiscordMessage(message, 'trades');
}
