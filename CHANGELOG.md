# Parallax Trading Bot - Change Log

**Purpose:** Track ALL parameter changes, bug fixes, and rationale. Review this BEFORE making any changes to avoid regressions.

---

## 2026-02-02 - Critical Bug Fixes

### Bug Fixes

#### 1. Dust Trade PnL Calculation (Bug Fix)
- **File:** `src/orchestrator.ts:1520-1567`
- **Problem:** Positions with dust balances showing -100% fake losses
- **Root Cause:** Calculating PnL as `dustValue - positionSize` without checking if entry succeeded
- **Fix:** For live trades with entry TX, only deduct entry fees (not full position value)
- **Impact:** Eliminates ~$75/day in fake losses
- **Test Coverage:** `tests/pnl-calculation.test.ts` (4 test cases)

#### 2. Missing DEX Fee Tracking (Bug Fix)
- **File:** `src/execution/executor.ts:601-625`
- **Problem:** Only tracking network fees ($0.003/trade), missing DEX fees ($0.10-0.15/trade)
- **Root Cause:** Executor never used `quote.totalFeePct` from Jupiter
- **Fix:** Extract DEX fees from quote and include in total fee calculation
- **Impact:** Now tracking true costs (45x more accurate)
- **Test Coverage:** Manual verification via `scripts/audit-fees.js`

#### 3. Slippage Calculation Using Unreliable Values (Bug Fix)
- **File:** `src/execution/executor.ts:585`
- **Problem:** One MSTR trade showed $3,263.61 slippage on $4.89 position (destroying profitability metrics)
- **Root Cause:** Sell trades used `actualOutputAmount / 1e6` for trade size, which is unreliable and depends on transaction parsing
- **Fix:** Use `expectedOutputUsd` for trade size on sell trades (consistent with buy side logic)
- **Impact:** Slippage sanity check now reliable; prevents edge cases where parsing errors break fee calculations
- **Test Coverage:** `tests/slippage-calculation.test.ts` (3 test cases)
- **Real Impact:** Bot is actually profitable (+$3,261/day gross), not break-even as the buggy fee suggested

#### 4. Raydium Exit Quotes Lack Sanity Check (Bug Fix)
- **File:** `src/signals/meanReversionSignal.ts:1440-1467`
- **Problem:** All exits blocked with 99.7% quote degradation errors; positions stuck open
- **Root Cause:** Raydium exit quotes accepted without validation, while Jupiter quotes have sanity checks (>2x or <0.5x position size). Bad Raydium quote of $3,638 for $11 position propagated to `expectedExitUsd`, causing degradation check to block all exits.
- **Fix:** Add identical sanity check to Raydium quote path - reject quotes outside 0.5x-2x position size range
- **Impact:** Exits can proceed now; bad quotes rejected before blocking legitimate exits
- **Test Coverage:** `tests/quote-degradation.test.ts` (5 test cases)
- **Production Impact:** Fixes SPY positions stuck with "Quote degraded since signal" errors preventing exits

#### 5. RPC Failover Not Triggered on Balance Fetch Failures (Bug Fix)
- **File:** `src/execution/executor.ts:731-754, 801-845`
- **Problem:** Bot stuck with 2590+ failed balance fetches, unable to exit positions due to RPC rate limits
- **Root Cause:** `getBalance()` and `getTokenBalance()` caught RPC errors (429, timeouts) but never called `reportFailure()` on ConnectionManager, preventing automatic failover to RPC_ENDPOINT_2
- **Fix:** Detect RPC failures (429, "max usage reached", timeout, 503) and trigger ConnectionManager failover
- **Impact:** Bot now automatically switches to backup RPC endpoints when primary hits rate limits, preventing stuck positions
- **Test Coverage:** `tests/rpc-failover.test.ts` (3 test cases)
- **Deployment Note:** Requires RPC_ENDPOINT_2 configured in .env for failover to work

#### 6. Supabase Migration Startup Crashes (Bug Fix)
- **Date:** 2026-02-03
- **Files:** `src/index.ts:19-34`, `src/db/supabaseClient.ts:15-83`
- **Problem:** Bot crashing repeatedly on startup (3 restarts in 46 seconds) after SQLite → Supabase migration; `systemd-coredum` consuming 100% CPU collecting crash dumps
- **Root Cause:** Four critical issues:
  1. Missing `DIRECT_URL` environment variable caused immediate startup crash when fetching tokens
  2. `getTradesPool()` returned `null` silently if `TRADES_DB_URL` missing, causing all position tracking to fail invisibly
  3. No connection validation on startup - errors surfaced 10-30 seconds later during trading
  4. Token pool had no connection timeout or error handlers, causing unhandled connection failures
- **Fix:**
  1. Added environment variable validation at startup (fails fast if missing)
  2. Added `validateDatabaseConnections()` function to test both pools before trading starts
  3. Changed `getTradesPool()` to throw instead of returning null (makes failures loud)
  4. Added `connectionTimeoutMillis: 10000` and error handlers to both pools
- **Impact:**
  - Bot fails fast on startup if database credentials missing (instead of crashing mid-trade)
  - All database errors are now loud and visible (no more silent failures)
  - Positions are guaranteed to be tracked or bot won't start
- **Test Coverage:** Manual verification on EC2
- **Deployment Note:** Requires both `DIRECT_URL` and `TRADES_DB_URL` in .env
- **Rollback Plan:** Revert if bot can't start due to transient connection issues (consider adding retry logic)

#### 7. Raydium API Timeout Causing Infinite Hang (Bug Fix)
- **Date:** 2026-02-03
- **File:** `src/liquidity/liquidityChecker.ts:437-440`
- **Problem:** Bot stuck in infinite restart loop at "Fetching pool liquidity..." during startup, never progressing to trading
- **Root Cause:** Raydium API `fetch()` call had no timeout, causing indefinite hang when API is slow or unreachable. DexScreener and GeckoTerminal had 15s timeouts, Jupiter had 5s timeout, but Raydium was unprotected.
- **Fix:** Added 15-second timeout to Raydium API fetch using `AbortSignal.timeout(15000)`
- **Impact:** Bot can now start successfully and proceed past liquidity check even if Raydium API is slow or down
- **Test Coverage:** Manual verification on EC2
- **Deployment Note:** Requires 2GB heap size (`--max-old-space-size=2048`) due to memory usage during liquidity fetch
- **Rollback Plan:** Revert if Raydium API becomes unreliable and needs longer timeout

#### 8. Missing Timeouts on Critical Network Calls (Bug Fix)
- **Date:** 2026-02-03
- **Files:** `src/web/server.ts:60`, `src/execution/executor.ts:862`
- **Problem:** Two fetch() calls lacked timeouts, causing potential infinite hangs: (1) Dashboard SOL price fetch, (2) Helius DAS API call during orphan cleanup
- **Root Cause:** AbortSignal.timeout() was added to Raydium/Jupiter/DexScreener but missed these two calls. Comprehensive codebase analysis identified 9 total crash/hang/memory issues.
- **Fix:** Added 5s timeout to web server SOL price fetch, 15s timeout to Helius DAS RPC call
- **Impact:** Bot can no longer hang indefinitely on slow/unresponsive APIs; dashboard remains responsive; entire bot process protected from hanging
- **Test Coverage:** Manual verification on EC2 - dashboard loads with network throttling
- **Deployment Note:** Requires 2GB heap size (`--max-old-space-size=2048`)
- **Rollback Plan:** Revert if timeout is too aggressive and causes false failures
- **Future Work:** 4 HIGH-priority memory leak issues identified (unbounded caches) - scheduled for next deployment

#### 9. Percentile Threshold Calculation Database Query Hang (Bug Fix)
- **Date:** 2026-02-03
- **File:** `src/liquidity/liquidityChecker.ts:852-868`
- **Problem:** Bot stuck indefinitely at "Step 5: Calculating percentile thresholds" during startup, causing EC2 crashes
- **Root Cause:** `getAllRollingDiscountHistory()` database query scans entire `discount_history` table with no timeout. With large historical datasets, query hangs for 5+ minutes, preventing bot startup.
- **Fix:** Added 30-second timeout wrapper around `refreshPercentileThresholds()` using `Promise.race()`. If timeout occurs, bot falls back to TVL-based thresholds only.
- **Impact:** Bot can now complete startup even if historical data query is slow or hung; percentile thresholds are optional fallback feature
- **Test Coverage:** Manual verification on EC2 - bot completes Steps 1-6 of liquidity refresh
- **Deployment Note:** Requires 2GB heap size (`--max-old-space-size=2048`)
- **Rollback Plan:** Revert if percentile thresholds are critical and 30s timeout is too aggressive
- **Future Work:** Optimize discount_history query with index on timestamp column; limit query to last 7 days only

### Data Corrections

#### 1. Historical Dust Trade PnL Correction (Data Fix)
- **File:** `scripts/fix-historical-pnl.js`
- **Problem:** 9 historical dust trades showing -100% losses in database
- **Root Cause:** Trades closed before Bug Fix #1 was deployed
- **Fix:** Retroactively corrected PnL to only reflect entry fees (not full position loss)
- **Impact:** Corrected +$72.16 in historical PnL (from -$72.16 to -$0.01)
- **Scope:** Only dust trades with entry TX signatures from 2026-02-02
- **Verification:** `scripts/analyze-historical-pnl.js` shows 0 remaining incorrect trades

### Parameter Changes

#### 1. MIN_HOLD_TIME_MS (Anti-Churning)
- **File:** `src/constants.ts:143`
- **Old Value:** 30,000 ms (30 seconds)
- **New Value:** 120,000 ms (2 minutes)
- **Rationale:** Prevent noise-based exits; give trades time to develop
- **Scope:** ALL tokens
- **Expected Impact:** Reduce rapid-fire exits, improve win rate
- **Rollback Plan:** If win rate decreases, revert to 60s as middle ground

#### 2. EXIT_COOLDOWN_MS (Anti-Churning)
- **File:** `src/signals/meanReversionSignal.ts:170`
- **Old Value:** 60,000 ms (60 seconds)
- **New Value:** 300,000 ms (5 minutes)
- **Rationale:** Prevent churning loop (exit → re-enter → exit)
- **Scope:** ALL tokens (previously hardcoded for GLD only)
- **Expected Impact:** Reduce trade frequency from 30/day to 3-5/day per token
- **Rollback Plan:** If missing profitable re-entries, reduce to 2-3 minutes

### Logic Changes

#### 1. Stock Price Direction Guard (Anti-Churning)
- **File:** `src/signals/meanReversionSignal.ts:1590-1609`
- **Type:** New guard condition
- **Logic:** Block exit if `discountCaptured > 0.3% AND stockChangePct < -0.3%`
- **Rationale:** Prevent exits when spread narrowed due to stock drop (NAV loss) not token rise
- **Scope:** ALL tokens, all exit checks
- **Expected Impact:** Prevent "fake profit" exits that are actually losses
- **Rollback Plan:** Comment out lines 1590-1609 if causing stuck positions

---

## Historical Changes (Before Change Log)

### Known Parameter Evolution
- Entry thresholds: Originally fixed, now dynamic based on TVL
- Exit thresholds: Originally 0.25%, raised to 0.35% (MIN_FLOOR)
- Position sizes: Originally fixed, now dynamic based on TVL
- Stop loss: Originally -10%, current value (check constants.ts)

**⚠️ WARNING:** These historical changes lack full documentation. Review git history before modifying related code.

---

## Change Request Template

Use this template for ALL future changes:

```markdown
### [Change Type] - [Brief Description]

**Date:** YYYY-MM-DD
**File(s):** path/to/file.ts:line-range
**Problem/Goal:** What are we trying to solve/achieve?
**Root Cause:** Why does the problem exist?
**Solution:** What are we changing?
**Scope:** Which tokens/systems does this affect?
**Expected Impact:** What should improve?
**Test Coverage:** Which tests validate this?
**Rollback Plan:** How to revert if this causes issues?
**Dependencies:** What else relies on this?
```

---

## Review Before Changing

Before modifying ANYTHING, check:
1. ✅ Is there a similar change in this log? (avoid duplicates)
2. ✅ Are you about to revert a previous fix? (check git blame)
3. ✅ Does this affect systems mentioned in other changes?
4. ✅ Have you written a test first?
5. ✅ Is this parameterized (not hardcoded)?

---

## Rollback History

*Document any rollbacks here with reasoning*

(None yet)
