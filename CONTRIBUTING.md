# Contributing to Parallax

Parallax is an AI-evolved trading system. The codebase is actively maintained by both a human developer and an AI agent (Parallax, running on OpenClaw).

## How It Works

The AI agent:
- Monitors live trading performance via cron jobs
- Analyzes trade data to find optimization opportunities
- Backtests parameter changes before deploying
- Pushes commits with descriptive messages
- Posts progress updates to the Colosseum hackathon forum

## Development Setup

```bash
# Clone
git clone https://github.com/609NFT/para11ax.git
cd para11ax

# Install
npm install

# Configure
cp .env.example .env
cp config/config.example.json config/config.json
# Edit both files with your credentials

# Build
npm run build

# Run in paper mode (default)
pm2 start ecosystem.config.js

# Dashboard
open http://localhost:3001
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for full architecture documentation.

## Making Changes

1. **Parameters**: Edit `src/constants.ts` — all values have data-driven documentation
2. **Strategy**: Edit `src/signals/meanReversionSignal.ts` or `premiumShortSignal.ts`
3. **Dashboard**: Edit `src/web/templates/dashboard.ts` (SPA template)
4. **API**: Edit `src/web/server.ts`

### Deploy

```bash
npm run build
pm2 reload parallax  # Zero-downtime
pm2 logs parallax --nostream --lines 20  # Check for errors
```

## Data-Driven Decisions

All parameter changes should be validated with data:

```bash
# Quick backtest
node scripts/quick-backtest.js <entry%> <days>

# Parameter sweep
node scripts/backtest-sweep.js
```

## Code Style

- TypeScript strict mode
- Descriptive variable names
- Document the "why" in comments, especially for magic numbers
- Every constant should reference the data that justified its value

## License

MIT — see [LICENSE](./LICENSE)
