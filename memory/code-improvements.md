# Code Improvements Log

## 2026-02-06 08:36 - CSS Color Token Cleanup

**Fixed**: Added `--color-yellow-green` CSS variable and replaced 3 hardcoded `#a3e635` color values

**Details**:
- Added `--color-yellow-green: #a3e635;` to CSS variables section in `src/web/templates/dashboard.ts`
- Replaced 3 TODO comments with proper CSS variable references: `var(--color-yellow-green)`
- Locations: Lines ~2309, ~2424, ~2554 in dashboard progress bar color logic

**Impact**: 
- Cleaner, more maintainable CSS
- Consistent design system usage
- Removed 3 TODO items from codebase

**Commit**: `3ce779a` - "chore: add yellow-green CSS color token, fix TODOs"

**Verification**: Bot reloaded successfully, no runtime errors