# Quantitative models and evaluation

This implementation separates executable numerical models from evidence that a strategy earns money. The numerical functions and offline research commands work without credentials. A-S pricing is available to the trading runtime. OU pairs, Hawkes flow and Heston options remain explicit research modules; importing a model does not enable a new venue or authorize a trade.

## Run the offline tools

```sh
bun run scripts/quant.ts
bun run scripts/quant.ts --model heston
bun run scripts/evaluate.ts --synthetic --frames 240
bun run scripts/evaluate.ts --data replay.json --config replay-config.json --output evaluation.json
bun run scripts/evaluate.ts --calibration calibration-samples.json --training-end 1767225600000
bun run scripts/evaluate.ts --strategy strategy-evidence.json
bun run scripts/evaluate.ts --pairs pair-research.json
bun test tests/quant-models.test.ts tests/evaluation-calibration.test.ts tests/evaluation-replay.test.ts
```

The example commands label generated data `SYNTHETIC_ENGINEERING_FIXTURES` or `provenance.kind: synthetic`. The default replay evaluates the deterministic baseline and returns `NOT_RUN` for LLM, Jev and Jev with confidence gates because no real provider recordings were supplied. It makes zero provider calls. A synthetic return, Sharpe ratio or fill count is an engineering output, not historical performance or an investment result.

## Numerical contracts

| Module | Public functions | Units and behavior |
|---|---|---|
| `src/quant/avellaneda-stoikov.ts` | `avellanedaStoikov`, `quoteEconomics` | Absolute price, base-asset inventory, volatility in price per square root of time, matching horizon units, tick-safe bid/ask |
| `src/quant/ou.ts` | `fitOU`, `fitPairs`, `ouZScore`, `pairsZScore`, `meanReversionSignal`, `simulateOU` | Regular timestamp units; fitted theta is inverse time and half-life uses the original time unit |
| `src/quant/hawkes.ts` | `hawkesIntensity`, `hawkesLogLikelihood`, `fitHawkes`, `ExponentialHawkes` | Kernel `alpha * exp(-beta * elapsed)`; alpha and beta use inverse event-time units |
| `src/quant/heston.ts` | `simulateHestonPath`, `priceHestonEuropean`, `calibrateHestonGrid` | Years, annual variance, annual rates, risk-neutral spot dynamics |
| `src/quant/kelly.ts` | `fractionalKelly` | Net trade win probability, average net win/loss ratio, fraction of bankroll; independently calibrated evidence required |

Every public calculation checks its domain and nonfinite input. A numerical failure is an error for the caller to handle, never a synthetic valid price.

### Avellaneda-Stoikov correction

The supplied Jev article mislabels the full spread as a half spread. This implementation uses the paper's finite-horizon approximation:

```text
reservation = mid - inventory * gamma * sigma^2 * timeRemaining
fullSpread  = gamma * sigma^2 * timeRemaining + 2 * log1p(gamma / kappa) / gamma
halfSpread  = fullSpread / 2
```

At `gamma = 0`, the reservation price is the mid and the half spread has the finite limit `1 / kappa`. The bid rounds down and the ask rounds up. Supplying both best prices constrains the result to remain strictly post-only. `fullSpread` describes the analytical spread; tick rounding and book constraints can change the final `ask - bid`.

The source is the original [Avellaneda and Stoikov paper, equations 29 and 30](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf). It models arithmetic mid-price diffusion and exponential fill intensities. That does not establish profitability on Kuru or estimate the required parameters for a particular account.

`quoteEconomics` makes expected fills, costs and gas explicit. Gas is charged even if no round trip completes. The expected fill count is an input requiring measurement; it is not inferred from Jev confidence.

### OU and pairs research

`fitOU(points, trainingEnd)` fits the AR(1) transition on the training prefix only. The exact OU relationship is `phi = exp(-theta * dt)`, giving `theta = -log(phi) / dt` and half-life `log(2) / theta`. The estimator rejects `phi <= 0`, `phi >= 1`, zero innovation variance, insufficient samples and irregular spacing. The [Dalhousie OU state-space study, section 1.3.2](https://dalspaceb.library.dal.ca/server/api/core/bitstreams/f987142c-dea0-4883-a2be-1c1e99e61ce9/content) states the transition and innovation variance used here.

`fitPairs` regresses log prices on the same training prefix, constructs the residual spread, then calibrates OU. It explicitly returns `cointegration: NOT_TESTED`: correlation, a plausible hedge ratio and an AR(1) coefficient do not prove cointegration. `ouZScore` and `pairsZScore` require a signal timestamp after the fitted period.

`backtestPairs` in `src/evaluation/strategy.ts` fills a signal on the next bar. It charges both legs at entry and exit, reports an open final position, and never invents a terminal liquidation. Bar-level fills remain a research approximation; they do not prove atomic paired execution or intrabar stop behavior.

### Hawkes convention and fit

The convention is explicitly `h(t) = alpha * exp(-beta * t)`, so the branching ratio is `alpha / beta`. Only subcritical parameters are admitted. Intensity at an event uses prior events, excluding the current event. The likelihood integrates the exponential kernel exactly and assumes empty prehistory at the observation start. Its computation follows the point-process likelihood and exponential-kernel treatment in [Bonnet, Martinez Herrera and Sangnier](https://perso.lpsm.paris/~msangnier/files/papers/spl2021.pdf).

`fitHawkes` performs a bounded grid followed by coordinate search, includes a Poisson candidate, and records its training interval. It does not claim a global optimum. A large branching ratio describes event persistence; the code does not reinterpret it as a certain price direction.

### Heston pricing and uncertainty

The option pricer simulates correlated spot and variance shocks under the risk-neutral measure. It uses full truncation for coefficients while retaining the raw latent variance, and log-Euler for spot. The numerical scheme follows [Lord, Koekkoek and van Dijk](https://repub.eur.nl/pub/7738/); the model originates in [Heston's 1993 paper](https://wwwf.imperial.ac.uk/~ajacquie/IC_Num_Methods/IC_Num_Methods_Docs/Literature/Heston.pdf).

The result includes Monte Carlo standard error, a 95% sampling interval, path/step counts, seed, and the Feller-condition diagnostic. The interval excludes discretization bias and model error. The Feller diagnostic is reported rather than used to silently discard otherwise supported parameter sets.

`calibrateHestonGrid` selects from a bounded set of supplied candidate parameters using training option observations. Future observations affect only the validation RMSE. Common random numbers make candidate comparison reproducible. This is a working research calibration path, not a market-surface optimizer or options execution adapter. It makes no claim that a realized/implied volatility difference is arbitrage.

## Common full-policy replay

`src/evaluation/replay.ts` exports the dataset/configuration interfaces and `compareBaselines`, `replayBaseline`, and the explicit opt-in recording helper `captureProviderReplay`.

All four baselines use the production `buildSnapshot`, `composePolicy`, `evaluateRisk`, economic veto and A-S pricing. They share market frames, costs, tick size, order size, residence limits, participation, latency assumptions, and risk limits. Plain Jev removes confidence thresholds; Jev with gates retains them. The deterministic baseline explicitly enables the conservative fallback branch. Spot mode is the default: sells require existing inventory and buys require sufficient quote cash. A separate `allowShort` research configuration is explicit.

### Dataset structure

```ts
interface ReplayDataset {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  symbol: string;
  provenance: {
    kind: "historical" | "synthetic";
    source: string;
    description: string;
  };
  frames: ReplayFrame[];
  recordings?: {
    llm?: RecordedDecision[];
    jev?: RecordedDecision[];
    jev_gated?: RecordedDecision[];
  };
}
```

Each frame contains a timestamped L2 book strictly before `decisionTs`, subsequent market prints used only for fills, a later settlement timestamp/mid, and optional source-stamped reference/baseline observations. Frames may not overlap. The production state builder receives only earlier observations. Future prints are never supplied to the decision provider.

Provider recordings contain a strictly validated battery, block, cost and provenance. The snapshot fingerprint includes portfolio and health state. A decision captured while holding a different inventory is not valid for the replay, even if its market prices match. For this reason, plain and gated Jev need their own matching decision histories once their portfolios diverge. Missing evidence produces `NOT_RUN` with no comparable metrics; the report includes the first missing block and snapshot ID.

`captureProviderReplay` accepts a factory receiving a replay clock. This maps historical clock origin while measuring real elapsed request latency. Construct a real `JevDecisionProvider({ clock })` or equivalent LLM provider explicitly. The helper records the real wall capture time separately and simulates orders only. It is not called by the offline CLI. No default command calls paid APIs, creates synthetic Jev responses, or spends exchange funds.

### Execution and accounting assumptions

- A print must trade strictly through a quote to fill it. A touch is insufficient when queue priority is unknown. A tick-scaled tolerance prevents floating-point equality from becoming a false fill.
- Fill size is bounded by remaining order size and the configured share of observed trade volume.
- Model and execution latency determine order activation. If a previous quote fills while a decision is pending, the new action is held because portfolio state changed.
- Minimum residence, replacement threshold and maximum quote age constrain churn. Simulated cancellation and submission costs are charged. A risk rejection before submission does not consume gas.
- The production cost calculation vetoes quotes whose assumed capture does not cover fees, slippage, adverse selection, decisions and round-trip gas. A common hourly gas budget also applies. Default assumptions can legitimately produce no trades; the simulator does not override the veto to make a demo look active.
- Maker fees and modeled slippage costs apply to notional. The limit execution price is preserved; slippage is modeled as an additional cost.
- Realized trade PnL uses average entry cost and allocated entry/exit fees. `closedTrades` counts closing fill events. Portfolio PnL also includes gas and decision cost.
- A kill cancels modeled open orders and blocks further exposure. Any residual inventory is reported and marked, never declared flattened without a modeled fill.

The simulator is not a reconstruction of chain ordering, hidden liquidity, L3 priority, mempool behavior or settlement failure. These limitations remain in every result.

### Metric definitions

`performanceMetrics` reports net equity/PnL, annualized Sharpe and Sortino, sampled max drawdown, closed-fill win rate, average win/loss, notional-weighted slippage and adverse selection, fill count, quote coverage and provider cost per million decisions. Adverse selection is signed against the post-fill settlement mark; positive means the market moved against the maker. Undefined ratios are `null`, not zero or infinity. Annualization requires a declared observation frequency and has little statistical meaning for a short fixture run.

## Calibration and sizing

Calibration samples carry unique IDs, model version, prediction timestamp, outcome availability timestamp, probability and binary outcome. The chronological split purges outcomes unavailable at the training cutoff. `fitPlatt` uses only matured training labels; `evaluatePlatt` rejects overlapping validation or a changed model version. It reports Brier score, clipped log loss, expected calibration error and reliability bins before and after sigmoid calibration. The [scikit-learn calibration documentation](https://scikit-learn.org/stable/modules/calibration.html) explains disjoint fitting/calibration evaluation and reliability diagrams.

The Kelly function implements `f = (b*p - (1-p)) / b`, then applies the chosen fractional multiplier and bankroll cap. It requires held-out evidence for **net profitable trades**, including support in the probability bin being sized. A model's “price up” output is not automatically such evidence. Missing samples, a changed version, excessive calibration error or absent local support yields zero allocation. Kelly's growth criterion and arbitrary-odds setting originate in [Kelly 1956](https://onlinelibrary.wiley.com/doi/10.1002/j.1538-7305.1956.tb03809.x).

## Strategy promotion

`assessStrategyEvidence` enforces at least three years of historical data, thirty completed trades, a full most-recent-year evaluation with positive net results, fees/slippage, a drawdown limit and at least three distinct parameter settings on the same dataset. Passing means `ELIGIBLE_FOR_PAPER`. It never grants live approval. Synthetic input is explicitly rejected as strategy acceptance evidence.

No historical dataset, real Jev/LLM recording, option surface, venue calibration, three-year strategy result or fourteen-day paper run was supplied with these source articles. Those operational evidence items remain unavailable; fixture verification does not substitute for them.
