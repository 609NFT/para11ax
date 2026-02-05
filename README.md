# Parallax

**Solana tokenized stock arbitrage — buy the discount, ride the reversion.**

Parallax is a fully automated statistical arbitrage bot that trades tokenized stocks (rTSLA, rNVDA, rSPY, and 20+ others) on Solana. It detects when on-chain token prices deviate from their real-world stock NAV, enters positions at discount, and exits on mean reversion — capturing the spread as profit.

Built by an AI agent collaborating with a human. Running in production with real capital.

> 🏆 Solana hackathon submission — this is a live, deployed system, not a prototype.

---

## How It Works

Tokenized stocks on Solana (rStocks via Clone/Reflect) sometimes trade at a discount or premium to their underlying stock price. Parallax monitors these spreads in real-time and:

1. **Buys** when a token trades at a significant discount to NAV (e.g., rTSLA at -4% vs TSLA)
2. **Holds** while the spread narrows (mean reversion)
3. **Sells** when the token price converges back toward fair value
4. **Shorts** via Flash Trade perps when tokens trade at a premium (optional)

The edge: these mispricings are temporary and predictable. Parallax captures them systematically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PARALLAX BOT                             │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  FEEDS   │→ │ SIGNALS  │→ │   RISK   │→ │  EXECUTION    │  │
│  │          │  │          │  │          │  │               │  │
│  │ • Pyth   │  │ • Mean   │  │ • Kill   │  │ • Jupiter     │  │
│  │ • Finnhub│  │   Revert │  │   Switch │  │   (swaps)     │  │
│  │ • Alpaca │  │ • Premium│  │ • Daily  │  │ • Flash Trade │  │
│  │ • DexScr │  │   Short  │  │   Limits │  │   (perps)     │  │
│  │ • Raydium│  │ • ATR    │  │ • Circuit│  │ • Raydium     │  │
│  │ • GeckoT │  │   Adjust │  │   Breaker│  │   (CLMM)      │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│       ↕              ↕              ↕              ↕            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ORCHESTRATOR (main loop @ 10s)             │   │
│  └─────────────────────────────────────────────────────────┘   │
│       ↕                                        ↕               │
│  ┌──────────┐                          ┌───────────────┐       │
│  │    DB    │                          │   DASHBOARD   │       │
│  │          │                          │               │       │
│  │ Supabase │                          │ Web UI + API  │       │
│  │ (prod)   │                          │ Heatmap view  │       │
│  │ SQLite   │                          │ P&L tracking  │       │
│  │ (dev)    │                          │ Risk status   │       │
│  └──────────┘                          └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Features

### Trading Engine
- **Mean reversion strategy** — buys discounted rStocks, exits on spread convergence
- **Premium shorting** — short via Flash Trade perps when tokens trade above NAV
- **Volatility-adjusted entry thresholds** — per-token ATR from Twelve Data API
- **TVL-scaled position sizing** — larger positions in liquid pools, smaller in thin ones
- **Dynamic exit targets** — time-decaying thresholds with trailing stops to let winners run
- **Percentile-based entry** — only enters when spread is historically exceptional (95th percentile)

### Risk Management
- **Kill switch** — instant halt on uncaught exceptions or manual trigger
- **Circuit breaker** — stops after consecutive losses
- **Daily loss limits** — configurable max daily drawdown
- **Daily trade limits** — prevents overtrading
- **Stop losses** — price-based and stock-based stop losses with grace periods
- **Staleness checks** — won't trade on stale price data
- **Paper → Shadow → Live** progression with safety gates

### Data & Monitoring
- **Real-time dashboard** at [parallax.report](https://parallax.report) (Cloudflare tunnel)
- **Discount heatmap** — visual grid of all token spreads
- **P&L tracking** — per-trade and aggregate performance
- **Discord notifications** — trade entries, exits, and circuit breaker alerts
- **Multi-source price feeds** — Alpaca, Finnhub, Polygon, Twelve Data with failover

### Execution
- **Jupiter Ultra** for optimized swaps (with fallback to standard Jupiter)
- **Raydium CLMM** direct routing for specific pools
- **Flash Trade SDK** for perpetual positions (shorting)
- **Slippage escalation** on exit retries (1% → 1.5% → 2%)
- **Priority fee escalation** for congested networks
- **Orphan token cleanup** — recovers dust from failed/partial trades

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js |
| Blockchain | Solana (via @solana/web3.js) |
| DEX | Jupiter, Raydium CLMM |
| Perps | Flash Trade SDK |
| Oracles | Pyth (via Flash Trade), Finnhub, Alpaca, Polygon |
| Volatility | Twelve Data ATR API |
| Database | Supabase (PostgreSQL) for prod, SQLite for dev |
| Dashboard | Express.js + server-rendered HTML |
| Process Mgmt | PM2 (cluster mode, zero-downtime reload) |
| Tunnel | Cloudflare Tunnel (parallax.report) |
| Notifications | Discord webhooks |
| Social | Twitter/X API v2 (automated posting) |
| Validation | Zod schemas |
| Testing | Jest |

---

## Setup

### Prerequisites

- Node.js ≥ 18
- npm
- A Solana wallet with USDC (for live trading)
- PM2 (`npm install -g pm2`) for production

### Install

```bash
git clone https://github.com/your-repo/parallax.git
cd parallax
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your API keys and settings
```

See the [Environment Variables](#environment-variables) section for all options.

### Build & Run

```bash
# Build TypeScript
npm run build

# Paper trading (safe, no real trades)
npm run paper

# Production with PM2
pm2 start ecosystem.config.js

# Dashboard only
npm run dashboard
```

---

## Trading Modes

| Mode | Description | Trades Real? | Risk |
|------|-------------|:------------:|------|
| **Paper** | Simulated trades against live prices | ❌ | None |
| **Shadow** | Paper trades + real quote validation | ❌ | None |
| **Live** | Real swaps on Solana | ✅ | Real capital at risk |

**Safety gates for live trading:**
1. `TRADING_MODE=live` in .env
2. `LIVE_TRADING=true` (separate flag — belt and suspenders)
3. `SOLANA_PRIVATE_KEY` must be set
4. Wallet must have USDC balance

Paper mode is the default. You cannot accidentally go live.

---

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|:--------:|---------|
| **Core** | | | |
| `TRADING_MODE` | `paper` / `shadow` / `live` | No | `paper` |
| `LIVE_TRADING` | Must be `true` for live trades | For live | `false` |
| `SOLANA_PRIVATE_KEY` | Base58 wallet private key | For live | — |
| **Solana RPC** | | | |
| `RPC_ENDPOINT` | Primary Solana RPC URL | Yes | `mainnet-beta` |
| `RPC_ENDPOINT_2` | Fallback RPC URL | No | — |
| **Stock Price APIs** | | | |
| `ALPACA_KEY_ID` | Alpaca API key | Recommended | — |
| `ALPACA_SECRET_KEY` | Alpaca secret key | Recommended | — |
| `FINNHUB_API_KEY` | Finnhub API key | Optional | — |
| `FINNHUB_API_KEY_2` | Finnhub backup key (rate limits) | Optional | — |
| `FINNHUB_API_KEY_3` | Finnhub backup key (rate limits) | Optional | — |
| `POLYGON_API_KEY` | Polygon.io API key | Optional | — |
| `TWELVE_DATA_API_KEY` | Twelve Data API (ATR volatility) | Optional | — |
| **Database** | | | |
| `TRADES_DB_URL` | Supabase PostgreSQL connection string | Yes | — |
| `DIRECT_URL` | Direct Supabase connection (no pooler) | Yes | — |
| `DATABASE_URL` | Supabase via PgBouncer | Optional | — |
| **DEX / Jupiter** | | | |
| `JUPITER_API_KEY` | Jupiter API key (higher rate limits) | Optional | — |
| **Flash Trade** | | | |
| `ENABLE_SHORTING` | Enable premium shorting via perps | No | `false` |
| **Dashboard** | | | |
| `DASHBOARD_ENABLED` | Enable web dashboard | No | `true` |
| `WEB_PORT` | Dashboard port | No | `3001` |
| `ADMIN_TOKEN` | Dashboard admin password | For admin | — |
| **Notifications** | | | |
| `DISCORD_WEBHOOK_URL` | Discord webhook for trade alerts | Optional | — |
| **Twitter/X** | | | |
| `TWITTER_API_KEY` | Twitter API key | Optional | — |
| `TWITTER_API_SECRET` | Twitter API secret | Optional | — |
| `TWITTER_BEARER_TOKEN` | Twitter bearer token | Optional | — |
| `TWITTER_ACCESS_TOKEN` | Twitter access token | Optional | — |
| `TWITTER_ACCESS_TOKEN_SECRET` | Twitter access token secret | Optional | — |
| `TWITTER_CLIENT_ID` | Twitter OAuth2 client ID | Optional | — |
| `TWITTER_CLIENT_SECRET` | Twitter OAuth2 client secret | Optional | — |
| **Logging** | | | |
| `LOG_LEVEL` | General log level | No | `info` |
| `LOG_LEVEL_CONSOLE` | Console log level | No | `warn` |
| `LOG_LEVEL_FILE` | File log level | No | `debug` |
| **Other** | | | |
| `GITHUB_TOKEN` | GitHub API token (changelog) | Optional | — |
| `HELIUS_API_KEY` | Helius RPC API key | Optional | — |

---

## Project Structure

```
src/
├── index.ts                 # Entry point
├── orchestrator.ts          # Main trading loop & position management
├── config.ts                # Configuration loading & validation
├── constants.ts             # Trading parameters & formulas
├── types.ts                 # TypeScript type definitions
├── logger.ts                # Pino structured logging
│
├── feeds/                   # Price data ingestion
│   ├── stockFeed.ts         #   Stock prices (Alpaca, Finnhub, Polygon)
│   ├── onchainFeed.ts       #   On-chain token prices
│   ├── dexScreenerFeed.ts   #   DexScreener price feed
│   ├── geckoTerminalFeed.ts #   GeckoTerminal price feed
│   ├── volatilityFeed.ts    #   ATR-based volatility (Twelve Data)
│   ├── swissquoteFeed.ts    #   Forex/commodity prices
│   └── endpointTracker.ts   #   API health monitoring
│
├── signals/                 # Entry/exit signal generation
│   ├── meanReversionSignal.ts  # Long: buy discount, sell reversion
│   └── premiumShortSignal.ts   # Short: sell premium via perps
│
├── execution/               # Trade execution
│   ├── executor.ts          #   Execution coordinator
│   ├── jupiterClient.ts     #   Jupiter swap integration
│   ├── jupiterUltraClient.ts#   Jupiter Ultra (optimized)
│   ├── raydiumClient.ts     #   Raydium CLMM direct swaps
│   ├── flashTradeClient.ts  #   Flash Trade perps
│   └── connectionManager.ts #   RPC connection pooling
│
├── liquidity/               # Liquidity analysis
│   └── liquidityChecker.ts  #   TVL monitoring & threshold scaling
│
├── risk/                    # Risk management
│   └── riskManager.ts       #   Kill switches, limits, circuit breaker
│
├── db/                      # Data persistence
│   ├── database.ts          #   SQLite (local dev)
│   ├── supabaseClient.ts    #   Supabase (production)
│   ├── queryCache.ts        #   Query result caching
│   └── writeQueue.ts        #   Batched write operations
│
├── web/                     # Dashboard
│   ├── server.ts            #   Express HTTP server
│   └── templates/           #   Server-rendered HTML
│
├── notifications/           # Alerts
│   └── discord.ts           #   Discord webhook notifications
│
├── backtest/                # Strategy backtesting
│   └── backtester.ts        #   Historical strategy simulation
│
└── standalone-dashboard.ts  # Dashboard-only mode
```

---

## Safety & Risk Features

Parallax is built with the assumption that **something will go wrong**. Every component has fallbacks:

- **Default paper mode** — impossible to accidentally trade real money
- **Dual safety gate** — both `TRADING_MODE=live` AND `LIVE_TRADING=true` required
- **Kill switch** — activated on uncaught exceptions, manual trigger, or daily loss limit
- **Circuit breaker** — auto-stops after 3 consecutive failures
- **Price staleness** — refuses to trade if price data is older than 30 seconds
- **Max deviation guard** — blocks trades if spread exceeds 50% (likely data error)
- **TVL minimum** — won't trade tokens with pool TVL below $50K
- **Slippage caps** — hard limit of 2% on any single trade
- **Position limits** — per-trade and daily USD caps
- **Graceful shutdown** — SIGINT/SIGTERM handling with position state preservation
- **Priority fee escalation** — auto-adjusts for network congestion
- **Orphan cleanup** — recovers tokens from failed partial trades

---

## Built With AI

Parallax was built through collaboration between a human (609) and an AI agent. The AI wrote the majority of the code, tuned the trading parameters through backtesting, and manages the live deployment. See [CLAUDE.md](CLAUDE.md) for the AI's working notes and architecture understanding.

This isn't a toy demo — it's a production system managing real positions on Solana mainnet, with thousands of lines of battle-tested TypeScript handling edge cases from months of live operation.

---

## License

[MIT](LICENSE) © 609NFT
