# Code Improvements Log

## 2026-02-06 — Type Safety Improvement (commit e4a66af)

**Fixed:** Replaced `any` types in `performanceTracker.ts` with specific types:
- `(t: any)` → `(t: MeanReversionPositionRow)` for trade filtering
- `(r: any)` → `(r: { buy_symbol: string })` for query result mapping

**Impact:** Better type safety and IDE support, prevents potential runtime errors

**Files Changed:** `src/signals/performanceTracker.ts`

**Build:** ✅ Clean compile, no errors