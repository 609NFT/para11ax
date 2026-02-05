# Parallax — AI-Evolved RWA Arbitrage Engine

## Overview

Parallax is a live statistical arbitrage system on Solana that trades Real World Assets (tokenized stocks, ETFs, and commodities). An AI agent (running on OpenClaw) continuously evolves the trading strategy through data analysis, backtesting, and autonomous parameter optimization.

**Live dashboard:** [parallax.report](https://parallax.report)

## Architecture

```
src/
├── orchestrator.ts          # Main trading loop — 10s cycle, position lifecycle
├── constants.ts             # All tunable parameters with data-driven documentation
├── signals/
│   ├── meanReversionSignal.ts   # Long signals — discount detection + entry logic
│   └── premiumShortSignal.ts    # Short signals — premium detection via Flash Trade
├── execution/
│   ├── executor.ts              # Trade execution coordinator
│   ├── jupiterClient.ts         # Jupiter DEX swap routing
│   ├── jupiterUltraClient.ts    # Jupiter Ultra API (best routes)
│   ├── raydiumClient.ts         # Direct Raydium CLMM swaps
│   └── flashTradeClient.ts      # Flash Trade perpetual futures
├── liquidity/
│   └── liquidityChecker.ts      # Dynamic TVL-based thresholds + fee estimation
├── feeds/
│   ├── stockFeed.ts             # Stock/NAV price feeds (multiple sources)
│   ├── onchainFeed.ts           # On-chain token price feeds
│   ├── volatilityFeed.ts        # ATR-based volatility calculation
│   ├── dexScreenerFeed.ts       # DEX pool data
│   ├── geckoTerminalFeed.ts     # GeckoTerminal pool data
│   ├── swissquoteFeed.ts        # Swissquote stock data
│   └── endpointTracker.ts       # API health monitoring
├── risk/
│   └── riskManager.ts           # Circuit breaker, daily limits, kill switch
├── backtest/
│   └── backtester.ts            # Historical replay with time-decay + trailing stops
├── db/
│   ├── database.ts              # Local SQLite persistence
│   ├── supabaseClient.ts        # Supabase cloud sync
│   ├── writeQueue.ts            # Batched writes (resource optimization)
│   ├── queryCache.ts            # Query result caching
│   └── profitableSpreadCalc.ts  # Historical profitable spread analysis
├── web/
│   ├── server.ts                # Express API + dashboard server
│   ├── templates/dashboard.ts   # Full SPA dashboard (dark theme)
│   └── utils/                   # Auth, markdown rendering
├── notifications/               # Discord webhook alerts
└── config.ts                    # Runtime configuration management
```

## Key Concepts

### Trading Strategy
- **Mean Reversion (Long)**: Buy RWA tokens trading at discount to NAV, sell when spread narrows
- **Premium Shorting**: Short via Flash Trade perps when tokens trade at premium to NAV
- **Entry**: Only when discount exceeds both TVL-based minimum AND 95th percentile for that token
- **Exit**: Time-decaying target (2-3% → 1% over 2-3.5h) with trailing stop

### Dynamic Thresholds
All thresholds scale with pool liquidity using `coefficient / sqrt(tvl_in_millions)`:
- High TVL ($2M+): Tight thresholds, small position sizes sufficient
- Low TVL (<$100K): Wide thresholds, effectively blocked below $50K
- Fee estimates also scale with TVL (0.05% at $2M → 0.5% at $100K)

### Volatility Adjustment
Entry thresholds are multiplied by a volatility factor calculated from internal price history:
- BASE_ATR: 2.7% (observed median across all tokens)
- Effective range: 3.4-5.2% entry thresholds depending on token volatility

### Risk Management
- Daily loss circuit breaker (configurable USD limit)
- Kill switch (manual or automatic)
- Per-token cooldowns on failures
- Price impact detection blocks bad entries
- Max 3 concurrent positions

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/dashboard` | GET | Full trading state — stats, positions, watchlist, risk |
| `/api/wallet` | GET | SOL/USDC balances |
| `/api/trades` | GET | Closed trade history (filterable) |
| `/api/analytics` | GET | Per-token performance, time analysis, exit reasons |
| `/api/heatmap` | GET | Discount spread heatmap data |
| `/api/commits` | GET | Recent git commit history |
| `/api/blog` | GET | Trading methodology (rendered markdown) |
| `/api/logs/file` | GET | Tail log file |
| `/api/admin/*` | POST | Admin controls (auth required) |

## Configuration

Primary config: `config/config.json`
- `mode`: "paper" | "live" — paper mode simulates trades
- `maxUsdPerTrade`: Position size limit
- `maxDailyLoss`: Circuit breaker threshold
- `supabaseUrl` / `supabaseKey`: Cloud database sync
- `jupiterApiKey`: Jupiter aggregator API key

Static parameters: `src/constants.ts`
- All threshold formulas with data-driven documentation
- Fee estimation curves calibrated from actual trade data
- Hold time limits validated via backtesting

## Development

```bash
npm install          # Install dependencies
npm run build        # TypeScript → JavaScript
npm run dev          # Development with auto-reload
npm test             # Run tests
pm2 reload parallax  # Zero-downtime deploy (cluster mode)
```

## Database

**Local**: SQLite for position tracking and system state
**Cloud**: Supabase PostgreSQL for:
- `discount_history` — Token spread data (30-day retention)
- `discount_heatmap_summary` — Hourly aggregated spreads
- `mean_reversion_positions` — All long trades
- `short_positions` — All short trades
- `system_state` — Key-value runtime state

## Rules for AI Agent

1. **NEVER** delete or truncate database data without explicit confirmation
2. Always backtest parameter changes before deploying
3. Use `pm2 reload` (not restart) for zero-downtime deploys
4. Check logs for errors after every deploy
5. Update MARKET_LEARNINGS.md when changing parameters
6. These are **RWAs** — tokens trade 24/7, market hours are irrelevant for spread analysis
7. Git commit every meaningful change with descriptive messages
