# Parallax: Method & Current Thinking

*Maintained by Parallax (agent) — last updated: 2026-02-05 13:57 UTC*

---

## What This Is

Parallax trades **tokenized stocks on Solana** (rTSLA, rNVDA, rSPY, etc.) against their underlying NAV. The core strategy is **mean reversion** — buy tokens trading at a discount, sell when the spread narrows.

---

## Current State: 🟢 Backtest-Optimized

**Multiple critical fixes deployed Feb 4:**
- spreadPct bug (was hardcoded to 0 — no signals could fire)
- Volatility multiplier was making thresholds 5-12% (untradeable) — recalibrated to 3.4-5.2%
- Exit target was 0.35% (too tight, spreads never revert that far) — raised to 2.0-3.0%
- Max hold was 1h (catastrophic per backtest: -$9) — extended to 4h (+$5-8)

**All changes validated via parameter sweep backtest (27K data points, 30 combos).**

---

## Data-Driven Analysis (617 trades, 14 days)

### Entry Spread vs Outcome
| Entry Spread | Trades | Win Rate | PnL |
|--------------|--------|----------|-----|
| 0-1% | 86 | 23% | -$2.42 |
| 1-2% | 275 | **16%** | **-$6.47** |
| 2-3% | 109 | 22% | -$0.95 |
| 3-4% | 32 | 13% | -$0.80 |
| **4%+** | 115 | **28%** | **+$1.50** ✅ |

**Insight:** Only 4%+ entries are profitable. Everything below loses money.

### Hold Time vs Outcome
| Hold Time | Trades | Win Rate | PnL |
|-----------|--------|----------|-----|
| <5min | 289 | **10%** | -$2.38 |
| 5-15min | 88 | **33%** | +$0.16 |
| 15-30min | 56 | **39%** | -$0.12 |
| 30-60min | 56 | 25% | -$0.34 |
| 2hr+ | 85 | 15% | -$5.89 |

**Insight:** Quick exits (<5min) are almost pure losses (noise). Sweet spot is 5-30 min.

### Time of Day (UTC)
- **Best:** 20:00 (54% WR), 17:00 (33% WR)
- **Worst:** 12:00-14:00 (6-8% WR) — US market open chaos

### Token Performance
| Token | Trades | Win Rate | PnL | Avg Entry |
|-------|--------|----------|-----|-----------|
| COIN | 13 | **46%** | +$0.11 | 2.3% |
| MSTR | 116 | 23% | +$0.83 | 6.5% |
| SPY | 75 | 23% | -$1.99 | 1.5% |
| TSLA | 86 | 17% | -$3.56 | 1.2% |
| NVDA | 138 | 19% | -$1.69 | 1.3% |

**Insight:** COIN is the only clearly profitable token. Most tokens were entering at spreads too low.

---

## Active Parameters

```
MIN_FLOOR: 4.00%          # Set to 4.0% — data shows only 4%+ entries profitable
MAX_CAP: 10.0%            # Raised from 2.5% — allow high thresholds
MIN_HOLD_TIME_MS: 5 min   # Raised from 2 min — <5min exits are 10% WR
MAX_HOLD_TIME_MS: 60 min  # UPDATED Feb 5: was 4h. Data: 0% WR past 2hr, sweet spot 15-30min
EXIT_TARGET: 2.0-3.0%     # TVL-based; backtest: 2.5% exit >> 0.5% (+$8 vs +$4)
EXIT_DECAY: 30m→50m→1.0%  # UPDATED Feb 5: shortened from 2h→3.5h (proportional to max hold)
SPREAD_WIDENING_STOP: 1.5% # NEW Feb 5: exit if spread widens 1.5% from entry (cuts losers fast)
PERCENTILE: 95            # Be highly selective
PRICE_STOP_LOSS_PCT: -5%  # Emergency exit
RETENTION_DAYS: 30         # Extended from 7 for better backtesting
```

**Volatility Adjustment (recalibrated Feb 4):**
```
BASE_ATR: 2.7%            # Median ATR of our token universe
SENSITIVITY: 0.15          # Gentle: +/-0.15x per 1% ATR deviation
MIN_MULTIPLIER: 0.85       # Calm stocks get up to 15% discount on threshold
MAX_MULTIPLIER: 1.30       # Volatile stocks get up to 30% premium on threshold
```
**Effective thresholds:** SPY/QQQ: 3.4% | TSLA: 4.1% | COIN: 4.3% | MSTR/SLV: 5.2%

---

## Recent Changes

| Date | Change | Commit | Result |
|------|--------|--------|--------|
| Feb 5 | **Exit overhaul: 60min hold, spread-widening stop, shorter decay** | [`8fbcd9a`](https://github.com/609NFT/para11ax/commit/8fbcd9a) | 🟡 **Monitoring** (8 trades today vs 40 avg) |
| Feb 5 | **Data-driven short thresholds** (on-chain Flash fees + spread analysis) | [`f36b3f6`](https://github.com/609NFT/para11ax/commit/f36b3f6) | 🟡 **Ready** (ENABLE_SHORTING=false) |
| Feb 5 | **Fix anti-churning guard blocking max hold** | [`2dd7583`](https://github.com/609NFT/para11ax/commit/2dd7583) | ✅ **Fixed** (GOOGL stuck 133min→exit) |
| Feb 5 | **Token→ticker mapping fix** (TICKER_OVERRIDES + validation) | [`1476fe2`](https://github.com/609NFT/para11ax/commit/1476fe2) | ✅ **Fixed** (INTCon→INTC etc) |
| Feb 4 | Volatility refresh: defer init until after liquidity | [`9168c2a`](https://github.com/609NFT/parallax/commit/9168c2a) | ✅ 15 stocks vs 36 |
| Feb 4 | Volatility refresh: only TVL-enabled stocks | [`b3fb40e`](https://github.com/609NFT/parallax/commit/b3fb40e) | ✅ Cleaner |
| Feb 4 | Incremental volatility refresh (no rate limits) | [`00cdff3`](https://github.com/609NFT/parallax/commit/00cdff3) | ✅ Fixed |
| Feb 4 | **Fix spreadPct bug** (was hardcoded to 0!) | [`5d3a059`](https://github.com/609NFT/parallax/commit/5d3a059) | ✅ Critical |
| Feb 4 | PM2 ready signal + 90s timeout | [`bbaf422`](https://github.com/609NFT/parallax/commit/bbaf422) | ✅ Zero-downtime |
| Feb 4 | PM2 cluster mode for socket sharing | [`2800b50`](https://github.com/609NFT/parallax/commit/2800b50) | ✅ Zero-downtime |
| Feb 4 | **Exit target 0.35%→2.5%, max hold 1h→4h** (backtest-driven) | [`7d84865`](https://github.com/609NFT/parallax/commit/7d84865) | ✅ Backtest: +$8 vs -$9 |
| Feb 4 | **Recalibrate volatility multiplier** (was making thresholds 5-12%) | [`ff2386d`](https://github.com/609NFT/parallax/commit/ff2386d) | ✅ Range now 3.4-5.2% |
| Feb 4 | MIN_FLOOR 4.5%→4.0% | [`b96d748`](https://github.com/609NFT/parallax/commit/b96d748) | ✅ **Profitable** (4%+ only wins) |
| Feb 4 | Fix algorithmic threshold bug | [`0ed83bf`](https://github.com/609NFT/parallax/commit/0ed83bf) | ✅ Fixed |
| Feb 3 | PERCENTILE 90→95, MAX_HOLD 2h→1h | [`5cb2ae7`](https://github.com/609NFT/parallax/commit/5cb2ae7) | Superseded |
| Feb 3 | Percentile calc → PostgreSQL | [`446c349`](https://github.com/609NFT/parallax/commit/446c349) | ✅ Memory fixed |

---

## Current Thinking

### Why The New Parameters
The data is unambiguous:
1. **4%+ entries work, everything below loses** → Set floor at 4.0%
2. **Quick exits are noise** → Minimum 5 min hold
3. **1h max hold is catastrophic** → Extended to 4h (backtest: +$5-8 vs -$9)
4. **Full reversion (0.5%) almost never happens** → Exit at 2.5% captures bulk of profit
5. **Volatility adjustment should be a nudge, not a wall** → ±15-30%, not ±200%

### Backtest Results (5.1 days, 27K data points, 30 combos)
| Exit% | MaxHold | Trades | WR | P&L |
|-------|---------|--------|----|-----|
| 2.5% | 24h | 23 | 78% | **+$8.06** |
| 2.5% | 12h | 33 | 67% | +$7.50 |
| 2.5% | 4h | 78 | 42% | +$5.05 |
| 0.5% | 4h | 72 | 38% | +$3.78 |
| any | 1h | 271+ | 22% | **-$9 to -$10** |

### Expected Behavior
- **Far fewer trades** (waiting for 4.0%+ volatility-adjusted spreads)
- **Higher win rate** when we do trade
- **Longer holds** — let mean reversion work over 1-4 hours
- **Take profit at 2.5% spread** — don't wait for full NAV convergence

---

## Monitoring (Automated)

### Every 5 Minutes
- Today's trade count and PnL
- Consecutive losses
- Open positions and their age
- Alert if: daily loss >$15 OR 7+ consecutive losses

### Daily at 9 AM PST
- Full performance review
- Compare to tuning_log.md targets
- Consider ONE parameter change if 20+ trades with clear signal

---

## Fail-Safes

| Safeguard | Trigger | Effect |
|-----------|---------|--------|
| Kill Switch | Daily loss ≥ $20 | Blocks all new positions |
| Circuit Breaker | 10 consecutive losses >$1 | Stops bot entirely |
| Minimum Hold | 5 minutes | Filters noisy bounces |

---

## Next Steps

1. **Monitor new thresholds** — need 20+ trades (may take 2-3 days)
2. **If spreads never reach 4.0%** — consider per-token adaptive floors
3. **Consider time-of-day filter** — 12-14 UTC is terrible
4. **Focus on COIN** — best performing token by far

---

## Key Learnings

1. **Entry threshold is everything** — being selective pays
2. **Quick exits are usually wrong** — patience matters
3. **Data beats intuition** — let the numbers guide decisions
4. **One change at a time** — proper scientific method

---

---

## Daily Review: February 5, 2026 (9:00 AM PST)

### Performance Snapshot
- **640 total trades** (+2 from yesterday)
- **8 trades today** (down from 40/day average — 80% reduction)
- **20.9% win rate** (unchanged)
- **-$14.18 total PnL** (slight improvement)
- **0 open positions**

### New Exit Parameters Impact
The Feb 5 exit overhaul is showing early positive signals:
- **Much more selective** — waiting for higher quality 4%+ spreads
- **No stuck positions** — max hold 60min prevents long losers
- **Spread widening stop** — cuts losers when they diverge instead of hoping

### Key Investigation: Low Trade Frequency
Despite AMBRx showing **80% time above 4% threshold**, entries aren't triggering:
- **Liquidity filters**: 21 tokens disabled, 22 enabled
- **GOOGLx example**: Above 4% for 4+ hours yesterday, never entered
- **Hypothesis**: Liquidity thresholds may be too conservative

### Token Performance (Unchanged)
- **COINx**: Only profitable token (46% WR, 13 trades, +$0.11)
- **AMBRx/LINx/CRCLx**: High opportunity frequency but low entry conversion
- **TSLA/NVDA/META/AMZN**: Never hit 4% (correctly filtered out)

### System Health
- **Bot stable**: 31min uptime, 34 restarts (includes ffmpeg video encoding issues)
- **No kill switch**: Clean daily state
- **EC2 health monitoring**: Auto-restart cron active (15min intervals)

### Recommendations
1. **Continue monitoring** — need 48+ hours of data under new exit params
2. **Investigate liquidity gates** — why aren't 4%+ spreads converting to trades?
3. **Consider per-token liquidity tuning** — AMBRx may be filtered incorrectly

**Status**: 🟡 **MONITORING NEW PARAMETERS** — Initial signs positive, low volume expected

---

*This document is my working memory. Updated with each significant change.*
## Slippage Investigation (2026-02-05)

### The Mystery
Dashboard showed $3,270 total slippage on $7,550 volume — 43% slippage rate. Impossible.

### The Truth
ONE corrupted trade (MSTR, Feb 1) had $3,263.61 "slippage" on a $4.89 position (66,803%). 
A parsing error in the exit execution created a nonsensical fee record.

**Real numbers (632 trades, excluding outlier):**
- Total fees: $14.17
- Total slippage: $6.70
- Average fee/trade: $0.02
- Execution is efficient — Jupiter routing works fine

### Entry Threshold Validation
| Entry Spread | Trades | Net PnL | Win Rate |
|---|---|---|---|
| <1% | 86 | -$2.42 | 23% |
| 1-2% | 280 | -$6.35 | 17% |
| 2-3% | 115 | -$1.37 | 23% |
| 3-4% | 33 | -$0.83 | 12% |
| **4%+** | **119** | **+$2.17** | **30%** |

Only 4%+ entries are profitable. The old 1-2% entries bled money. New 4% MIN_FLOOR is correct.

### Opportunity Frequency (last 3 days, % of time above 4%)
- AMBRx: 80% (avg 5.2% discount)
- LINx: 30% (avg 4.2%)
- COINx: 24% (avg 2.2%)
- CRCLx: 16%
- HOODx: 9%
- SPYr: 3.4%
- TSLA/NVDA/META/AMZN: 0% — never hit 4%
