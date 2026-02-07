# Code Improvements Log

## 2026-02-08 - Add explicit return type annotations to singleton getters

**What was fixed:**
- Added explicit return type annotations to `getQueryCache()` and `getWriteQueue()` functions
- Changed `getQueryCache = () => cacheInstance` to `getQueryCache = (): QueryCache => cacheInstance`
- Changed `getWriteQueue = () => queueInstance` to `getWriteQueue = (): WriteQueue => queueInstance`

**Technical details:**
- Located in `src/db/queryCache.ts` and `src/db/writeQueue.ts`
- Improves TypeScript type safety and IDE intellisense
- Follows best practice of explicit return type annotations for public API functions

**Verification:**
- TypeScript build successful (`npm run build`)
- PM2 reload completed without errors
- Change committed to git: `073288a`

**Impact:** Small improvement to type safety - helps catch type mismatches at compile time.

## 2026-02-07 - Extract hardcoded TTL constant for price data cache

**What was fixed:**
- Replaced hardcoded `10000` with named constant `CACHE_TTL_PRICE` in `src/db/database.ts`
- Added proper documentation: "10 seconds for price data that needs to be fresh"
- Improves code maintainability and clarity

**Technical details:**
- Located at line 269 in the `getLatestDiscount` method
- Part of cache TTL management for frequently changing price data
- Follows existing pattern of named constants for cache timeouts

**Verification:**
- TypeScript build successful (`npm run build`)
- No runtime errors in PM2 logs
- Change committed to git: `a8d956f`

**Impact:** Small but positive - makes cache TTL configuration more consistent and self-documenting.