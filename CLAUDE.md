# Parallax - Tokenized Stock Arbitrage Bot

## Project Overview

Parallax is a Solana-based trading bot that executes statistical arbitrage on tokenized stocks (rStocks like rTSLA, rNVDA, rSPY). It runs two strategies:

1. **Long (Mean Reversion)**: Buy spot tokens at discount, sell when spread narrows
2. **Short (Premium Shorting)**: Short via Flash Trade perps when tokens trade at premium

## Architecture

```
src/
├── orchestrator.ts      # Main trading loop, position management
├── signals/
│   ├── meanReversionSignal.ts   # Long entry/exit signals
│   └── premiumShortSignal.ts    # Short entry/exit signals
├── execution/
│   ├── flashTradeClient.ts      # Flash Trade perp execution
│   └── jupiterClient.ts         # DEX swap execution
├── liquidity/
│   └── liquidityChecker.ts      # TVL-based thresholds
├── risk/
│   └── riskManager.ts           # Daily limits, circuit breaker
├── db/
│   └── database.ts              # SQLite persistence
└── web/
    └── server.ts                # Dashboard UI
```

## Key Concepts

- **Discount**: Token trading below stock price (good for longs)
- **Premium**: Token trading above stock price (good for shorts)
- **Entry Threshold**: Minimum discount/premium to enter position
- **Circuit Breaker**: 5 consecutive losses stops the bot
- **TVL Tiers**: Position size and thresholds scale with liquidity

## Running

```bash
npm run build          # Compile TypeScript
npm start              # Live mode with Cloudflare tunnel
npm run start:notunnel # Live mode without tunnel
npm run paper          # Paper trading mode
```

## Database

SQLite at `data/parallax.db`:
- `mean_reversion_positions` - Long positions
- `short_positions` - Short positions
- `discount_history` - Price snapshots

## Dashboard

Web UI at http://localhost:3001 (or https://parallax.report via tunnel)

## Token Discovery

Tokens are loaded dynamically from **Supabase** (not config.json). The `config/config.json` file is only used for trading parameters (thresholds, position sizing, etc.), NOT for token lists.

```
src/db/supabaseClient.ts  # Fetches tokens from Supabase "Token" table where indexId='stocks'
src/config.ts             # Merges DB tokens with config.json settings
```

## CRITICAL RULES

**NEVER delete, truncate, or modify database data without explicit confirmation.** Always ask "Which specific tables do you want me to truncate/delete from?" before running any destructive database operations. SQLite on EC2 is the source of truth; Supabase is a replica.

## DATA ACCESS - READ THIS FIRST

**Production runs on EC2, NOT locally.** When investigating trades, positions, or errors:

1. **Trade/Position Data**: Query **Supabase** (via `TRADES_DB_URL` in .env), NOT local SQLite
   - Local `data/parallax.db` is for local dev only - it has no production data
   - Use: `node -e "require('dotenv').config(); const {Pool}=require('pg'); ..."` pattern

2. **Logs**: Claude cannot SSH to EC2 (network sandbox restriction)
   - Ask user to paste log output directly into chat
   - User runs in AWS console: `pm2 logs parallax --nostream --lines 50 | grep -i "error\|fail"`
   - Local logs are NOT production logs

3. **Never assume local files have production data** - always use Supabase or SSH to EC2
