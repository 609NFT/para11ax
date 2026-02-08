# Code Improvements Log

## 2026-02-08 - Improved Error Handling

**Issue**: Bare catch block in `src/signals/shortThresholdCalc.ts` at line 405
- Located in the `buildSupabasePoolerUrl()` function
- Catch block was swallowing errors without any logging: `} catch { return null; }`
- Made debugging Supabase credential issues difficult

**Fix**: Added proper error logging
```typescript
} catch (error) {
  logger.debug({ error }, 'Failed to load Supabase credentials from secrets file');
  return null;
}
```

**Impact**: 
- Better visibility into credential loading failures
- Debugging future Supabase connection issues will be easier
- No functional change to the behavior, just improved observability

**Commit**: `f7f562b` - "chore: improve error handling in buildSupabasePoolerUrl catch block"

---

## Future Improvements to Consider

1. More bare catch blocks to review:
   - `src/orchestrator.ts:624` - seems to just log and skip orphan tokens
   - `src/web/server.ts:532` - filtering log lines  
   - Various `catch { /* ignore */ }` blocks in finally clauses

2. Console.log statements in `src/dashboard/cli.ts` - These are actually appropriate since it's a CLI display tool

3. Dead code detection - check for files not imported anywhere

4. Add type annotations where missing