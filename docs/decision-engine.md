# Decision engine and deterministic risk contract

The runtime uses five modules under `src/engine`: `types.ts`, `state.ts`, `decisions.ts`, `policy.ts`, and `risk.ts`. They implement the Jev article's deterministic state, six independent judgments, policy composition, and absolute risk veto. The existing trader, venue adapters, and SQLite journal own execution and persistence.

This implementation does not install or depend on AgenKit.

## Point-in-time state

`buildSnapshot(input, options)` rejects invalid numbers, inconsistent books, wrong source blocks, conflicting observations, and any market observation whose timestamp is at or after `decisionTs`. The book must belong to the requested block. The caller supplies an actual observation timestamp and must not renew a cached book's age by fetching it again.

The resulting snapshot is recursively frozen. Its `id` is a SHA-256 hash of its data using stable key ordering. Both the session identity and exact snapshot hash accompany every decision. The policy rejects a decision for another session or snapshot. A persisted snapshot can be checked with `verifySnapshot` after it is loaded.

| Feature | Calculation and availability |
| --- | --- |
| Mid and spread | `(bid + ask) / 2` and `(ask - bid) / mid * 10000`. Locked, crossed and empty books are invalid. |
| Microprice | `(ask * bestBidSize + bid * bestAskSize) / (bestBidSize + bestAskSize)`. |
| Depth and imbalance | First three distinct levels on each side; imbalance is `(bidDepth - askDepth) / (bidDepth + askDepth)`. Missing levels are reported. |
| Returns | Clock-time 1, 5 and 30 minute returns, using a prior observation at the window boundary. Insufficient coverage or a large gap returns `null`. A block count is not silently substituted for elapsed time. |
| Realized volatility | Square root of the sum of squared log returns divided by elapsed seconds. Short and medium windows use available observations from the last 60 and 300 seconds. The sample count and warmup status are explicit. Units are log return per square root of a second. |
| Flow | Buy/sell volume and VWAP from observed prints. Per-second trade and cancellation rates require `flowWindowStartMs`. An absent feed is `null`; an observed quiet window may be zero. |
| Queue ahead | Only accepted from an explicitly supplied, timestamped measurement. L2 depth is not presented as an observed queue position. |
| Cross venue and basis | Reference-venue divergence and derivative-to-spot basis use separate timestamped inputs. Missing or stale inputs remain `null`. |
| Funding and 24h baselines | Supplied by an independent source with a timestamp and freshness limit. A few seconds of history are not promoted to a 24h reference. |
| Account and health | Ledger inventory, equity, daily PnL, high-water drawdown, inventory age, gross exposure, error counts, measured fill/reject rates, slippage and the last ten latencies. |

`readiness` distinguishes freshness, warmup, fatal reasons, and unavailable optional measurements. The default warmup requires 20 return samples. Callers can choose a higher threshold or explicitly manage warmup with `requireWarmup: false`. Unknown age for a nonzero position blocks readiness.

Account values must describe the ledger state before the decision. Gross exposure cannot understate the position in this instrument. The account owner must maintain daily equity boundaries, high-water equity and fill identities; these facts are never supplied by the model.

### Compact transport state

`compactSnapshot` encodes the features into numeric groups and keeps the full evidence snapshot in the journal. The normal state fits the configurable 400 estimated-token budget. The estimate is UTF-8 bytes divided by four, rounded up; it is a budget indicator rather than an exact tokenizer result. An oversized state is rejected instead of silently dropping risk data.

The question instructions explain each relevant numeric group. Those instructions also consume input tokens. Costs must use the API's `usage.input_tokens`, not the compact-state estimate or the article's per-block cost claims.

## Jev request and response contract

`JevDecisionProvider` makes one direct request to `POST https://api.typesafe.ai/v1/systemone`. It reads `TYPESAFE_API_KEY`, with the original repository's `TYPESAFE_AI_API_KEY` as a compatibility alias. The default version is explicitly pinned to `jev-1.14.0`; moving aliases such as `jev-latest` are rejected. A response from a different version is also rejected.

The six questions are independent:

| Question | Primitive | Answer space |
| --- | --- | --- |
| `regime` | Choice | `trending`, `mean_reverting`, `high_vol`, `crisis` |
| `direction` | Choice | `up`, `down`, `neutral` over the supplied horizon |
| `toxic_flow` | Noul | Probability of informed/aggressive adverse flow |
| `liquidity_stressed` | Noul | Probability of stressed liquidity |
| `quote_environment` | Score | Four ordered levels from do not quote to excellent |
| `inventory_pressure` | Score | Four ordered levels from none to reduce now |

The current REST schema uses an ordered `criteria` array for Score requests. `legend` belongs to Score responses. Token usage uses `input_tokens` and `output_tokens`. Choice and Score responses require a finite confidence value; missing confidence is not replaced with the largest choice probability. The decoder also validates answer types, choice names, probability ranges and normalization, score expectations, usage, model identity and timing.

The call has a deadline and an abort signal, including when a fetch or response body stalls. There are no retries on the block path. Errors do not copy response bodies or keys into the journal. Provider outages can invoke the explicit deterministic fallback through the runtime; they never turn a late response into a fresh decision.

The API contract was checked against the provider's [System One API](https://docs.typesafe.ai/api/system-one), [model/version documentation](https://docs.typesafe.ai/models), [JavaScript SDK documentation](https://docs.typesafe.ai/sdk/javascript), and [confidence documentation](https://docs.typesafe.ai/confidence) on 2026-11-06. The code uses the direct REST path to keep timeout and retry behavior explicit. No authenticated Jev call is claimed by the unit tests.

## Policy composition

`composePolicy(snapshot, battery, overrides, nowMs)` returns an action plus reason codes, size/spread multipliers, directional skew and an optional reducing side. It performs no external write.

The policy first verifies the snapshot, session binding and decision timing. Stale books pull quotes. Expired decisions hold. Toxic flow and a crisis regime pull quotes regardless of an otherwise favorable quality score. A normal quote requires both sufficient quality and its separate confidence threshold. Marginal quality or stressed liquidity produces smaller, wider quotes only when the minimum quality gate passes. High inventory pressure can request the reducing side; the executor still caps the quantity and applies hard risk checks.

Action thresholds are in `DEFAULT_POLICY_CONFIG` and runtime code. They are not instructions asking a model to enforce a limit. Directional skew has its own confidence and probability conditions. A high reported probability does not substitute for confidence.

`DeterministicDecisionProvider` is a reproducible rules baseline. It performs no network request, records zero model tokens, and supplies `null` confidence. Its discrete distribution encodes a rule's selected label, not measured odds of a profitable trade. Its output is accepted for small/wide fallback quotes only with `allowDeterministicFallback: true`. It cannot silently masquerade as Jev or acquire calibrated confidence.

Every raw provider decision records `calibration: "unverified"`. Domain calibration and expected payoff estimates must come from held-out evaluation. Neither the provider's training method nor a successful mock run is sufficient evidence to use a confidence value as a Kelly win probability.

## Hard risk veto

`evaluateRisk(input, overrides)` checks the state and proposed orders independently of the model. The caller must pass both resting orders and all uncertain/pending orders in `openOrders` until their cancellations or outcomes are confirmed. Opposing orders are not netted: either side can fill without the other.

For signed inventory `q`, total reserved buys `B`, and total reserved sells `S`, the inventory bound is `max(|q|, |q + B|, |q - S|)`. Leverage includes other instrument exposure and a conservative valuation of this worst case. Every proposed order must also be finite, positive, within size limits, post-only against the observed touch, and free of a self-crossing batch.

| Limit or event | Result |
| --- | --- |
| Proposed order size, projected position or leverage exceeds its cap | Reject the write. A different safe action may be considered by the caller. |
| Existing position or leverage already exceeds a hard cap | Request a persistent kill. |
| Daily loss or drawdown reaches its limit | Request a persistent kill. |
| Stale data, unknown/excessive inventory age or error budget exhausted | Request a persistent kill. |
| Decision latency exceeds its limit | Reject that decision. A single late response does not reset or bypass any limit. |
| Invalid configuration, nonfinite risk data, corrupted snapshot or arithmetic overflow | Fail closed. |
| Kill already latched | Keep it latched; a model answer cannot reset it. |

The runtime must persist a kill before attempting recovery. Cancellation and bounded inventory reduction are separate execution operations with their own evidence. A requested flatten, an accepted transaction and an observed fill are different states. Residual or uncertain exposure remains unresolved until reconciled.

The exported `DEFAULT_RISK_LIMITS` retain a small demo account convention. The actual runtime derives and passes limits from its validated configuration, including the configured bankroll; callers must not assume that every application uses the library defaults.

## Verification

Run the focused checks with:

```sh
bun test tests/state.test.ts tests/decisions.test.ts tests/policy.test.ts tests/risk.test.ts
bun test tests/runtime-safety.test.ts
bun run typecheck
```

The module tests cover deterministic feature calculations, missing sources, timestamp leakage, gap handling, tampered evidence, the real REST request shape, malformed responses, stalled-request abort, model version mismatch, fallback provenance, policy priority, pending exposure, loss limits and nonfinite values. Runtime regression tests cover late decisions, unknown execution outcomes, partial fills, recovery, receipt completeness, restart replay and shutdown ordering using local injected venues and clocks.

These tests establish engineering behavior on their supplied cases. They do not establish live latency, actual queue position, exchange availability, trading edge, calibration on MON-USDC or profitability after real costs.
