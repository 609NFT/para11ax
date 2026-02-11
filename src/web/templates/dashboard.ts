/**
 * Dashboard HTML template generation
 */

import { getAllThresholds } from '../../liquidity/liquidityChecker';

// Tab configuration type
export interface TabConfig {
  title: string;
  description: string;
  ogImage: string;
  activeTab: string;
}

export const TAB_CONFIG: Record<string, TabConfig> = {
  dashboard: {
    title: 'Parallax Dashboard',
    description: 'Live monitoring for RWA arbitrage, positions, and signals.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'dashboard',
  },
  heatmap: {
    title: 'Parallax NAV Spreads',
    description: 'RWA token vs NAV price spread visualization over time.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'heatmap',
  },
  method: {
    title: 'Parallax Method',
    description: 'How the RWA arbitrage strategy works.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'blog',
  },
  changelog: {
    title: 'Parallax Changelog',
    description: 'Recent updates and changes to the Parallax bot.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'changelog',
  },
  trades: {
    title: 'Parallax Trade History',
    description: 'Complete trade history with analytics and per-token performance.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'trades',
  },
  admin: {
    title: 'Parallax Admin',
    description: 'Admin controls for kill switch, restart, and token management.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'admin',
  },
  predict: {
    title: 'Parallax Predictions',
    description: 'Prediction market information arbitrage.',
    ogImage: 'https://parallax.report/public/SEO.jpg',
    activeTab: 'predict',
  },
};

/**
 * Generate the dashboard HTML
 */
export function getDashboardHTML(tab: string = 'dashboard'): string {
  const tabConfig = TAB_CONFIG[tab] || TAB_CONFIG.dashboard;
  const urlPath = tab === 'dashboard' ? '' : `/${tab}`;
  // Use getAllThresholds() for real-time enabled count (after liquidity checks)
  const thresholds = getAllThresholds();
  const enabledTokenCount = thresholds.filter(t => t.enabled).length || 12; // fallback to 12
  const isAdminTab = tabConfig.activeTab === 'admin';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-T39253E9P8"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-T39253E9P8');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${tabConfig.description}">
  <meta property="og:title" content="${tabConfig.title}">
  <meta property="og:description" content="${tabConfig.description}">
  <meta property="og:image" content="${tabConfig.ogImage}">
  <meta property="og:url" content="https://parallax.report${urlPath}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${tabConfig.title}">
  <meta name="twitter:description" content="${tabConfig.description}">
  <meta name="twitter:image" content="${tabConfig.ogImage}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⏾</text></svg>">
  <title>${tabConfig.title}</title>
  <style>
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
      --color-yellow-green: #a3e635;
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

      /* Backward-compatible aliases */
      --bg: var(--bg-primary);
      --card-bg: var(--bg-card);
      --border: var(--border-primary);
      --text: var(--text-primary);
      --text-dim: var(--text-secondary);
      --green: var(--color-green);
      --red: var(--color-red);
      --yellow: var(--color-yellow);
      --cyan: var(--color-link);
      --purple: var(--color-purple);
    }

    /* Utility classes */
    .text-positive { color: var(--color-green); }
    .text-negative { color: var(--color-red); }
    .text-warning { color: var(--color-yellow); }
    .text-muted { color: var(--text-secondary); }
    .text-brand { color: var(--color-purple); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-sm); }
    .badge-purple { background: var(--color-purple); color: white; }
    .badge-warning { background: var(--color-yellow); color: var(--text-inverse); }
    .badge-red { background: var(--color-red); color: white; }

    /* Analytics cards */
    .analytics-card {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-lg);
      padding: var(--space-4);
    }
    .analytics-card .label {
      color: var(--text-secondary);
      font-size: var(--text-sm);
      margin-bottom: var(--space-1);
    }
    .analytics-card .value {
      font-size: var(--text-xl);
      font-weight: 600;
    }

    /* Trade table hover */
    #trades-tbody tr:hover {
      background: var(--bg-hover);
    }

    /* Global focus states */
    :focus-visible {
      outline: 2px solid var(--color-purple);
      outline-offset: 2px;
    }

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      .skeleton, .pulse-dot, .live-dot-ring, .live-dot-center { animation: none !important; }
      .flash-up, .flash-down { animation: none !important; }
      * { transition-duration: 0.01ms !important; }
    }
    /* Skeleton loader styles */
    @keyframes skeleton-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, var(--border) 25%, #3a3a4e 50%, var(--border) 75%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
      border-radius: 4px;
    }
    .skeleton-text {
      height: 14px;
      margin-bottom: 8px;
    }
    .skeleton-text:last-child {
      margin-bottom: 0;
    }
    .skeleton-text-sm {
      height: 12px;
    }
    .skeleton-text-lg {
      height: 24px;
    }
    .skeleton-value {
      height: 28px;
      margin-bottom: 6px;
    }
    .skeleton-label {
      height: 12px;
      margin-bottom: 8px;
    }
    .skeleton-sub {
      height: 11px;
    }
    .skeleton-stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    .skeleton-table-row {
      display: flex;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      align-items: center;
    }
    .skeleton-table-cell {
      height: 14px;
      flex: 1;
    }
    .skeleton-progress-bar {
      height: 8px;
      border-radius: 4px;
      flex: 2;
    }
    .skeleton-heatmap-grid {
      display: grid;
      gap: 2px;
      width: 100%;
    }
    .skeleton-heatmap-label {
      height: 16px;
      border-radius: var(--radius-sm);
    }
    .skeleton-heatmap-cell {
      height: 16px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      box-sizing: border-box;
    }
    /* Heatmap skeleton color variants to mimic the real chart */
    @keyframes skeleton-heatmap-shimmer {
      0% { opacity: 0.4; }
      50% { opacity: 0.7; }
      100% { opacity: 0.4; }
    }
    .skeleton-heatmap-cell[data-color="green"] {
      background: linear-gradient(90deg, rgba(34, 197, 94, 0.3) 0%, rgba(34, 197, 94, 0.5) 50%, rgba(34, 197, 94, 0.3) 100%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-heatmap-cell[data-color="green-light"] {
      background: linear-gradient(90deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.25) 50%, rgba(34, 197, 94, 0.15) 100%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-heatmap-cell[data-color="red"] {
      background: linear-gradient(90deg, rgba(239, 68, 68, 0.3) 0%, rgba(239, 68, 68, 0.5) 50%, rgba(239, 68, 68, 0.3) 100%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-heatmap-cell[data-color="red-light"] {
      background: linear-gradient(90deg, rgba(239, 68, 68, 0.15) 0%, rgba(239, 68, 68, 0.25) 50%, rgba(239, 68, 68, 0.15) 100%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-heatmap-cell[data-color="neutral"] {
      background: linear-gradient(90deg, rgba(26, 26, 46, 0.6) 0%, rgba(58, 58, 78, 0.8) 50%, rgba(26, 26, 46, 0.6) 100%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    /* PnL Chart Skeleton */
    .skeleton-pnl-chart {
      position: relative;
      width: 100%;
      height: 60px;
    }
    .skeleton-pnl-chart svg {
      overflow: visible;
    }
    .skeleton-pnl-chart .skeleton-axis-label {
      fill: var(--text-dim);
      opacity: 0.3;
    }
    .skeleton-pnl-chart .skeleton-zero-line {
      stroke: var(--border);
      opacity: 0.5;
    }
    .skeleton-pnl-chart .skeleton-curve {
      fill: none;
      stroke: var(--border);
      stroke-width: 2;
      stroke-linecap: round;
    }
    @keyframes skeleton-curve-shimmer {
      0% { stroke: var(--border); opacity: 0.4; }
      50% { stroke: #3a3a4e; opacity: 0.7; }
      100% { stroke: var(--border); opacity: 0.4; }
    }
    .skeleton-pnl-chart .skeleton-curve {
      animation: skeleton-curve-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-pnl-chart .skeleton-dot {
      fill: var(--border);
    }
    .skeleton-pnl-chart .skeleton-dot-ring {
      fill: var(--border);
      animation: livePulseRing 1.5s ease-out infinite;
    }
    .skeleton-timeline-item {
      display: flex;
      gap: 16px;
      padding: 16px 0;
      border-left: 2px solid var(--border);
      margin-left: 8px;
      padding-left: 24px;
    }
    .skeleton-commit-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-left: -29px;
      margin-right: 14px;
    }
    .skeleton-blog-title {
      height: 32px;
      width: 60%;
      margin-bottom: 24px;
    }
    .skeleton-blog-paragraph {
      height: 14px;
      margin-bottom: 12px;
    }
    .skeleton-log-line {
      height: 16px;
      margin-bottom: 6px;
      border-radius: 2px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
      background: var(--bg);
      color: var(--text);
      padding: var(--space-5);
      min-height: 100vh;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-5);
      flex-wrap: nowrap;
      background-image: url('/public/blob.webp');
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      padding: 16px 20px;
      border-radius: var(--radius-xl);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .header-brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .header-title {
      display: flex;
      align-items: center;
      line-height: 1;
    }
    .header-subtitle {
      font-size: 12px;
      color: #fff;
    }
    .header-by-link {
      font-size: 12px;
      color: #fff;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--purple);
      border-radius: 6px;
      background: var(--bg);
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-left: auto;
    }
    .header-wallet {
      text-align: right;
    }
    .header h1 {
      font-size: 24px;
      color: var(--purple);
    }
    .header .mode {
      padding: 4px 10px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
    }
    .mode.live { background: var(--bg); color: #fff; border: 1px solid var(--border); }
    .mode.paper { background: transparent; color: var(--yellow); border: 1px solid var(--border); }
    .mode.market-open { background: var(--bg); color: #fff; border: 1px solid var(--border); }
    .mode.market-closed { background: var(--bg); color: #fff; border: 1px solid var(--border); }
    .mode.pre-market { background: var(--bg); color: #fff; border: 1px solid var(--border); }
    .mode.post-market { background: var(--bg); color: #fff; border: 1px solid var(--border); }
    .time-range {
      display: flex;
      gap: 0;
      margin-left: auto;
      margin-bottom: -1px;
    }
    .time-range-btn {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      border-radius: 6px 6px 0 0;
      background: var(--card-bg);
      color: var(--text-dim);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      margin-left: -1px;
      transition: all 0.15s;
      position: relative;
    }
    .time-range-btn:first-child {
      margin-left: 0;
    }
    .time-range-btn:hover {
      color: var(--text);
      background: var(--bg);
    }
    .time-range-btn.active {
      background: var(--bg);
      color: var(--purple);
      border-bottom-color: var(--bg);
      z-index: 1;
    }
    .time-range.hidden {
      display: none;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--purple);
      animation: pulse 2s ease-in-out infinite;
    }
    .mode.paper .pulse-dot { background: var(--yellow); }
    .mode.market-open .pulse-dot { background: var(--green); }
    .mode.market-closed .pulse-dot { background: #ef4444; }
    .mode.pre-market .pulse-dot { background: var(--yellow); }
    .mode.post-market .pulse-dot { background: #f97316; }
    .header-status {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }
    .desktop-only { display: none; }
    .mobile-only { display: inline; }
    .header-by-link.desktop-only { display: none; }
    @media (min-width: 601px) {
      .desktop-only { display: inline; }
      .mobile-only { display: none; }
      .header-by-link.mobile-only { display: none; }
      .header-by-link.desktop-only { display: inline-flex; }
      .header-status .mode,
      .header-status .header-by-link.desktop-only {
        height: 26px;
        width: 120px;
        justify-content: center;
        box-sizing: border-box;
        white-space: nowrap;
      }
      .header-status .mode { padding: 0 8px; font-size: 11px; }
      .header-status .header-by-link.desktop-only {
        padding: 0 8px;
        border: 1px solid var(--border);
        font-size: 11px;
      }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
    @keyframes livePulseRing {
      0% { opacity: 0.8; r: 4; }
      100% { opacity: 0; r: 12; }
    }
    .live-dot-ring {
      animation: livePulseRing 1.5s ease-out infinite;
    }
    .live-dot-center {
      /* static dot, no animation */
    }
    @keyframes flashGreen {
      0% { background-color: rgba(34, 197, 94, 0.5); }
      100% { background-color: transparent; }
    }
    @keyframes flashRed {
      0% { background-color: rgba(239, 68, 68, 0.5); }
      100% { background-color: transparent; }
    }
    .flash-up {
      animation: flashGreen 0.8s ease-out;
    }
    .flash-down {
      animation: flashRed 0.8s ease-out;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-5);
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-4);
    }
    .stat-card .label {
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-bottom: 5px;
    }
    .stat-card .value {
      font-size: var(--text-2xl);
      font-weight: bold;
    }
    .stat-card .sub {
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-top: 3px;
    }
    .stat-card.wide {
      grid-column: span 2;
      border-color: rgba(168, 85, 247, 0.3);
      background: linear-gradient(135deg, var(--bg-card) 0%, rgba(168, 85, 247, 0.04) 100%);
    }
    #notable-logs {
      border-left: 3px solid var(--color-yellow);
      padding-left: var(--space-3);
    }
    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .stale { color: var(--yellow); }
    .very-stale { color: var(--red); }
    .progress-bar {
      width: 100%;
      min-width: 60px;
      height: 8px;
      background: rgba(255,255,255,0.1);
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .progress-text {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 3px;
      white-space: nowrap;
    }
    .section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: var(--space-5);
    }
    .watchlists-container {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .watchlists-container .section {
      flex: none;
      min-width: 0;
    }
    .table-wrapper {
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
    }
    .table-wrapper::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .table-wrapper::-webkit-scrollbar-track {
      background: var(--card-bg);
      border-radius: 4px;
    }
    .table-wrapper::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }
    .table-wrapper::-webkit-scrollbar-thumb:hover {
      background: var(--text-dim);
    }
    thead {
      position: sticky;
      top: 0;
      background: var(--card-bg);
      z-index: 10;
    }
    thead th {
      overflow: visible;
    }
    .section-header {
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      font-weight: bold;
      color: var(--purple);
      transition: color var(--transition-fast);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: var(--space-2) var(--space-4);
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: rgba(255,255,255,0.02);
      color: var(--text-dim);
      font-size: 11px;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: none; }
    .ticker-link {
      color: var(--text-primary);
      text-decoration: none;
      font-weight: bold;
    }
    .ticker-link:hover {
      text-decoration: underline;
    }
    .tooltip {
      position: relative;
      cursor: help;
    }
    .tooltip-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--border);
      color: var(--text-dim);
      font-size: 10px;
      font-weight: bold;
      margin-left: 4px;
      vertical-align: middle;
    }
    .tooltip:hover .tooltip-text {
      visibility: visible;
      opacity: 1;
    }
    .tooltip-text {
      visibility: hidden;
      opacity: 0;
      position: fixed;
      background: var(--card-bg);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: normal;
      text-transform: none;
      white-space: normal;
      max-width: 180px;
      text-align: center;
      z-index: 9999;
      border: 1px solid var(--border);
      transition: opacity 0.2s;
      pointer-events: none;
    }
    .log-container {
      max-height: 264px; /* ~6 rows */
      overflow-y: auto;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      padding: 10px;
      font-size: 11px;
    }
    .log-container::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .log-container::-webkit-scrollbar-track {
      background: var(--card-bg);
      border-radius: 4px;
    }
    .log-container::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }
    .log-container::-webkit-scrollbar-thumb:hover {
      background: var(--text-dim);
    }
    .log-entry {
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      margin-bottom: 2px;
      white-space: nowrap;
      display: block;
      width: 100%;
      box-sizing: border-box;
      font-size: 11px;
      line-height: 1.4;
    }
    .log-info { background: rgba(255, 255, 255, 0.03); }
    .log-warn { background: rgba(234, 179, 8, 0.2); color: var(--yellow); }
    .log-error { background: rgba(239, 68, 68, 0.2); color: var(--red); }
    .log-time { color: var(--text-dim); margin-right: 8px; font-size: 11px; }
    .log-component { color: var(--purple); margin-right: 8px; font-size: 11px; }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .status-dot.active { background: var(--green); }
    .status-dot.inactive { background: var(--text-dim); }
    .refresh-info {
      display: flex;
      justify-content: center;
      align-items: center;
      color: var(--text-dim);
      font-size: 12px;
      margin-top: 10px;
      padding-bottom: 40px;
    }
    .kill-switch-warning {
      background: var(--red);
      color: white;
      padding: 15px;
      text-align: center;
      font-weight: bold;
      margin-bottom: 20px;
      border-radius: 8px;
    }
    .tabs {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-bottom: var(--space-5);
      border-bottom: 1px solid var(--border);
    }
    .tab-group {
      display: flex;
      gap: 0;
    }
    .tab {
      cursor: pointer;
      color: var(--text-dim);
      font-weight: bold;
      font-size: 14px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      border-radius: 8px 8px 0 0;
      margin-right: -1px;
      margin-bottom: -1px;
      position: relative;
      transition: all 0.2s;
    }
    .tab:hover {
      color: var(--text);
      background: var(--bg);
    }
    .tab.active {
      color: var(--purple);
      background: var(--bg);
      border-color: var(--border);
      border-bottom-color: var(--bg);
      z-index: 1;
    }
    .tab a {
      color: inherit;
      text-decoration: none;
      display: block;
      padding: 10px 20px;
    }
    .tabs-line {
      display: none;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .blog-container {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-lg);
      padding: 30px;
      width: 100%;
      line-height: 1.7;
    }
    .blog-container h1 {
      color: var(--color-purple);
      font-size: var(--text-3xl);
      margin-bottom: var(--space-3);
    }
    .blog-container h2 {
      color: var(--color-purple);
      font-size: var(--text-2xl);
      margin-top: var(--space-10);
      margin-bottom: var(--space-4);
      padding-bottom: var(--space-2);
      border-bottom: 1px solid var(--border-primary);
    }
    .blog-container h3 {
      color: var(--color-link);
      font-size: var(--text-xl);
      margin-top: var(--space-6);
      margin-bottom: var(--space-3);
    }
    .blog-container h4 {
      color: var(--text-primary);
      font-size: var(--text-lg);
      margin-top: var(--space-5);
      margin-bottom: var(--space-2);
    }
    .blog-container p {
      margin-bottom: var(--space-4);
      color: var(--text-primary);
    }
    .blog-container blockquote {
      border-left: 3px solid var(--color-purple);
      padding-left: var(--space-4);
      margin: var(--space-5) 0;
      color: var(--text-secondary);
      font-style: italic;
    }
    .blog-container ul, .blog-container ol {
      margin: var(--space-4) 0;
      padding-left: var(--space-6);
    }
    .blog-container li {
      margin-bottom: var(--space-2);
    }
    .blog-container code {
      background: rgba(168, 85, 247, 0.15);
      color: var(--color-purple);
      padding: 2px var(--space-2);
      border-radius: var(--radius-sm);
      font-size: 13px;
    }
    .blog-container pre {
      background: var(--bg-elevated);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      overflow-x: auto;
      margin: var(--space-4) 0;
    }
    .blog-container pre code {
      background: none;
      padding: 0;
      color: var(--text-primary);
    }
    .blog-container table {
      width: 100%;
      border-collapse: collapse;
      margin: var(--space-5) 0;
      font-size: var(--text-base);
    }
    .blog-container th {
      background: rgba(168, 85, 247, 0.1);
      color: var(--color-purple);
      padding: var(--space-3);
      text-align: left;
      border: 1px solid var(--border-primary);
    }
    .blog-container td {
      padding: var(--space-3);
      border: 1px solid var(--border-primary);
    }
    .blog-container strong {
      color: var(--text-primary);
    }
    .blog-container hr {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: var(--space-8) 0;
    }
    .blog-container a {
      color: var(--color-link);
      text-decoration: none;
    }
    .blog-container a:hover {
      text-decoration: underline;
    }
    /* Discount Heatmap Styles */
    .heatmap-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 30px;
      width: 100%;
    }
    .heatmap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .heatmap-title {
      color: var(--purple);
      font-size: 24px;
      font-weight: 600;
      margin: 0;
    }
    .heatmap-range {
      display: flex;
      gap: 4px;
    }
    .heatmap-range-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: all 0.2s;
    }
    .heatmap-range-btn:hover {
      border-color: var(--purple);
      color: var(--text);
    }
    .heatmap-range-btn.active {
      background: var(--purple);
      border-color: var(--purple);
      color: white;
    }
    .heatmap-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .heatmap-legend {
      display: flex;
      gap: 12px;
    }
    .heatmap-legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .heatmap-legend-color {
      width: 14px;
      height: 14px;
      border-radius: 2px;
    }
    .discount-heatmap {
      overflow-x: auto;
      padding-bottom: 10px;
      width: 100%;
    }
    .discount-heatmap-grid {
      display: grid;
      gap: 2px;
      width: 100%;
    }
    .heatmap-row-label {
      font-size: var(--text-sm);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 8px;
      font-weight: 500;
      white-space: nowrap;
    }
    .heatmap-time-label {
      font-size: 8px;
      color: var(--text-dim);
      text-align: center;
      transform: rotate(-45deg);
      white-space: nowrap;
    }
    .heatmap-cell {
      width: 100%;
      height: 16px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      transition: transform 0.1s;
      cursor: crosshair;
    }
    .heatmap-cell:hover {
      transform: scale(2);
      z-index: 10;
      position: relative;
      box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
    }
    .heatmap-tooltip {
      position: fixed;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
      white-space: nowrap;
    }
    .heatmap-tooltip-symbol {
      font-weight: 600;
      color: var(--purple);
    }
    .heatmap-tooltip-time {
      color: var(--text-dim);
      margin-left: 8px;
    }
    .heatmap-tooltip-discount {
      color: var(--text);
      margin-top: 2px;
    }
    /* Changelog Timeline Styles */
    .changelog-container {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-lg);
      padding: var(--space-8);
      width: 100%;
      position: relative;
    }
    .changelog-container::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 80px;
      background: linear-gradient(to bottom, transparent 0%, var(--bg-card) 100%);
      pointer-events: none;
      border-radius: 0 0 var(--radius-lg) var(--radius-lg);
    }
    .changelog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-6);
      padding-bottom: var(--space-4);
      border-bottom: 1px solid var(--border-primary);
    }
    .changelog-title {
      color: var(--color-purple);
      font-size: var(--text-2xl);
      font-weight: 600;
      margin: 0;
    }
    .changelog-repo {
      color: var(--text-secondary);
      font-size: var(--text-sm);
    }
    .changelog-repo a {
      color: var(--color-link);
      text-decoration: none;
    }
    .changelog-repo a:hover {
      text-decoration: underline;
    }
    .changelog-timeline {
      position: relative;
      padding-left: var(--space-6);
    }
    .changelog-timeline::before {
      content: '';
      position: absolute;
      left: 5px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: linear-gradient(180deg, var(--color-purple) 0%, var(--border-primary) 100%);
    }
    .changelog-item {
      position: relative;
      margin-bottom: var(--space-5);
      padding-bottom: var(--space-5);
      border-bottom: 1px solid var(--border-primary);
    }
    .changelog-item:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .changelog-dot {
      position: absolute;
      left: -22px;
      top: 4px;
      width: 8px;
      height: 8px;
      border-radius: var(--radius-full);
      background: var(--color-purple);
      border: 2px solid var(--bg-card);
      box-shadow: 0 0 0 2px var(--color-purple);
    }
    .changelog-item:not(:first-child) .changelog-dot {
      background: var(--bg-card);
      box-shadow: 0 0 0 2px var(--border-primary);
    }
    .changelog-date {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: var(--space-1);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .changelog-date a {
      color: var(--text-secondary);
      text-decoration: none;
      font-family: monospace;
      font-size: var(--text-xs);
      background: rgba(168, 85, 247, 0.1);
      padding: 1px var(--space-2);
      border-radius: var(--radius-sm);
    }
    .changelog-date a:hover {
      color: var(--color-purple);
      background: rgba(168, 85, 247, 0.2);
    }
    .changelog-message {
      color: var(--text-primary);
      font-size: var(--text-base);
      line-height: 1.5;
      margin-bottom: var(--space-2);
    }
    .changelog-message strong {
      color: var(--color-link);
    }
    .changelog-author {
      font-size: 11px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }
    .changelog-author img {
      width: var(--space-4);
      height: var(--space-4);
      border-radius: var(--radius-full);
    }
    .changelog-author a {
      color: var(--text-secondary);
      text-decoration: none;
    }
    .changelog-author a:hover {
      color: var(--color-link);
    }
    .changelog-loading {
      text-align: center;
      color: var(--text-secondary);
      padding: var(--space-3);
    }
    .changelog-error {
      text-align: center;
      color: var(--color-red);
      padding: var(--space-3);
    }
    /* Admin Styles */
    .admin-section {
      margin-bottom: var(--space-6);
      padding: var(--space-4);
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-lg);
    }
    .admin-section h3 {
      color: var(--text-primary);
      margin-bottom: var(--space-4);
      font-size: var(--text-lg);
    }
    .admin-section p {
      color: var(--text-secondary);
      font-size: var(--text-sm);
      margin-bottom: var(--space-3);
    }
    .admin-input {
      padding: var(--space-2) var(--space-3);
      background: var(--bg-primary);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font-size: var(--text-base);
    }
    .admin-btn {
      padding: var(--space-2) var(--space-5);
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
      font-weight: 600;
      transition: opacity var(--transition-fast);
    }
    .admin-btn:hover { opacity: 0.85; }
    .admin-btn-primary {
      background: var(--color-purple);
      color: white;
    }
    .admin-btn-warning {
      background: var(--color-yellow);
      color: var(--text-inverse);
    }
    .admin-btn-danger {
      background: var(--color-red);
      color: white;
    }
    /* Interactive element transitions */
    button, .btn, [onclick] {
      transition: opacity var(--transition-fast), background-color var(--transition-fast);
    }
    button:hover, .btn:hover {
      opacity: 0.85;
    }
    tr {
      transition: background-color var(--transition-fast);
    }
    .stat-card {
      transition: border-color var(--transition-fast);
    }
    .stat-card:hover {
      border-color: var(--border-hover);
    }

    /* Tab fade-in animation */
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .tab-content.active {
      animation: fadeIn 0.15s ease;
    }

    @media (max-width: 900px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
      .table-wrapper { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
      table { min-width: 700px; font-size: var(--text-sm); }
      th, td { padding: var(--space-2) 6px; white-space: nowrap; }
    }
    @media (max-width: 600px) {
      body { padding: 8px; }
      .tooltip-icon { display: none; }
      .tooltip-text { display: none; }
      .gap-text { display: none; }
      .progress-bar { width: 100% !important; } /* override JS inline */
      .progress-text { width: 100% !important; } /* override JS inline */
      .header { flex-direction: row; align-items: stretch; gap: 8px; padding: 12px; margin-bottom: 8px; }
      .header-left { flex-direction: column; align-items: flex-start; justify-content: space-between; gap: 2px; }
      .header-title { line-height: 1; }
      .header-title span:first-child { font-size: 18px !important; margin-right: 4px !important; } /* override JS inline */
      .header-title span:last-child { font-size: 16px !important; } /* override JS inline */
      .header-subtitle { font-size: 10px; }
      .header-by-link { font-size: 10px; padding: 2px 6px; border: 1px solid var(--border); }
      .header-by-link img { width: 14px !important; height: 14px !important; } /* override JS inline */
      .header-by-link svg { width: 14px; height: 14px; }
      .header-by-link.desktop-only { display: none; }
      .header-by-link.mobile-only { display: inline-flex; }
      .header-right { flex-direction: column-reverse; align-items: flex-end; justify-content: space-between; gap: 2px; }
      .header .mode {
        padding: 2px 6px;
        font-size: 10px;
        border-radius: 6px;
      }
      .header .mode .pulse-dot {
        width: 6px;
        height: 6px;
      }
      #header-wallet-total { font-size: 14px !important; text-align: right; } /* override JS inline */
      #header-wallet-breakdown { font-size: 10px !important; } /* override JS inline */
      .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 12px; }
      .stat-card { padding: 12px; }
      .stat-card .value { font-size: 16px; }
      .stat-card .label { font-size: 10px; }
      .stat-card .sub { font-size: 10px; }
      .section { padding: 12px; }
      .section-header { font-size: 14px; margin-bottom: 10px; }
      #weekend-warning.visible { display: block !important; margin-left: 0 !important; margin-top: 6px; font-size: 10px !important; } /* override JS inline */
      table { min-width: 700px; font-size: 12px; border-collapse: separate; border-spacing: 0; }
      th, td { padding: 8px 12px; }
      th { letter-spacing: 0.5px; }
      .log-container { max-height: 180px; font-size: 10px; overflow-y: auto; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .log-entry { padding: 3px 6px; font-size: 10px; }
      .log-entry * { font-size: 10px; }
      .log-time { font-size: 10px; margin-right: 6px; }
      .log-component { font-size: 10px; margin-right: 6px; }
      .tabs { flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
      .tab-group { order: 1; }
      .tabs-line { display: none; }
      .time-range { order: 2; margin-left: 0; }
      .time-range-btn { padding: 6px 10px; font-size: 11px; }
      .tab { font-size: 12px; }
      .tab a { padding: 8px 14px; }
      .blog-container { padding: var(--space-3); }
      .blog-container h2 { font-size: 18px; }
      .blog-container p, .blog-container li { font-size: 13px; }
      .changelog-container { padding: var(--space-3); }
      .changelog-header { margin-bottom: var(--space-4); padding-bottom: var(--space-3); }
      .changelog-timeline { padding-left: var(--space-5); }
      .changelog-dot { left: -18px; }
      .heatmap-container { padding: 12px; }
      .heatmap-header { flex-direction: column; align-items: flex-start; gap: 12px; }
      .heatmap-title { font-size: 18px; }
      .heatmap-info { flex-direction: column; align-items: flex-start; gap: 8px; }
      .heatmap-legend { flex-wrap: wrap; gap: 8px; }
      .heatmap-row-label { font-size: var(--text-xs); min-width: 40px; padding-right: 4px; }
      .heatmap-cell { height: 14px; min-width: 8px; }
      .skeleton-heatmap-cell { height: 14px; }
      .skeleton-heatmap-label { height: 14px; }
      .skeleton-heatmap-grid { gap: 3px; }
      .discount-heatmap-grid { gap: 3px; }
      .heatmap-tooltip { max-width: 200px; font-size: 11px; }
      .discount-heatmap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .refresh-info { flex-direction: column; }
      .refresh-separator { display: none; }
    }
    @media (max-width: 400px) {
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .stat-card .value { font-size: 14px; }
      table { min-width: 600px; font-size: 11px; }
      th, td { padding: 6px 10px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-brand">
        <div class="header-title">
          <span style="font-size: 24px; margin-right: 8px; color: #fff; line-height: 1;">⊹</span>
          <span style="font-size: 26px; font-weight: 900; letter-spacing: -0.5px; color: var(--purple); font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1;">Parallax</span>
        </div>
        <div class="header-subtitle">RWA/Spot Arbitrage Bot</div>
      </div>
      <div class="header-by-link mobile-only"><a href="https://x.com/para11ax" target="_blank" rel="noopener" style="display: flex; align-items: center; gap: 6px; color: inherit; text-decoration: none;"><img src="/public/parallax-avatar.png" alt="Parallax" style="width: 16px; height: 16px; border-radius: 50%;">@para11ax</a><a href="https://github.com/609NFT/para11ax" target="_blank" rel="noopener" style="display: flex; align-items: center;"><svg height="16" width="16" viewBox="0 0 16 16" fill="white"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a></div>
    </div>
    <div class="header-right">
      <div class="header-wallet" style="display: flex; flex-direction: column; gap: 4px;">
        <div style="font-size: 18px; font-weight: bold; color: #fff; display: flex; align-items: center; justify-content: flex-end; gap: 6px;">
          <a href="https://solscan.io/account/kKiUUdgpNf1f1iwJLY4AGrbPbfkNcwnC5SaUbWsyBLj" target="_blank" rel="noopener" style="display: flex; align-items: center;">
            <img src="https://solscan.io/favicon.ico" alt="Solscan" style="width: 16px; height: 16px; opacity: 0.7;">
          </a>
          <span id="header-wallet-total">--</span>
        </div>
        <div style="font-size: 11px; color: #fff; text-align: right;" id="header-wallet-breakdown">-- USDC | -- SOL</div>
      </div>
      <div class="header-status">
        <a href="https://www.tradinghours.com/markets/nyse" target="_blank" rel="noopener" class="mode" id="mode"><span class="pulse-dot"></span><span id="mode-text">--</span></a>
        <div class="header-by-link desktop-only"><a href="https://x.com/para11ax" target="_blank" rel="noopener" style="display: flex; align-items: center; gap: 6px; color: inherit; text-decoration: none;"><img src="/public/parallax-avatar.png" alt="Parallax" style="width: 16px; height: 16px; border-radius: 50%;">@para11ax</a><a href="https://github.com/609NFT/para11ax" target="_blank" rel="noopener" style="display: flex; align-items: center;"><svg height="16" width="16" viewBox="0 0 16 16" fill="white"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a></div>
      </div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab-group">
      <div class="tab${tabConfig.activeTab === 'dashboard' ? ' active' : ''}" data-tab="dashboard"><a href="/"><span class="desktop-only">Dashboard</span><span class="mobile-only">Dash</span></a></div>
      <div class="tab${tabConfig.activeTab === 'heatmap' ? ' active' : ''}" data-tab="heatmap"><a href="/heatmap"><span class="desktop-only">Spreads</span><span class="mobile-only">Map</span></a></div>
      <div class="tab${tabConfig.activeTab === 'trades' ? ' active' : ''}" data-tab="trades"><a href="/trades">Trades</a></div>
      <div class="tab${tabConfig.activeTab === 'blog' ? ' active' : ''}" data-tab="blog"><a href="/method">Method</a></div>
      <div class="tab${tabConfig.activeTab === 'changelog' ? ' active' : ''}" data-tab="changelog"><a href="/changelog"><span class="desktop-only">Changelog</span><span class="mobile-only">Log</span></a></div>
      <div class="tab${tabConfig.activeTab === 'predict' ? ' active' : ''}" data-tab="predict"><a href="/predict"><span class="desktop-only">Predict</span><span class="mobile-only">🔮</span></a></div>
    </div>
    <div class="tabs-line"></div>
    <div class="time-range${tabConfig.activeTab !== 'dashboard' ? ' hidden' : ''}" id="time-range">
      <button class="time-range-btn desktop-only" data-range="6H">6H</button>
      <button class="time-range-btn active" data-range="12H">12H</button>
      <button class="time-range-btn" data-range="D">D</button>
      <button class="time-range-btn" data-range="W">W</button>
      <button class="time-range-btn" data-range="M">M</button>
      <button class="time-range-btn desktop-only" data-range="Y">Y</button>
      <button class="time-range-btn" data-range="ALL">All</button>
    </div>
  </div>

  <div id="tab-dashboard" class="tab-content${tabConfig.activeTab === 'dashboard' ? ' active' : ''}">

  <div id="kill-switch-warning" class="kill-switch-warning" style="display: none;">
    KILL SWITCH ACTIVE - ALL TRADING HALTED
  </div>

  <div class="stats-grid">
    <div class="stat-card pnl-card wide">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div class="label tooltip">Net PnL<span class="tooltip-icon">?</span><span class="tooltip-text">Profit after all fees (network, priority, slippage)</span></div>
          <div class="value" id="pnl">$0.00</div>
          <div class="sub" id="return-pct">0.0% return</div>
        </div>
        <div id="pnl-chart" style="flex: 1; height: 60px; position: relative; min-width: 100px; margin-left: 15px;"></div>
      </div>
    </div>
    <div class="stat-card">
      <div class="label">Total Trades</div>
      <div class="value" id="trades">0</div>
      <div class="sub" id="win-rate">-- win rate</div>
    </div>
    <div class="stat-card">
      <div class="label">Open Positions</div>
      <div class="value" id="open-positions">0</div>
      <div class="sub" id="total-invested">$0.00 invested</div>
    </div>
    <div class="stat-card">
      <div class="label">Largest Win</div>
      <div class="value positive" id="largest-win">--</div>
      <div class="sub" id="largest-win-details">--</div>
    </div>
    <div class="stat-card">
      <div class="label">Largest Loss</div>
      <div class="value negative" id="largest-loss">--</div>
      <div class="sub" id="largest-loss-details">--</div>
    </div>
    <div class="stat-card">
      <div class="label">Daily Trades</div>
      <div class="value" id="daily-trades">0</div>
      <div class="sub" id="avg-daily-trades">0 avg/day</div>
    </div>
    <div class="stat-card">
      <div class="label">RWAs Watched</div>
      <div class="value" id="stocks-watched" style="display: flex; align-items: center; gap: 8px;">0 <a href="https://neglect.trade/index/stocks" target="_blank" rel="noopener" style="color: var(--purple); font-size: 12px; font-weight: normal;">View</a></div>
      <div class="sub" id="stocks-watched-sub"><span class="tooltip">0 enabled<span class="tooltip-icon">?</span><span class="tooltip-text">Tokens must have sufficient liquidity and valid price feeds to be enabled for trading</span></span></div>
    </div>
  </div>

  <div class="watchlists-container">
    <div class="section" id="premium-watchlist-section" style="display: none;">
      <div class="section-header" style="color: var(--purple);">Premium Watchlist (<span id="premium-watchlist-count">0</span>) <span id="equity-market-closed-badge" style="display: none; background: var(--purple); color: var(--text-primary); padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-sm); margin-left: var(--space-2);">Market Closed</span></div>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>RWA/Token</th>
              <th class="tooltip">Entry Target<span class="tooltip-icon">?</span><span class="tooltip-text">Progress toward entry threshold</span></th>
              <th class="tooltip">Premium (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Current premium of token vs NAV (negative discount)</span></th>
              <th class="tooltip">Entry Threshold<span class="tooltip-icon">?</span><span class="tooltip-text">Minimum premium required to open a short position</span></th>
              <th>Price (NAV / T)</th>
              <th class="tooltip">Leverage<span class="tooltip-icon">?</span><span class="tooltip-text">Position leverage for this ticker</span></th>
              <th class="tooltip">Updated (NAV / T)<span class="tooltip-icon">?</span><span class="tooltip-text">Time since NAV and token prices last changed</span></th>
            </tr>
          </thead>
          <tbody id="premium-watchlist-table">
            <tr><td colspan="7" style="text-align: center; color: var(--text-dim);">No tokens at premium</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section" id="watchlist-section" style="display: none;">
      <div class="section-header" style="color: var(--purple);">Discount Watchlist (<span id="watchlist-count">0</span>)</div>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>RWA/Token</th>
              <th class="tooltip">Entry Target<span class="tooltip-icon">?</span><span class="tooltip-text">Progress toward entry threshold - fills up as discount approaches target</span></th>
              <th class="tooltip">Current (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Current discount of token vs NAV</span></th>
              <th class="tooltip">Entry Threshold<span class="tooltip-icon">?</span><span class="tooltip-text">Minimum discount required to enter a position</span></th>
              <th>Price (NAV / T)</th>
              <th class="tooltip">Updated (NAV / T)<span class="tooltip-icon">?</span><span class="tooltip-text">Time since NAV and token prices last changed</span></th>
              <th class="tooltip">TVL<span class="tooltip-icon">?</span><span class="tooltip-text">Total Value Locked in liquidity pool</span></th>
            </tr>
          </thead>
          <tbody id="watchlist-table">
            <tr><td colspan="7" style="text-align: center; color: var(--text-dim);">No tokens near entry</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">Open Positions (<span id="open-positions-count">0</span>) <span id="weekend-warning" style="display: none; background: var(--purple); color: var(--text-primary); padding: 2px var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); margin-left: var(--space-2);"></span></div>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>RWA/Token</th>
            <th class="tooltip">Exit Target<span class="tooltip-icon">?</span><span class="tooltip-text">Estimated PnL vs exit threshold. Actual exit uses live DEX quotes.</span></th>
            <th class="tooltip">Entry (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Discount (long) or premium (short) when position was opened</span></th>
            <th class="tooltip">Current (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Current discount (long) or premium (short) vs NAV</span></th>
            <th class="tooltip">NAV Δ<span class="tooltip-icon">?</span><span class="tooltip-text">NAV change since entry</span></th>
            <th>Size</th>
            <th class="tooltip">Leverage<span class="tooltip-icon">?</span><span class="tooltip-text">Position leverage (1x for spot longs, configurable for shorts)</span></th>
            <th class="tooltip">Unrealized PnL<span class="tooltip-icon">?</span><span class="tooltip-text">Net PnL after estimated exit fees (~0.5% for longs, ~0.2% for shorts)</span></th>
            <th>Hold Time</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody id="open-positions-table">
          <tr><td colspan="11" style="text-align: center; color: var(--text-dim);">No open positions</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-header">Recent Trades (<span id="recent-trades-count">0</span>)</div>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>RWA/Token</th>
            <th class="tooltip">Entry (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Discount (long) or premium (short) when position was opened</span></th>
            <th class="tooltip">Exit (%)<span class="tooltip-icon">?</span><span class="tooltip-text">Discount (long) or premium (short) when position was closed</span></th>
            <th>Size / PnL</th>
            <th>Leverage</th>
            <th>Reason</th>
            <th>Held</th>
            <th>Tx (Open / Close)</th>
          </tr>
        </thead>
        <tbody id="recent-trades-table">
          <tr><td colspan="9" style="text-align: center; color: var(--text-dim);">No recent trades</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-header" style="display: flex; justify-content: space-between; align-items: center;">
      <span>Recent Logs</span>
      <input type="text" id="log-search" placeholder="Search logs..." style="background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; color: var(--text); font-size: 12px; font-family: inherit; width: 150px;" />
    </div>
    <div class="log-container" id="logs">
      <div style="padding: 8px;">
        <div class="skeleton skeleton-log-line" style="width: 95%;"></div>
        <div class="skeleton skeleton-log-line" style="width: 80%;"></div>
        <div class="skeleton skeleton-log-line" style="width: 88%;"></div>
        <div class="skeleton skeleton-log-line" style="width: 72%;"></div>
        <div class="skeleton skeleton-log-line" style="width: 90%;"></div>
        <div class="skeleton skeleton-log-line" style="width: 65%;"></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" style="display: flex; justify-content: space-between; align-items: center;">
      <span>Notable Logs <span style="font-weight: normal; font-size: 11px; color: var(--text-dim);">(Errors & Warnings)</span></span>
      <a href="/api/logs/file?lines=100&level=40" target="_blank" style="background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; color: var(--text); font-size: 12px; font-family: inherit; text-decoration: none; cursor: pointer;">View Raw</a>
    </div>
    <div class="log-container" id="notable-logs">
      <div class="log-entry log-info" style="color: var(--text-dim);">No errors or warnings</div>
    </div>
  </div>

  <div class="refresh-info">
    <span>Auto-refreshes every 10 seconds</span><span class="refresh-separator"> | </span><span class="refresh-updated">Last updated: <span id="last-update">--</span></span>
  </div>

  </div><!-- end tab-dashboard -->

  <div id="tab-heatmap" class="tab-content${tabConfig.activeTab === 'heatmap' ? ' active' : ''}">
    <div class="heatmap-container">
      <div class="heatmap-header">
        <h2 class="heatmap-title">Historical RWA vs. Spot Spreads</h2>
        <div class="heatmap-range">
          <button class="heatmap-range-btn" data-range="1h">1H</button>
          <button class="heatmap-range-btn" data-range="4h">4H</button>
          <button class="heatmap-range-btn active" data-range="24h">24H</button>
          <button class="heatmap-range-btn" data-range="7d">7D</button>
        </div>
      </div>
      <div class="heatmap-info">
        <span id="heatmap-time-range">--</span>
        <span class="heatmap-legend">
          <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--color-green);"></span> 4% Premium</span>
          <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--bg-elevated);"></span> 0%</span>
          <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--color-red);"></span> 4% Discount</span>
        </span>
      </div>
      <div id="discount-heatmap" class="discount-heatmap">
        <div class="skeleton-heatmap-loader">
          <div class="skeleton-heatmap-grid" style="grid-template-columns: 50px repeat(24, 1fr);">
            ${(() => {
              const skeletonColors = ['neutral', 'neutral', 'neutral', 'red-light', 'red', 'green-light', 'green'];
              const getRandomColor = () => skeletonColors[Math.floor(Math.random() * skeletonColors.length)];
              return Array(enabledTokenCount).fill(0).map(() =>
                '<div class="skeleton skeleton-heatmap-label"></div>' +
                Array(24).fill(0).map(() => '<div class="skeleton skeleton-heatmap-cell" data-color="' + getRandomColor() + '"></div>').join('')
              ).join('');
            })()}
          </div>
        </div>
      </div>
    </div>
  </div><!-- end tab-heatmap -->

  <div id="tab-blog" class="tab-content${tabConfig.activeTab === 'blog' ? ' active' : ''}">
    <div class="blog-container" id="blog-content">
      <div class="skeleton skeleton-blog-title" style="width: 55%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 100%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 96%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 92%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 98%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 85%;"></div>
      <div style="height: 32px;"></div>
      <div class="skeleton skeleton-text-lg" style="width: 35%; margin-bottom: 20px;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 100%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 94%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 88%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 96%;"></div>
      <div style="height: 32px;"></div>
      <div class="skeleton skeleton-text-lg" style="width: 42%; margin-bottom: 20px;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 100%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 90%;"></div>
      <div class="skeleton skeleton-blog-paragraph" style="width: 95%;"></div>
    </div>
  </div><!-- end tab-blog -->

  <div id="tab-trades" class="tab-content${tabConfig.activeTab === 'trades' ? ' active' : ''}">
    <div style="max-width: 1200px; margin: 0 auto; padding: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h2 style="color: var(--text); margin: 0;">Trade History</h2>
        <div id="trades-analytics-summary" style="color: var(--text-dim); font-size: 13px;"></div>
      </div>

      <!-- Analytics Cards -->
      <div id="trades-analytics" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px;">
        <div class="skeleton" style="height: 80px; border-radius: 8px;"></div>
        <div class="skeleton" style="height: 80px; border-radius: 8px;"></div>
        <div class="skeleton" style="height: 80px; border-radius: 8px;"></div>
        <div class="skeleton" style="height: 80px; border-radius: 8px;"></div>
        <div class="skeleton" style="height: 80px; border-radius: 8px;"></div>
      </div>

      <!-- Token Performance -->
      <div id="token-performance" style="margin-bottom: 24px;">
        <h3 style="color: var(--text); margin-bottom: 12px; font-size: 16px;">Per-Token Performance</h3>
        <div class="skeleton" style="height: 200px; border-radius: 8px;"></div>
      </div>

      <!-- Trade Table -->
      <div style="overflow-x: auto;">
        <table id="trades-table" style="width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed;">
          <colgroup>
            <col style="width: 10%;">
            <col style="width: 10%;">
            <col style="width: 10%;">
            <col style="width: 12%;">
            <col style="width: 10%;">
            <col style="width: 22%;">
            <col style="width: 10%;" class="desktop-only">
            <col style="width: 16%;" class="desktop-only">
          </colgroup>
          <thead>
            <tr style="border-bottom: 1px solid var(--border); color: var(--text-dim);">
              <th style="padding: 8px; text-align: left;">Token</th>
              <th style="padding: 8px; text-align: right;">Entry %</th>
              <th style="padding: 8px; text-align: right;">Exit %</th>
              <th style="padding: 8px; text-align: right;">PnL</th>
              <th style="padding: 8px; text-align: right;">Hold</th>
              <th style="padding: 8px; text-align: left; overflow: hidden; text-overflow: ellipsis;">Reason</th>
              <th style="padding: 8px; text-align: right;" class="desktop-only">Size</th>
              <th style="padding: 8px; text-align: right;" class="desktop-only">Time</th>
            </tr>
          </thead>
          <tbody id="trades-tbody">
            ${Array(10).fill(0).map(() => `
              <tr style="border-bottom: 1px solid var(--border);">
                ${Array(8).fill(0).map((_, i) => `<td style="padding: 8px;"${i > 5 ? ' class="desktop-only"' : ''}><div class="skeleton skeleton-text" style="width: ${60 + Math.random() * 40}%;"></div></td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div id="trades-load-more" style="text-align: center; margin-top: 16px; display: none;">
        <button onclick="loadMoreTrades()" style="background: var(--color-purple); color: white; border: none; padding: 8px 24px; border-radius: 6px; cursor: pointer; font-size: 13px;">Load More</button>
      </div>
    </div>
  </div><!-- end tab-trades -->

  <div id="tab-changelog" class="tab-content${tabConfig.activeTab === 'changelog' ? ' active' : ''}">
    <div class="changelog-container">
      <div class="changelog-header">
        <h2 class="changelog-title">Changelog</h2>
        <div class="changelog-repo">
          <a href="https://github.com/609NFT/para11ax" target="_blank" rel="noopener" style="display: flex; align-items: center;"><svg height="24" width="24" viewBox="0 0 16 16" fill="white"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
        </div>
      </div>
      <div id="changelog-content">
        <div class="changelog-timeline">
          ${Array(6).fill(0).map(() => `
            <div class="skeleton-timeline-item">
              <div class="skeleton skeleton-commit-dot"></div>
              <div style="flex: 1;">
                <div class="skeleton skeleton-text" style="width: 75%; margin-bottom: 10px;"></div>
                <div class="skeleton skeleton-text-sm" style="width: 25%;"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  </div><!-- end tab-changelog -->


  <div id="tab-predict" class="tab-content${tabConfig.activeTab === 'predict' ? ' active' : ''}">
    <div class="predict-container" style="max-width: 1200px; margin: 0 auto; padding: var(--space-4);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-5);">
        <h2 style="color: var(--text-primary); margin: 0;">🔮 Prediction Markets</h2>
        <div style="display: flex; gap: var(--space-3); align-items: center;">
          <span id="predict-status" style="font-size: var(--text-sm); color: var(--text-secondary);">Loading...</span>
          <button onclick="refreshPredictData()" class="admin-btn" style="padding: 6px 12px;">↻ Refresh</button>
        </div>
      </div>
      <div class="predict-stats" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-5);">
        <div class="stat-card" style="background: var(--surface-1); padding: var(--space-4); border-radius: 8px; border: 1px solid var(--border-primary);">
          <div style="font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;">Open Positions</div>
          <div id="predict-open" style="font-size: 24px; font-weight: 600; color: var(--text-primary);">-</div>
        </div>
        <div class="stat-card" style="background: var(--surface-1); padding: var(--space-4); border-radius: 8px; border: 1px solid var(--border-primary);">
          <div style="font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;">Win Rate</div>
          <div id="predict-winrate" style="font-size: 24px; font-weight: 600; color: var(--text-primary);">-</div>
        </div>
        <div class="stat-card" style="background: var(--surface-1); padding: var(--space-4); border-radius: 8px; border: 1px solid var(--border-primary);">
          <div style="font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;">Total PnL</div>
          <div id="predict-pnl" style="font-size: 24px; font-weight: 600; color: var(--text-primary);">-</div>
        </div>
        <div class="stat-card" style="background: var(--surface-1); padding: var(--space-4); border-radius: 8px; border: 1px solid var(--border-primary);">
          <div style="font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;">Avg Edge</div>
          <div id="predict-edge" style="font-size: 24px; font-weight: 600; color: var(--text-primary);">-</div>
        </div>
        <div class="stat-card" style="background: var(--surface-1); padding: var(--space-4); border-radius: 8px; border: 1px solid var(--border-primary);">
          <div style="font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;">Total Fees</div>
          <div id="predict-fees" style="font-size: 24px; font-weight: 600; color: var(--color-red);">-</div>
        </div>
      </div>
      <div class="predict-section" style="margin-bottom: var(--space-5);">
        <h3 style="color: var(--text-primary); margin-bottom: var(--space-3); font-size: var(--text-base);">⚡ Live Opportunities</h3>
        <div id="predict-opportunities" style="background: var(--surface-1); border-radius: 8px; border: 1px solid var(--border-primary); overflow: hidden;">
          <div style="padding: var(--space-4); color: var(--text-secondary); text-align: center;">Scanning markets...</div>
        </div>
      </div>
      <div class="predict-section" style="margin-bottom: var(--space-5);">
        <h3 style="color: var(--text-primary); margin-bottom: var(--space-3); font-size: var(--text-base);">📊 Open Positions</h3>
        <div id="predict-positions" style="background: var(--surface-1); border-radius: 8px; border: 1px solid var(--border-primary); overflow: hidden;">
          <div style="padding: var(--space-4); color: var(--text-secondary); text-align: center;">No open positions</div>
        </div>
      </div>
      <div class="predict-section">
        <h3 style="color: var(--text-primary); margin-bottom: var(--space-3); font-size: var(--text-base);">📈 Recent Trades</h3>
        <div id="predict-trades" style="background: var(--surface-1); border-radius: 8px; border: 1px solid var(--border-primary); overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead><tr style="border-bottom: 1px solid var(--border-primary);">
              <th style="text-align: left; padding: 12px; color: var(--text-secondary);">Market</th>
              <th style="text-align: center; padding: 12px; color: var(--text-secondary);">Outcome</th>
              <th style="text-align: right; padding: 12px; color: var(--text-secondary);">Entry</th>
              <th style="text-align: right; padding: 12px; color: var(--text-secondary);">Edge</th>
              <th style="text-align: center; padding: 12px; color: var(--text-secondary);">Result</th>
              <th style="text-align: right; padding: 12px; color: var(--text-secondary);">PnL</th>
            </tr></thead>
            <tbody id="predict-trades-body">
              <tr><td colspan="6" style="padding: 16px; text-align: center; color: var(--text-secondary);">No trades yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div><!-- end tab-predict -->

  ${isAdminTab ? `<div id="tab-admin" class="tab-content active">
    <div class="admin-container" style="max-width: 800px; margin: 0 auto; padding: var(--space-5);">
      <h2 style="color: var(--text-primary); margin-bottom: var(--space-6);">Admin Controls</h2>

      <div class="admin-auth admin-section">
        <label style="color: var(--text-secondary); font-size: var(--text-sm); text-transform: uppercase; margin-bottom: var(--space-2); display: block;">Admin Token</label>
        <div style="display: flex; gap: var(--space-3); align-items: center;">
          <input type="password" id="admin-token" placeholder="Enter admin token"
            onkeypress="if(event.key==='Enter')verifyAdminToken()"
            class="admin-input" style="flex: 1;">
          <button onclick="verifyAdminToken()" class="admin-btn admin-btn-primary">
            Verify
          </button>
        </div>
        <div id="admin-auth-status" style="margin-top: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary);"></div>
      </div>

      <div id="admin-panel" style="display: none;">
        <div class="admin-endpoints admin-section">
          <h3>API Endpoints</h3>
          <div id="endpoints-table" style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border);">
                  <th style="text-align: left; padding: 8px; color: var(--text-dim);">Endpoint</th>
                  <th style="text-align: right; padding: 8px; color: var(--text-dim);">Calls/min</th>
                  <th style="text-align: right; padding: 8px; color: var(--text-dim);">Calls/hr</th>
                  <th style="text-align: right; padding: 8px; color: var(--text-dim);">Avg ms</th>
                  <th style="text-align: center; padding: 8px; color: var(--text-dim);">Status</th>
                </tr>
              </thead>
              <tbody id="endpoints-body">
                <tr><td colspan="5" style="padding: 12px; text-align: center; color: var(--text-dim);">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="admin-status admin-section">
          <h3>Status</h3>
          <div id="admin-status-content" style="display: grid; gap: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="color: var(--text-dim);">Kill Switch</span>
              <span id="status-kill-switch" style="font-weight: 600;">--</span>
            </div>
          </div>
        </div>

        <div class="admin-actions" style="display: grid; gap: var(--space-4);">
          <div class="admin-section" style="margin-bottom: 0;">
            <h3>Kill Switch</h3>
            <p>Resets the kill switch to allow trading to resume.</p>
            <button onclick="resetKillSwitch()" class="admin-btn admin-btn-warning">
              Reset Kill Switch
            </button>
          </div>

          <div class="admin-section" style="margin-bottom: 0;">
            <h3>Restart Bot</h3>
            <p>Restarts the PM2 process. Page will reload after restart.</p>
            <button onclick="restartBot()" class="admin-btn admin-btn-danger">
              Restart Bot
            </button>
          </div>

        </div>

        <div id="admin-result" style="margin-top: var(--space-4); padding: var(--space-3); border-radius: var(--radius-md); display: none;"></div>
      </div>
    </div>
  </div><!-- end tab-admin -->` : ''}

  <script>
    // Server-side config for skeleton loaders
    const ENABLED_TOKEN_COUNT = ${enabledTokenCount};

    function formatHoldTime(ms) {
      if (!ms || ms < 0) return '0s';
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
      if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
      return seconds + 's';
    }

    function formatUsd(value) {
      // Show decimals only if not a whole number, with comma separators
      if (value % 1 === 0) {
        return '$' + Math.abs(value).toLocaleString('en-US');
      }
      return '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatPnl(value) {
      const sign = value >= 0 ? '+' : '-';
      // Show up to 3 decimal places for precision on small trades, with comma separators
      if (value % 1 === 0) {
        return sign + '$' + Math.abs(value).toLocaleString('en-US');
      }
      return sign + '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    }

    function formatTime(timestamp) {
      return new Date(timestamp).toLocaleTimeString();
    }

    function formatTimeSince(timestamp) {
      if (!timestamp) return '--';
      const now = Date.now();
      const diff = now - timestamp;
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ago';
    }

    function getLogLevel(level) {
      if (level >= 50) return 'error';
      if (level >= 40) return 'warn';
      return 'info';
    }

    function formatExitReason(reason) {
      const labels = {
        profit_target: 'Profit',
        max_hold_time: 'Time Limit',
        stop_loss: 'Stop Loss',
        price_stop_loss: 'Price Stop',
        rwa_stop_loss: 'NAV Stop',
        balance_zero: 'Balance Zero',
        manual_close: 'Manual',
        kill_switch: 'Kill Switch',
      };
      if (labels[reason]) return labels[reason];
      if (!reason) return '--';
      // Fallback: convert snake_case to Title Case
      return reason.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }

    // Store chart data for hover interactions
    let pnlChartData = null;

    function showPnlChartSkeleton() {
      const container = document.getElementById('pnl-chart');
      const width = container.offsetWidth || 200;
      const height = 60;
      const paddingLeft = 35;
      const paddingRight = 5;
      const paddingTop = 5;
      const paddingBottom = 14;

      // Create a realistic-looking curve path (gentle upward trend with some variation)
      const chartWidth = width - paddingLeft - paddingRight;
      const chartHeight = height - paddingTop - paddingBottom;
      const midY = paddingTop + chartHeight * 0.5;
      const zeroY = paddingTop + chartHeight * 0.6;

      // Generate a smooth curve that looks like a PnL chart
      const points = [];
      const numPoints = 12;
      for (let i = 0; i < numPoints; i++) {
        const x = paddingLeft + (i / (numPoints - 1)) * chartWidth;
        // Create gentle wave pattern ending slightly up
        const progress = i / (numPoints - 1);
        const wave = Math.sin(progress * Math.PI * 2) * 0.15;
        const trend = progress * 0.3;
        const y = midY - (wave + trend) * chartHeight * 0.4;
        points.push({ x, y });
      }

      // Build cardinal spline path
      let pathD = 'M' + points[0].x + ',' + points[0].y;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const tension = 1;
        const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
        const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
        const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
        const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;
        pathD += ' C' + cp1x + ',' + cp1y + ' ' + cp2x + ',' + cp2y + ' ' + p2.x + ',' + p2.y;
      }

      const lastPoint = points[points.length - 1];

      container.innerHTML =
        '<div class="skeleton-pnl-chart">' +
        '<svg width="' + width + '" height="' + height + '" style="overflow: visible;">' +
        // Y-axis placeholder labels
        '<rect x="2" y="' + (paddingTop - 1) + '" width="28" height="8" rx="2" class="skeleton" style="animation: skeleton-shimmer 1.5s ease-in-out infinite;"/>' +
        '<rect x="8" y="' + (height - paddingBottom - 4) + '" width="22" height="8" rx="2" class="skeleton" style="animation: skeleton-shimmer 1.5s ease-in-out infinite;"/>' +
        // X-axis placeholder labels
        '<rect x="' + paddingLeft + '" y="' + (height - 10) + '" width="30" height="7" rx="2" class="skeleton" style="animation: skeleton-shimmer 1.5s ease-in-out infinite;"/>' +
        '<rect x="' + (width - paddingRight - 30) + '" y="' + (height - 10) + '" width="30" height="7" rx="2" class="skeleton" style="animation: skeleton-shimmer 1.5s ease-in-out infinite;"/>' +
        // Zero line
        '<line x1="' + paddingLeft + '" y1="' + zeroY + '" x2="' + (width - paddingRight) + '" y2="' + zeroY + '" class="skeleton-zero-line" stroke-width="1" stroke-dasharray="3,3"/>' +
        // Smooth curve
        '<path d="' + pathD + '" class="skeleton-curve"/>' +
        // End dot with pulse
        '<circle class="skeleton-dot-ring" cx="' + lastPoint.x + '" cy="' + lastPoint.y + '" r="4"/>' +
        '<circle class="skeleton-dot" cx="' + lastPoint.x + '" cy="' + lastPoint.y + '" r="3"/>' +
        '</svg>' +
        '</div>';
    }

    function renderPnlChart(history) {
      const container = document.getElementById('pnl-chart');
      if (!history || history.length < 2) {
        const w = container.offsetWidth || 200;
        container.innerHTML = '<svg width="' + w + '" height="60"><text x="' + (w/2) + '" y="34" text-anchor="middle" fill="var(--text-dim)" font-size="11">Not enough data</text></svg>';
        pnlChartData = null;
        return;
      }

      const width = container.offsetWidth || 200;
      const height = 60;
      const paddingLeft = 35;
      const paddingRight = 5;
      const paddingTop = 5;
      const paddingBottom = 14;

      // Get min/max values
      const values = history.map(h => h.cumulativePnl);
      const minVal = Math.min(0, ...values);
      const maxVal = Math.max(0, ...values);
      const range = maxVal - minVal || 1;

      // Scale functions
      const xScale = (i) => paddingLeft + (i / (history.length - 1)) * (width - paddingLeft - paddingRight);
      const yScale = (v) => height - paddingBottom - ((v - minVal) / range) * (height - paddingTop - paddingBottom);

      // Build smooth curve using cardinal spline
      function cardinalSpline(points, tension) {
        if (points.length < 2) return '';
        if (points.length === 2) return 'M' + points[0].x + ',' + points[0].y + ' L' + points[1].x + ',' + points[1].y;

        let path = 'M' + points[0].x + ',' + points[0].y;
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[Math.max(0, i - 1)];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[Math.min(points.length - 1, i + 2)];

          const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
          const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
          const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
          const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

          path += ' C' + cp1x + ',' + cp1y + ' ' + cp2x + ',' + cp2y + ' ' + p2.x + ',' + p2.y;
        }
        return path;
      }

      const points = history.map((h, i) => ({ x: xScale(i), y: yScale(h.cumulativePnl), pnl: h.cumulativePnl, timestamp: h.timestamp }));
      const pathD = cardinalSpline(points, 1);

      // Store for hover
      pnlChartData = { points, paddingLeft, width, paddingRight };

      // Zero line y position
      const zeroY = yScale(0);

      // Determine color based on final value
      const finalPnl = history[history.length - 1].cumulativePnl;
      const lineColor = finalPnl >= 0 ? 'var(--green)' : 'var(--red)';

      // Format time for x-axis labels - include date if data spans multiple days
      const firstTime = new Date(history[0].timestamp);
      const lastTime = new Date(history[history.length - 1].timestamp);
      const spansDays = firstTime.toDateString() !== lastTime.toDateString();
      const formatAxisTime = (d) => {
        const time = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        if (spansDays) {
          return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
        }
        return time;
      };

      // Y-axis labels
      const maxLabel = maxVal >= 0 ? '+$' + maxVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-$' + Math.abs(maxVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const minLabel = minVal >= 0 ? '+$' + minVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-$' + Math.abs(minVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      container.innerHTML =
        '<svg id="pnl-chart-svg" width="' + width + '" height="' + height + '" style="overflow: visible; cursor: crosshair;">' +
        // Y-axis labels
        '<text x="' + (paddingLeft - 3) + '" y="' + (paddingTop + 3) + '" text-anchor="end" fill="var(--text-dim)" font-size="8">' + maxLabel + '</text>' +
        '<text x="' + (paddingLeft - 3) + '" y="' + (height - paddingBottom) + '" text-anchor="end" fill="var(--text-dim)" font-size="8">' + minLabel + '</text>' +
        // X-axis labels
        '<text x="' + paddingLeft + '" y="' + (height - 3) + '" text-anchor="start" fill="var(--text-dim)" font-size="8">' + formatAxisTime(firstTime) + '</text>' +
        '<text x="' + (width - paddingRight) + '" y="' + (height - 3) + '" text-anchor="end" fill="var(--text-dim)" font-size="8">' + formatAxisTime(lastTime) + '</text>' +
        // Zero line
        '<line x1="' + paddingLeft + '" y1="' + zeroY + '" x2="' + (width - paddingRight) + '" y2="' + zeroY + '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3"/>' +
        // Smooth curve
        '<path d="' + pathD + '" fill="none" stroke="' + lineColor + '" stroke-width="2"/>' +
        // Current value dot
        '<circle class="live-dot-ring" cx="' + points[points.length - 1].x + '" cy="' + points[points.length - 1].y + '" r="4" fill="' + lineColor + '"/>' +
        '<circle class="live-dot-center" cx="' + points[points.length - 1].x + '" cy="' + points[points.length - 1].y + '" r="3" fill="' + lineColor + '"/>' +
        // Hover elements (hidden initially)
        '<circle id="pnl-hover-dot" cx="0" cy="0" r="4" fill="' + lineColor + '" style="display: none;"/>' +
        '<line id="pnl-hover-line" x1="0" y1="' + paddingTop + '" x2="0" y2="' + (height - paddingBottom) + '" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="2,2" style="display: none;"/>' +
        '</svg>' +
        '<div id="pnl-chart-tooltip" style="display: none; position: absolute; background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-size: 10px; pointer-events: none; z-index: 100; white-space: nowrap;"></div>';

      // Add hover event listeners
      const svg = document.getElementById('pnl-chart-svg');
      const tooltip = document.getElementById('pnl-chart-tooltip');
      const hoverDot = document.getElementById('pnl-hover-dot');
      const hoverLine = document.getElementById('pnl-hover-line');

      svg.addEventListener('mousemove', function(e) {
        if (!pnlChartData) return;
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        // Find closest point
        let closestPoint = null;
        let closestDist = Infinity;
        pnlChartData.points.forEach(p => {
          const dist = Math.abs(p.x - mouseX);
          if (dist < closestDist) {
            closestDist = dist;
            closestPoint = p;
          }
        });

        if (closestPoint && mouseX >= pnlChartData.paddingLeft && mouseX <= pnlChartData.width - pnlChartData.paddingRight) {
          const pnlLabel = closestPoint.pnl >= 0 ? '+$' + closestPoint.pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : '-$' + Math.abs(closestPoint.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
          const d = new Date(closestPoint.timestamp);
          const timeLabel = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const pnlColor = closestPoint.pnl >= 0 ? 'var(--green)' : 'var(--red)';

          tooltip.innerHTML = '<span style="color: ' + pnlColor + '; font-weight: bold;">' + pnlLabel + '</span><br><span style="color: var(--text-dim);">' + timeLabel + '</span>';
          tooltip.style.display = 'block';
          tooltip.style.left = (e.clientX - rect.left + 10) + 'px';
          tooltip.style.top = (e.clientY - rect.top - 30) + 'px';

          hoverDot.setAttribute('cx', closestPoint.x);
          hoverDot.setAttribute('cy', closestPoint.y);
          hoverDot.style.display = 'block';

          hoverLine.setAttribute('x1', closestPoint.x);
          hoverLine.setAttribute('x2', closestPoint.x);
          hoverLine.style.display = 'block';
        }
      });

      svg.addEventListener('mouseleave', function() {
        tooltip.style.display = 'none';
        hoverDot.style.display = 'none';
        hoverLine.style.display = 'none';
      });
    }

    // Track selected time range
    let selectedTimeRange = '12H';

    // Store logs for filtering
    let allLogs = [];
    let logSearchTerm = '';

    // Track previous watchlist prices for flash animations
    // Key: symbol, Value: { stockPrice, tokenPrice }
    let prevWatchlistPrices = {};

    function renderLogs() {
      const logsContainer = document.getElementById('logs');
      const searchTerm = logSearchTerm.toLowerCase();
      const filteredLogs = searchTerm
        ? allLogs.filter(log => {
            const component = (log.component || 'system').toLowerCase();
            const msg = (log.msg || '').toLowerCase();
            return component.includes(searchTerm) || msg.includes(searchTerm);
          })
        : allLogs;

      if (filteredLogs.length === 0) {
        logsContainer.innerHTML = '<div class="log-entry log-info" style="color: var(--text-dim);">' + (searchTerm ? 'No matching logs' : 'No logs available') + '</div>';
      } else {
        logsContainer.innerHTML = filteredLogs.map(log => {
          const level = getLogLevel(log.level);
          const time = new Date(log.time).toLocaleTimeString();
          const component = log.component || 'system';
          return '<div class="log-entry log-' + level + '">' +
            '<span class="log-time">' + time + '</span>' +
            '<span class="log-component">[' + component + ']</span>' +
            '<span>' + log.msg + '</span>' +
          '</div>';
        }).join('');
      }
    }

    async function fetchData() {
      try {
        const [dashRes, logsRes, notableLogsRes, walletRes] = await Promise.all([
          fetch('/api/dashboard?range=' + selectedTimeRange),
          fetch('/api/logs/file?lines=50'),
          fetch('/api/logs/file?lines=50&level=40'), // Fetch warnings/errors separately
          fetch('/api/wallet')
        ]);

        const data = await dashRes.json();
        const logs = await logsRes.json();
        const notableLogs = await notableLogsRes.json();
        const wallet = await walletRes.json();

        // Update market status with session type
        const modeEl = document.getElementById('mode');
        const session = data.marketStatus?.session || 'closed';
        const sessionLabels = {
          'pre-market': 'Pre-Market',
          'regular': 'Market Open',
          'post-market': 'Post-Market',
          'closed': 'Market Closed'
        };
        const sessionClasses = {
          'pre-market': 'pre-market',
          'regular': 'market-open',
          'post-market': 'post-market',
          'closed': 'market-closed'
        };
        document.getElementById('mode-text').textContent = sessionLabels[session] || 'Market Closed';
        modeEl.className = 'mode ' + (sessionClasses[session] || 'market-closed');

        // Kill switch
        document.getElementById('kill-switch-warning').style.display =
          data.risk.killSwitch ? 'block' : 'none';

        // Wallet balance (in header)
        if (wallet && wallet.totalUsd > 0) {
          document.getElementById('header-wallet-total').textContent = formatUsd(wallet.totalUsd);
          document.getElementById('header-wallet-breakdown').textContent =
            wallet.usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC | ' + wallet.sol.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + ' SOL';
        } else {
          document.getElementById('header-wallet-total').textContent = '--';
          document.getElementById('header-wallet-breakdown').textContent = 'Wallet not connected';
        }

        // Stats
        const pnlEl = document.getElementById('pnl');
        pnlEl.textContent = formatPnl(data.stats.totalPnlUsd);
        pnlEl.className = 'value ' + (data.stats.totalPnlUsd >= 0 ? 'positive' : 'negative');

        const returnPct = data.stats.returnPct || 0;
        document.getElementById('return-pct').textContent =
          (returnPct >= 0 ? '+' : '') + returnPct.toFixed(1) + '% return';

        // Render PnL chart
        renderPnlChart(data.pnlHistory);

        document.getElementById('trades').textContent = data.stats.totalTrades;
        document.getElementById('win-rate').textContent =
          data.stats.totalTrades > 0
            ? (data.stats.winRate * 100).toFixed(0) + '% win rate'
            : '-- win rate';

        document.getElementById('open-positions').textContent = data.openPositions.length;
        const totalInvested = data.openPositions.reduce((sum, p) => sum + (p.sizeUsd || 0), 0);
        document.getElementById('total-invested').textContent = totalInvested > 0 ? formatUsd(totalInvested) + ' invested' : '$0 invested';
        document.getElementById('largest-win').textContent = data.stats.largestWin > 0 ? formatPnl(data.stats.largestWin) : '--';
        document.getElementById('largest-loss').textContent = data.stats.largestLoss < 0 ? formatPnl(data.stats.largestLoss) : '--';

        // Largest win trade details
        const winDetailsEl = document.getElementById('largest-win-details');
        if (data.stats.largestWinTrade) {
          const t = data.stats.largestWinTrade;
          const dateStr = new Date(t.exitTimestamp).toLocaleDateString();
          const txLink = t.txSignature
            ? ' <a href="https://solscan.io/tx/' + t.txSignature + '" target="_blank" rel="noopener" style="color: var(--text-dim);">tx</a>'
            : '';
          winDetailsEl.innerHTML = t.ticker + ' · ' + dateStr + txLink;
        } else {
          winDetailsEl.textContent = '--';
        }

        // Largest loss trade details
        const lossDetailsEl = document.getElementById('largest-loss-details');
        if (data.stats.largestLossTrade) {
          const t = data.stats.largestLossTrade;
          const dateStr = new Date(t.exitTimestamp).toLocaleDateString();
          const txLink = t.txSignature
            ? ' <a href="https://solscan.io/tx/' + t.txSignature + '" target="_blank" rel="noopener" style="color: var(--text-dim);">tx</a>'
            : '';
          lossDetailsEl.innerHTML = t.ticker + ' · ' + dateStr + txLink;
        } else {
          lossDetailsEl.textContent = '--';
        }
        document.getElementById('daily-trades').textContent = data.risk.todayTrades;
        document.getElementById('avg-daily-trades').textContent =
          data.risk.avgDailyTrades.toFixed(1) + ' avg/day';

        // Stocks watched
        const totalTokens = data.tokens ? data.tokens.length : 0;
        const enabledTokens = data.tokens ? data.tokens.filter(t => t.enabled).length : 0;
        document.getElementById('stocks-watched').innerHTML = totalTokens + ' <a href="https://neglect.trade/index/stocks" target="_blank" rel="noopener" style="color: var(--purple); font-size: 12px; font-weight: normal;">View</a>';
        document.getElementById('stocks-watched-sub').innerHTML = '<span class="tooltip">' + enabledTokens + ' enabled<span class="tooltip-icon">?</span><span class="tooltip-text">Tokens must have sufficient liquidity and valid price feeds to be enabled for trading</span></span>';

        // Open positions table
        const openTable = document.getElementById('open-positions-table');
        if (data.openPositions.length === 0) {
          openTable.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-dim);">No open positions</td></tr>';
        } else {
          openTable.innerHTML = data.openPositions.map(p => {
            const isShort = p.type === 'short';
            const pnlClass = (p.unrealizedPnlUsd || 0) >= 0 ? 'positive' : 'negative';
            const pnlSign = (p.unrealizedPnlUsd || 0) >= 0 ? '+' : '';
            // Current discount: green if less than entry (spread narrowed = good) for longs
            // For shorts: green if premium decreased (currentDiscount < entryDiscount since both stored as positive via Math.abs)
            const currentClass = isShort
              ? (p.currentDiscount < p.entryDiscount ? 'positive' : 'negative')
              : (p.currentDiscount < p.entryDiscount ? 'positive' : 'negative');
            const solscanIcon = '<img src="https://solscan.io/favicon.ico" alt="Solscan" style="width: 14px; height: 14px; vertical-align: middle;">';
            const txLink = p.entryTxSignature
              ? '<a href="https://solscan.io/tx/' + p.entryTxSignature + '" target="_blank" rel="noopener">' + solscanIcon + '</a>'
              : '-';
            // Show exit threshold info - actual exit depends on live DEX quotes
            const exitThreshold = p.exitThresholdPct || 0;
            // Use token appreciation % for progress (matches how exit signal actually works)
            const tokenAppreciation = p.tokenAppreciationPct || 0;
            // Progress = how much of the exit threshold we've achieved (based on token price appreciation)
            // Note: rawProgress can exceed 100% - we track this to show "awaiting DEX quote" state
            const rawProgress = exitThreshold > 0 ? (tokenAppreciation / exitThreshold) * 100 : 0;
            const progressPct = Math.max(0, Math.min(100, rawProgress));

            // Check if trailing stop is active (juicing for extra profit)
            const isJuicing = p.trailingStopActive || false;
            const peakPct = p.trailingStopPeakPct || tokenAppreciation;

            // Color: purple when juicing, otherwise normal gradient
            let progressColor;
            if (isJuicing) {
              progressColor = 'var(--purple)'; // Purple when letting winner run
            } else if (rawProgress >= 100) {
              progressColor = 'var(--green)';
            } else if (rawProgress >= 85) {
              progressColor = 'var(--color-yellow-green)';
            } else if (rawProgress >= 60) {
              progressColor = 'var(--yellow)';
            } else {
              progressColor = 'var(--text-tertiary)';
            }

            // Show different text based on state
            let progressText;
            let gapText;
            if (isJuicing) {
              // Juicing: show current vs peak
              progressText = '+' + tokenAppreciation.toFixed(2) + '% (peak +' + peakPct.toFixed(2) + '%)';
              const pullback = peakPct - tokenAppreciation;
              gapText = 'DROP ' + pullback.toFixed(2) + '%';
            } else if (rawProgress >= 100) {
              progressText = tokenAppreciation.toFixed(2) + '% (getting quote)';
              gapText = 'GAP ' + (exitThreshold - tokenAppreciation).toFixed(2) + '%';
            } else {
              progressText = tokenAppreciation.toFixed(2) + '% / ' + exitThreshold.toFixed(2) + '%';
              gapText = 'GAP ' + (exitThreshold - tokenAppreciation).toFixed(2) + '%';
            }
            // Stock appreciation coloring
            // For longs: stock up = good (green), stock down = bad (red)
            // For shorts: stock down = good (green), stock up = bad (red)
            const stockAppreciation = p.stockAppreciationPct || 0;
            const stockIsGood = isShort ? stockAppreciation <= 0 : stockAppreciation >= 0;
            const stockClass = stockIsGood ? 'positive' : 'negative';
            const stockSign = stockAppreciation >= 0 ? '+' : '';
            // Type badge
            const typeBadge = isShort
              ? '<span style="color: var(--red); font-weight: 600;">Short</span>'
              : '<span style="color: var(--green); font-weight: 600;">Long</span>';
            // Token link - for shorts use rStock symbol display
            const tokenLink = isShort
              ? '<span class="ticker-link">' + p.symbol + '</span>'
              : '<a href="https://dexscreener.com/solana/' + p.mint + '" target="_blank" rel="noopener" class="ticker-link">' + p.symbol + '</a>';
            // Format entry/current % as absolute values (context from Long/Short badge is enough)
            const entryValue = Math.abs(p.entryDiscount);
            const currentValue = Math.abs(p.currentDiscount);
            return '<tr>' +
              '<td>' + typeBadge + '</td>' +
              '<td><a href="https://www.tradingview.com/chart/?symbol=' + p.ticker + '" target="_blank" rel="noopener" class="ticker-link">' + p.ticker + '</a> / ' + tokenLink + '</td>' +
              '<td><div class="progress-bar"><div class="progress-fill" style="width: ' + progressPct.toFixed(1) + '%; background: ' + progressColor + ';"></div></div><div class="progress-text" style="display: flex; justify-content: space-between; width: 100%;"><span>' + progressText + '</span><span class="gap-text" style="color: var(--text-dim);">' + gapText + '</span></div></td>' +
              '<td>' + entryValue.toFixed(2) + '%</td>' +
              '<td class="' + currentClass + '">' + currentValue.toFixed(2) + '%</td>' +
              '<td class="' + stockClass + '">' + stockSign + stockAppreciation.toFixed(2) + '%</td>' +
              '<td>' + formatUsd(p.sizeUsd) + '</td>' +
              '<td>' + (p.leverage || 1).toFixed(2) + 'x</td>' +
              '<td class="' + pnlClass + '">' + formatPnl(p.unrealizedPnlUsd || 0) + ' (' + pnlSign + (p.unrealizedPnlPct || 0).toFixed(2) + '%)</td>' +
              '<td>' + formatHoldTime(p.holdTimeMs) + '</td>' +
              '<td>' + txLink + '</td>' +
            '</tr>';
          }).join('');
        }

        // Update counts
        document.getElementById('open-positions-count').textContent = data.openPositions.length;
        document.getElementById('recent-trades-count').textContent = data.recentTrades.length;
        document.getElementById('watchlist-count').textContent = (data.watchlist || []).length;

        // Weekend warning for open shorts
        const weekendWarningEl = document.getElementById('weekend-warning');
        const hasOpenShorts = data.openPositions.some(p => p.type === 'short');
        if (hasOpenShorts && data.weekendWarning && data.weekendWarning.isWarning) {
          const isMobile = window.innerWidth <= 600;
          const msg = data.weekendWarning.message;
          // Shorten message on mobile
          let shortMsg = msg;
          if (msg.includes('Weekend - market closed')) {
            shortMsg = 'Weekend';
          } else if (msg.includes('Market closed - weekend gap')) {
            shortMsg = 'Closed';
          } else if (msg.includes('Friday close in')) {
            shortMsg = msg.match(/[\d.]+h/)?.[0] || msg;
          } else if (msg.includes('Friday afternoon')) {
            const hours = msg.match(/[\d.]+h/)?.[0] || '';
            shortMsg = hours ? hours + ' left' : msg;
          }
          weekendWarningEl.textContent = '⚠️ ' + (isMobile ? shortMsg : msg);
          weekendWarningEl.style.display = 'inline';
          weekendWarningEl.classList.add('visible');
        } else {
          weekendWarningEl.style.display = 'none';
          weekendWarningEl.classList.remove('visible');
        }

        // Watchlist table
        const watchlistSection = document.getElementById('watchlist-section');
        const watchlistTable = document.getElementById('watchlist-table');
        if (!data.watchlist || data.watchlist.length === 0) {
          watchlistSection.style.display = 'none';
        } else {
          watchlistSection.style.display = 'block';
          // Build new prices map for comparison
          const newWatchlistPrices = {};
          // Build set of mints that have open positions
          const openLongMints = new Set(data.openPositions.filter(p => p.type === 'long').map(p => p.mint));
          watchlistTable.innerHTML = data.watchlist.map(w => {
            // Check if there's already an open position for this token
            const hasOpenPosition = openLongMints.has(w.mint);
            // Discount is positive internally, but display as negative (token below stock)
            const discountClass = w.discount > 0 ? 'positive' : 'negative';
            const tvlFormatted = w.tvl >= 1000000 ? '$' + (w.tvl / 1000000).toFixed(2) + 'M' : '$' + (w.tvl / 1000).toFixed(0) + 'K';
            // Progress bar: current discount as % of entry threshold
            // 0% = no discount, 100% = at entry threshold (ready to trade)
            const rawProgress = w.entryThreshold > 0 ? (w.discount / w.entryThreshold) * 100 : 0;
            const progressPct = Math.max(0, Math.min(100, rawProgress));
            // Color gradient: gray -> yellow -> yellow-green -> green (purple if position open)
            let progressColor;
            if (hasOpenPosition) {
              progressColor = 'var(--purple)';
            } else if (rawProgress >= 100) {
              progressColor = 'var(--green)';
            } else if (rawProgress >= 85) {
              progressColor = 'var(--color-yellow-green)';
            } else if (rawProgress >= 60) {
              progressColor = 'var(--yellow)';
            } else {
              progressColor = 'var(--text-tertiary)';
            }
            // Show discount as positive (token trading below stock price = good for longs)
            let progressText;
            if (hasOpenPosition) {
              progressText = w.discount.toFixed(2) + '% (Position open)';
            } else if (rawProgress >= 100) {
              // Show rejection reason if available, otherwise "Ready to trade"
              const reason = w.rejectReason || 'Ready to trade';
              progressText = w.discount.toFixed(2) + '% (' + reason + ')';
            } else {
              progressText = w.discount.toFixed(2) + '% / ' + w.entryThreshold.toFixed(2) + '%';
            }
            const gapText = 'GAP ' + w.gap.toFixed(2) + '%';

            // Check for price changes and determine flash classes
            const prev = prevWatchlistPrices[w.symbol];
            let stockFlash = '';
            let tokenFlash = '';
            if (prev) {
              if (w.stockPrice > prev.stockPrice) stockFlash = ' flash-up';
              else if (w.stockPrice < prev.stockPrice) stockFlash = ' flash-down';
              if (w.tokenPrice > prev.tokenPrice) tokenFlash = ' flash-up';
              else if (w.tokenPrice < prev.tokenPrice) tokenFlash = ' flash-down';
            }
            // Store current prices for next comparison
            newWatchlistPrices[w.symbol] = { stockPrice: w.stockPrice, tokenPrice: w.tokenPrice };

            // Calculate time since last update for stock and token separately
            const now = Date.now();
            const stockAgeSec = Math.floor((now - (w.stockTimestamp || now)) / 1000);
            const tokenAgeSec = Math.floor((now - (w.tokenTimestamp || now)) / 1000);
            const formatAge = (sec) => {
              const mins = Math.floor(sec / 60);
              const hrs = Math.floor(mins / 60);
              if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
              if (mins > 0) return mins + 'm ' + (sec % 60) + 's';
              return sec + 's';
            };
            const getAgeClass = (sec) => sec > 300 ? 'very-stale' : (sec > 60 ? 'stale' : '');
            const stockAgeClass = getAgeClass(stockAgeSec);
            const tokenAgeClass = getAgeClass(tokenAgeSec);

            // Apply strikethrough style if position is open
            const strikeStyle = hasOpenPosition ? 'text-decoration: line-through; opacity: 0.6;' : '';
            return '<tr>' +
              '<td style="' + strikeStyle + '"><a href="https://www.tradingview.com/chart/?symbol=' + w.ticker + '" target="_blank" rel="noopener" class="ticker-link">' + w.ticker + '</a> / <a href="https://dexscreener.com/solana/' + w.mint + '" target="_blank" rel="noopener" class="ticker-link">' + w.symbol + '</a></td>' +
              '<td style="' + strikeStyle + '"><div class="progress-bar"><div class="progress-fill" style="width: ' + progressPct.toFixed(1) + '%; background: ' + progressColor + ';"></div></div><div class="progress-text" style="display: flex; justify-content: space-between; width: 100%;"><span>' + progressText + '</span><span class="gap-text" style="color: var(--text-dim);">' + gapText + '</span></div></td>' +
              '<td style="' + strikeStyle + '" class="' + discountClass + '">' + w.discount.toFixed(2) + '%</td>' +
              '<td style="' + strikeStyle + '">' + w.entryThreshold.toFixed(2) + '%</td>' +
              '<td style="' + strikeStyle + '"><span class="' + stockFlash.trim() + '">$' + w.stockPrice.toFixed(2) + '</span> / <span class="' + tokenFlash.trim() + '">$' + w.tokenPrice.toFixed(2) + '</span></td>' +
              '<td style="' + strikeStyle + '"><span class="stock-age ' + stockAgeClass + '" data-stock-timestamp="' + (w.stockTimestamp || now) + '">' + formatAge(stockAgeSec) + '</span> / <span class="token-age ' + tokenAgeClass + '" data-token-timestamp="' + (w.tokenTimestamp || now) + '">' + formatAge(tokenAgeSec) + '</span></td>' +
              '<td style="' + strikeStyle + '">' + tvlFormatted + '</td>' +
            '</tr>';
          }).join('');
          // Update previous prices for next fetch
          prevWatchlistPrices = newWatchlistPrices;
        }

        // Premium (Short) Watchlist table
        const premiumWatchlistSection = document.getElementById('premium-watchlist-section');
        const premiumWatchlistTable = document.getElementById('premium-watchlist-table');
        const marketClosedBadge = document.getElementById('equity-market-closed-badge');
        const isMarketClosed = !data.equityMarketOpen;
        const isHoliday = data.holidayStatus && data.holidayStatus.isHoliday;
        const isFullDayHoliday = isHoliday && !data.holidayStatus.isEarlyClose;
        const shouldGrayOut = isMarketClosed || isFullDayHoliday;
        document.getElementById('premium-watchlist-count').textContent = (data.premiumWatchlist || []).length;

        // Show/hide market closed or holiday badge
        if (marketClosedBadge) {
          if (isMarketClosed || isHoliday) {
            const isMobile = window.innerWidth <= 600;
            let badgeText = '';
            if (isHoliday) {
              if (isMobile) {
                badgeText = isFullDayHoliday ? '⚠️ Holiday' : '⚠️ Early Close';
              } else {
                if (isFullDayHoliday) {
                  badgeText = '⚠️ ' + data.holidayStatus.eventName;
                } else {
                  badgeText = '⚠️ Early Close: ' + (data.holidayStatus.tradingHours || data.holidayStatus.eventName);
                }
              }
            } else if (isMarketClosed) {
              if (isMobile) {
                badgeText = '⚠️ Closed';
              } else {
                const timeText = data.timeUntilMarketOpen || '';
                const separator = timeText ? ' - ' : '';
                badgeText = '⚠️ Market Closed' + separator + timeText;
              }
            }
            marketClosedBadge.textContent = badgeText;
            marketClosedBadge.style.display = 'inline';
          } else {
            marketClosedBadge.style.display = 'none';
          }
        }

        if (!data.shortingEnabled || !data.premiumWatchlist || data.premiumWatchlist.length === 0) {
          premiumWatchlistSection.style.display = 'none';
        } else {
          premiumWatchlistSection.style.display = 'block';
          // Apply grayed out style when market is closed or full-day holiday
          const tableWrapper = premiumWatchlistSection.querySelector('.table-wrapper');
          if (tableWrapper) {
            tableWrapper.style.opacity = shouldGrayOut ? '0.5' : '1';
            tableWrapper.style.filter = shouldGrayOut ? 'grayscale(50%)' : 'none';
          }
          // Build set of tickers that have open short positions
          const openShortTickers = new Set(data.openPositions.filter(p => p.type === 'short').map(p => p.ticker));
          premiumWatchlistTable.innerHTML = data.premiumWatchlist.map(w => {
            // Check if there's already an open short position for this ticker
            const hasOpenPosition = openShortTickers.has(w.ticker);
            const premiumClass = 'positive'; // Premium > 0 is good for shorts (green)
            // Progress bar: current premium as % of entry threshold
            const rawProgress = w.entryThreshold > 0 ? (w.premiumPct / w.entryThreshold) * 100 : 0;
            const progressPct = Math.max(0, Math.min(100, rawProgress));
            // Color gradient: gray -> yellow -> yellow-green -> green (purple if position open)
            let progressColor;
            if (hasOpenPosition) {
              progressColor = 'var(--purple)';
            } else if (rawProgress >= 100) {
              progressColor = 'var(--green)';
            } else if (rawProgress >= 85) {
              progressColor = 'var(--color-yellow-green)';
            } else if (rawProgress >= 60) {
              progressColor = 'var(--yellow)';
            } else {
              progressColor = 'var(--text-tertiary)';
            }
            let progressText;
            if (hasOpenPosition) {
              progressText = w.premiumPct.toFixed(2) + '% (position open)';
            } else if (rawProgress >= 100) {
              progressText = w.premiumPct.toFixed(2) + '% (ready to short)';
            } else {
              progressText = w.premiumPct.toFixed(2) + '% / ' + w.entryThreshold.toFixed(2) + '%';
            }
            const gapText = 'GAP ' + w.gap.toFixed(2) + '%';
            // Calculate time since prices last CHANGED (S / T format like long watchlist)
            const now = Date.now();
            const stockAgeSec = Math.floor((now - (w.stockTimestamp || now)) / 1000);
            const tokenAgeSec = Math.floor((now - (w.tokenTimestamp || now)) / 1000);
            const formatAge = (sec) => {
              const mins = Math.floor(sec / 60);
              const hrs = Math.floor(mins / 60);
              if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
              if (mins > 0) return mins + 'm ' + (sec % 60) + 's';
              return sec + 's';
            };
            const getAgeClass = (sec) => sec > 300 ? 'very-stale' : (sec > 60 ? 'stale' : '');
            const stockAgeClass = getAgeClass(stockAgeSec);
            const tokenAgeClass = getAgeClass(tokenAgeSec);
            // Apply strikethrough style if position is open
            const strikeStyle = hasOpenPosition ? 'text-decoration: line-through; opacity: 0.6;' : '';
            return '<tr>' +
              '<td style="' + strikeStyle + '"><a href="https://www.tradingview.com/chart/?symbol=' + w.ticker + '" target="_blank" rel="noopener" class="ticker-link">' + w.ticker + '</a> / <a href="https://dexscreener.com/solana/' + w.mint + '" target="_blank" rel="noopener" class="ticker-link">' + w.symbol + '</a></td>' +
              '<td style="' + strikeStyle + '"><div class="progress-bar"><div class="progress-fill" style="width: ' + progressPct.toFixed(1) + '%; background: ' + progressColor + ';"></div></div><div class="progress-text" style="display: flex; justify-content: space-between; width: 100%;"><span>' + progressText + '</span><span class="gap-text" style="color: var(--text-dim);">' + gapText + '</span></div></td>' +
              '<td style="' + strikeStyle + '" class="' + premiumClass + '">' + w.premiumPct.toFixed(2) + '%</td>' +
              '<td style="' + strikeStyle + '">' + w.entryThreshold.toFixed(2) + '%</td>' +
              '<td style="' + strikeStyle + '">$' + w.stockPrice.toFixed(2) + ' / $' + w.tokenPrice.toFixed(2) + '</td>' +
              '<td style="' + strikeStyle + '">' + (w.leverage || 1).toFixed(2) + 'x</td>' +
              '<td style="' + strikeStyle + '"><span class="stock-age ' + stockAgeClass + '" data-stock-timestamp="' + (w.stockTimestamp || now) + '">' + formatAge(stockAgeSec) + '</span> / <span class="token-age ' + tokenAgeClass + '" data-token-timestamp="' + (w.tokenTimestamp || now) + '">' + formatAge(tokenAgeSec) + '</span></td>' +
            '</tr>';
          }).join('');
        }

        // Recent trades table
        const tradesTable = document.getElementById('recent-trades-table');
        if (data.recentTrades.length === 0) {
          tradesTable.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-dim);">No recent trades</td></tr>';
        } else {
          tradesTable.innerHTML = data.recentTrades.map(t => {
            const pnlClass = (t.pnlUsd || 0) >= 0 ? 'positive' : 'negative';
            const isShort = t.type === 'short';
            // For longs: exit discount < entry = good (spread narrowed)
            // For shorts: exit premium < entry = good (premium collapsed)
            const exitClass = (t.exitDiscount || 0) < t.entryDiscount ? 'positive' : 'negative';
            // Show both open and close tx links with Solscan logo and timeago
            const solscanIcon = '<img src="https://solscan.io/favicon.ico" alt="Solscan" style="width: 14px; height: 14px; vertical-align: middle;">';
            const openTimeAgo = t.entryTimestamp ? formatTimeSince(t.entryTimestamp) : '';
            const closeTimeAgo = t.exitTimestamp ? formatTimeSince(t.exitTimestamp) : '';
            const openTxLink = t.entryTxSignature
              ? '<a href="https://solscan.io/tx/' + t.entryTxSignature + '" target="_blank" rel="noopener" style="color: var(--text-dim); text-decoration: none;">' + solscanIcon + ' ' + openTimeAgo + '</a>'
              : '-';
            const closeTxLink = t.exitTxSignature
              ? '<a href="https://solscan.io/tx/' + t.exitTxSignature + '" target="_blank" rel="noopener" style="color: var(--text-dim); text-decoration: none;">' + solscanIcon + ' ' + closeTimeAgo + '</a>'
              : '-';
            const txLink = openTxLink + ' / ' + closeTxLink;
            // Type badge: green for long, red for short
            const typeColor = isShort ? 'var(--red)' : 'var(--green)';
            const typeLabel = isShort ? 'Short' : 'Long';
            // Token link: for shorts, just show rStock symbol (no dexscreener link)
            const tokenLink = isShort
              ? '<span class="ticker-link">' + t.symbol + '</span>'
              : '<a href="https://dexscreener.com/solana/' + t.mint + '" target="_blank" rel="noopener" class="ticker-link">' + t.symbol + '</a>';
            // Show signed values: positive = discount, negative = premium
            const entryValue = t.entryDiscount;
            const exitValue = t.exitDiscount || 0;
            return '<tr>' +
              '<td style="color: ' + typeColor + '; font-weight: 500;">' + typeLabel + '</td>' +
              '<td><a href="https://www.tradingview.com/chart/?symbol=' + t.ticker + '" target="_blank" rel="noopener" class="ticker-link">' + t.ticker + '</a> / ' + tokenLink + '</td>' +
              '<td>' + entryValue.toFixed(2) + '%</td>' +
              '<td class="' + exitClass + '">' + exitValue.toFixed(2) + '%</td>' +
              '<td>' + formatUsd(t.sizeUsd || 0) + ' / <span class="' + pnlClass + '">' + formatPnl(t.pnlUsd || 0) + '</span></td>' +
              '<td>' + (t.leverage || 1).toFixed(2) + 'x</td>' +
              '<td>' + formatExitReason(t.exitReason) + '</td>' +
              '<td>' + formatHoldTime(t.holdTimeMs) + '</td>' +
              '<td>' + txLink + '</td>' +
            '</tr>';
          }).join('');
        }

        // Logs
        allLogs = logs;
        renderLogs();

        // Notable Logs (errors and warnings only) - fetched separately to ensure visibility
        const notableLogsContainer = document.getElementById('notable-logs');
        if (notableLogs.length === 0) {
          notableLogsContainer.innerHTML = '<div class="log-entry log-info" style="color: var(--text-dim);">No errors or warnings</div>';
        } else {
          notableLogsContainer.innerHTML = notableLogs.map(log => {
            const level = getLogLevel(log.level);
            const time = new Date(log.time).toLocaleTimeString();
            const component = log.component || 'system';
            // Build context string from relevant fields
            let context = '';
            if (log.token) context += ' [' + log.token + ']';
            else if (log.ticker) context += ' [' + log.ticker + ']';
            if (log.discount) context += ' discount=' + log.discount + '%';
            return '<div class="log-entry log-' + level + '">' +
              '<span class="log-time">' + time + '</span>' +
              '<span class="log-component">[' + component + ']</span>' +
              '<span>' + log.msg + context + '</span>' +
            '</div>';
          }).join('');
        }

        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
      } catch (error) {
        console.error('Failed to fetch data:', error);
      }
    }

    // Update watchlist age timers every second
    function updateWatchlistTimers() {
      const now = Date.now();
      const formatAge = (sec) => {
              const mins = Math.floor(sec / 60);
              const hrs = Math.floor(mins / 60);
              if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
              if (mins > 0) return mins + 'm ' + (sec % 60) + 's';
              return sec + 's';
            };

      // Helper to get age class: white < 60s, yellow 60s-5m, red > 5m
      const getAgeClass = (ageSec) => ageSec > 300 ? ' very-stale' : (ageSec > 60 ? ' stale' : '');

      // Update stock age spans
      document.querySelectorAll('#watchlist-table .stock-age').forEach(span => {
        const timestamp = parseInt(span.getAttribute('data-stock-timestamp'), 10);
        const ageSec = Math.floor((now - timestamp) / 1000);
        span.textContent = formatAge(ageSec);
        span.className = 'stock-age' + getAgeClass(ageSec);
      });

      // Update token age spans
      document.querySelectorAll('#watchlist-table .token-age').forEach(span => {
        const timestamp = parseInt(span.getAttribute('data-token-timestamp'), 10);
        const ageSec = Math.floor((now - timestamp) / 1000);
        span.textContent = formatAge(ageSec);
        span.className = 'token-age' + getAgeClass(ageSec);
      });
    }

    // Initial fetch
    fetchData();

    // Auto-refresh every 10 seconds (Supabase queries can be slow)
    setInterval(fetchData, 10000);

    // Update timers every second
    setInterval(updateWatchlistTimers, 1000);

    // Trades tab variables (must be before loadTradesContent call)
    let tradesOffset = 0;
    const TRADES_PAGE_SIZE = 50;

    // Load content for active tab on page load
    const activeBlogTab = document.querySelector('#tab-blog.active');
    if (activeBlogTab && !window.blogLoaded) {
      loadBlogContent();
    }
    const activeChangelogTab = document.querySelector('#tab-changelog.active');
    if (activeChangelogTab && !window.changelogLoaded) {
      loadChangelogContent();
    }
    const activeTradesTab = document.querySelector('#tab-trades.active');
    if (activeTradesTab && !window.tradesLoaded) {
      loadTradesContent();
    }
    // Time range selection
    document.querySelectorAll('.time-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = btn.getAttribute('data-range');
        selectedTimeRange = range;

        // Update button styles
        document.querySelectorAll('.time-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Show skeleton while loading
        showPnlChartSkeleton();

        // Fetch new data immediately
        fetchData();
      });
    });

    // Tab navigation is now handled by links - no click handler needed

    // Heatmap data storage
    let heatmapData = null;
    let heatmapTooltip = null;
    const isMobile = window.innerWidth <= 600;

    // Load and render discount heatmap
    async function loadHeatmapContent(range) {
      range = range || '24h';
      const container = document.getElementById('discount-heatmap');

      // Calculate skeleton columns based on range to match actual data
      let skeletonCols;
      switch (range) {
        case '1h':
          skeletonCols = isMobile ? 12 : 30;  // 5min or 2min buckets
          break;
        case '4h':
          skeletonCols = isMobile ? 16 : 48;  // 15min or 5min buckets
          break;
        case '24h':
          skeletonCols = 24;  // Hourly buckets
          break;
        case '7d':
          skeletonCols = isMobile ? 42 : 168;  // Hourly buckets (7*24)
          break;
        default:
          skeletonCols = 24;
      }

      const labelWidth = isMobile ? '40px' : '50px';
      // Generate skeleton cells with random colors to mimic the real heatmap appearance
      const skeletonColors = ['neutral', 'neutral', 'neutral', 'red-light', 'red', 'green-light', 'green'];
      const getRandomColor = () => skeletonColors[Math.floor(Math.random() * skeletonColors.length)];
      const skeletonCells = Array(ENABLED_TOKEN_COUNT).fill(0).map(() =>
        '<div class="skeleton skeleton-heatmap-label"></div>' +
        Array(skeletonCols).fill(0).map(() => '<div class="skeleton skeleton-heatmap-cell" data-color="' + getRandomColor() + '"></div>').join('')
      ).join('');
      container.innerHTML = '<div class="skeleton-heatmap-loader"><div class="skeleton-heatmap-grid" style="grid-template-columns: ' + labelWidth + ' repeat(' + skeletonCols + ', 1fr);">' + skeletonCells + '</div></div>';

      try {
        const mobileParam = isMobile ? '&mobile=true' : '';
        const res = await fetch('/api/heatmap?range=' + range + mobileParam);
        heatmapData = await res.json();

        if (!heatmapData.symbols || heatmapData.symbols.length === 0 || !heatmapData.timestamps || heatmapData.timestamps.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 40px;">No heatmap data available. Need more discount history.</div>';
          return;
        }

        // Update time range display
        const startTime = new Date(heatmapData.timestamps[0]);
        const endTime = new Date(heatmapData.timestamps[heatmapData.timestamps.length - 1]);
        document.getElementById('heatmap-time-range').textContent =
          startTime.toLocaleDateString() + ' ' + startTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) +
          ' - ' + endTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) +
          ' (' + heatmapData.timestamps.length + ' periods)';

        renderDiscountHeatmap(heatmapData);
        window.heatmapLoaded = true;
      } catch (error) {
        console.error('Failed to load heatmap:', error);
        container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 40px;">Failed to load heatmap data</div>';
      }
    }

    // Render discount heatmap (time-based)
    function renderDiscountHeatmap(data) {
      const container = document.getElementById('discount-heatmap');
      const numSymbols = data.symbols.length;
      const numTimes = data.timestamps.length;

      // Create tooltip if not exists
      if (!heatmapTooltip) {
        heatmapTooltip = document.createElement('div');
        heatmapTooltip.className = 'heatmap-tooltip';
        heatmapTooltip.style.display = 'none';
        document.body.appendChild(heatmapTooltip);
      }

      // Build holiday lookup set (date strings in YYYY-MM-DD format)
      const holidayMap = new Map();
      (data.holidays || []).forEach(h => {
        holidayMap.set(h.date, h);
      });

      // Helper to get market session for a timestamp
      // Returns: 'regular', 'pre-market', 'post-market', 'closed', or 'holiday'
      function getMarketSession(timestamp) {
        const date = new Date(timestamp);

        // Get ET date string for holiday lookup
        const etDateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format
        const holiday = holidayMap.get(etDateStr);

        // Check if it's a full-day holiday
        if (holiday && !holiday.isEarlyClose) {
          return { session: 'holiday', holiday: holiday.name };
        }

        // Get day of week in ET
        const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const dayOfWeek = etDate.getDay();

        // Weekend check (0 = Sunday, 6 = Saturday)
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          return { session: 'closed', holiday: null };
        }

        // Get time in ET
        const etTime = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
        const [hours, minutes] = etTime.split(':').map(Number);
        const totalMinutes = hours * 60 + minutes;

        // Time boundaries in minutes from midnight
        const preMarketOpen = 4 * 60;      // 4:00 AM
        const regularOpen = 9 * 60 + 30;   // 9:30 AM
        const regularClose = 16 * 60;       // 4:00 PM
        const postMarketClose = 20 * 60;   // 8:00 PM

        // Check for early close holidays
        let effectiveClose = regularClose;
        if (holiday && holiday.isEarlyClose && holiday.tradingHours) {
          // Parse trading hours like "9:30-13:00"
          const match = holiday.tradingHours.match(/(\\d+):(\\d+)-(\\d+):(\\d+)/);
          if (match) {
            effectiveClose = parseInt(match[3]) * 60 + parseInt(match[4]);
          }
        }

        // Determine session
        if (totalMinutes >= preMarketOpen && totalMinutes < regularOpen) {
          return { session: 'pre-market', holiday: holiday ? holiday.name : null };
        } else if (totalMinutes >= regularOpen && totalMinutes < effectiveClose) {
          return { session: 'regular', holiday: holiday ? holiday.name : null };
        } else if (totalMinutes >= effectiveClose && totalMinutes < postMarketClose && !holiday) {
          return { session: 'post-market', holiday: null };
        } else if (holiday && totalMinutes >= effectiveClose) {
          return { session: 'holiday', holiday: holiday.name + ' (Early Close)' };
        } else {
          return { session: 'closed', holiday: null };
        }
      }

      // Session brightness - dimming based on market status (keeps colors saturated)
      function getSessionStyle(session) {
        switch (session) {
          case 'regular': return { brightness: 1 };
          case 'pre-market': return { brightness: 0.8 };
          case 'post-market': return { brightness: 0.7 };
          case 'holiday': return { brightness: 0.6 };
          case 'closed': return { brightness: 0.65 };
          default: return { brightness: 0.65 };
        }
      }

      // Build grid HTML - use 1fr for flexible full-width cells
      let html = '<div class="discount-heatmap-grid" style="grid-template-columns: 50px repeat(' + numTimes + ', 1fr);">';

      // Each row is a symbol
      for (let i = 0; i < numSymbols; i++) {
        const symbol = data.symbols[i];

        // Row label - show full token symbol
        html += '<div class="heatmap-row-label">' + symbol + '</div>';

        // Data cells for this symbol
        for (let j = 0; j < numTimes; j++) {
          const spread = data.data[i][j];
          const color = spread !== null ? getSpreadColor(spread) : 'var(--bg)';
          const timestamp = data.timestamps[j];
          const { session, holiday } = getMarketSession(timestamp);
          const style = getSessionStyle(session);

          html += '<div class="heatmap-cell" style="background: ' + color + '; filter: brightness(' + style.brightness + ');" ' +
            'data-symbol="' + symbol + '" data-time="' + timestamp + '" data-spread="' + (spread !== null ? spread.toFixed(2) : 'N/A') + '" data-session="' + session + '" data-holiday="' + (holiday || '') + '">' +
            '</div>';
        }
      }

      html += '</div>';
      container.innerHTML = html;

      // Session label formatting
      function formatSessionLabel(session, holiday) {
        switch (session) {
          case 'regular': return '<span style="color: var(--green);">Regular Hours</span>';
          case 'pre-market': return '<span style="color: var(--yellow);">Pre-Market</span>';
          case 'post-market': return '<span style="color: #f97316;">Post-Market</span>';
          case 'holiday': return '<span style="color: #ef4444;">Holiday' + (holiday ? ': ' + holiday : '') + '</span>';
          case 'closed': return '<span style="color: var(--text-dim);">Closed</span>';
          default: return '<span style="color: var(--text-dim);">Unknown</span>';
        }
      }

      // Add hover handlers for tooltip
      container.querySelectorAll('.heatmap-cell').forEach(cell => {
        cell.addEventListener('mouseenter', (e) => {
          const symbol = cell.getAttribute('data-symbol');
          const time = parseInt(cell.getAttribute('data-time'));
          const spread = cell.getAttribute('data-spread');
          const session = cell.getAttribute('data-session');
          const holiday = cell.getAttribute('data-holiday');
          const timeStr = new Date(time).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit'});

          const spreadVal = parseFloat(spread);
          const spreadLabel = isNaN(spreadVal) ? spread : (spreadVal < 0 ? 'Premium: ' + Math.abs(spreadVal).toFixed(2) + '%' : 'Discount: ' + spreadVal.toFixed(2) + '%');
          const sessionLabel = formatSessionLabel(session, holiday);

          heatmapTooltip.innerHTML =
            '<div><span class="heatmap-tooltip-symbol">' + symbol + '</span><span class="heatmap-tooltip-time">' + timeStr + '</span></div>' +
            '<div class="heatmap-tooltip-discount">' + spreadLabel + '</div>' +
            '<div style="font-size: 10px; margin-top: 2px;">' + sessionLabel + '</div>';
          heatmapTooltip.style.display = 'block';
          heatmapTooltip.style.left = (e.clientX + 10) + 'px';
          heatmapTooltip.style.top = (e.clientY + 10) + 'px';
        });

        cell.addEventListener('mousemove', (e) => {
          heatmapTooltip.style.left = (e.clientX + 10) + 'px';
          heatmapTooltip.style.top = (e.clientY + 10) + 'px';
        });

        cell.addEventListener('mouseleave', () => {
          heatmapTooltip.style.display = 'none';
        });
      });
    }

    // Get color for spread value (negative = premium/green, positive = discount/red)
    // Uses same colors as rest of app: --green (#22c55e) and --red (#ef4444)
    function getSpreadColor(spread) {
      // Clamp to reasonable range: -4% to +4% for more saturated colors
      spread = Math.max(-4, Math.min(4, spread));

      if (spread < 0) {
        // Premium (negative): dark -> green (#22c55e = rgb 34, 197, 94)
        const intensity = Math.abs(spread) / 4;
        const r = Math.round(26 * (1 - intensity) + 34 * intensity);
        const g = Math.round(26 * (1 - intensity) + 197 * intensity);
        const b = Math.round(46 * (1 - intensity) + 94 * intensity);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      } else {
        // Discount (positive): dark -> red (#ef4444 = rgb 239, 68, 68)
        const intensity = spread / 4;
        const r = Math.round(26 * (1 - intensity) + 239 * intensity);
        const g = Math.round(26 * (1 - intensity) + 68 * intensity);
        const b = Math.round(46 * (1 - intensity) + 68 * intensity);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      }
    }

    // Heatmap range buttons
    document.querySelectorAll('.heatmap-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.heatmap-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const range = btn.getAttribute('data-range');
        window.heatmapLoaded = false;
        loadHeatmapContent(range);
      });
    });

    // Load and render blog content
    async function loadBlogContent() {
      try {
        const res = await fetch('/api/blog');
        const data = await res.json();
        document.getElementById('blog-content').innerHTML = data.html;
        window.blogLoaded = true;
      } catch (error) {
        document.getElementById('blog-content').innerHTML = '<p>Failed to load blog content.</p>';
      }
    }

    // Load and render changelog content from GitHub
    async function loadChangelogContent() {
      const container = document.getElementById('changelog-content');
      try {
        const res = await fetch('/api/commits');
        const data = await res.json();

        if (!data.commits || data.commits.length === 0) {
          container.innerHTML = '<div class="changelog-error">No commits found</div>';
          return;
        }

        // Format date for display
        function formatCommitDate(dateStr) {
          const date = new Date(dateStr);
          const now = new Date();
          const diffMs = now - date;
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

          let relativeTime;
          if (diffHours < 1) {
            const diffMins = Math.floor(diffMs / (1000 * 60));
            relativeTime = diffMins + ' min ago';
          } else if (diffHours < 24) {
            relativeTime = diffHours + ' hour' + (diffHours !== 1 ? 's' : '') + ' ago';
          } else if (diffDays < 7) {
            relativeTime = diffDays + ' day' + (diffDays !== 1 ? 's' : '') + ' ago';
          } else {
            relativeTime = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          }

          return relativeTime;
        }

        // Group commits by date
        const html = '<div class="changelog-timeline">' +
          data.commits.map((commit, index) => {
            // Custom avatar for Parallax (the agent)
            const isParallax = commit.author.login === 'Parallax' || commit.author.name === 'Parallax';
            const authorHtml = isParallax
              ? '<img src="/public/parallax-avatar.png" alt="Parallax" style="width:24px;height:24px;border-radius:50%;">' +
                '<span>Parallax</span>'
              : commit.author.avatar
                ? '<img src="' + commit.author.avatar + '&s=32" alt="' + commit.author.login + '">' +
                  '<span>' + commit.author.login + '</span>'
                : '<span>' + commit.author.login + '</span>';

            return '<div class="changelog-item">' +
              '<div class="changelog-dot"></div>' +
              '<div class="changelog-date">' +
                formatCommitDate(commit.date) +
              '</div>' +
              '<div class="changelog-message">' + escapeHtml(commit.message) + '</div>' +
              '<div class="changelog-author">' + authorHtml + '</div>' +
            '</div>';
          }).join('') +
        '</div>';

        container.innerHTML = html;
        window.changelogLoaded = true;
      } catch (error) {
        console.error('Failed to load changelog:', error);
        container.innerHTML = '<div class="changelog-error">Failed to load commits from GitHub</div>';
      }
    }

    // ================================================================
    // TRADES TAB
    // ================================================================

    async function loadTradesContent() {
      try {
        // Load analytics and trades in parallel
        const [analyticsRes, tradesRes] = await Promise.all([
          fetch('/api/analytics'),
          fetch('/api/trades?limit=' + TRADES_PAGE_SIZE)
        ]);
        const analytics = await analyticsRes.json();
        const trades = await tradesRes.json();

        renderAnalyticsCards(analytics);
        renderTokenPerformance(analytics);
        renderTradesTable(trades, false);
        tradesOffset = trades.length;
        if (trades.length >= TRADES_PAGE_SIZE) {
          document.getElementById('trades-load-more').style.display = 'block';
        }
        window.tradesLoaded = true;
      } catch (err) {
        console.error('Failed to load trades:', err);
      }
    }

    function renderAnalyticsCards(a) {
      if (!a || !a.summary) return;
      const s = a.summary;
      const exitReasons = a.exitReasons || {};
      const cards = document.getElementById('trades-analytics');
      cards.innerHTML = [
        makeCard('Total Trades', s.totalTrades, ''),
        makeCard('Win Rate', (s.winRate * 100).toFixed(1) + '%', s.winRate > 0.3 ? 'green' : s.winRate > 0.2 ? '' : 'red'),
        makeCard('Net PnL', '$' + s.avgPnl.toFixed(4) + '/trade', s.avgPnl > 0 ? 'green' : 'red'),
        makeCard('Avg Hold', s.avgHoldTimeMin.toFixed(1) + ' min', ''),
        makeCard('Profit Factor', s.profitFactor ? s.profitFactor.toFixed(2) : 'N/A', s.profitFactor > 1 ? 'green' : 'red'),
      ].join('');
      document.getElementById('trades-analytics-summary').textContent =
        'Exit reasons: ' + Object.entries(exitReasons).map(([k,v]) => k + ': ' + v).join(', ');
    }

    function makeCard(label, value, color) {
      const colorClass = color === 'green' ? 'text-positive' : color === 'red' ? 'text-negative' : '';
      return '<div class="analytics-card">' +
        '<div class="label">' + label + '</div>' +
        '<div class="value ' + colorClass + '">' + value + '</div>' +
      '</div>';
    }

    function renderTokenPerformance(a) {
      if (!a || !a.byToken) return;
      const container = document.getElementById('token-performance');
      const tokens = Object.entries(a.byToken).sort((x, y) => y[1].totalPnl - x[1].totalPnl);
      if (tokens.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary);">No token data yet</p>';
        return;
      }
      let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-2);">';
      for (const [token, data] of tokens) {
        const pnlColor = data.totalPnl > 0 ? 'var(--color-green)' : data.totalPnl < 0 ? 'var(--color-red)' : 'var(--text-secondary)';
        html += '<div style="background: var(--bg-card); border: 1px solid var(--border-primary); border-radius: var(--radius-md); padding: var(--space-3); transition: border-color var(--transition-fast);">' +
          '<div style="font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">' + escapeHtml(token) + '</div>' +
          '<div style="font-size: var(--text-sm); color: var(--text-secondary);">' +
            data.trades + ' trades · ' + (data.winRate * 100).toFixed(0) + '% WR' +
          '</div>' +
          '<div style="font-size: 14px; color: ' + pnlColor + '; margin-top: 4px;">$' + data.totalPnl.toFixed(4) + '</div>' +
        '</div>';
      }
      html += '</div>';
      container.innerHTML = '<h3 style="color: var(--text-primary); margin-bottom: var(--space-3); font-size: 16px;">Per-Token Performance</h3>' + html;
    }

    function renderTradesTable(trades, append) {
      const tbody = document.getElementById('trades-tbody');
      if (!append) tbody.innerHTML = '';
      for (const t of trades) {
        const pnlColor = t.pnlUsd > 0 ? 'var(--color-green)' : t.pnlUsd < 0 ? 'var(--color-red)' : 'var(--text-secondary)';
        const holdMin = (t.holdTimeMs / 60000).toFixed(1);
        const exitTime = new Date(Number(t.exitTimestamp)).toLocaleString();
        const reason = (t.exitReason || '').replace(/_/g, ' ');
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid var(--border-primary)';
        row.innerHTML =
          '<td style="padding: var(--space-2); color: var(--text-primary);">' + escapeHtml(t.ticker || t.symbol) + '</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: var(--text-primary);">' + (t.entryDiscount || 0).toFixed(2) + '%</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: var(--text-primary);">' + (t.exitDiscount || 0).toFixed(2) + '%</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: ' + pnlColor + ';">$' + (t.pnlUsd || 0).toFixed(4) + '</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: var(--text-primary);">' + holdMin + 'm</td>' +
          '<td style="padding: var(--space-2); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + reason + '">' + reason + '</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: var(--text-primary);" class="desktop-only">$' + (t.sizeUsd || 0).toFixed(2) + '</td>' +
          '<td style="padding: var(--space-2); text-align: right; color: var(--text-secondary);" class="desktop-only">' + exitTime + '</td>';
        tbody.appendChild(row);
      }
    }

    window.loadMoreTrades = async function() {
      try {
        const res = await fetch('/api/trades?limit=' + TRADES_PAGE_SIZE + '&offset=' + tradesOffset);
        const trades = await res.json();
        renderTradesTable(trades, true);
        tradesOffset += trades.length;
        if (trades.length < TRADES_PAGE_SIZE) {
          document.getElementById('trades-load-more').style.display = 'none';
        }
      } catch (err) {
        console.error('Failed to load more trades:', err);
      }
    };

    // Escape HTML for safe display
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Log search filtering
    document.getElementById('log-search').addEventListener('input', (e) => {
      logSearchTerm = e.target.value;
      renderLogs();
    });

    // Tooltip positioning for fixed position tooltips
    document.querySelectorAll('.tooltip').forEach(tooltip => {
      const tooltipText = tooltip.querySelector('.tooltip-text');
      if (!tooltipText) return;

      tooltip.addEventListener('mouseenter', () => {
        const rect = tooltip.getBoundingClientRect();
        tooltipText.style.top = (rect.bottom + 8) + 'px';
        tooltipText.style.left = (rect.left + rect.width / 2) + 'px';
        tooltipText.style.transform = 'translateX(-50%)';
      });
    });

    // Load heatmap on page load if on heatmap tab (must be after function definitions)
    if (document.querySelector('#tab-heatmap.active') && !window.heatmapLoaded) {
      loadHeatmapContent('24h');
    }

    // Admin panel functions - uses secure HTTP-only session cookies
    let isAdminAuthenticated = false;

    async function checkExistingSession() {
      try {
        const res = await fetch('/api/admin/check-session');
        const data = await res.json();
        if (data.authenticated) {
          showAuthenticatedState();
          return true;
        }
      } catch (err) {
        console.error('Session check failed:', err);
      }
      return false;
    }

    function showAuthenticatedState() {
      isAdminAuthenticated = true;
      const statusDiv = document.getElementById('admin-auth-status');
      const authSection = document.querySelector('.admin-auth');
      statusDiv.innerHTML = '<span style="color: var(--green);">Authenticated (session valid for 30 days)</span>';
      document.getElementById('admin-panel').style.display = 'block';
      // Hide token input, show logout button
      authSection.innerHTML = \`
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--green); font-weight: 600;">Session Active</span>
          <button onclick="adminLogout()" style="padding: 8px 16px; background: var(--red); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">
            Logout
          </button>
        </div>
      \`;
      loadAdminStatus();
    }

    async function verifyAdminToken() {
      const tokenInput = document.getElementById('admin-token');
      const statusDiv = document.getElementById('admin-auth-status');
      const token = tokenInput.value.trim();

      if (!token) {
        statusDiv.innerHTML = '<span style="color: var(--red);">Please enter a token</span>';
        return;
      }

      try {
        // Use login endpoint to create session cookie
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          showAuthenticatedState();
        } else {
          const data = await res.json();
          statusDiv.innerHTML = '<span style="color: var(--red);">' + (data.error || 'Invalid token') + '</span>';
        }
      } catch (err) {
        statusDiv.innerHTML = '<span style="color: var(--red);">Connection error</span>';
      }
    }

    async function adminLogout() {
      try {
        await fetch('/api/admin/logout', { method: 'POST' });
        location.reload();
      } catch (err) {
        console.error('Logout failed:', err);
      }
    }

    async function loadAdminStatus() {
      if (!isAdminAuthenticated) return;

      try {
        const res = await fetch('/api/admin/status');
        if (res.ok) {
          const data = await res.json();
          document.getElementById('status-kill-switch').innerHTML = data.killSwitchActive
            ? '<span style="color: var(--red);">ACTIVE</span>'
            : '<span style="color: var(--green);">Inactive</span>';
        } else if (res.status === 401) {
          // Session expired, reload page
          location.reload();
        }
      } catch (err) {
        console.error('Failed to load admin status:', err);
      }

      // Also load endpoint stats
      loadEndpointStats();
    }

    async function loadEndpointStats() {
      if (!isAdminAuthenticated) return;

      try {
        const res = await fetch('/api/admin/endpoints');
        if (res.ok) {
          const data = await res.json();
          const tbody = document.getElementById('endpoints-body');
          if (!data.endpoints || data.endpoints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center; color: var(--text-dim);">No endpoint data yet</td></tr>';
            return;
          }

          tbody.innerHTML = data.endpoints.map(ep => {
            const statusColor = ep.lastStatus === 'ok' ? 'var(--green)' : ep.lastStatus === 'error' ? 'var(--red)' : 'var(--text-dim)';
            const statusDot = '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ' + statusColor + ';"></span>';
            return '<tr style="border-bottom: 1px solid var(--border);">' +
              '<td style="padding: 8px; color: var(--text);">' + ep.name + '</td>' +
              '<td style="padding: 8px; text-align: right; color: var(--text);">' + ep.callsLastMinute + '</td>' +
              '<td style="padding: 8px; text-align: right; color: var(--text);">' + ep.callsLastHour + '</td>' +
              '<td style="padding: 8px; text-align: right; color: var(--text);">' + ep.avgResponseMs + '</td>' +
              '<td style="padding: 8px; text-align: center;">' + statusDot + '</td>' +
            '</tr>';
          }).join('');
        }
      } catch (err) {
        console.error('Failed to load endpoint stats:', err);
      }
    }

    function showAdminResult(message, isError) {
      const resultDiv = document.getElementById('admin-result');
      resultDiv.style.display = 'block';
      resultDiv.style.background = isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)';
      resultDiv.style.border = '1px solid ' + (isError ? 'var(--red)' : 'var(--green)');
      resultDiv.style.color = isError ? 'var(--red)' : 'var(--green)';
      resultDiv.textContent = message;
      setTimeout(() => { resultDiv.style.display = 'none'; }, 5000);
    }

    async function resetKillSwitch() {
      if (!isAdminAuthenticated) return;
      try {
        const res = await fetch('/api/admin/reset-kill-switch', { method: 'POST' });
        const data = await res.json();
        showAdminResult(data.message || 'Kill switch reset', !res.ok);
        loadAdminStatus();
      } catch (err) {
        showAdminResult('Failed to reset kill switch: ' + err.message, true);
      }
    }

    async function restartBot() {
      if (!isAdminAuthenticated) return;
      if (!confirm('Are you sure you want to restart the bot?')) return;
      try {
        const res = await fetch('/api/admin/restart', { method: 'POST' });
        const data = await res.json();
        showAdminResult(data.message || 'Restart initiated', !res.ok);
        if (res.ok) {
          setTimeout(() => location.reload(), 5000);
        }
      } catch (err) {
        showAdminResult('Failed to restart: ' + err.message, true);
      }
    }


    // Load admin status if on admin page
    if (document.querySelector('#tab-admin.active')) {
      // First check for existing session (cookie-based)
      checkExistingSession().then(hasSession => {
        if (!hasSession) {
          // Check if token is in URL for convenience (one-time login)
          const urlParams = new URLSearchParams(window.location.search);
          const urlToken = urlParams.get('token');
          if (urlToken) {
            document.getElementById('admin-token').value = urlToken;
            verifyAdminToken();
            // Remove token from URL for security
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        }
      });
    }

    // Predict tab functions
    async function refreshPredictData() {
      try {
        document.getElementById('predict-status').textContent = 'Refreshing...';
        
        // Fetch stats
        const statsRes = await fetch('/api/predict/stats');
        const stats = await statsRes.json();
        
        document.getElementById('predict-open').textContent = stats.openPositions || '0';
        document.getElementById('predict-winrate').textContent = stats.totalTrades > 0 
          ? stats.winRate.toFixed(0) + '%' 
          : '-';
        document.getElementById('predict-pnl').textContent = stats.totalPnL !== undefined
          ? (stats.totalPnL >= 0 ? '+' : '') + '$' + stats.totalPnL.toFixed(2)
          : '-';
        document.getElementById('predict-edge').textContent = stats.avgEdge
          ? (stats.avgEdge * 100).toFixed(0) + '%'
          : '-';
        document.getElementById('predict-fees').textContent = stats.totalFees
          ? '-$' + stats.totalFees.toFixed(4)
          : '$0';
        
        // Fetch opportunities
        const oppsRes = await fetch('/api/predict/opportunities');
        const opps = await oppsRes.json();
        
        const oppsContainer = document.getElementById('predict-opportunities');
        if (Array.isArray(opps) && opps.length > 0) {
          oppsContainer.innerHTML = opps.map(o => \`
            <div style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-primary); display: flex; justify-content: space-between; align-items: center;">
              <div style="flex: 1;">
                <div style="color: var(--text-primary); font-weight: 500;">\${o.title.length > 80 ? o.title.substring(0, 80) + '...' : o.title}</div>
                <div style="color: var(--text-secondary); font-size: var(--text-xs); margin-top: 4px;">
                  \${o.dataValue} via \${o.dataSource} • Expires in \${o.hoursToExpiry.toFixed(0)}h
                </div>
              </div>
              <div style="text-align: right;">
                <div style="color: var(--color-green); font-weight: 600;">\${(o.edge * 100).toFixed(0)}% edge</div>
                <div style="color: var(--text-secondary); font-size: var(--text-xs);">
                  \${o.outcome.toUpperCase()} @ \${(o.marketPrice * 100).toFixed(1)}¢
                </div>
              </div>
            </div>
          \`).join('');
        } else {
          oppsContainer.innerHTML = '<div style="padding: var(--space-4); color: var(--text-secondary); text-align: center;">No opportunities found</div>';
        }
        
        // Fetch positions
        const posRes = await fetch('/api/predict/positions');
        const positions = await posRes.json();
        
        // Open positions — sort by expiration (settling soonest first)
        const openContainer = document.getElementById('predict-positions');
        if (positions.open && positions.open.length > 0) {
          const sorted = [...positions.open].sort((a, b) => a.expirationTime - b.expirationTime);
          const now = Date.now();
          
          function formatCountdown(ms) {
            if (ms <= 0) return 'settling...';
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
            if (h > 0) return h + 'h ' + m + 'm';
            return m + 'm';
          }
          
          function countdownColor(ms) {
            if (ms <= 0) return 'var(--color-accent)';
            if (ms < 3600000) return 'var(--color-red)';      // <1h
            if (ms < 86400000) return 'var(--color-yellow, #f5a623)'; // <24h
            return 'var(--text-secondary)';
          }
          
          openContainer.innerHTML = '<div style="padding: 8px 16px; display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-primary); font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;"><span>Market</span><span style="display: flex; gap: 24px;"><span style="width: 60px; text-align: right;">Size</span><span style="width: 50px; text-align: right;">Edge</span><span style="width: 70px; text-align: right;">Settles In</span></span></div>' + sorted.map(p => {
            const timeLeft = (p.expirationTime * 1000) - now;
            return \`
            <div style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-primary); display: flex; justify-content: space-between; align-items: center;">
              <div style="flex: 1; min-width: 0;">
                <div style="color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${p.title ? (p.title.length > 60 ? p.title.substring(0, 60) + '...' : p.title) : p.marketTicker}</div>
                <div style="color: var(--text-secondary); font-size: var(--text-xs);">\${p.outcome.toUpperCase()} • \${p.dataValue}\${p.entryTxSignature && !p.entryTxSignature.startsWith('paper_') ? ' • <a href="https://solscan.io/tx/' + p.entryTxSignature + '" target="_blank" style="color: var(--color-accent);">tx ↗</a>' : ''}</div>
              </div>
              <div style="display: flex; gap: 24px; align-items: center; flex-shrink: 0;">
                <div style="width: 60px; text-align: right; color: var(--text-primary);">$\${p.sizeUsd.toFixed(2)}</div>
                <div style="width: 50px; text-align: right; color: var(--color-green); font-size: var(--text-xs);">\${(p.edgePct * 100).toFixed(0)}%</div>
                <div style="width: 70px; text-align: right; font-size: var(--text-xs); font-weight: 600; color: \${countdownColor(timeLeft)};">\${formatCountdown(timeLeft)}</div>
              </div>
            </div>\`;
          }).join('');
        } else {
          openContainer.innerHTML = '<div style="padding: var(--space-4); color: var(--text-secondary); text-align: center;">No open positions</div>';
        }
        
        // Recent trades
        const tradesBody = document.getElementById('predict-trades-body');
        if (positions.recent && positions.recent.length > 0) {
          tradesBody.innerHTML = positions.recent.filter(p => p.status !== 'open').map(p => \`
            <tr style="border-bottom: 1px solid var(--border-primary);">
              <td style="padding: 12px; color: var(--text-primary);">\${p.title ? (p.title.length > 60 ? p.title.substring(0, 60) + '...' : p.title) : p.marketTicker}</td>
              <td style="padding: 12px; text-align: center; color: var(--text-secondary);">\${p.outcome.toUpperCase()}</td>
              <td style="padding: 12px; text-align: right; color: var(--text-secondary);">\${(p.entryPrice * 100).toFixed(1)}¢</td>
              <td style="padding: 12px; text-align: right; color: var(--text-secondary);">\${(p.edgePct * 100).toFixed(0)}%</td>
              <td style="padding: 12px; text-align: center;">
                <span style="color: \${p.settlementResult === 'win' ? 'var(--color-green)' : 'var(--color-red)'};">
                  \${p.settlementResult ? (p.settlementResult === 'win' ? '✓ WIN' : '✗ LOSS') : p.status}
                </span>
              </td>
              <td style="padding: 12px; text-align: right; color: \${p.pnlUsd >= 0 ? 'var(--color-green)' : 'var(--color-red)'};">
                \${p.pnlUsd !== undefined ? (p.pnlUsd >= 0 ? '+' : '') + '$' + p.pnlUsd.toFixed(2) : '-'}
              </td>
            </tr>
          \`).join('') || '<tr><td colspan="6" style="padding: 16px; text-align: center; color: var(--text-secondary);">No settled trades</td></tr>';
        }
        
        document.getElementById('predict-status').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('predict-status').textContent = 'Error: ' + e.message;
      }
    }
    
    // Auto-refresh predict data if on that tab
    if (window.location.pathname === '/predict') {
      refreshPredictData();
      setInterval(refreshPredictData, 60000); // Refresh every minute
    }
  </script>
</body>
</html>`;
}

