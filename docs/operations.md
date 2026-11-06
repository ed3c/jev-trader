# Operations and verification

This branch implements the three supplied articles as software. The original upstream demo's unconditional per-block spending behavior is superseded by the requested deadline, policy, cost and risk gates. It still evaluates fresh block events, but an order is not required on every block.

## Local setup

Use Bun 1.4.4, matching the lockfile, CI and container. The runtime is TypeScript; the articles' Python/TypeScript/Rust SDK commands are alternatives, not three required implementations. No AgenKit package, license activation, account purchase or engineering-kit installation is used.

```sh
bun install --frozen-lockfile
bun run verify
bun run decision:smoke
bun run quant
bun run evaluate --synthetic --output data/evaluation.json
bun run demo --blocks 100 --data-dir data/demo
bun run demo --serve --port 3000 --data-dir data/demo-service
```

The demo uses explicitly synthetic data and an offline deterministic provider. Its fills, timings and PnL are integration fixtures. They do not establish market profitability, venue latency or Jev performance. A synthetic journal cannot pass the real-market paper admission gate.

The built-in operations dashboard is `http://127.0.0.1:3000/dashboard`. The existing Next.js dashboard is also supported:

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

It listens on `http://127.0.0.1:3001` and uses `NEXT_PUBLIC_API_URL`, defaulting to the local engine. It no longer silently reads the upstream author's public bot.

## Real-market paper operation

```sh
cp .env.example .env
bun run start
```

The default is `MODE=paper`, `DRY_RUN=true`, `MODEL=mock`. A private key alone cannot change execution mode. The source reads actual Kuru/Monad books and logs. A book must have valid bids and asks; missing liquidity, gaps and unavailable data are not replaced with invented prices. The paper venue respects queue-ahead volume, partial fills, a shared print-volume budget and durable replay cursors.

`MODEL=jev` additionally requires `TYPESAFE_API_KEY` (the old `TYPESAFE_AI_API_KEY` name is accepted). The direct REST client uses a pinned model ID, currently `jev-1.14.0`; moving aliases are rejected. One request asks six atomic questions. `bun run decision:smoke --live` explicitly makes a real provider call on a labeled synthetic state. It is not run by CI.

Configured token prices, expected fill probability, spread capture, fees, slippage, adverse selection and gas are assumptions recorded with each economic decision. Gas is included even when no fill occurs. The native Monad receipt cost uses the signed gas limit multiplied by the receipt effective gas price, matching [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing); it does not use Ethereum-style gas-used billing. Read actual venue fees and measure fills/costs before modifying assumptions. Low confidence never enlarges an order to satisfy a minimum lot: it observes when the reduced order would be too small.

## Persisted state and failure behavior

The SQLite engine journal uses WAL and `synchronous=FULL`. It retains snapshots, decisions, policy/risk verdicts, order intents, receipts, fills, cost assumptions, kill events and the portfolio checkpoint. The initial inventory cost basis is explicitly the session's first mark, not an invented historical acquisition price.

A complete market frame, all of its fills and the paper replay cursor commit atomically. Receipt effects and their immediate fills also commit as one transaction. The same economic fill identity is applied once. A failed journal stops further writes and reports `accountingVerified=false`. No model can clear the persisted kill latch.

The live transport computes the transaction hash locally and commits its intent before broadcast. Timeout means an unknown outcome. It retains the pending exposure and polls the same hash instead of reissuing a new order. A receipt must contain the expected order/cancellation effects before reservations are released. For a single aggressive recovery limit, immediate taker fills plus the created residual must equal the requested gross quantity. Fully filled recovery orders need no residual OrderCreated event. A cancellation raced by a fill can be resolved only after independently verifying zero remaining size. Nonce allocation uses the pending nonce.

Startup reconciliation scans the configured complete wallet activity range, checks actual order ownership/remaining size and margin balances, and replays missed maker fills after the session baseline. Its range must start before the wallet's first transaction; the prior nonce is checked. A bounded range that omits earlier transactions is refused. Untracked orders or cash/inventory mismatches latch a halt. Do not share a trading wallet with unrelated processes.

The execution engine classifies an exposure-reducing fill after allocating its signed entry and exit trading fees. Remaining entry fees stay with open inventory across restarts; they affect the loss-streak classification without being charged to equity twice. A legacy nonflat checkpoint without that allocation must be explicitly reconstructed or migrated, not silently resumed with zero entry fees. Gas and API costs remain included in account equity and the aggregate loss/cost limits.

Native fills use the market's actual maker rebate and taker fee parameters with integer token rounding. Base-denominated fees or rebates change inventory separately from gross order-fill quantity; a rebate is a negative economic fee. Immediate taker fees require complete transaction events and at most one aggressive recovery order per transaction. This matches the supported transport. The [Kuru contract](https://github.com/Kuru-Labs/Kuru-contracts-dex-public/blob/main/contracts/OrderBook.sol) defines residual-order and settlement behavior. Principal quote arithmetic outside settlement still uses JavaScript numbers. Restart cash reconciliation uses a strict USD 0.00001 tolerance and logs both values on mismatch; accumulated principal rounding can therefore cause a conservative stop and requires investigation, never an automatic cash rebase. Genuine base-token dust remains inventory even below the venue's minimum order size.

## Kill and recovery

Read-only endpoints:

| Endpoint | Purpose |
|---|---|
| `/` | Latest block and full engine status |
| `/history` | Bounded recent block history |
| `/events` | Bounded SSE clients with disconnect cleanup |
| `/dashboard` | Read-only operational view |
| `/healthz` | Liveness/readiness and kill state |
| `/metrics` | Prometheus-format counters and gauges |

`POST /control/kill` and `GET /audit` require a bearer `CONTROL_TOKEN`. Configure it through the environment, not source control. There is deliberately no HTTP endpoint that clears a kill or enables live trading.

```sh
curl -X POST http://127.0.0.1:3000/control/kill \
  -H "Authorization: Bearer $CONTROL_TOKEN"
```

Recovery first cancels known working orders, then uses bounded exposure-reducing limit orders on a fresh captured book. It never flips a position or increases the requested size. New data invalidates an exit priced from an older captured book. An unknown transaction, stale data, an unfillable limit or inventory below the venue minimum remains `kill_recovery_pending`. A request being sent is not evidence that the account is flat. Residual exposure requires continued reconciliation or an operator's explicit venue action.

SIGINT/SIGTERM stops the feed, aborts the active decision, waits for in-flight work, persists the kill and attempts bounded recovery. Inspect the saved state for residual exposure. Restart retains the kill; it does not silently resume risk-taking.

## Paper-to-live admission

No funded execution is enabled or performed by this change. Before a live session, collect actual evidence rather than editing sample numbers:

1. At least fourteen elapsed days and fourteen observed calendar days of real-market paper operation.
2. At least thirty orders and thirty fills, no unresolved operations and no recorded rule violations.
3. Historical research with at least three years, thirty trades, positive separate recent-year performance, sensitivity checks and a declared expected paper-return range for the same number of observed days.
4. Review the underlying dataset provenance, fees, fills, scope and assumptions. A report does not prove the quality of external market data.

`bun run readiness --db data/engine.sqlite --backtest accepted-backtest.json --out data/readiness.json` creates a reviewable report. The backtest import contract is:

```json
{
  "version": 1,
  "source": "historical",
  "datasetSha256": "actual SHA-256 of the reviewed data",
  "historyYears": 3,
  "trades": 30,
  "recentYearReturn": 0.01,
  "parameterStabilityPassed": true,
  "expectedPaperReturnRange": { "min": -0.01, "max": 0.01, "days": 14 }
}
```

These are illustrative fields, not supplied evidence. The range must come from the reviewed strategy and the report should be retained with its original data and code. The readiness script does not enable live mode.

An operator then creates a bounded authorization JSON referencing the actual report path and exact SHA-256. `src/engine/authorization.ts` defines `LiveAuthorization`: exact live session ID, separate paper session ID, wallet, market, strategy hash, issue/expiry times, maximum notional and the paper summary. The actual report bytes, strategy and summary are verified; a report for another strategy is rejected. The grant expires within 24 hours and is rechecked immediately before broadcast. The strategy hash binds model/horizon, risk limits, costs, sizing and spend configuration.

Live startup additionally requires all of `MODE=live`, `DRY_RUN=false`, `LIVE_TRADING_ENABLED=true`, `PRIVATE_KEY`, `LIVE_AUTHORIZATION_FILE`, a complete `RECONCILE_FROM_BLOCK` and a sufficiently large explicit `MAX_RECONCILE_BLOCKS`. The persisted session ID and strategy hash are printed before admission. Use a dedicated wallet with no unrelated trading processes. Pre-fund the dedicated margin account explicitly; process startup does not deposit, approve tokens or create accounts. A reviewed grant authorizes only its bounded Kuru session. The scheduled Alpaca desk separately binds approvals to each exact plan.

## Deployment and rollback

The container and Compose configuration run paper mode and mount `/app/data` persistently. Ports bind to loopback on the host. They run as the `bun` user, drop capabilities, prohibit privilege escalation and keep the application filesystem read-only.

```sh
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:3000/healthz
```

The container configuration was added, but no production deployment or funded service was started. Use a host with persistent storage, bounded network timeouts and alerts on the health/metrics endpoints. Do not add signing credentials to the web container, browser, CI, logs or a public repository. The provided engine alert callback writes structured events to stderr; external Telegram/Slack/email delivery remains a separately configured integration.

Before an upgrade, stop new exposure, reconcile outstanding operations and take a consistent snapshot:

```sh
bun run backup -- data/engine.sqlite backups/engine-before-upgrade.sqlite
```

The backup command uses SQLite `VACUUM INTO` and checks the copied database. Test restoring to a separate path. Retain the application commit/image identifier and its matching configuration with each backup. If an upgrade fails, restore the previous code/image and matching data snapshot, start halted, reconcile authoritative venue state, and issue a new authorization only after reviewing any differences. Never restore an old ledger over a live account and assume no orders occurred afterward.

Monitor disk usage and archive evidence according to retention needs. Do not truncate active fill/operation identities: duplicate suppression and authorization depend on them. Journal failure is a stop condition, not a reason to bypass logging.

## Explicit external verification boundaries

Authenticated Jev inference, actual paid-provider baseline recordings, Alpaca account execution, TradingView OAuth/alert creation, Grok Bot provisioning, chart-side Pine compilation, complete historical backtests, fourteen-day paper evidence, funded Kuru execution and production deployment require their actual external environments. Contract tests and synthetic fixtures are labeled accordingly. See `docs/requirements-coverage.md` and `docs/validation.md` for the implementation/evidence distinction.
