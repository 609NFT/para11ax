#!/usr/bin/env npx ts-node
/**
 * CLI tool to search and analyze Parallax logs
 * Usage: npx ts-node scripts/search-logs.ts [options] <search_term>
 *
 * Options:
 *   --last <n>     Show last n lines (default: 100)
 *   --level <lvl>  Filter by log level (error, warn, info, debug)
 *   --component <c> Filter by component (feed, signal, risk, execution, db)
 *   --since <time> Show logs since time (e.g., "1h", "30m", "2024-01-19")
 *   --trades       Search trades.log instead of parallax.log
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const args = process.argv.slice(2);

// Parse args
let lastN = 100;
let level: string | null = null;
let component: string | null = null;
let since: number | null = null;
let searchTerm: string | null = null;
let useTradesLog = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--last' && args[i + 1]) {
    lastN = parseInt(args[++i], 10);
  } else if (arg === '--level' && args[i + 1]) {
    level = args[++i].toLowerCase();
  } else if (arg === '--component' && args[i + 1]) {
    component = args[++i];
  } else if (arg === '--since' && args[i + 1]) {
    const sinceArg = args[++i];
    if (sinceArg.endsWith('h')) {
      since = Date.now() - parseInt(sinceArg) * 60 * 60 * 1000;
    } else if (sinceArg.endsWith('m')) {
      since = Date.now() - parseInt(sinceArg) * 60 * 1000;
    } else {
      since = new Date(sinceArg).getTime();
    }
  } else if (arg === '--trades') {
    useTradesLog = true;
  } else if (!arg.startsWith('--')) {
    searchTerm = arg;
  }
}

const logFile = useTradesLog
  ? path.join(process.cwd(), 'logs', 'trades.log')
  : path.join(process.cwd(), 'logs', 'parallax.log');

if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

interface LogEntry {
  level?: number;
  time?: number;
  component?: string;
  msg?: string;
  [key: string]: unknown;
}

const levelNames: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const levelNumbers: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

async function main() {
  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const lines: string[] = [];
  const matchedLines: LogEntry[] = [];

  for await (const line of rl) {
    lines.push(line);
    // Keep only last N * 10 lines in memory for efficiency
    if (lines.length > lastN * 10) {
      lines.shift();
    }
  }

  // Process last N lines
  const toProcess = lines.slice(-lastN * 2);

  for (const line of toProcess) {
    try {
      const entry = JSON.parse(line) as LogEntry;

      // Filter by level
      if (level && entry.level !== undefined) {
        const targetLevel = levelNumbers[level];
        if (targetLevel && entry.level < targetLevel) continue;
      }

      // Filter by component
      if (component && entry.component !== component) continue;

      // Filter by time
      if (since && entry.time && entry.time < since) continue;

      // Filter by search term
      if (searchTerm) {
        const lineStr = JSON.stringify(entry).toLowerCase();
        if (!lineStr.includes(searchTerm.toLowerCase())) continue;
      }

      matchedLines.push(entry);
    } catch {
      // Skip non-JSON lines
      if (searchTerm && line.toLowerCase().includes(searchTerm.toLowerCase())) {
        console.log(line);
      }
    }
  }

  // Output last N matched lines
  const output = matchedLines.slice(-lastN);

  if (output.length === 0) {
    console.log('No matching log entries found.');
    process.exit(0);
  }

  // Format output
  for (const entry of output) {
    const time = entry.time ? new Date(entry.time).toISOString() : 'unknown';
    const lvl = entry.level !== undefined ? levelNames[entry.level] || 'unknown' : 'unknown';
    const comp = entry.component || '-';
    const msg = entry.msg || '';

    // Remove already-printed fields for cleaner output
    const { time: _t, level: _l, component: _c, msg: _m, pid: _p, hostname: _h, ...rest } = entry;

    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';

    console.log(`[${time}] ${lvl.toUpperCase().padEnd(5)} [${comp}] ${msg}${extra}`);
  }

  console.log(`\n--- Showing ${output.length} of ${matchedLines.length} matched entries ---`);
}

main().catch(console.error);
