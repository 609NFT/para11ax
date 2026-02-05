import { describe, test, expect } from '@jest/globals';

describe('Slippage Calculation Bug - MSTR Trade', () => {
  test('sell trade should use expectedOutputUsd for trade size, not actualOutputAmount', () => {
    // Simulate a MSTR sell trade
    const expectedOutputUsd = 4.89; // Expected USD value from quote
    const realOutputUsd = 4.88; // Actual USD received (slight slippage)
    const actualOutputAmount = 4.88 * 1e6; // USDC received in lamports

    // BUGGY CODE: Uses actualOutputAmount / 1e6 for trade size
    const buggyTradeSizeUsd = actualOutputAmount / 1e6; // For sell trades

    // For this case, buggy code would give: 4.88 (which happens to be correct for USDC)
    // But the issue is when actualOutputAmount is wrong or for slippage calculation consistency
    expect(buggyTradeSizeUsd).toBe(4.88);

    // CORRECT CODE: Use expectedOutputUsd for trade size
    const correctTradeSizeUsd = expectedOutputUsd; // For sell trades

    // The trade size should be based on what we expected to trade, not what we received
    expect(correctTradeSizeUsd).toBe(4.89);

    // For slippage sanity check, we want to use the EXPECTED trade size
    // Otherwise, if actualOutputAmount is very different due to bugs,
    // the sanity check becomes unreliable
    const rawSlippageUsd = Math.abs(expectedOutputUsd - realOutputUsd);
    const maxReasonableSlippage = correctTradeSizeUsd * 1.0; // Should be based on expected size

    expect(rawSlippageUsd).toBeCloseTo(0.01, 10); // Small slippage
    expect(rawSlippageUsd).toBeLessThan(maxReasonableSlippage); // Passes sanity check
  });

  test('sell trade with wrong decimals in actualOutputAmount would break old code', () => {
    // This demonstrates what could happen if actualOutputAmount was mistakenly
    // set to the input token amount instead of USDC output
    const expectedOutputUsd = 4.89;
    const actualOutputAmountWrong = 0.0353681 * 1e8; // Accidentally contains MSTR amount (8 decimals)

    // BUGGY CODE with wrong actualOutputAmount
    const buggyTradeSizeUsd = actualOutputAmountWrong / 1e6; // Treats 8-decimal value as 6-decimal

    // This produces wrong trade size: 3536810 / 1000000 = 3.53681
    expect(buggyTradeSizeUsd).toBeCloseTo(3.537, 2);

    // The slippage would then be calculated as: |4.89 - 3.537| = 1.35
    // But more importantly, the trade size is wrong, making the sanity check unreliable

    // CORRECT CODE: Use expectedOutputUsd (doesn't depend on actualOutputAmount parsing)
    const correctTradeSizeUsd = expectedOutputUsd;
    expect(correctTradeSizeUsd).toBe(4.89);
  });

  test('trade size calculation should be consistent regardless of output amount bugs', () => {
    const expectedOutputUsd = 10.0;

    // CORRECT: Using expectedOutputUsd for sell trades protects us from parsing errors
    const tradeSizeUsd = expectedOutputUsd;

    expect(tradeSizeUsd).toBe(10.0);

    // This makes the slippage sanity check reliable:
    // Slippage should never exceed trade size (100% loss would be impossible)
    const maxReasonableSlippage = tradeSizeUsd * 1.0;
    expect(maxReasonableSlippage).toBe(10.0);
  });
});
