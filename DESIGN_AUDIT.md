# Dashboard Design Audit

> Audited: 2025-02-05  
> Source: `src/web/templates/dashboard.ts` (3,236 lines)  
> Target: `DESIGN.md` premium design system  
> Auditor: Parallax Design Agent

---

## Executive Summary

The Parallax dashboard is a surprisingly capable single-file application that punches above its weight in data density and real-time functionality. The skeleton loaders are excellent, the PnL chart interaction is polished, and the heatmap visualization is genuinely useful. The overall dark theme feels appropriate for a trading dashboard, and the monospace typography creates a credible "terminal" aesthetic. For something built iteratively, it holds together well.

However, the dashboard has significant structural debt that prevents it from reaching the premium tier described in DESIGN.md. The biggest issue is **inconsistency** — the same conceptual element (a card, a color, a spacing unit) is expressed differently depending on which screen or which developer session produced it. There are **37+ hardcoded color values** bypassing the CSS variable system, **15+ different border-radius values**, and **20+ arbitrary spacing values** with no systematic scale. The entire UI lives in a single 3,236-line file mixing CSS, HTML, and JavaScript in one template string, making maintenance fragile and changes risky.

The gap between current state and DESIGN.md's vision is moderate — not a rewrite, but a disciplined refactoring. The bones are good: the layout logic works, the data flows correctly, the responsive breakpoints exist. What's needed is a systematic pass to replace ad-hoc values with tokens, extract repeated patterns into reusable classes, and bring the visual language into alignment across all six screens. Phase 1 (design tokens) and Phase 2 (Dashboard tab) would deliver 80% of the visual improvement with 30% of the effort.

---

## Score Matrix

| Dimension | Dashboard (/) | Spreads | Trades | Method | Changelog | Admin | Avg |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1. Color System | 5 | 6 | 3 | 6 | 6 | 3 | 4.8 |
| 2. Typography | 5 | 5 | 4 | 7 | 6 | 4 | 5.2 |
| 3. Spacing | 4 | 5 | 4 | 6 | 6 | 3 | 4.7 |
| 4. Card/Container | 6 | 7 | 5 | 7 | 7 | 4 | 6.0 |
| 5. Data Density | 8 | 7 | 6 | 7 | 6 | 5 | 6.5 |
| 6. Interactions | 7 | 7 | 4 | 3 | 3 | 3 | 4.5 |
| 7. Responsiveness | 6 | 5 | 4 | 6 | 5 | 3 | 4.8 |
| 8. Accessibility | 3 | 3 | 2 | 4 | 3 | 2 | 2.8 |
| 9. Loading States | 8 | 8 | 6 | 7 | 7 | 2 | 6.3 |
| 10. Visual Polish | 6 | 7 | 4 | 6 | 7 | 3 | 5.5 |
| 11. Code Quality | 3 | 4 | 2 | 5 | 5 | 2 | 3.5 |
| 12. Navigation | 7 | 7 | 7 | 7 | 7 | 5 | 6.7 |
| 13. Tables | 6 | N/A | 5 | 5 | N/A | 4 | 5.0 |
| 14. Charts/Viz | 7 | 8 | 3 | N/A | N/A | N/A | 6.0 |
| 15. Empty States | 5 | 5 | 4 | 4 | 4 | 3 | 4.2 |
| **Screen Avg** | **5.7** | **6.0** | **4.1** | **5.9** | **5.5** | **3.2** | **5.1** |

---

## Detailed Findings

### Global Issues (affect all screens)

#### 🔴 Critical

1. **`--cyan` variable is actually white (`#ffffff`)** — Line 106: `--cyan: #ffffff;`. This is semantically wrong and confusing. Every place using `var(--cyan)` thinks it's getting cyan but renders white. Blog links (`a { color: var(--cyan); }`), changelog strong text, and admin buttons all reference this. This needs to be either renamed to `--white` or given an actual cyan value.

2. **37+ hardcoded colors bypassing the token system** — The CSS variable system exists but is routinely bypassed:
   - `#4ecb71` and `#ff6b6b` in `makeCard()` (line ~2977) and `renderTokenPerformance()` (line ~2996) — should be `var(--green)` / `var(--red)`
   - `#a3e635` (yellow-green) used in progress bars (lines ~2132, ~2296, ~2374) — no token exists
   - `#6b7280` (gray) used in progress bars (lines ~2138, ~2302, ~2380) — no token exists
   - `#f97316` (orange) for post-market dot (line 401) — no token exists
   - `#1a1a24` used in blog `pre` background (line 803) — close to but not `var(--card-bg)` (#12121a)
   - `#1a1a2e` in heatmap neutral color (line ~203) — yet another dark shade
   - `#3a3a4e` in skeleton shimmer (line ~98) — no token
   - `color: #fff` used directly in 20+ inline styles throughout the HTML
   - `color: #a855f7` hardcoded in section headers (line ~1390) instead of `var(--purple)`

3. **3,236 lines in a single file** — CSS (~1,200 lines), HTML (~400 lines), and JavaScript (~1,600 lines) all live inside one template literal in `dashboard.ts`. This makes:
   - CSS changes risky (no syntax highlighting in template strings)
   - No tree-shaking or code splitting possible
   - Impossible to lint CSS or JS independently
   - Every tab's code loads regardless of which tab is active

4. **Massive inline style usage in JavaScript** — The JS-rendered HTML (watchlists, positions, trades, admin) uses inline `style="..."` attributes extensively instead of CSS classes. Examples:
   - `renderTradesTable()` (line ~3003): Every `<td>` has `style="padding: 8px; text-align: right; color: var(--text);"`
   - `makeCard()` (line ~2977): Entire card structure is inline styles
   - `renderTokenPerformance()` (line ~2996): Grid and card styles all inline
   - Admin panel (lines 1601-1668): Every element uses inline styles
   - This means you can't restyle these components with CSS alone — you must edit JavaScript

5. **No focus states anywhere** — Zero `:focus` or `:focus-visible` CSS rules. Keyboard navigation is effectively invisible. Tab key works but users can't see where they are.

6. **No ARIA attributes** — No `role`, `aria-label`, `aria-live`, or `aria-describedby` attributes. The live-updating data (PnL, positions, logs) should use `aria-live="polite"`. Tables lack `scope` attributes on `<th>` elements.

#### 🟡 Moderate

7. **Inconsistent border-radius values** — At least 7 different values used: `2px` (line ~271), `3px` (lines 269, 657, 908), `4px` (lines 98, 480, 529), `6px` (lines 311, 432, 871), `8px` (lines 469, 521, 734), `10px` (line 295), `50%` (circles). DESIGN.md demands consistent tokens.

8. **No spacing scale** — Padding values found: `2px`, `3px`, `4px`, `5px`, `6px`, `8px`, `10px`, `12px`, `15px`, `16px`, `20px`, `24px`, `25px`, `30px`, `40px`. No 4px or 8px base grid. The `15px` padding (stat cards, table cells) is particularly off-grid.

9. **Font size chaos** — Sizes found: `8px`, `9px`, `10px`, `11px`, `12px`, `13px`, `14px`, `16px`, `18px`, `20px`, `22px`, `24px`, `26px`, `28px`. No type scale ratio. The jump from body text to headings is arbitrary.

10. **Duplicated logic in JS** — Several functions are defined multiple times or have near-identical code:
    - `formatAge()` defined identically at lines ~2263, ~2355, ~2534
    - `getAgeClass()` defined identically at lines ~2268, ~2540
    - Progress bar rendering logic repeated 3 times (watchlist, premium watchlist, open positions)
    - Progress color gradient logic repeated 3 times

11. **Header brand uses system-ui font** — Line 1229: `font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` for the "Parallax" wordmark. Everything else is monospace. This is intentional (brand differentiation) but should be documented as a deliberate exception.

12. **Desktop-only time ranges hidden on mobile** — Line 1285-1290: 6H, W, M, Y buttons have `class="desktop-only"` but there's no mobile alternative. Mobile users only see 12H, D, and All — losing the weekly and monthly views.

13. **`!important` overrides in mobile CSS** — At least 15 `!important` declarations in the 600px breakpoint (lines ~1127-1200). This is a code smell indicating specificity wars and makes future changes harder.

#### 🟢 Minor

14. **Inconsistent color for positive/negative in Trades tab** — Dashboard uses `var(--green)` (#22c55e) and `var(--red)` (#ef4444), but Trades tab `makeCard()` and `renderTokenPerformance()` use `#4ecb71` and `#ff6b6b` — visually different greens and reds on the same site.

15. **Tooltip hiding on mobile is blunt** — Lines 1128-1129: `.tooltip-icon { display: none; } .tooltip-text { display: none; }` removes all tooltips on mobile. Some of this contextual info (like what "Exit Target" means) would benefit from a tap-to-reveal pattern instead.

16. **No print stylesheet** — If someone wants to screenshot or print PnL for tax/reporting purposes, the dark theme on paper would be problematic.

17. **Google Analytics loads synchronously-ish** — Line 72-78: GA tag loads before any content. Consider deferring.

18. **SVG favicon is emoji-based** — Line 88: Uses `⏾` emoji as favicon. Works but renders differently across platforms.

---

### Per-Screen Analysis

#### Dashboard (/) — Score: 5.7/10

**What works:**
- Stats grid with auto-fit columns adapts well (line 469: `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`)
- PnL chart with hover interaction is polished — cardinal spline smoothing, axis labels, crosshair cursor, live pulse dot (lines 1753-1930)
- Skeleton loaders for the PnL chart are best-in-class — they mimic the actual chart shape with SVG curves (lines 1695-1752)
- Progress bars in watchlist/positions communicate state effectively with color gradient system
- Flash animations on price changes (`flashGreen`/`flashRed` keyframes, lines 452-457) add life
- Kill switch warning is prominent and unmissable (line 1303)
- Log search input is practical (line 1413)
- Watchlist timer updates every second for real-time feel (lines 2546-2572)

**What doesn't work:**
- **PnL card is `wide` (span 2) but doesn't feel differentiated enough** — Line 1308: The most important metric (Net PnL) should have stronger visual hierarchy. It uses the same card background as "Daily Trades"
- **Stat card values lack units context** — "0" for trades, "0" for positions — no loading distinction from "actually zero"
- **Table headers have tiny tooltips that compete with each other** — 7 columns with `?` icons in Premium Watchlist (line 1396-1408) creates visual noise
- **"Recent Logs" and "Notable Logs" look identical** — Same component, same visual weight. Notable logs (errors/warnings) should feel more urgent
- **Weekend warning badge uses inline styles** — Line 1404: `style="display: none; background: var(--purple); color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px;"` — should be a CSS class
- **Section header inconsistency** — Some use `color: #a855f7` inline (line 1390), others inherit from `.section-header` which already sets `color: var(--purple)` (line 555). Redundant and fragile.

**Proposed fixes:**
- Elevate PnL card with subtle gradient border or different background shade
- Add "No data yet" vs "0" distinction for stat cards
- Create `.badge` CSS class for inline badges (weekend warning, market closed, etc.)
- Differentiate Notable Logs section with left border accent or background tint
- Replace all inline `color: #a855f7` with the existing `var(--purple)` class

#### Spreads (/heatmap) — Score: 6.0/10

**What works:**
- Heatmap visualization is genuinely excellent — color interpolation (lines 2801-2823), market session dimming (lines 2714-2724), and tooltip with session context
- Range buttons (1H/4H/24H/7D) are clean and functional (lines 871-887)
- Legend is clear and minimal (line 1474-1478)
- Skeleton loader mimics the actual heatmap grid with colored cells (lines 1484-1499) — thoughtful
- Cell hover with `scale(2)` zoom (line 911) is a nice touch for dense data

**What doesn't work:**
- **Heatmap row labels at 10px are too small** — Line 903: `font-size: 10px` for token symbols. On a 4K monitor these are nearly unreadable. Mobile goes to 9px (line 1194) which is worse.
- **Time labels at 8px rotated 45°** — Line 915-916: These are extremely hard to read
- **Legend uses hardcoded colors** — Line 1476-1478: `style="background: #22c55e;"` and `style="background: #ef4444;"` instead of `var(--green)` and `var(--red)`
- **No empty state design** — Line 2629: Just a text message. Should show a placeholder illustration or guide.
- **Mobile heatmap scrolls horizontally** — Functional but not ideal. Consider transposing (tokens as columns, time as rows) on mobile.
- **Cell tooltip lacks contrast info** — For cells near 0% spread, the color is almost invisible against the dark background. Tooltip helps but you can't tell visually which cells to investigate.

**Proposed fixes:**
- Increase row label to 12px minimum, time labels to 10px
- Replace hardcoded legend colors with CSS variables
- Add subtle grid lines or row striping for scanability
- Consider a "focus mode" that highlights one token's row on hover

#### Trades (/trades) — Score: 4.1/10

**What works:**
- Analytics cards give quick summary (line ~2977)
- Per-token performance grid is useful (line ~2996)
- Load more pagination works (line ~3014)
- Table has fixed column widths with `<colgroup>` (line 1559)

**What doesn't work:**
- **Worst code quality of any screen** — Almost entirely inline styles in JS. The analytics cards (`makeCard`), token performance grid, and trade table rows are all built with inline `style="..."` in JavaScript (lines 2977-3010). Zero CSS classes.
- **Different green/red than rest of site** — `#4ecb71` vs `var(--green)` (#22c55e), `#ff6b6b` vs `var(--red)` (#ef4444). Lines 2977, 2996. Visually noticeable difference.
- **Trade table has no hover states** — Unlike Dashboard tables which inherit hover behavior, trades table rows have no visual feedback
- **Analytics cards skeleton is generic** — Line 1547: Just `<div class="skeleton" style="height: 80px;">` — no structure mimicking
- **No sorting capability** — Header columns aren't clickable despite looking like a data table
- **Container has arbitrary max-width** — Line 1537: `max-width: 1200px` with `padding: 20px` — doesn't match any other screen's layout
- **"Trade History" heading uses inline styles** — Line 1539: `style="color: var(--text); margin: 0;"` instead of a class
- **Load More button uses `var(--accent)` which doesn't exist** — Line 1580: `background: var(--accent)` — this CSS variable is never defined, so the button has no background color!

**Proposed fixes:**
- Define `var(--accent)` or replace with `var(--purple)` for the Load More button
- Extract `makeCard()` inline styles into `.analytics-card` CSS class
- Align colors with global token system
- Add table row hover states
- Add column sort indicators (even if sort isn't implemented yet — visual affordance)

#### Method (/method) — Score: 5.9/10

**What works:**
- Blog container has good typography hierarchy (lines 767-800): h1 at 28px, h2 at 22px, h3 at 18px, h4 at 16px
- Line-height 1.7 for readability (line 760)
- Blockquote styling with purple left border (line 784)
- Code blocks with purple tint background (lines 792-800)
- Good use of `max-width` constraints for readability (inherits from parent)

**What doesn't work:**
- **`var(--cyan)` renders as white for links** — Line 799: `.blog-container a { color: var(--cyan); }` makes links indistinguishable from bold text since `--cyan: #ffffff`
- **No heading anchors** — Can't link to specific sections
- **Paragraph spacing is tight** — Line 779: `margin-bottom: 8px` for `<p>` tags. Standard for body text is 16-24px between paragraphs. This makes the blog feel compressed.
- **No reading progress indicator** — For long-form content, this would add polish
- **Skeleton is decent but generic** — The blog skeleton (lines 1515-1530) shows title + paragraph shapes, which is good, but could match the actual content structure better

**Proposed fixes:**
- Fix `--cyan` variable or create a dedicated `--link` color token
- Increase paragraph `margin-bottom` to 16px for breathing room
- Add `id` attributes to headings for deep linking
- Consider a subtle background gradient or max-width constraint for better reading experience

#### Changelog (/changelog) — Score: 5.5/10

**What works:**
- Timeline design with gradient vertical line is elegant (line 1043: `linear-gradient(180deg, var(--purple) 0%, var(--border) 100%)`)
- First commit dot is visually differentiated with purple fill (lines 1053-1058)
- Commit hash links with purple tint background (lines 1073-1077)
- Author avatars add personality
- Fade-out gradient at bottom (lines 957-965) is a nice "there's more" signal
- Skeleton timeline items mimic actual structure (lines 1596-1604)

**What doesn't work:**
- **No date grouping headers** — Commits are listed chronologically but without "Today", "Yesterday", "Jan 30" separators. Dense commit history blurs together.
- **All commits look the same weight** — No distinction between feature commits, bug fixes, and config changes
- **No filtering** — Can't search or filter commits
- **Timeline padding differs from skeleton** — Skeleton uses `padding-left: 24px` (line ~253) but actual timeline also uses `padding-left: 24px` (line 1040) — consistent, but the dot positioning (`left: -22px` / `left: -29px`) differs between skeleton and actual
- **Fade gradient hides last items** — The 120px gradient (line 960) means users might miss the last 2-3 commits without scrolling

**Proposed fixes:**
- Add date group separators ("Today", "Yesterday", date headers)
- Use commit message prefixes (feat:, fix:, chore:) for visual categorization if available
- Reduce fade gradient to 60px or make it clickable to expand

#### Admin (/admin) — Score: 3.2/10

**What works:**
- Token-gated access with session cookies is secure (lines 3064-3100)
- Kill switch and restart are the right controls to surface
- Endpoint stats table is useful for monitoring
- Auth flow (enter token → verify → session) works logically

**What doesn't work:**
- **100% inline styles** — The entire admin panel uses zero CSS classes. Every element has `style="..."` attributes (lines 1601-1668). This is the worst code quality of any screen.
- **Inconsistent with rest of site** — Admin uses `var(--cyan)` for the Verify button (line 1625) which renders as white text on white-ish background. Low contrast.
- **No responsive design** — No mobile-specific styles for admin. On mobile the `max-width: 800px` with `padding: 20px` is fine, but form inputs and buttons don't adapt.
- **Endpoint stats have no loading state** — Line 1609: Just shows "Loading..." text, no skeleton
- **Restart button has no confirmation UX** — Uses browser `confirm()` dialog (line 3215) — functional but jarring. Should be an inline confirmation.
- **No status refresh** — Admin status loads once on auth. Should poll periodically.
- **Not listed in tab navigation** — Admin is hidden from tabs (by design, it's token-gated), but the URL `/admin` is discoverable. Consider whether the tab should appear after auth.

**Proposed fixes:**
- Extract admin styles into CSS classes (`.admin-card`, `.admin-input`, `.admin-btn`, `.admin-btn--danger`)
- Add mobile breakpoint styles
- Replace `confirm()` with inline confirmation component
- Add skeleton/loading states for endpoint stats
- Auto-refresh status every 30 seconds

---

## Phased Implementation Plan

### Phase 1: Foundation (CSS Variables + Global Styles)
**Effort: ~2-3 hours | Risk: Low**

This phase touches only the `<style>` block and creates the foundation everything else builds on.

1. **Expand CSS custom properties** — Replace `:root` block (lines 97-107) with a full token system:
   ```css
   :root {
     /* Backgrounds */
     --bg-primary: #0a0a0f;
     --bg-card: #12121a;
     --bg-elevated: #1a1a24;
     --bg-hover: rgba(255, 255, 255, 0.03);
     
     /* Borders */
     --border-primary: #1e1e2e;
     --border-hover: #2e2e3e;
     
     /* Text */
     --text-primary: #e0e0e0;
     --text-secondary: #888888;
     --text-tertiary: #666666;
     --text-inverse: #0a0a0f;
     
     /* Semantic colors */
     --color-green: #22c55e;
     --color-red: #ef4444;
     --color-yellow: #eab308;
     --color-orange: #f97316;
     --color-purple: #a855f7;
     --color-blue: #3b82f6;
     --color-link: #60a5fa;
     
     /* Spacing scale (4px base) */
     --space-1: 4px;
     --space-2: 8px;
     --space-3: 12px;
     --space-4: 16px;
     --space-5: 20px;
     --space-6: 24px;
     --space-8: 32px;
     --space-10: 40px;
     
     /* Border radius */
     --radius-sm: 4px;
     --radius-md: 6px;
     --radius-lg: 8px;
     --radius-xl: 12px;
     --radius-full: 9999px;
     
     /* Typography */
     --font-mono: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
     --font-brand: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
     --text-xs: 10px;
     --text-sm: 12px;
     --text-base: 14px;
     --text-lg: 16px;
     --text-xl: 20px;
     --text-2xl: 24px;
     --text-3xl: 28px;
     
     /* Transitions */
     --transition-fast: 0.15s ease;
     --transition-normal: 0.2s ease;
     --transition-slow: 0.3s ease;
   }
   ```

2. **Create utility classes** for commonly inlined patterns:
   ```css
   .text-positive { color: var(--color-green); }
   .text-negative { color: var(--color-red); }
   .text-warning { color: var(--color-yellow); }
   .text-muted { color: var(--text-secondary); }
   .text-brand { color: var(--color-purple); }
   .badge { padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-sm); }
   .badge-purple { background: var(--color-purple); color: white; }
   .badge-warning { background: var(--color-yellow); color: var(--text-inverse); }
   ```

3. **Add focus states** globally:
   ```css
   :focus-visible {
     outline: 2px solid var(--color-purple);
     outline-offset: 2px;
   }
   ```

4. **Backward compatibility** — Keep old variable names as aliases:
   ```css
   --bg: var(--bg-primary);
   --card-bg: var(--bg-card);
   --border: var(--border-primary);
   --text: var(--text-primary);
   --text-dim: var(--text-secondary);
   --green: var(--color-green);
   --red: var(--color-red);
   --yellow: var(--color-yellow);
   --cyan: var(--color-link);  /* FIX: was #ffffff */
   --purple: var(--color-purple);
   ```

### Phase 2: Dashboard Tab (highest visibility)
**Effort: ~3-4 hours | Risk: Medium**

1. **Migrate stat cards to token system** — Replace `padding: 15px` with `padding: var(--space-4)`, `border-radius: 8px` with `border-radius: var(--radius-lg)`, `font-size: 12px` with `font-size: var(--text-sm)`, etc.
   - Affected lines: 469-492

2. **Elevate PnL card** — Add subtle distinction for the primary metric:
   ```css
   .pnl-card {
     border-color: var(--color-purple);
     border-width: 1px;
     background: linear-gradient(135deg, var(--bg-card) 0%, rgba(168, 85, 247, 0.05) 100%);
   }
   ```

3. **Extract progress bar component** — Create a single `.progress-bar-container` class and use it in watchlist, premium watchlist, and open positions (replaces ~90 lines of duplicated inline JS).

4. **Extract section header badge** — Create `.section-badge` class to replace the 5+ inline badge styles.

5. **Create Notable Logs distinction** — Add left accent border:
   ```css
   #notable-logs { border-left: 3px solid var(--color-yellow); }
   ```

6. **Fix all Dashboard inline `color: #a855f7`** to use existing `.section-header` color.

7. **Add `aria-live="polite"`** to `#pnl`, `#open-positions-table`, `#watchlist-table`, and `#logs`.

### Phase 3: Data Screens (Spreads, Trades)
**Effort: ~4-5 hours | Risk: Medium**

**Spreads:**
1. Increase row label font-size from 10px to `var(--text-sm)` (12px)
2. Increase time label font-size from 8px to `var(--text-xs)` (10px)
3. Replace hardcoded legend colors with CSS variables
4. Add `.heatmap-empty-state` class with placeholder SVG

**Trades:**
1. **Fix the broken Load More button** — Replace `var(--accent)` (undefined) with `var(--color-purple)` (line 1580)
2. Extract `makeCard()` inline styles → `.analytics-card` CSS class
3. Replace `#4ecb71`/`#ff6b6b` → `var(--color-green)`/`var(--color-red)` in JS
4. Extract trade table row styles → CSS classes (`.trades-row td`, `.trades-cell-token`, etc.)
5. Add table row hover state: `#trades-tbody tr:hover { background: var(--bg-hover); }`
6. Remove the `max-width: 1200px` wrapper or make it match other screens

### Phase 4: Content Screens (Method, Changelog)
**Effort: ~2 hours | Risk: Low**

**Method:**
1. Fix link color — change `--cyan` from `#ffffff` to actual link color (done in Phase 1)
2. Increase paragraph `margin-bottom` from 8px to 16px
3. Verify heading hierarchy uses token scale
4. Add heading `id` attributes for deep linking (requires blog render API change)

**Changelog:**
1. Add date group separators between commits from different days
2. Reduce fade gradient from 120px to 60px
3. Align skeleton dot positions with actual dot positions
4. Consider commit type badges (if commit messages follow conventional format)

**Admin:**
1. Extract all inline styles into CSS classes:
   - `.admin-section` (replaces repeated card pattern)
   - `.admin-input` (input field style)
   - `.admin-btn`, `.admin-btn--primary`, `.admin-btn--danger`
   - `.admin-status-row`
2. Add mobile breakpoint for admin layout
3. Add skeleton loader for endpoint stats
4. Fix Verify button contrast (`var(--cyan)` → `var(--color-purple)`)

### Phase 5: Polish (Interactions, Animations, Mobile)
**Effort: ~3-4 hours | Risk: Low-Medium**

1. **Replace `!important` overrides** — Restructure mobile CSS to avoid specificity wars. Use more specific selectors instead of `!important` (affects ~15 rules in the 600px breakpoint).

2. **Add transition to all interactive elements** — Ensure buttons, links, and cards have `transition: var(--transition-fast)` consistently.

3. **Restore mobile time ranges** — Show W and M buttons on mobile (they fit), or add a dropdown/overflow menu.

4. **Mobile tooltip alternative** — Replace hidden tooltips with an info drawer or long-press reveal pattern.

5. **Add reduced-motion support**:
   ```css
   @media (prefers-reduced-motion: reduce) {
     .skeleton, .pulse-dot, .live-dot-ring { animation: none; }
     .flash-up, .flash-down { animation: none; }
   }
   ```

6. **Smooth tab transitions** — Add subtle fade or slide when switching tabs instead of instant show/hide.

7. **Print stylesheet** — Add `@media print` with white background, dark text, hidden nav.

8. **Code splitting consideration** — Long-term, consider splitting the JS into per-tab modules that load on demand. The heatmap rendering, trades logic, and admin code don't need to load for the Dashboard tab.

---

## Risk Assessment

### What Could Break

| Change | Risk | Mitigation |
|---|---|---|
| Renaming CSS variables | **High** — JS uses `var()` in template strings and inline styles | Phase 1 maintains backward-compatible aliases |
| Fixing `--cyan` to actual link color | **Medium** — Blog links, changelog text, admin buttons all change appearance | Visually verify all 6 screens after change |
| Extracting inline styles to classes | **Medium** — JS-generated HTML must reference new class names | Test each table (watchlist, positions, trades) after migration |
| Removing `!important` | **Medium** — Mobile layouts might break if specificity isn't resolved correctly | Test on actual mobile device, not just DevTools |
| Adding new CSS classes | **Low** — Additive change, nothing breaks | Standard review |
| Adding ARIA attributes | **Low** — Screen readers benefit, no visual change | Automated a11y testing |

### How to Test

1. **Visual regression** — Screenshot each of the 6 tabs before and after each phase, compare
2. **Mobile testing** — Test on actual iPhone and Android device (DevTools responsive mode misses touch issues and real viewport sizing)
3. **Functionality checklist per phase:**
   - [ ] Stats update every 10s
   - [ ] PnL chart renders and hover works
   - [ ] Watchlist flash animations fire
   - [ ] Time range buttons switch data
   - [ ] Heatmap loads and tooltip works
   - [ ] Trades load and "Load More" works
   - [ ] Blog content renders
   - [ ] Changelog loads from GitHub
   - [ ] Admin login and actions work
   - [ ] Kill switch warning shows when active
4. **Accessibility** — Run axe-core or Lighthouse accessibility audit after Phase 1

### Rollback Strategy

Since this is a single file, git provides natural rollback:
```bash
git stash        # Before starting a phase
git stash pop    # If something goes wrong
```

Recommend committing after each phase so rollback is granular:
- `git commit -m "design: phase 1 - token system foundation"`
- `git commit -m "design: phase 2 - dashboard tab polish"`
- etc.

Each phase is independently deployable and independently revertible. No phase depends on a later phase, so you can stop after any phase and still have a better product than before.
