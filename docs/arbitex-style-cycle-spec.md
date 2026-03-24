# Arbitex-Style Cycle Spec

Last updated: 2026-03-23

This document captures the cycle mechanics described in the product thread.
It does not assert that the strategy is accepted by any prop firm. It defines
the internal math and product behavior needed to model the cycle in PairGrid.

## Core Idea

One cycle combines:

- one prop evaluation account
- one private broker account
- one asymmetric hedge ratio between the two

The system is designed so that:

- if the prop account fails at any stage, the broker should recover:
  - challenge cost
  - accumulated broker losses from previous passed stages
  - target net profit
- if the prop account passes, the broker accepts a proportional loss and the
  next stage increases the required broker recovery target

## Execution Mechanics

### Trade Entry

- Prop trade and broker trade open at the same time
- Direction is not important to the cycle engine
- The prop account is the leading leg
- The broker account is the follower leg

Operational interpretation:

- the strategy engine receives a prop-side order intent
- the same event immediately generates the broker-side opposite or paired order
  using the active broker multiplier for the current phase

### Sizing Authority

- Prop lot size is the source of truth
- Broker lot size is derived from the prop lot size
- Broker size formula:
  - `broker_lot_raw = prop_lot * current_multiplier`
- Broker lot precision:
  - round up to the nearest allowed broker step
- Launch assumption:
  - broker minimum lot step = `0.01`

### Broker Lot Rounding

If broker lot tick differs from `0.01`, the system still rounds up to the next
valid tradable lot increment.

Generic formula:

- `broker_lot_final = ceil(broker_lot_raw / broker_lot_step) * broker_lot_step`

Examples:

- if `broker_lot_raw = 0.1529` and `broker_lot_step = 0.01`
  - `broker_lot_final = 0.16`
- if `broker_lot_raw = 0.1529` and `broker_lot_step = 0.1`
  - `broker_lot_final = 0.2`

Product consequence:

- the backend must store both:
  - raw theoretical multiplier result
  - rounded executable broker lot

## Working Example

Current canonical example from the product thread:

- Prop size: `100_000 USD`
- Prop max loss: `10_000 USD`
- Broker initial equity: `4_000 USD`
- Challenge cost: `529 USD`
- Net target if cycle ends in prop failure: `1_000 USD`
- Broker lot precision: `0.01`

## Constants

Let:

- `D = prop_max_loss`
- `C = challenge_cost`
- `N = desired_net_profit_if_fail`
- `B0 = initial_broker_equity`

Then:

- `base_recovery_target T0 = C + N`
- `base_multiplier M0 = T0 / D`

For the canonical example:

- `D = 10_000`
- `T0 = 529 + 1_000 = 1_529`
- `M0 = 1_529 / 10_000 = 0.1529`

## Phase Ratios

For a `100k` FundingPips 2-Step cycle:

- Student target = `8_000 = 0.8 * D`
- Practitioner target = `5_000 = 0.5 * D`
- First funded payout target used in the example = `5_000 = 0.5 * D`

Define:

- `R1 = 0.8`
- `R2 = 0.5`
- `R3 = 0.5`

## Pass / Fail Mechanics

At phase `i`, if the prop account fails:

- broker gain = current recovery target `Ti`
- cycle closes successfully from the strategy perspective

At phase `i`, if the prop account passes:

- broker loss = `Ti * Ri`
- next recovery target = `Ti+1 = Ti + (Ti * Ri) = Ti * (1 + Ri)`
- next multiplier = `Mi+1 = Ti+1 / D`

This creates the invariant:

- failure at any stage should bring broker equity back to
  `B0 + C + N`

## Cycle State Machine

The cycle is discrete and branch-based.

### State Path

1. `phase_1_active`
2. `phase_1_passed` or `phase_1_failed`
3. if passed:
   - `phase_2_active`
4. `phase_2_passed` or `phase_2_failed`
5. if phase 2 passed:
   - `funded_active`
6. `funded_failed` or `funded_payout_reached`

### Reset Rules

The cycle resets when:

- the challenge fails in phase 1
- the challenge fails in phase 2
- the funded account fails

### Payout Stop Rule

If the funded account reaches the payout target:

- the current cycle stops
- the cycle does not continue automatically
- the system waits until broker balance/equity becomes positive again
- once broker capital is restored, a new cycle can begin

Implementation interpretation:

- payout is not just an event, it is a terminal cycle state
- a broker refill may come from:
  - prop payout transfer
  - external deposit
- a new cycle should require an explicit `restart_ready` condition

### Terminal States

Terminal states for one cycle:

- `closed_on_phase_1_fail`
- `closed_on_phase_2_fail`
- `closed_on_funded_fail`
- `closed_on_funded_payout`

### Restart Condition

A cycle can restart only when:

- broker account equity is positive again
- required configuration for a new prop cycle is present
- user or automation explicitly starts a new cycle

## Canonical 100k Walkthrough

### Stage 1: Student

- `T0 = 1_529`
- `M0 = 0.1529`

#### Fail Student

- Prop result: `-10_000`
- Broker result: `+1_529`
- Final broker equity: `4_000 + 1_529 = 5_529`

#### Pass Student

- Prop result: `+8_000`
- Broker loss: `1_529 * 0.8 = 1_223.2`
- Final broker equity: `4_000 - 1_223.2 = 2_776.8`
- Next recovery target:
  - `T1 = (1_223.2 + 529) * 1.2 = 2_102.64`
- Next multiplier:
  - `M1 = 2_102.64 / 10_000 = 0.210264`

### Stage 2: Practitioner

Current revised product rule:

- phase 1 broker loss = `phase_1_base_target * 0.8`
- phase 2 recovery target:
  - `(phase_1_loss + challenge_fee) * 1.2`
- phase 2 pass loss:
  - `phase_2_recovery_target * 0.5`

Example with `phase_1_base_target = 1_529` and `challenge_fee = 529`:

- `phase_1_loss = 1_529 * 0.8 = 1_223.2`
- `T1 = (1_223.2 + 529) * 1.2 = 2_102.64`
- `M1 = 2_102.64 / 10_000 = 0.210264`

#### Fail Practitioner

- Prop result: `-10_000`
- Broker result: `+2_102.64`
- Final broker equity: `2_776.8 + 2_102.64 = 4_879.44`

#### Pass Practitioner

- Prop result: `+5_000`
- Broker loss: `2_102.64 * 0.5 = 1_051.32`
- Final broker equity: `2_776.8 - 1_051.32 = 1_725.48`
- Next recovery target:
  - funded logic is no longer derived from `T1 + loss`
- Next multiplier:
  - funded uses a fixed prop-to-broker ratio of `0.40`

### Stage 3: Funded / Master

Current revised product rule:

- prop lot `1.00` -> broker lot `0.40`
- funded multiplier is fixed, not recursively derived from previous stages
- for a `100k` account with static `10k` drawdown:
  - `funded recovery target = 10_000 * 0.40 = 4_000`
  - `funded pass loss at +5% = 4_000 * 0.5 = 2_000`

#### Fail Funded Account

- Prop result: `-10_000`
- Broker result: `+4_000`
- Final broker equity: `1_725.48 + 4_000 = 5_725.48`

#### Reach First Payout at +5%

- Gross payout target: `5_000`
- Payout split assumption in the example: `80%`
- Real payout received: `4_000`
- Broker loss: `4_000 * 0.5 = 2_000`
- Broker equity before payout transfer:
  - `1_725.48 - 2_000 = -274.52`

Conclusion:

- without added broker capital, the private broker account is exhausted before
  the first funded payout path completes
- the funded payout can then be used to refill the broker account and restart
  or continue a new cycle

## Key Invariants

### Recovery Logic

With the revised product rule:

- phase 1 keeps the original asymmetric target logic
- phase 2 is derived from:
  - `phase_1_loss + challenge_fee + 20%`
- funded does not reuse recursive growth
- funded uses a fixed broker ratio of `0.40`

This means there is no longer a single fixed terminal-equity invariant shared by
all fail branches.

### Broker Survival Threshold

Ignoring margin constraints and considering only equity:

- to survive until after Student + Practitioner passes:
  - `required_broker_equity > phase_1_loss + phase_2_pass_loss`
- to survive until after the first funded payout target:
  - `required_broker_equity > phase_1_loss + phase_2_pass_loss + funded_pass_loss`

Canonical example:

- to survive through phase 2 pass:
  - `> 1_223.2 + 1_376.1 = 2_599.3`
- to survive funded +5% path:
  - `> 1_223.2 + 1_376.1 + 2_064.15 = 4_663.45`

Since `B0 = 4_000`, the funded payout route creates an equity deficit even
before considering broker margin requirements.

## Product Implications

This strategy is not only a trade execution engine. It is a cycle-management
engine with capital accounting.

The system must track:

1. Cycle state
   - active phase
   - pass/fail/payout outcome
   - cycle closed or reset

2. Capital state
   - broker starting equity
   - current broker equity
   - challenge cost
   - cumulative broker loss
   - expected recovery target

3. Multiplier state
   - current asymmetry ratio
   - raw ratio
   - rounded broker lot ratio at `0.01`

4. Phase targets
   - current prop target amount
   - current pass ratio vs drawdown budget
   - current fail recovery amount

5. Funded stress state
   - payout target under test
   - broker deficit if payout path succeeds
   - refill required from payout proceeds

## Backend Objects

Minimum strategy-specific objects:

### `strategy_cycles`

- `id`
- `user_id`
- `prop_firm`
- `program`
- `account_size`
- `challenge_cost`
- `net_target`
- `broker_initial_equity`
- `prop_max_loss`
- `status`

### `cycle_phases`

- `cycle_id`
- `phase_index`
- `phase_name`
- `prop_target_amount`
- `phase_ratio`
- `recovery_target_before_phase`
- `broker_multiplier_before_phase`
- `broker_equity_before_phase`
- `broker_equity_after_pass`
- `broker_equity_after_fail`

### `cycle_events`

- `cycle_id`
- `phase_name`
- `event_type`
  - `pass`
  - `fail`
  - `payout_requested`
  - `payout_received`
  - `reset`
- `prop_pnl`
- `broker_pnl`
- `notes`

### `capital_resets`

- `cycle_id`
- `source`
  - `external_deposit`
  - `prop_payout`
- `amount`
- `broker_equity_before`
- `broker_equity_after`

### `trade_pairs`

- `cycle_id`
- `phase_name`
- `prop_order_id`
- `broker_order_id`
- `prop_symbol`
- `broker_symbol`
- `prop_lot`
- `broker_lot_raw`
- `broker_lot_step`
- `broker_lot_final`
- `entry_timestamp`
- `status`

### `cycle_state_transitions`

- `cycle_id`
- `from_state`
- `to_state`
- `reason`
- `trigger_event_id`
- `created_at`

## Dashboard Requirements

The dashboard needs dedicated views for this math:

### Cycle Overview

- current phase
- broker equity
- current recovery target
- current multiplier
- terminal fail outcome

### Phase Path Cards

For each phase show:

- if pass
  - expected broker loss
  - next multiplier
  - next recovery target
- if fail
  - expected broker recovery
  - terminal broker equity

### Funded Stress Panel

- projected payout received
- projected broker deficit
- additional capital required
- reset amount from payout

### Warnings

- low broker equity
- insufficient broker margin for current multiplier
- funded payout path causes negative broker equity
- broker lot rounded upward beyond theoretical size
- cycle stopped waiting for broker equity recovery

### State Timeline

The dashboard should expose the discrete cycle path clearly:

- `Phase 1 active`
- `Phase 1 pass/fail`
- `Phase 2 active`
- `Phase 2 pass/fail`
- `Funded active`
- `Funded fail/payout`
- `Stopped`
- `Ready to restart`

## UX Interpretation

The most important UX insight from this strategy:

- the product is not simply "copy opposite trade"
- the product must explain a branching financial state machine clearly

The main screen should answer:

- where am I in the cycle?
- what happens if the phase passes?
- what happens if the phase fails?
- what broker capital is at risk right now?
- can I afford the next transition?

## Open Questions

Still needed for implementation:

1. Whether the broker follower order is always opposite to the prop order or
   symbol/direction mapping can vary per setup
2. Whether the broker multiplier is tied only to raw lot multiple or also
   constrained by stop-based risk logic
3. How correlated trades are grouped into one "idea"
4. How broker margin sufficiency is computed per symbol and leverage
5. Whether a funded payout always implies a fresh new challenge purchase
