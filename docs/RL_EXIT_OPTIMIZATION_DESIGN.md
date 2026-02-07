# RL-Based Exit Optimization Design Document

**Date:** 2026-02-07  
**Status:** Research & Design (Not Implemented)  
**Author:** Research Sub-Agent

---

## Executive Summary

This document outlines a reinforcement learning (RL) approach to optimize trade exit timing for the Parallax trading bot. The current time-decay threshold system results in 17.5% max_hold_time exits and ~21% win rate. An RL agent can learn optimal exit timing by observing real market dynamics rather than following fixed decay curves.

---

## 1. Problem Analysis

### Current System
The existing exit logic (`meanReversionSignal.ts`) uses:
- **Time-decay thresholds**: Start at `entry_spread * coefficient`, linearly decay over 30-50 min to `MIN_EXIT_FLOOR` (1.0%)
- **Multiple exit triggers**: Profit target, trailing stop (5M+ TVL only), price stop-loss, stock stop-loss, discount stop-loss, spread-widening stop, max hold time (60 min)
- **Anti-churning guard**: Blocks exits when spread narrows due to stock drop

### Problems
1. **17.5% max_hold_time exits** — spreads don't revert in time
2. **~21% win rate** — many trades that should have exited earlier or later
3. **Fixed decay curve** — doesn't adapt to token-specific behavior or market conditions
4. **One-size-fits-all** — same logic for high-volatility and low-volatility tokens

### Goal
Replace the fixed time-decay curve with an RL agent that learns:
- When to hold (spread still reverting)
- When to exit (optimal profit capture)
- When to cut losses early (spread diverging, won't revert)

---

## 2. RL Algorithm Selection

### Candidates Evaluated

| Algorithm | Type | Action Space | Sample Efficiency | Stability | Complexity |
|-----------|------|--------------|-------------------|-----------|------------|
| **DQN** | Value-based | Discrete | High (replay buffer) | Good | Low |
| **PPO** | Policy gradient | Both | Low (on-policy) | Very Good | Medium |
| **A2C** | Actor-critic | Both | Low (on-policy) | Medium | Medium |
| **SAC** | Actor-critic | Continuous | High (off-policy) | Good | High |
| **DDPG** | Actor-critic | Continuous | High (off-policy) | Lower | High |

### Recommendation: **Dueling Double DQN (D3QN)**

**Rationale:**
1. **Discrete action space** — Exit decision is binary (hold/exit), perfect for DQN
2. **Sample efficiency** — Can learn from historical data via experience replay (critical with limited trades)
3. **Stability** — Double DQN fixes overestimation bias; Dueling architecture separates value and advantage for better learning
4. **Simplicity** — Easier to implement and debug than policy gradient methods
5. **Battle-tested** — Extensive literature on DQN for trading applications

**Alternative considered:** PPO is more stable but requires on-policy learning (can't efficiently use historical replay). Given our limited trade volume (~5-15 trades/day), sample efficiency is paramount.

---

## 3. State Space Design

### Feature Vector (18 dimensions)

```typescript
interface ExitState {
  // Spread dynamics (5 features)
  currentSpread: number;         // Current discount vs stock (%)
  entrySpread: number;           // Discount at entry (%)
  spreadChange: number;          // currentSpread - entrySpread (%)
  spreadVelocity: number;        // Rate of spread change over last 5 min (%/min)
  spreadAcceleration: number;    // Change in velocity (momentum)
  
  // Hold time (3 features)
  holdTimeNormalized: number;    // holdTime / MAX_HOLD_TIME (0-1)
  holdTimeMin: number;           // Raw hold time in minutes
  timeToMaxHold: number;         // Minutes remaining until forced exit
  
  // Price dynamics (3 features)
  tokenAppreciation: number;     // Token price change from entry (%)
  stockChange: number;           // Stock price change from entry (%)
  navDivergence: number;         // tokenAppreciation - stockChange (shows if gain is real or NAV-driven)
  
  // Volatility (3 features)
  tokenVolatility: number;       // Recent token price volatility (std dev of returns)
  stockATR: number;              // Stock ATR from Twelve Data (normalized)
  spreadVolatility: number;      // Spread volatility over hold period
  
  // Liquidity (2 features)
  tvlNormalized: number;         // log(TVL) / log(10M) — normalized pool depth
  expectedSlippage: number;      // Estimated exit slippage based on TVL
  
  // Market context (2 features)
  hourOfDayEncoded: number;      // sin/cos encoding of UTC hour (captures cyclical nature)
  marketOpen: number;            // 1.0 if US equity market open, 0.0 otherwise
}
```

### Feature Engineering Notes

1. **Spread velocity** — Computed as exponential moving average of spread changes over 5 minutes
2. **NAV divergence** — Critical for detecting "fake profits" where spread narrows due to stock drop
3. **TVL normalization** — Log scale because liquidity impact is logarithmic
4. **Hour encoding** — Use sin(2π·hour/24) and cos(2π·hour/24) for cyclical representation

### Normalization Strategy
All features should be normalized to [-1, 1] or [0, 1] range using historical statistics:
```typescript
const NORMALIZATION_PARAMS = {
  spreadChange: { min: -10, max: 10 },      // Clip extremes
  tokenAppreciation: { min: -15, max: 15 },
  stockATR: { mean: 2.5, std: 1.5 },        // Z-score normalize
  // ... etc
};
```

---

## 4. Action Space

### Discrete Actions (3 options)

| Action | Description | When to Use |
|--------|-------------|-------------|
| **0: HOLD** | Continue holding position | Spread still reverting, momentum favorable |
| **1: EXIT** | Close position immediately | Target reached or cutting losses |
| **2: WAIT_AND_REASSESS** | Hold but increase evaluation frequency | Uncertain, gather more data |

**Note:** Started with 2 actions (hold/exit) but added WAIT_AND_REASSESS to handle uncertainty without committing. This action triggers more frequent evaluation (every 30s vs 2 min) without changing position.

### Alternative: Continuous Action Space (Not Recommended)

A continuous action (e.g., exit probability 0-1) would require:
- SAC or DDPG algorithm (more complex)
- Threshold tuning for when to actually exit
- Less interpretable

The discrete space is simpler and sufficient for this problem.

---

## 5. Reward Function Design

### Primary Reward: Risk-Adjusted P&L

```typescript
function calculateReward(
  action: Action,
  position: Position,
  outcome: TradeOutcome
): number {
  const { pnlPct, holdTimeMin, exitReason } = outcome;
  
  // Base reward: P&L percentage
  let reward = pnlPct;
  
  // Time efficiency bonus/penalty
  // Reward quick profitable exits, penalize holding losers too long
  const expectedHoldTime = 20; // minutes (sweet spot from data)
  const timeEfficiency = expectedHoldTime / Math.max(holdTimeMin, 1);
  if (pnlPct > 0) {
    reward *= Math.min(timeEfficiency, 2.0);  // Up to 2x for fast wins
  } else {
    reward *= Math.max(1 / timeEfficiency, 0.5);  // Extra penalty for slow losses
  }
  
  // Penalty for max_hold_time exits (failed to exit in time)
  if (exitReason === 'max_hold_time') {
    reward -= 0.5;  // Fixed penalty
  }
  
  // Penalty for stop-loss exits (could have cut earlier)
  if (exitReason.includes('stop_loss')) {
    reward -= 0.3;
  }
  
  // Bonus for profit target exits (learned the pattern)
  if (exitReason === 'target' || exitReason.includes('trailing')) {
    reward += 0.2;
  }
  
  return reward;
}
```

### Intermediate Rewards (Shaping)

For the HOLD action, provide small intermediate rewards to guide learning:
```typescript
function calculateIntermediateReward(state: ExitState, prevState: ExitState): number {
  // Reward positive spread momentum
  const momentumReward = state.spreadVelocity > 0 ? 0.01 : -0.01;
  
  // Reward spread narrowing
  const spreadProgress = (prevState.spreadChange - state.spreadChange) / 10;
  
  return momentumReward + spreadProgress;
}
```

### Reward Considerations

1. **Sparse vs Dense** — Trading rewards are naturally sparse (only at exit). Intermediate shaping helps but risks reward hacking.
2. **Risk adjustment** — Could incorporate Sharpe-like scaling: `reward / sqrt(variance_of_rewards)`
3. **Discount factor (γ)** — Use 0.99 for long-term orientation

---

## 6. Network Architecture

### Dueling DQN Architecture

```
Input (18 features)
    │
    ▼
┌─────────────────────────────────────┐
│     Shared Feature Extraction       │
│  Dense(128, ReLU) → Dense(64, ReLU) │
└─────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────┐      ┌─────────────────┐
│ Value Stream │      │ Advantage Stream│
│ Dense(32)    │      │ Dense(32)       │
│ Dense(1)     │      │ Dense(3)        │
└─────────────┘      └─────────────────┘
         │                    │
         └─────────┬──────────┘
                   │
         Q(s,a) = V(s) + (A(s,a) - mean(A))
```

### Hyperparameters (Initial)

```typescript
const DQN_CONFIG = {
  // Network
  hiddenLayers: [128, 64],
  activation: 'relu',
  
  // Training
  learningRate: 0.0001,
  batchSize: 32,
  gamma: 0.99,           // Discount factor
  
  // Exploration
  epsilonStart: 1.0,
  epsilonEnd: 0.05,
  epsilonDecaySteps: 10000,
  
  // Replay buffer
  replayBufferSize: 50000,
  minReplaySize: 1000,   // Start training after this many experiences
  
  // Target network
  targetUpdateFreq: 500, // Steps between target network updates
  
  // Double DQN
  useDoubleDQN: true,
};
```

---

## 7. Training Approach

### Phase 1: Offline Training (Historical Data)

1. **Extract training data from Supabase**:
   ```sql
   SELECT 
     p.id, p.stock_ticker, p.buy_symbol,
     p.entry_spread_pct, p.exit_spread_pct,
     p.entry_timestamp, p.exit_timestamp,
     p.pnl_pct, p.exit_reason,
     p.entry_stock_price, p.size_usd
   FROM mean_reversion_positions p
   WHERE p.status = 'closed'
   ORDER BY p.entry_timestamp;
   ```

2. **Reconstruct state trajectories**:
   ```sql
   SELECT 
     symbol, discount_pct, stock_price, token_price, tvl_usd, timestamp
   FROM discount_history
   WHERE timestamp BETWEEN :entry_time AND :exit_time
     AND symbol = :token_symbol
   ORDER BY timestamp;
   ```

3. **Build experience tuples**:
   ```typescript
   type Experience = {
     state: ExitState;
     action: Action;       // What the old system did
     reward: number;       // Calculated from outcome
     nextState: ExitState;
     done: boolean;        // Was this the exit?
   };
   ```

4. **Train with experience replay**:
   - Shuffle experiences to break temporal correlation
   - Use prioritized experience replay (PER) to focus on surprising outcomes
   - Train for 100+ epochs until convergence

### Phase 2: Online Fine-Tuning (Paper Trading)

1. **Shadow mode**: RL agent suggests actions, current system executes
2. **Log disagreements**: When RL would exit but system holds (or vice versa)
3. **Analyze counterfactuals**: What would have happened with RL's decision?
4. **Gradually increase trust**: If RL outperforms, increase its influence

### Phase 3: Live Trading

1. **Conservative rollout**: Start with 10% of positions using RL exits
2. **Monitor key metrics**: Win rate, avg P&L, max_hold_time rate
3. **A/B testing**: Compare RL vs baseline on similar trades
4. **Full rollout**: Once statistically significant improvement proven

---

## 8. Implementation Architecture

### Option A: Native TypeScript (TensorFlow.js)

```
┌─────────────────────────────────────────────────────────┐
│                    Parallax Bot                         │
│  ┌─────────────────┐      ┌──────────────────────────┐ │
│  │ meanReversion   │──────│  RLExitAgent             │ │
│  │ Signal.ts       │      │  ├─ model.ts (TF.js)     │ │
│  │                 │      │  ├─ stateBuilder.ts      │ │
│  │ shouldExit() ◄──┼──────│  ├─ rewardCalculator.ts  │ │
│  │                 │      │  └─ trainer.ts           │ │
│  └─────────────────┘      └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Pros:**
- Single codebase, no extra services
- TensorFlow.js is mature for DQN
- Easy deployment (npm package)

**Cons:**
- Less mature RL ecosystem than Python
- TensorFlow.js can be memory-heavy
- Limited pre-built RL algorithms

### Option B: Python Microservice (Recommended)

```
┌─────────────────────────────────┐     ┌──────────────────────────┐
│         Parallax Bot            │     │    RL Exit Service       │
│  ┌─────────────────┐            │     │    (Python/FastAPI)      │
│  │ meanReversion   │  HTTP/gRPC │     │  ┌──────────────────┐   │
│  │ Signal.ts       │◄──────────►│     │  │ stable-baselines3│   │
│  │                 │            │     │  │ or CleanRL       │   │
│  │ shouldExit()    │            │     │  └──────────────────┘   │
│  └─────────────────┘            │     │  ┌──────────────────┐   │
│                                 │     │  │ Model Weights    │   │
│                                 │     │  │ (PyTorch)        │   │
│                                 │     │  └──────────────────┘   │
└─────────────────────────────────┘     └──────────────────────────┘
```

**Pros:**
- Mature RL libraries (stable-baselines3, CleanRL, RLlib)
- Better GPU support for training
- Easier experimentation and hyperparameter tuning
- Can use ONNX for fast inference

**Cons:**
- Additional service to deploy/maintain
- Latency overhead (HTTP ~5-20ms)
- Cross-language complexity

### Recommendation: **Option B (Python Microservice)**

The Python ecosystem is significantly more mature for RL. stable-baselines3 provides battle-tested DQN implementation with prioritized replay, target networks, and all optimizations built-in. The latency overhead is acceptable since exit decisions aren't time-critical (10-20ms doesn't matter when checking every 2 minutes).

---

## 9. Training Data Requirements

### Minimum Data for Meaningful Training

| Metric | Minimum | Recommended |
|--------|---------|-------------|
| Closed trades | 500 | 2,000+ |
| Unique tokens | 10 | 30+ |
| Time span | 1 month | 3+ months |
| State observations | 10,000 | 100,000+ |
| Discount history rows | 100,000 | 500,000+ |

### Current Data Availability (Estimate)

Based on ~5-15 trades/day:
- ~30-60 days of data = 150-900 trades
- discount_history likely has 100K+ rows (sampled every 10s)

**Verdict:** May need 1-2 more months of data for robust training, or use data augmentation.

### Data Augmentation Strategies

1. **Time shifting**: Offset historical trajectories by random amounts
2. **Noise injection**: Add small noise to spreads/prices
3. **Synthetic trajectories**: Generate from learned distributions
4. **Cross-token transfer**: Learn from similar tokens

---

## 10. Integration with Existing Code

### Minimal Changes to meanReversionSignal.ts

```typescript
// In checkExit() method, replace fixed logic with RL call:

async checkExit(position: MeanReversionPosition): Promise<ExitDecision> {
  // Build state from current position/market data
  const state = await this.buildExitState(position);
  
  // Get RL recommendation
  const rlDecision = await rlExitAgent.getAction(state);
  
  // Safety overrides (never disable stop-losses)
  if (this.isStopLossTriggered(position)) {
    return { shouldExit: true, reason: 'stop_loss', source: 'override' };
  }
  
  if (position.holdTimeMs > MAX_HOLD_TIME_MS) {
    return { shouldExit: true, reason: 'max_hold_time', source: 'override' };
  }
  
  // RL makes the call for profit-taking decisions
  if (rlDecision.action === Action.EXIT) {
    return { 
      shouldExit: true, 
      reason: 'rl_exit', 
      confidence: rlDecision.confidence,
      source: 'rl'
    };
  }
  
  return { shouldExit: false, reason: '', source: 'rl' };
}
```

### New Files

```
src/rl/
├── types.ts           # ExitState, Action, Experience types
├── stateBuilder.ts    # Build ExitState from position/market data  
├── rlExitAgent.ts     # Interface to Python service or TF.js model
├── rewardCalculator.ts # Calculate rewards from outcomes
└── experienceBuffer.ts # Store experiences for training

scripts/
├── train-rl-exit.ts   # Offline training script
└── eval-rl-exit.ts    # Evaluate model on held-out data
```

---

## 11. Evaluation Metrics

### Primary Metrics

| Metric | Current | Target | Calculation |
|--------|---------|--------|-------------|
| Win Rate | 21% | 35%+ | wins / total trades |
| Max Hold Exit Rate | 17.5% | <8% | max_hold exits / total exits |
| Avg P&L per Trade | ~$0.15 | >$0.30 | total_pnl / num_trades |
| Sharpe Ratio | ~0.8 | >1.5 | mean(returns) / std(returns) |

### Secondary Metrics

- **Exit timing accuracy**: Correlation between RL exit time and optimal (hindsight) exit time
- **False exit rate**: Exited early but spread continued narrowing
- **Missed exit rate**: Held too long when should have exited
- **Stop-loss avoidance**: Reduction in stop-loss triggers (implies earlier cuts)

### Backtesting Protocol

1. **Train/Test Split**: 70% train, 15% validation, 15% test (time-ordered)
2. **Walk-forward validation**: Train on months 1-3, test on month 4, then retrain
3. **Out-of-sample testing**: Final evaluation on completely unseen data
4. **Statistical significance**: Require p < 0.05 for improvement claims

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Overfitting to historical patterns | Model fails on new market conditions | Regularization, dropout, early stopping, diverse training data |
| Reward hacking | Agent finds loopholes in reward function | Careful reward design, monitor intermediate rewards |
| Distribution shift | Market dynamics change over time | Regular retraining, monitor performance drift |
| Latency issues | Exit signals arrive too late | Cache model locally, pre-compute states |
| Catastrophic forgetting | Model forgets old patterns when learning new | Experience replay with prioritization |

---

## 13. Estimated Complexity and Timeline

### Development Phases

| Phase | Duration | Tasks |
|-------|----------|-------|
| **1. Data Pipeline** | 1 week | Export training data from Supabase, build state reconstruction |
| **2. Training Infrastructure** | 1 week | Set up Python service, implement DQN with stable-baselines3 |
| **3. Offline Training** | 1 week | Train on historical data, hyperparameter tuning |
| **4. Integration** | 1 week | Connect to Parallax, shadow mode implementation |
| **5. Evaluation** | 1 week | Paper trading, A/B testing framework |
| **6. Rollout** | 2 weeks | Gradual production rollout, monitoring |

**Total: 8 weeks** (with buffer for iteration)

### Effort Estimate

- **Engineering hours**: 80-120 hours
- **Compute cost**: ~$50-100 for training (GPU instances)
- **Ongoing cost**: Minimal (inference is lightweight)

---

## 14. Appendix: Alternative Approaches Considered

### A. Supervised Learning (Exit Classifier)

Train a classifier to predict "should exit now?" based on historical optimal exits.

**Pros:** Simpler, faster to train  
**Cons:** Doesn't learn sequential decision-making, requires labeled "optimal exit" which is subjective

### B. Genetic Algorithm for Parameter Optimization

Evolve the current time-decay parameters (decay rate, floor, etc.)

**Pros:** No code changes, easy to implement  
**Cons:** Still uses fixed curves, can't adapt to market state

### C. Contextual Bandits

Simpler than full RL — learn action-value without state transitions.

**Pros:** Faster training, less data needed  
**Cons:** Ignores temporal dynamics (hold time matters!)

### D. Human-Designed Rules Expansion

Add more conditions to the existing if/else logic based on data analysis.

**Pros:** Interpretable, no ML overhead  
**Cons:** Doesn't scale, hard to capture complex patterns

---

## 15. Conclusion

An RL-based exit optimization system is feasible and potentially impactful for Parallax. The recommended approach is:

1. **Algorithm**: Dueling Double DQN (D3QN) for sample efficiency
2. **Implementation**: Python microservice using stable-baselines3
3. **State space**: 18 features covering spread dynamics, time, volatility, and market context
4. **Action space**: Discrete (HOLD, EXIT, WAIT_AND_REASSESS)
5. **Reward**: Risk-adjusted P&L with time efficiency and exit reason bonuses/penalties

The system can be built incrementally, starting with offline training on historical data and progressing to shadow mode before live deployment. With proper evaluation and rollout, this approach could significantly reduce max_hold_time exits and improve overall profitability.

---

## 16. Next Steps (If Approved)

1. [ ] Export 3+ months of training data from Supabase
2. [ ] Set up Python microservice skeleton with FastAPI
3. [ ] Implement state reconstruction from discount_history
4. [ ] Train initial D3QN model offline
5. [ ] Build integration layer in meanReversionSignal.ts
6. [ ] Deploy shadow mode and collect comparison data
7. [ ] Analyze results and iterate on reward function
8. [ ] Gradual production rollout with monitoring
