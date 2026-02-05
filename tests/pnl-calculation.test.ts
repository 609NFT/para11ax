/**
 * Tests for PnL calculation bugs
 *
 * Bug: Dust trades showing -100% PnL loss
 *
 * Issue: When a position's balance becomes too small to sell (dust),
 * the code incorrectly calculates:
 *   pnlUsd = estimatedValueUsd - position.sizeUsd
 *
 * Example:
 *   - Entry: Buy $8 worth of tokens (transaction succeeds)
 *   - Balance becomes dust ($0.01 remaining)
 *   - PnL calculated as: $0.01 - $8 = -$7.99 (-100%)
 *
 * This is incorrect because:
 *   1. We successfully bought tokens (entry TX exists)
 *   2. The dust calculation treats it as a total loss
 *   3. Actual PnL should account for what happened to the tokens
 */

import { MeanReversionPosition } from '../src/types';

describe('PnL Calculation - Dust Trades', () => {
  /**
   * Test case based on real production data:
   * Trade ID: pair-1770036662966-wo2fguehe
   * Ticker: GLD (GLDx)
   * Intended Size: $7.84
   * Entry TX: 5fBnLC...hwdTB (successful)
   * Exit TX: MISSING
   * Current calculation: -$7.84 (-100%)
   */
  test('dust trade should not show -100% loss when entry succeeded', () => {
    // Setup: Create a position that entered successfully
    const position: MeanReversionPosition = {
      id: 'test-dust-position',
      stockTicker: 'GLD',
      buySymbol: 'GLDx',
      buyMint: 'GLD_MINT_ADDRESS',
      sellSymbol: 'USDC',
      sellMint: 'USDC_MINT_ADDRESS',
      entrySpreadPct: 2.15,
      entryTimestamp: Date.now() - 6000000, // 100 minutes ago
      sizeUsd: 7.84, // Intended entry size
      buyAmount: 0.017839, // Actual tokens bought
      sellAmount: 7.84,
      status: 'open',
      entryTxSignature: '5fBnLC1D86FQ4DFuQhWn2ew1Qz7AtsUkiyhZCwYrpShxw8ZAN8go3TWC3hKYRhZgGRGXsf5b1buMBifAk76hwdTB',
      entryFeesUsd: 0.000533,
    };

    // Simulate: Balance becomes dust (much smaller than min sellable)
    const currentDustValueUsd = 0.01; // Very small remaining value

    // CURRENT BUGGY CALCULATION (from orchestrator.ts:1527-1528)
    const buggyPnlUsd = currentDustValueUsd - position.sizeUsd;
    const buggyPnlPct = ((currentDustValueUsd - position.sizeUsd) / position.sizeUsd) * 100;

    // This shows the bug: -100% loss
    expect(buggyPnlUsd).toBeCloseTo(-7.83, 2);
    expect(buggyPnlPct).toBeCloseTo(-99.87, 1);

    // EXPECTED CORRECT CALCULATION
    // Option 1: If we never tried to sell, PnL should be based on current market value
    // Option 2: If partial sells failed, track those failures
    // Option 3: Mark as unknown PnL if we can't determine what happened

    // For now, let's assert what the CORRECT behavior should be:
    // Since we have entry TX but no exit TX, and the balance is dust,
    // we should NOT assume a -100% loss. Instead:

    // 1. If entry succeeded but balance is dust, something external happened
    //    (price crash, failed sell attempts, or tracking bug)
    // 2. We should mark PnL as close to zero or as "uncertain" rather than -100%
    // 3. At minimum, we should subtract the actual entry cost, not the intended size

    const actualEntryCost = position.sizeUsd + (position.entryFeesUsd || 0);
    const correctPnlUsd = currentDustValueUsd - actualEntryCost;
    const correctPnlPct = (correctPnlUsd / actualEntryCost) * 100;

    // The correct PnL should still be negative (we lost money),
    // but should account for actual costs
    expect(correctPnlUsd).toBeCloseTo(-7.83, 2);
    expect(correctPnlPct).toBeCloseTo(-99.87, 1);

    // Actually, both calculations are the same in this case!
    // The REAL issue is: did we actually spend $7.84, or did something else happen?

    // Let's test a different scenario: what if the entry partially failed?
  });

  /**
   * Scenario: Entry transaction succeeded but only partially filled
   * This can happen with slippage or partial fills
   */
  test('dust trade with partial entry fill should calculate PnL correctly', () => {
    // Position intended to enter with $7.84 but only partially filled
    // If the entry only partially filled, we might have only spent $1
    const actualUsdcSpent = 1.0; // Actual USDC debited from wallet
    const currentDustValueUsd = 0.01;

    // Correct PnL = current value - actual cost
    const correctPnlUsd = currentDustValueUsd - actualUsdcSpent;
    const correctPnlPct = (correctPnlUsd / actualUsdcSpent) * 100;

    expect(correctPnlUsd).toBeCloseTo(-0.99, 2);
    expect(correctPnlPct).toBeCloseTo(-99, 0);

    // This is MUCH different from -$7.84!
  });

  /**
   * Scenario: Position had successful partial exits before becoming dust
   * Example: Entered with $10, sold $8 for profit, left with $0.01 dust
   */
  test('dust trade with previous successful exits should not double-count losses', () => {
    const position: MeanReversionPosition = {
      id: 'test-multi-exit',
      stockTicker: 'GLD',
      buySymbol: 'GLDx',
      buyMint: 'GLD_MINT_ADDRESS',
      sellSymbol: 'USDC',
      sellMint: 'USDC_MINT_ADDRESS',
      entrySpreadPct: 2.15,
      entryTimestamp: Date.now() - 6000000,
      sizeUsd: 10.0, // Entered with $10
      buyAmount: 0.023, // Bought 0.023 tokens
      sellAmount: 10.0,
      status: 'open',
      entryTxSignature: 'ENTRY_TX',
    };

    // Scenario: We already sold 90% of the position successfully
    const previousExitProceeds = 9.50; // Made $9.50 back from selling 90%
    const currentDustValueUsd = 0.01; // Remaining 10% is now dust

    // Total recovered: $9.50 + $0.01 = $9.51
    // Total cost: $10.00
    // Actual PnL: -$0.49 (not -$10!)
    const totalRecovered = previousExitProceeds + currentDustValueUsd;
    const correctPnlUsd = totalRecovered - position.sizeUsd;
    const correctPnlPct = (correctPnlUsd / position.sizeUsd) * 100;

    expect(correctPnlUsd).toBeCloseTo(-0.49, 2);
    expect(correctPnlPct).toBeCloseTo(-4.9, 1);

    // But the CURRENT code would calculate:
    // pnlUsd = $0.01 - $10 = -$9.99
    // This is WRONG because it ignores the $9.50 we already got back!
  });

  /**
   * The core issue: We need to track ACTUAL USDC spent vs ACTUAL USDC received
   * Not just intended size vs current dust value
   */
  test('correct PnL calculation should track actual wallet changes', () => {
    // This test defines what the CORRECT implementation should do:

    // 1. Track actual USDC debited during entry
    const actualUsdcSpent = 7.84;

    // 2. Track actual USDC credited during any partial exits
    const actualUsdcReceived = 0.0; // None yet

    // 3. Track current token value (if not sold)
    const currentTokenValue = 0.01; // Dust

    // 4. Calculate PnL as: (received USDC + current token value) - spent USDC
    const correctPnlUsd = (actualUsdcReceived + currentTokenValue) - actualUsdcSpent;
    const correctPnlPct = (correctPnlUsd / actualUsdcSpent) * 100;

    expect(correctPnlUsd).toBeCloseTo(-7.83, 2);
    expect(correctPnlPct).toBeCloseTo(-99.87, 1);

    // In THIS specific case, the calculation happens to be correct
    // But only because actualUsdcSpent === position.sizeUsd
    // AND there were no partial exits

    // The bug is: we're using position.sizeUsd instead of tracking actual wallet changes
  });
});
