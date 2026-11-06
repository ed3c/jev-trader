# Jev Trader: execution engine and research desk

A Bun/TypeScript trading system built on [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader). This implementation adds the deterministic features, six-question Jev decision layer, risk controls, quantitative research modules and six-role trading desk described in the supplied articles.

**The default is paper trading with an offline deterministic provider.** Starting the program with a private key does not enable live trading. The system can observe, hold, reduce exposure or quote both sides; it does not require an order on every block. The requested `npx agenkit install engineering-kit` command is excluded and AgenKit is not a dependency.

There are two separate workflows:

| Workflow | Market and execution | Entry point |
|---|---|---|
| Block execution engine | Kuru MON–USDC on Monad; local paper or explicitly authorized live transport | `bun run start` |
| Research desk | US-equity evidence, six roles, session-aware routines, local simulation and opt-in Alpaca adapters | `bun run desk` |

They keep separate accounts, approvals and journals. Quantitative research does not automatically promote a model into either live workflow.

## Run an offline demonstration

Use **Bun 1.4.4**, matching the lockfiles, CI and container.

```sh
bun install --frozen-lockfile
bun run verify
bun run decision:smoke
bun run demo --blocks 100 --data-dir data/demo
bun run desk demo --journal data/desk-demo.sqlite --csv data/trade-journal.csv
```

These commands require no broker account, wallet, paid model call or API key. Demo prices, orders and fills are explicitly synthetic. They demonstrate software behavior and cannot satisfy real-market admission requirements.

Start the built-in read-only dashboard:

```sh
bun run demo --serve --port 3000 --data-dir data/demo-service
```

Open [http://127.0.0.1:3000/dashboard](http://127.0.0.1:3000/dashboard). The retained Next.js interface is available separately:

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). `NEXT_PUBLIC_API_URL` defaults to the local engine on port 3000. The browser receives no signing keys or broker credentials.

## Use actual market data in paper mode

```sh
cp .env.example .env
bun run start
```

Defaults are `MODE=paper`, `DRY_RUN=true` and `MODEL=mock`. The Kuru source reads actual block-pinned books and trade logs. Empty books, stale data, gaps and insufficient history remain explicit unavailable states. They are not replaced with synthetic observations.

For Jev inference, set `MODEL=jev` and `TYPESAFE_API_KEY`; the previous `TYPESAFE_AI_API_KEY` name remains accepted. A pinned model version is required. The configured model is `jev-1.14.0`; the model ID and actual decision latency are logged. Deterministic fallback is separately labeled and configurable. The optional `bun run decision:smoke --live` command makes a real provider request and is excluded from CI.

### How a block becomes an order

1. Capture a coherent book, trades, source timestamps and portfolio state.
2. Calculate price/flow/depth/volatility features in code. Preserve unknown observations.
3. Ask six typed atomic questions in one request, then validate identities, probabilities, scores and deadline.
4. Compose an execution policy independently from the directional judgment.
5. Calculate inventory-aware A–S quotes and check net edge, quote lifetime, worst-case exposure and hard risk limits.
6. Persist the exact intent before a write; reconcile receipts and unique fills into the durable account ledger.

A newer block invalidates an older decision. An uncertain send keeps its reservation and transaction identity. Risk and authorization are checked again immediately before broadcast. Known receipt fees are recorded even when order effects still need reconciliation.

## Research and evaluation

```sh
bun run quant --model all --output data/quant-examples.json
bun run evaluate --synthetic --output data/evaluation.json
bun run evaluate --data historical-replay.json --config replay-config.json --output data/historical-evaluation.json
bun run evaluate --calibration samples.json --training-end 1790000000000
bun run evaluate --pairs pair-history.json
```

| Module | Implemented behavior | Scope |
|---|---|---|
| Avellaneda–Stoikov | Reservation price, full/half spread, inventory skew, volatility and tick-aware quotes | Integrated into the execution engine |
| Ornstein–Uhlenbeck | Prefix-only fitting, z-scores, half-life, pair backtest with next-bar execution and both-leg costs | Research; cointegration is not assumed |
| Hawkes | Predictable intensity, likelihood and bounded stationary fitting | Order-flow research |
| Heston | European option Monte Carlo, full truncation and training-only parameter selection | Options research; uncertainty is reported |
| Four policy baselines | Shared data/cost/risk assumptions; exact-state recorded LLM/Jev responses | Missing provider recordings are `NOT_RUN` |
| Calibration and sizing | Brier/log loss/ECE, reliability bins, purged chronological Platt validation, constrained fractional Kelly | No calibrated sizing without suitable held-out outcomes |

The A–S implementation corrects the article's full-spread versus half-spread ambiguity. Kelly uses the net payoff ratio; `2p - 1` is not treated as a universal sizing formula. [Quant model documentation](docs/quant-models.md) explains the equations, data contracts, original references and limits.

## Six-role research desk

The enforced route is **Scout → Chart Analyst → Strategist → Risk Officer → Trader**, coordinated by Chief. The workflow keeps source-stamped evidence, rejects skipped stages, retains failed ideas, binds approvals to exact plans and prevents additional execution while an earlier result remains unresolved.

```sh
bun run desk demo --journal data/desk-demo.sqlite --input-out data/desk-demo-input.json
bun run desk replay --input data/desk-demo-input.json --synthetic-demo
bun run desk schedule --at 2026-11-06T14:30:00Z
bun run desk export --journal data/desk-demo.sqlite --out data/trade-journal.csv
bun run desk templates --out data/grok-desk-templates.md
```

`service --config config/desk.example.json` runs the scheduled workflow against a configured evidence provider. The example deliberately requires an input file; it does not fabricate news, chart analysis or historical results. Routines follow `America/New_York`, an explicit exchange calendar, holidays and early closes. Calendar coverage is checked; the built-in calendar covers 2026.

The desk includes Alpaca bracket-order handling, TradingView MCP discovery, a fourteen-column journal, portable Grok role templates and [Desk Signal](indicators/desk-signal.pine), a Pine Script v6 indicator with EMA ribbon, breakout/volume/RSI rules, confirmed swing zones, ATR filter and alert conditions. The [desk runbook](docs/research-desk.md) describes integration configuration, write permissions and evidence contracts.

## Risk, persistence and live admission

Hard limits cover order size, position, pending exposure, daily loss, drawdown, inventory age, leverage, stale data, errors and decision latency. Paper fills share available print volume, account for queue-ahead liquidity and survive restart without replaying the same trades.

SQLite records immutable event identities and transactional checkpoints. A persistence failure stops trading. The kill latch survives restart. Recovery cancels and attempts bounded exposure-reducing limits; an unfillable residual or unknown transaction remains visible as `kill_recovery_pending`. Sending a cancel or exit is not reported as a verified flat account.

Kuru live mode requires separate explicit settings, a complete reconciliation range and an expiring wallet/session/strategy-bound authorization referencing a real readiness report. Actual paper history and historical comparison are required. Alpaca has its own per-plan admission controls. Neither synthetic fixtures nor a passing unit test establish readiness for funded operation.

No automatic account creation, token approval, margin deposit or paid inference occurs in the default paths. See [Operations](docs/operations.md) before configuring an external account.

## API and operations

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /` | Read-only | Latest block and current engine status |
| `GET /history` | Read-only | Bounded recent events |
| `GET /events` | Read-only | SSE updates with client limits and cleanup |
| `GET /dashboard` | Read-only | Operations view |
| `GET /healthz` | Read-only | Readiness and kill state |
| `GET /metrics` | Read-only | Prometheus-format measurements |
| `GET /audit` | Bearer `CONTROL_TOKEN` | Audit events |
| `POST /control/kill` | Bearer `CONTROL_TOKEN` | Latch halt and attempt bounded recovery |

The default listener is loopback. No HTTP route enables live mode or clears a kill. Docker/Compose, CI, consistent SQLite backup and rollback instructions are included; deployment must be verified in its actual environment.

```sh
bun run backup -- data/engine.sqlite backups/engine-before-upgrade.sqlite
bun run readiness --db data/engine.sqlite --backtest accepted-backtest.json --out data/readiness.json
```

## Repository map and evidence

| Path | Responsibility |
|---|---|
| `src/engine/` | Features, typed decisions, policy, risk, costs, authorization and ledger |
| `src/execution/` | Paper fill engine and durable Kuru transport |
| `src/quant/`, `src/evaluation/` | Mathematical models, calibration, historical backtests and baseline replay |
| `src/desk/`, `src/integrations/` | Role workflow, rules, journal, routines and service adapters |
| `src/trader.ts`, `src/chain.ts`, `src/trades.ts` | Runtime, block feed, gap handling and maker/taker fills |
| `src/server.ts`, `src/dashboard.ts`, `web/` | API, operations view and Next.js dashboard |
| `scripts/`, `tests/`, `.github/workflows/` | Runnable tools, failure-path tests and CI |

- [Requirements coverage](docs/requirements-coverage.md) maps all three supplied articles and records exclusions and external boundaries.
- [Decision engine](docs/decision-engine.md) documents feature and model contracts.
- [Validation report](docs/validation.md) records observed checks separately from external actions that were not run.
- [Operations](docs/operations.md) covers configuration, reconciliation, live admission, recovery, backup and rollback.

The upstream MIT license and attribution are retained. This repository contains an implementation and its engineering evidence, not a claim of profitable trading or a provisioned hosted trading team.
