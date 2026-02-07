# Code Improvements Log

## 2026-02-07 — Discord Notification Error Handling (commit ae8a26f)

**Fixed:** Added error logging to critical Discord notifications that were using fire-and-forget pattern:
- Circuit breaker notification: `notifyCircuitBreaker().catch(() => {})` → proper error logging
- Startup notification: `notifyStartup().catch(() => {})` → proper error logging

**Impact:** Visibility into Discord notification failures for critical bot events

**Files Changed:** `src/orchestrator.ts`

**Build:** ✅ Clean compile, successful PM2 reload

## 2026-02-06 — Type Safety Improvement (commit e4a66af)

**Fixed:** Replaced `any` types in `performanceTracker.ts` with specific types:
- `(t: any)` → `(t: MeanReversionPositionRow)` for trade filtering
- `(r: any)` → `(r: { buy_symbol: string })` for query result mapping

**Impact:** Better type safety and IDE support, prevents potential runtime errors

**Files Changed:** `src/signals/performanceTracker.ts`

**Build:** ✅ Clean compile, no errors