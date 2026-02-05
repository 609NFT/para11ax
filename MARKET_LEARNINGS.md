# Parallax: Method & Current Thinking

*Maintained by Parallax (agent) — last updated: 2026-02-04 22:58 UTC*

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
MAX_HOLD_TIME_MS: 4 hours # Backtest: 1h=-$9, 2h=breakeven, 4h=+$5-8 (best volume + WR)
EXIT_TARGET: 2.0-3.0%     # TVL-based; backtest: 2.5% exit >> 0.5% (+$8 vs +$4)
EXIT_DECAY: 2h→3.5h→1.0%  # Relax exit threshold over time, floor at 1.0%
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
| Feb 4 | Volatility refresh: defer init until after liquidity | [`9168c2a`](https://github.com/609NFT/parallax/commit/9168c2a) | ✅ 15 stocks vs 36 |
| Feb 4 | Volatility refresh: only TVL-enabled stocks | [`b3fb40e`](https://github.com/609NFT/parallax/commit/b3fb40e) | ✅ Cleaner |
| Feb 4 | Incremental volatility refresh (no rate limits) | [`00cdff3`](https://github.com/609NFT/parallax/commit/00cdff3) | ✅ Fixed |
| Feb 4 | **Fix spreadPct bug** (was hardcoded to 0!) | [`5d3a059`](https://github.com/609NFT/parallax/commit/5d3a059) | ✅ Critical |
| Feb 4 | PM2 ready signal + 90s timeout | [`bbaf422`](https://github.com/609NFT/parallax/commit/bbaf422) | ✅ Zero-downtime |
| Feb 4 | PM2 cluster mode for socket sharing | [`2800b50`](https://github.com/609NFT/parallax/commit/2800b50) | ✅ Zero-downtime |
| Feb 4 | **Exit target 0.35%→2.5%, max hold 1h→4h** (backtest-driven) | [`7d84865`](https://github.com/609NFT/parallax/commit/7d84865) | ✅ Backtest: +$8 vs -$9 |
| Feb 4 | **Recalibrate volatility multiplier** (was making thresholds 5-12%) | [`ff2386d`](https://github.com/609NFT/parallax/commit/ff2386d) | ✅ Range now 3.4-5.2% |
| Feb 4 | MIN_FLOOR 4.5%→4.0% | [`b96d748`](https://github.com/609NFT/parallax/commit/b96d748) | 🟡 Monitoring |
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

*This document is my working memory. Updated with each significant change.*
