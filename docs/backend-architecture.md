# PairGrid Backend Architecture

Last updated: 2026-03-23

This document translates the current product thread into a first backend
architecture for the strategy engine and dashboard.

## Goal

Build a backend that can:

- manage one active asymmetric setup at a time
- monitor FundingPips 2-Step accounts phase by phase
- sync prop and broker execution
- abort orphan legs immediately
- track cycle math and broker recovery targets
- stream live state to the dashboard over WebSockets

## High-Level Services

### 1. Account Sync Service

Responsibilities:

- connect to prop and broker accounts
- read balance, equity, open orders, positions, and fills
- persist account health
- emit disconnect or sync degradation events

### 2. Cycle Engine

Responsibilities:

- own the strategy cycle state machine
- advance phases on pass/fail
- stop cycle on funded payout
- mark cycle ready for restart only when broker equity becomes positive again

### 3. Risk Engine

Responsibilities:

- enforce one setup at a time
- enforce max two trades per day
- compute current phase target, fail threshold, daily loss remaining, total loss remaining
- compute current broker recovery target and multiplier
- enforce master-only restrictions later, including red-folder lockout

### 4. Sync Execution Engine

Responsibilities:

- receive prop order intent
- compute broker follower size from current multiplier
- round broker size up to the nearest valid lot step
- send prop and broker orders asynchronously
- wait for both ticket confirmations inside the sync timeout window

### 5. Orphan Kill Switch

Responsibilities:

- detect when one leg is filled and the other is not confirmed in time
- send immediate market close on the executed leg
- mark trade pair as `ORPHAN_ABORTED`
- stop strategy execution and emit critical alert

### 6. Global Equity Watcher

Responsibilities:

- monitor prop equity in a tight loop
- trigger emergency close on phase pass
- trigger emergency close on hard fail
- update dashboard state in real time

### 7. Daily Session Controller

Responsibilities:

- reset counters at `00:00` prop server time
- snapshot daily starting balance and equity
- store the higher day-start reference
- track `Daily_Trades_Count`

### 8. Market Gap Memory

Responsibilities:

- store prop execution ms
- store broker execution ms
- store slippage differential
- compute a rolling quality score for execution timing

### 9. Dashboard Stream Gateway

Responsibilities:

- push account updates, trade states, risk events, and system logs over WebSockets
- fan out updates to:
  - main command center
  - risk & execution view
  - network & latency view

## Suggested Runtime Layout

### API Layer

- `Node.js` service
- authenticated REST API for:
  - accounts
  - cycle setup
  - settings
  - dashboard snapshots

### Realtime Layer

- WebSocket server
- dashboard subscriptions by user and by cycle

### Strategy Workers

- background workers for:
  - sync execution
  - orphan detection
  - equity watching
  - daily reset jobs
  - news blackout jobs

### Data Layer

- `PostgreSQL` for relational state
- `Redis` for:
  - pub/sub
  - job queues
  - short-lived execution locks
  - distributed timers

## Core Database Model

### `accounts`

- `id`
- `user_id`
- `account_type` -> `PROP` | `BROKER`
- `firm`
- `program`
- `phase`
- `initial_balance`
- `current_balance`
- `current_equity`
- `currency`
- `broker_lot_step`
- `is_active`
- `connection_status`

### `strategy_cycles`

- `id`
- `user_id`
- `prop_account_id`
- `broker_account_id`
- `status`
- `phase`
- `account_size`
- `challenge_cost`
- `net_target`
- `prop_max_loss`
- `broker_initial_equity`
- `broker_current_equity`
- `current_recovery_target`
- `current_multiplier_raw`
- `current_multiplier_display`
- `created_at`
- `closed_at`

### `cycle_state_transitions`

- `id`
- `cycle_id`
- `from_state`
- `to_state`
- `reason`
- `metadata`
- `created_at`

### `daily_sessions`

- `id`
- `cycle_id`
- `session_date`
- `server_timezone`
- `day_start_balance`
- `day_start_equity`
- `day_start_reference`
- `daily_loss_limit`
- `daily_loss_used`
- `trades_executed`
- `drawdown_hit`

### `trade_pairs`

- `id`
- `cycle_id`
- `phase`
- `symbol`
- `status` -> `PENDING` | `OPEN` | `CLOSED` | `ORPHAN_ABORTED`
- `prop_ticket_id`
- `broker_ticket_id`
- `prop_lot_size`
- `broker_lot_raw`
- `broker_lot_step`
- `broker_lot_final`
- `hidden_close_rule`
- `open_time`
- `close_time`

### `risk_events`

- `id`
- `cycle_id`
- `severity`
- `event_type`
- `message`
- `metadata`
- `created_at`

### `market_gap_memory`

- `id`
- `cycle_id`
- `pair`
- `recorded_at`
- `prop_execution_ms`
- `broker_execution_ms`
- `slippage_diff_pips`

### `payout_resets`

- `id`
- `cycle_id`
- `source` -> `PROP_PAYOUT` | `EXTERNAL_DEPOSIT`
- `amount`
- `broker_equity_before`
- `broker_equity_after`
- `created_at`

## Strategy Locks

To enforce one setup at a time:

- acquire a cycle execution lock before sending any new order pair
- reject any new signal if:
  - an order pair is `PENDING`
  - an order pair is `OPEN`
  - cycle status is not executable

## Critical State Machine

### Cycle States

- `phase_1_active`
- `phase_1_passed`
- `phase_1_failed`
- `phase_2_active`
- `phase_2_passed`
- `phase_2_failed`
- `funded_active`
- `funded_failed`
- `funded_payout_reached`
- `stopped_waiting_broker_recovery`
- `ready_to_restart`

### Critical Triggers

- prop target hit -> `EmergencyCloseAll()` -> `phase_passed`
- prop hard fail hit -> `EmergencyCloseAll()` -> `phase_failed`
- orphan leg -> `MarketClose(executed_leg)` -> `ORPHAN_ABORTED` -> stop execution
- funded payout reached -> stop cycle until broker equity positive

## Dashboard Data Contracts

### Main Command Center

Needs:

- system sync status
- prop equity and balance
- progress to target
- distance from hard loss floor
- broker equity and floating pnl
- current multiplier
- current cycle state

### Risk & Execution

Needs:

- daily quota counter
- active trade count
- current prop risk exposure
- hidden close rules
- emergency close action state
- orphan protection state

### Network & Latency

Needs:

- execution ms by side
- delta window
- slippage differential
- realtime system log feed
- market gap memory history

## Next Implementation Order

1. Build dashboard shell and mock domain data
2. Add normalized domain types and selectors
3. Build REST snapshot endpoint contract
4. Add WebSocket event schema
5. Implement cycle engine and risk calculations
6. Implement sync execution and orphan kill switch
