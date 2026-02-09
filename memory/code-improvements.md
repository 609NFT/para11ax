# Code Improvements Log

## 2026-02-09 — Cache TTL Constants (commit 6a8779e)

**Fixed**: Replaced magic number 600000 (10min in ms) with named constant CACHE_TTL_LONG

**Files changed**: `src/db/database.ts`
- Added `CACHE_TTL_LONG = 600000` constant
- Replaced two hardcoded `600000` values in cache.set() calls
- Improves code maintainability and readability

**Impact**: No runtime changes, constants-only improvement. No restart needed.

**Type**: Code cleanup - replaced magic numbers with named constants

---

*Track incremental code quality improvements here. Focus on small, safe changes.*