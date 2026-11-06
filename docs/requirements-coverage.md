# Source requirements and implementation coverage

This matrix traces the three supplied articles to executable code, research tools, and external setup boundaries. `IMPLEMENTED` describes repository capability, not proof of real trading performance, a configured external account, or an attended live deployment.

## Supplied sources

| Label | Uploaded source | Relevant sections |
|---|---|---|
| JEV | `貼上的文字 (2)(1).txt` | Parts 2 through 6: deterministic features, typed judgments, policy, execution, risk, calibration |
| QUANT | `貼上的文字 (3).txt` | Parts 1, 2, 4 and 5: four mathematical model families, engineering process, six system layers |
| DESK | `貼上的文字 (1)(4).txt` | Parts 2 through 4: six roles, rules, integrations, indicator, routines, paper-to-live requirements |

The requested exclusion is `npx agenkit install engineering-kit`. It has not been run and is not a dependency of this implementation. AgenKit license activation, advertising calls to action and vendor claims about model ability are not executable product requirements.

## Status meaning

| Status | Meaning |
|---|---|
| IMPLEMENTED | The working code path exists; local verification covers its described behavior. External operations still require their own configuration and evidence. |
| RESEARCH | A working numerical or evaluation module; no automatic live strategy or profitability claim. |
| CONFIGURATION READY | Adapter, manifest or export boundary exists; an external account, OAuth grant, credentials or user configuration is still required. |
| NOT RUN | The actual external action or operational evidence has not been observed in this implementation session. |
| LIMITATION | The source describes a capability beyond the current executable path; it is not disguised as a credentials issue. |
| EXCLUDED | The user's explicit exclusion. |

## Jev and the execution engine

| ID | Source requirement | Implementation and verification evidence | Status |
|---|---|---|---|
| JEV-01 | Compute facts in code; isolate probabilistic judgments | `src/engine/state.ts`, `src/engine/decisions.ts`, `src/engine/policy.ts`; point-in-time and probability validation tests | IMPLEMENTED |
| JEV-02 | Mid, microprice, 1m/5m/30m returns, spread, depth and imbalance | `src/engine/state.ts`; insufficient history remains missing rather than fabricated | IMPLEMENTED |
| JEV-03 | Flow volumes/intensities, volatility, reference divergence, basis and funding | `src/engine/state.ts`; optional source-stamped observations with freshness and coverage checks | IMPLEMENTED |
| JEV-04 | Queue position, 24-hour baselines and execution health | Typed optional inputs in `src/engine/types.ts`; unknown observations remain null | IMPLEMENTED; actual queue/reference/baseline feeds depend on configured data |
| JEV-05 | Six atomic questions in one request, mixing Choice/Noul/Score | `src/engine/decisions.ts`, `scripts/decision-smoke.ts`; direct REST schema, exactly six answers, probability/score checks | IMPLEMENTED; actual paid Jev requests NOT RUN |
| JEV-06 | Pin model version, log decisions and measured latency | `src/engine/decisions.ts`, `src/trader.ts`, `src/engine/journal.ts`; moving aliases rejected for live Jev | IMPLEMENTED |
| JEV-07 | Compact state budget and strict timestamp discipline | `compactSnapshot`, immutable snapshot fingerprint, source-age/warmup checks; budget is explicitly an estimate | IMPLEMENTED |
| JEV-08 | Toxicity/liquidity/confidence/inventory policy and fallback ladder | `src/engine/policy.ts`; late or mismatched decisions cannot authorize quotes; deterministic fallback is explicit | IMPLEMENTED |
| JEV-09 | A-S reservation price and bid/ask spread | `src/quant/avellaneda-stoikov.ts`, wired by `src/trader.ts`; correct full/half spread and zero-gamma limit | IMPLEMENTED |
| JEV-10 | Block loop, WebSocket and polling backstop, stale response handling | `src/chain.ts`, `src/trader.ts`, `src/book.ts`; generation and deadline handling in runtime | IMPLEMENTED |
| JEV-11 | Max position/order/loss/drawdown/age/leverage/errors/latency | `src/engine/risk.ts`; pending and open exposure count before a new order | IMPLEMENTED |
| JEV-12 | Cancel/reprice/post-only, gas honesty and quote residence | `src/execution/kuru.ts`, `src/engine/economics.ts`, `src/trader.ts`; cost veto, hourly gas cap, minimum residence and reprice thresholds | IMPLEMENTED |
| JEV-13 | Confirm orders and fills; reconcile restarts and ambiguous submits | `src/execution/kuru.ts`, `src/engine/journal.ts`, `src/trader.ts`; durable operation identity, receipts and reconciliation | IMPLEMENTED; real wallet/broker execution NOT RUN |
| JEV-14 | Kill switch, cancel, flatten and alert without false success | `src/trader.ts`, venue adapters and dashboard; unresolved exposure remains recovery-pending | IMPLEMENTED; external emergency liquidation NOT RUN |
| JEV-15 | Four comparable policy baselines with identical data/costs/limits | `src/evaluation/replay.ts`; production state/policy/risk/economics functions, conservative trade-through fills and exact-state recordings | IMPLEMENTED; actual LLM/Jev comparison NOT RUN |
| JEV-16 | Sharpe, Sortino, drawdown, hit rate, costs, slippage, adverse selection and coverage | `src/evaluation/metrics.ts`; undefined statistics are null; synthetic metrics are labeled | IMPLEMENTED |
| JEV-17 | Reliability bins, Brier, log loss, ECE and Platt scaling | `src/evaluation/calibration.ts`; matured training labels, purging, future disjoint validation and model-version checks | IMPLEMENTED; venue calibration NOT RUN |
| JEV-18 | Fractional Kelly after appropriate calibration | `src/quant/kelly.ts`; general payoff ratio, held-out trade-profit labels, local probability support and size cap | RESEARCH; no default live size increase |

## Mathematical models and engineering workflow

| ID | Source requirement | Implementation and verification evidence | Status |
|---|---|---|---|
| QUANT-01 | OU/statistical arbitrage, z-scores and half-life filter | `src/quant/ou.ts`, `backtestPairs` in `src/evaluation/strategy.ts`; prefix fit, next-bar execution, both-leg costs | RESEARCH |
| QUANT-02 | Market making with inventory and volatility | `src/quant/avellaneda-stoikov.ts`; main runtime uses this model with independent risk and cost gates | IMPLEMENTED |
| QUANT-03 | Hawkes order-flow intensity and persistence | `src/quant/hawkes.ts`; predictable intensity, analytic likelihood, stationary bounded parameter search | RESEARCH |
| QUANT-04 | Heston volatility/options model and calibration path | `src/quant/heston.ts`; risk-neutral European Monte Carlo, full truncation, uncertainty and training-only candidate selection | RESEARCH |
| QUANT-05 | Data, signal, decision, risk, execution and monitoring layers | `src/engine`, `src/quant`, `src/execution`, `src/trader.ts`, `src/server.ts`, `src/dashboard.ts` | IMPLEMENTED |
| QUANT-06 | Focused design/build/review/test disciplines without AgenKit | Explicit module contracts, requirement matrix, negative-path tests and source-backed math documentation | IMPLEMENTED; no claim that ten hosted Astra agents were provisioned |
| QUANT-07 | CI, deploy verification, rollback and operational inspection | `.github/workflows/ci.yml`, `docs/operations.md`, health/metrics/audit endpoints, backup and readiness commands | IMPLEMENTED; actual hosting deployment NOT RUN |
| QUANT-08 | Engineering kit installation | `npx agenkit install engineering-kit` | EXCLUDED |
| QUANT-09 | Hyperliquid examples, options venues and other markets | Mathematical APIs are reusable; the execution runtime remains Kuru/Monad, with a separate US-equity desk adapter | LIMITATION: no new Hyperliquid/options venue connector or automatic model promotion |

## Research desk, indicator and routines

| ID | Source requirement | Implementation and verification evidence | Status |
|---|---|---|---|
| DESK-01 | Chief, Scout, Chart, Strategist, Risk and Trader roles | `src/desk/types.ts`, `src/desk/workflow.ts`; role capability allowlists and enforced ordered stages | IMPLEMENTED |
| DESK-02 | Shared desk rules, paper capital, risk, losses and position caps | `src/desk/types.ts`, `src/desk/risk.ts`, `config/desk.example.json`; configurable deterministic checks | IMPLEMENTED |
| DESK-03 | Source/timestamp evidence, no invented results, rumor/promotion rejection | `src/desk/evidence.ts`, Scout stage in workflow; immutable evidence and synthetic provenance | IMPLEMENTED |
| DESK-04 | Chart evidence, 1–10 score and threshold of seven | Chart stage checks daily/4h trends, support/resistance, RSI, averages, volume, Desk Signal and three-line explanation | IMPLEMENTED |
| DESK-05 | Exact entry/stop/target/size and robust backtest acceptance | `src/desk/backtest.ts` executes the named Desk Signal long strategy on supplied daily bars with a sourced event calendar, next-bar limits/brackets, risk sizing, fees/slippage and two real sensitivity runs; exact plan/evidence binding plus `assessStrategyEvidence` gates three years, thirty trades and recent-year results | IMPLEMENTED for `desk-signal-long-v1`; real historical strategy qualification NOT RUN; unrelated strategies require their own executable rules |
| DESK-06 | Independent risk veto, correlated exposure, events and stop review | `src/desk/risk.ts`; fresh account/quote evidence, correlation/event completeness and portfolio checks | IMPLEMENTED |
| DESK-07 | Only Trader submits approved unchanged plans; no chasing | `src/desk/workflow.ts`; hash-bound expiring approval, fresh pre-submit recheck and stable client order ID | IMPLEMENTED |
| DESK-08 | Limit entry, attached stop/target, confirm fills and reconcile | `src/integrations/paper-broker.ts`, `src/integrations/alpaca.ts`; bracket verification, partial/unknown states and reconciliation | IMPLEMENTED for local paper, Alpaca paper and separately gated live; authenticated broker orders NOT RUN |
| DESK-09 | Daily loss/streak/stale/slippage/rule kill; cancel/flatten/pause | Desk risk/workflow and broker emergency methods; keep kill latched until separately reviewed | IMPLEMENTED; actual external liquidation NOT RUN |
| DESK-10 | Auditable Trade Journal with all fourteen requested columns | `src/desk/journal.ts`; SQLite evidence/event history, durable state and spreadsheet-safe CSV export | IMPLEMENTED |
| DESK-11 | Failed ideas retained and repeated identical failures rejected | Strategist stage stores a strategy/symbol/parameter/dataset fingerprint | IMPLEMENTED |
| DESK-12 | Morning/close briefs and weekly review | Chief methods and scheduler jobs; weekly review compares equal-duration historical outcomes and pauses below-range/unknown-cost strategies; outputs are local artifacts/journal entries, not sent messages | IMPLEMENTED; external notifications and real historical/paper comparison NOT RUN |
| DESK-13 | Premarket, half-hour Scout, hourly Chart, nightly backtest, pre-order Risk and quarter-hour Trader | `src/desk/scheduler.ts`, `src/desk/runner.ts`, synchronous workflow risk; nightly raw-job execution and evidence/plan verification through `executeDeskBacktest`; absent raw jobs explicitly return `NOT_RUN` | IMPLEMENTED dispatch and computation; actual externally sourced routines NOT RUN |
| DESK-14 | Eastern time, holidays, early closes and restart idempotency | Explicit NYSE 2026 calendar; UTC-minute enumeration handles DST folds/gaps; injected atomic store claim with owner token | IMPLEMENTED; calendar updates required beyond declared coverage |
| DESK-15 | Continuous watchlist monitoring | Five-minute read-only monitoring jobs plus external provider/tool interface | CONFIGURATION READY; actual X/news monitoring NOT RUN |
| DESK-16 | Pine v6 EMA ribbon, breakout/volume/RSI signals, zones, ATR filter and alerts | `indicators/desk-signal.pine`; prior-bar breakout extrema, closed-bar signals, confirmation-time pivot zones, per-line comments | IMPLEMENTED source; native Pine compilation and chart installation NOT RUN |
| DESK-17 | TradingView quotes/history/screener/news/fundamentals/watchlists/alert-log access | `src/integrations/tradingview.ts`; authenticated MCP discovery and explicitly allowlisted read tools | CONFIGURATION READY; actual tool availability/OAuth NOT RUN |
| DESK-18 | Create/watchlist-manage TradingView alerts, authenticate and install indicator | Separate `TradingViewSetupClient` maps reviewed watchlist/alert purposes to actual discovered tools, requires explicit setup approval and excludes broker/order capabilities; discover/read/preview/setup CLI commands, Pine source and alert conditions supplied | IMPLEMENTED adapter / CONFIGURATION READY; actual OAuth, discovered setup capabilities, native Pine compilation and UI installation NOT RUN |
| DESK-19 | Google Sheets or Notion journal | `src/integrations/journal-export.ts` and journal-create/sync/reconcile CLI commands create either service's journal and append rows; injected transport, real API schemas, RAW Sheets values, typed Notion pages, durable operation claims, explicit write opt-in and ambiguous-write reconciliation; safe CSV remains available | IMPLEMENTED adapters / CONFIGURATION READY; OAuth/shared-parent setup and actual remote creation/appends NOT RUN |
| DESK-20 | Grok Bot team, memory, plugins and routines on hosted computers | Repository role contracts, job scheduler and onboarding/runbook boundary | CONFIGURATION READY; hosted Grok Bot provisioning/account setup NOT RUN |
| DESK-21 | Fourteen paper days, comparison to backtest, tiny first live size, explicit per-order approval | `src/desk/live-authorization.ts` verifies hash-linked journal and backtest artifacts, derives observed paper metrics and requires bound per-order authorization; Kuru has its separate session/evidence path | IMPLEMENTED gates; real paper history and readiness evidence NOT RUN |
| DESK-22 | Switch Alpaca from paper to actual approved live transport | Separate `AlpacaLiveBroker` with fixed live endpoint, account binding, fresh artifact revalidation, per-order approval and explicit configuration; paper cannot silently switch endpoints | IMPLEMENTED; authenticated live transport and orders NOT RUN |

## Material corrections and limits

1. The Jev article's alleged half-spread formula is the full A-S spread. The implementation corrects it and tests the zero-risk-aversion limit.
2. `2p - 1` assumes even-money payoffs. General Kelly sizing needs a net payoff ratio and calibration for the actual trade outcome; absent evidence yields zero allocation.
3. A fitted OU coefficient does not prove cointegration. Pair research reports `NOT_TESTED` and is not automatically activated for live execution.
4. High Hawkes persistence is not a certain directional move. Heston Monte Carlo uncertainty excludes discretization and model error.
5. A provider's own confidence or latency claims do not demonstrate venue calibration, profitability or end-to-end latency here.
6. Historical records cannot be reused after a counterfactual policy changes the portfolio snapshot. Missing matching records remain `NOT_RUN`.
7. A synthetic test run cannot satisfy fourteen paper days, a three-year real backtest, live account setup, a completed cancellation, or a verified flatten.
8. The articles' vendor prices, speed comparisons, business claims and promises about profitability are not treated as implementation acceptance criteria.

## Verification entry points

```sh
bun run verify
bun test tests/quant-models.test.ts tests/evaluation-calibration.test.ts tests/evaluation-replay.test.ts tests/desk-scheduler.test.ts
bun test tests/desk-backtest.test.ts tests/journal-export.test.ts
bun run scripts/quant.ts
bun run scripts/evaluate.ts --synthetic
```

Mathematical references, units, replay assumptions and data schemas are documented in [quant-models.md](quant-models.md). The concrete nightly path and exact strategy boundary are documented in [desk-backtesting.md](desk-backtesting.md); remote document adapters and recovery semantics in [journal-integrations.md](journal-integrations.md). Operational controls and external execution boundaries are documented in [operations.md](operations.md). The final implementation report must retain every `NOT RUN` and `LIMITATION` distinction above even when the local test suite passes.
