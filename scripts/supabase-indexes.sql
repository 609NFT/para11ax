-- Supabase Performance Indexes for SQLite Sunset Migration
-- Run these in the Supabase SQL Editor
-- Note: CONCURRENTLY removed to avoid transaction block error

-- 1. Hot path: Open mean reversion positions (called every 10-30s in trading loop)
CREATE INDEX IF NOT EXISTS idx_mean_reversion_status_ts
ON mean_reversion_positions(status, entry_timestamp DESC)
WHERE status = 'open';

-- 2. Hot path: Open short positions (called every 10-30s)
CREATE INDEX IF NOT EXISTS idx_short_positions_status_ts
ON short_positions(status, entry_timestamp DESC)
WHERE status = 'open';

-- 3. CRITICAL: Latest discount lookup (fixes NAV bug - was reading from empty SQLite table)
CREATE INDEX IF NOT EXISTS idx_discount_ticker_symbol_ts
ON discount_history(stock_ticker, token_a_symbol, timestamp DESC);

-- 4. Rolling history queries for volatility and percentile calculations
CREATE INDEX IF NOT EXISTS idx_discount_symbol_ts
ON discount_history(token_a_symbol, timestamp DESC);

-- Verify indexes were created
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('mean_reversion_positions', 'short_positions', 'discount_history')
ORDER BY tablename, indexname;
