# Parameter Change Policy

**ALL threshold/parameter changes require approval from 609 before deployment.**

## Protected Parameters (DO NOT CHANGE WITHOUT APPROVAL)
- `ENTRY_THRESHOLD_FORMULA.MIN_FLOOR`
- `ENTRY_THRESHOLD_FORMULA.COEFFICIENT`
- `PERCENTILE_THRESHOLD_FORMULA.PERCENTILE`
- `EXIT_THRESHOLD_FORMULA.*`
- `ENABLE_SHORTING`
- Any trading mode flags

## Sub-Agent Rules
1. Sub-agents MAY analyze and RECOMMEND changes
2. Sub-agents MUST NOT deploy parameter changes directly
3. Sub-agents MUST report findings to main session and wait for review
4. Only main session (with 609's approval) can modify protected parameters

## Current Values (2026-02-06)
- MIN_FLOOR: 4.0% (changed from 4.3% by deep-analysis, approved by 609)
- PERCENTILE: 80 (changed from 95 by deep-analysis, approved by 609)

## Change Log
| Date | Parameter | Old | New | Approved By | Reason |
|------|-----------|-----|-----|-------------|--------|
| 2026-02-06 | MIN_FLOOR | 4.3% | 4.0% | 609 (post-hoc) | Bot not trading, captures more opportunities |
| 2026-02-06 | PERCENTILE | 95 | 80 | 609 (post-hoc) | 95th too restrictive |
