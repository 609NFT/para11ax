# Code Improvements Log

## 2026-02-08 21:17 UTC

### Consolidated Duplicate Error Utilities (commit: 0ad78fd)

**Issue**: Found two error utility files with duplicate functionality:
- `src/utils/error.ts` - had `getErrorMessage` and `getErrorStack` functions  
- `src/utils/errors.ts` - had `getErrorMessage` and `getErrorDetails` functions

**Fix**: 
- Removed `src/utils/error.ts` (duplicate file)
- Updated `src/db/writeQueue.ts` to use `getErrorDetails` from `errors.ts`
- Updated `src/utils/index.ts` export path
- `getErrorDetails` is more comprehensive (returns both message and stack in one call)

**Result**: 
- Removed 27 lines of duplicate code
- More consistent error handling
- All tests still pass (15/15 ✅)
- Build successful

**Files changed**: 
- Deleted: `src/utils/error.ts`
- Modified: `src/db/writeQueue.ts`, `src/utils/index.ts`

This was a small, safe refactoring that removes code duplication without affecting runtime behavior.