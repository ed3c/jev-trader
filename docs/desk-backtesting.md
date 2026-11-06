# Concrete nightly desk backtests

`src/desk/backtest.ts` implements `desk-signal-long-v1`: an explicit long-only daily-bar strategy derived from the supplied Desk Signal. It computes signals, executes simulated limit/bracket orders against supplied OHLCV bars, applies costs and risk limits, tests two parameter perturbations, creates immutable evidence, and generates a plan from the latest completed bar. It never substitutes synthetic prices for missing history.

This is the executable same-rule path for this named strategy. An unrelated strategy or a discretionary narrative needs its own rule implementation and validation. Calling `assessStrategyEvidence` on a supplied report remains evidence validation; it is not called a newly executed backtest.

## Data and commands

```sh
bun run desk backtest --input data/raw-backtest-job.json --out data/backtest-report.json
bun run desk prepare --input data/desk-seeds-and-backtests.json --out data/desk-input.json
```

`DeskBacktestJob` contains:

| Field | Required content |
|---|---|
| `caseId` | Stable identity matching the desk idea |
| `dataset.symbol` | The US-equity symbol used by the proposed plan |
| `dataset.source` | The actual source of historical prices; a local synthetic source must say so |
| `dataset.provenance` | `historical` or `synthetic`; synthetic results never qualify for strategy acceptance |
| `dataset.adjustment` | `split_adjusted` or `unadjusted`, consistently applied across all prices and volume |
| `dataset.bars` | Strictly chronological daily `{openAt, closeAt, open, high, low, close, volume}` records; times are Unix milliseconds |
| `dataset.events` | Sourced calendar with `completeFrom`, `completeThrough`, and `{at, knownAt, kind, symbol?}` items; complete through the proposed holding window |
| `evaluationStart` | Holdout start after at least 199 completed warmup bars |
| `planSignalAt` | Must equal the latest completed bar's close timestamp |
| `parameters` | Every `DeskBreakoutParameters` field, explicitly supplied; defaults are exported as `DEFAULT_DESK_BREAKOUT_PARAMETERS` |

The default parameters are a 20-bar breakout, 20-bar volume average, 1.5× relative volume, 2× ATR stop distance, 2× stop-distance reward target, 10-calendar-day maximum holding period, 1% risk cap, $10,000 initial research capital, 1 basis point fee and 2 basis points modeled slippage per side. These are declared research assumptions, not broker prices or fitted optimal parameters. Tighten risk limits or supply a cost estimate appropriate to the instrument. Historical equity used to size the backtest differs from an actual current account; the workflow independently checks live account equity/cash before approval.

The event calendar must cover the evaluated history and the future proposed holding window. Missing calendar coverage, future/incomplete candles, stale proposed signal bars, gaps longer than seven days, and inadequate warmup yield `NOT_RUN`. Invalid prices, out-of-order records, non-daily bars and parameters that exceed desk risk limits are rejected. Source completeness and corporate-action correctness remain data-provider claims requiring independent verification.

An input bundle for `prepare` has `cases` containing Scout/Chart/Risk/Quote seed evidence and `backtests` containing matching raw jobs. Preparation computes each plan and its backtest evidence before the immutable case is registered. The nightly runner recomputes the supplied raw job and uses `verifyDeskBacktestBinding` to compare the dataset, full rule parameters, outcomes, and exact entry/stop/target/quantity/deadline against that case. A changed order or changed report fails. A missing raw job is explicitly `NOT_RUN`; it cannot silently count as an executed nightly backtest. Receipt times may differ across computations; the outcome payload must be identical.

## Signals and causal execution

Indicators use only completed prefix bars. BUY requires close above the highest high of the previous 20 bars, volume at least 1.5× the current 20-bar average, RSI(14) above 50, and ATR(14) no higher than the nearest-rank 90th percentile of the latest 100 ATR observations. SELL uses the opposite price/RSI direction and the same volume/ATR filters. At least 200 bars are needed for warmup. EMA 8/21/50/200 values are computed for the ribbon; their ordering is not an extra BUY gate, matching the Pine source.

The BUY signal places a one-bar limit at its closed-bar price, rounded down to a cent, on the following daily bar. A mere touch does not prove a fill. A gap below the proposed stop invalidates the entry. Whole-share size reserves both entry and exit costs within the 1% stop-loss budget and cannot exceed available cash. Stops and targets remain the original planned prices even if the entry receives price improvement. A scheduled earnings/Fed/CPI/major event known at signal time vetoes a holding window that contains it; future announcements do not leak into earlier decisions.

An open bracket checks the stop before the target when both occur in the same bar. Stop gaps fill at the lower opening price. Target fills are conservatively assumed at the target, and no target profit is assumed on the entry bar because its high may precede the limit fill. SELL or maximum-hold exits execute on the next available open. Trade timestamps represent bar execution bounds, not observed exchange fill times. Explicit per-side fees and slippage are debited as costs; this does not claim that real limit execution exceeds its limit price.

The research account holds at most one long position in this symbol, has no leverage, pauses after three consecutive losses, and rejects a new entry after a 2% daily equity loss. A gap can exceed a planned stop budget. Remaining inventory is marked to the latest close and reported as residual; an unfilled final signal is also retained. There is no fabricated terminal liquidation. Portfolio-wide correlation, news selection and discretionary chart scoring are outside this single-symbol mechanical backtest and remain workflow risk/evidence checks.

## Reports and acceptance

The baseline and two volume-threshold perturbations (0.9× and 1.1×) run independently on the same holdout. Reports include closed trades, win rate, average win/loss, drawdown, net cost-adjusted equity, costs, and fill/veto counters. The same evidence gate reports recent-year results, requires at least three years of source history, at least thirty completed trades, a fully evaluated positive recent year, acceptable drawdown, and positive results under all three distinct parameter settings. Insufficient observations produce null ratios or rejection, not invented values.

Sensitivity is a robustness check, not an optimization procedure. The baseline is never replaced by whichever perturbation performed best. New tuning requires a fresh future holdout. A successful historical gate means `ELIGIBLE_FOR_PAPER`, never live approval. The fourteen-day paper observation and per-order live approval gates still apply.

`bun test tests/desk-backtest.test.ts` verifies prefix causality, next-bar fills, fees/slippage, stop-first ambiguous bars, no touch fill, gap invalidation, event publication timing, missing/future data, synthetic rejection, and exact plan/evidence binding. Test prices are explicitly synthetic; no real three-year backtest or strategy acceptance was performed in this implementation session.
