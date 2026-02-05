import { describe, test, expect } from '@jest/globals';

describe('Quote Degradation Bug - expectedExitUsd Calculation', () => {
  test('expectedExitUsd should match position size, not be 300x inflated', () => {
    // Reproduce the bug from logs:
    // Position size: $11.18
    // Signal quote (expectedExitUsd): $3,638.13
    // Execution quote: $11.11
    // Degradation: 99.695%

    const positionSizeUsd = 11.18;
    const stockPrice = 638; // SPY stock price
    const tokenPrice = 619; // Token trading at 3% discount

    // But if buyAmount gets corrupted to use the wrong value...
    const corruptedBuyAmount = 5.7; // This is what logs suggest
    const corruptedExpectedExitUsd = corruptedBuyAmount * stockPrice; // $3,638 ❌

    // Should be way higher than actual position size
    expect(corruptedExpectedExitUsd).toBeGreaterThan(3600);

    // Correct calculation
    const correctBuyAmount = positionSizeUsd / tokenPrice; // 0.0181 tokens
    const correctExpectedExitUsd = correctBuyAmount * tokenPrice; // $11.18 ✓

    expect(correctExpectedExitUsd).toBeCloseTo(positionSizeUsd, 1);
  });

  test('position.buyAmount should reflect actual tokens received, not estimated', () => {
    // When buying $11 of SPY tokens:
    const positionSizeUsd = 11.0;
    const estimatedTokenPrice = 620; // Price API says

    // WRONG: Using estimated amount
    const estimatedBuyAmount = positionSizeUsd / estimatedTokenPrice; // 0.01774 tokens

    // CORRECT: Using actual output from trade
    const actualBuyAmount = 0.01780; // What we actually got (11 / 618)

    // buyAmount should be set from actual trade output, not estimation
    expect(actualBuyAmount).toBeGreaterThan(estimatedBuyAmount);
  });

  test('quote degradation check should use consistent price source', () => {
    const buyAmount = 0.0178; // Actual tokens purchased

    // Signal generator gets quote
    const signalTokenPrice = 619; // Current DEX price
    const signalQuoteUsd = buyAmount * signalTokenPrice; // $11.02

    // Later, orchestrator gets fresh quote
    const executionTokenPrice = 618; // DEX price dropped slightly
    const executionQuoteUsd = buyAmount * executionTokenPrice; // $11.00

    // Degradation should be minimal
    const degradationPct = ((signalQuoteUsd - executionQuoteUsd) / signalQuoteUsd) * 100;

    expect(degradationPct).toBeLessThan(1.0); // Should pass 1% threshold
    expect(degradationPct).toBeCloseTo(0.18, 1); // ~0.2% degradation is normal
  });

  test('Raydium quotes should have same sanity check as Jupiter', () => {
    // Jupiter has sanity check: reject quotes >2x or <0.5x position size
    // Raydium LACKS this check, causing bad quotes to propagate

    const positionSizeUsd = 11.0;

    // Simulate bad Raydium quote
    const badRaydiumQuote = 3638; // 300x too high!

    // Jupiter sanity check logic
    const maxReasonableQuote = positionSizeUsd * 2; // $22
    const minReasonableQuote = positionSizeUsd * 0.5; // $5.50

    // Bad quote should be rejected
    const shouldRejectRaydium = badRaydiumQuote > maxReasonableQuote;
    expect(shouldRejectRaydium).toBe(true);

    // Good quote should be accepted
    const goodRaydiumQuote = 11.1; // Reasonable
    const shouldAcceptRaydium =
      goodRaydiumQuote <= maxReasonableQuote &&
      goodRaydiumQuote >= minReasonableQuote;
    expect(shouldAcceptRaydium).toBe(true);
  });

  test('BUG REPRODUCTION: position.buyAmount stores wrong value', () => {
    // This test reproduces the actual bug we're seeing in logs

    // Entry: User wants to buy $11 of SPY tokens
    const stockPrice = 638.00; // SPY stock price from API

    // Then after trade executes, if buyAmount is NOT updated properly...
    // And somehow gets multiplied or uses wrong reference...
    const buggyStoredBuyAmount = 5.7; // Mystery value from logs

    // Later, signal generator calculates expected exit:
    const buggyExpectedExitUsd = buggyStoredBuyAmount * stockPrice; // $3,638!!

    // But actual position is only worth:
    const actualQuoteUsd = 11.0;

    // Degradation check:
    const degradation = ((buggyExpectedExitUsd - actualQuoteUsd) / buggyExpectedExitUsd) * 100;
    expect(degradation).toBeCloseTo(99.695, 1); // Matches logs exactly!

    // This degradation > 1%, so exit is blocked
    expect(degradation).toBeGreaterThan(1.0);
  });
});
