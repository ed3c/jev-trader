# Six-role research and execution desk

The desk is a runnable Bun program for sourced equity research, explicit historical strategy validation, portfolio risk, durable execution and scheduled reviews. It runs independently of Jev's fast Kuru loop. Its default broker is a local paper simulator with USD 10,000. Real provider data, account consent, credentials and a continuously running host are configuration inputs.

## Run the complete local demonstration

```bash
bun run desk demo --csv data/demo-trade-journal.csv --out data/desk-demo.json --input-out data/desk-demo-input.json
bun run desk replay --input data/desk-demo-input.json --synthetic-demo
bun run desk schedule --at 2026-11-06T14:30:00Z
bun run desk templates --out data/grok-desk-templates.md
```

The demo performs `NEW -> SCOUTED -> CHARTED -> STRATEGIZED -> APPROVED -> FILLED`, emits a Chief of Staff brief, persists the immutable audit trail and simulates a whole-share limit bracket. All five specialist handoffs and all six role capabilities execute. It labels every source and output synthetic; `historicalStrategyAccepted` and `externalOrdersSent` are false. A synthetic case cannot reach Alpaca or qualify for live readiness. Replay is restricted to the local simulator and uses an injected historical clock; network execution uses a moving system clock.

The demonstration's 40 shares at entry 100, stop 98 and target 106 exercise an USD 80 planned loss inside the USD 100 default per-trade cap. These prices and outcomes are fixtures, not market data or strategy results. A stop gap fills at the available supplied bid in the simulator; it does not invent a fill at the stop price.

## Commands

| Command | Purpose |
|---|---|
| `bun run desk demo` | Complete synthetic local workflow with a fresh default journal |
| `bun run desk run-once --input input.json` | Execute/reconcile supplied complete, immutable research cases |
| `bun run desk replay --input input.json --synthetic-demo` | Deterministic local replay with no external broker |
| `bun run desk backtest --input job.json --out report.json` | Compute the exact daily-bar strategy baseline and two parameter perturbations |
| `bun run desk prepare --input seeds.json --out data/desk-input.json` | Materialize plans and backtest evidence from raw jobs into research seeds |
| `bun run desk service --config config/desk.example.json` | Run the durable scheduled role loop |
| `bun run desk service --config config/desk.example.json --once` | Run one scheduler tick without launching an ongoing daemon |
| `bun run desk schedule --at ISO_TIMESTAMP` | Inspect due America/New_York routines without executing them |
| `bun run desk export --journal data/desk.sqlite --out trade-journal.csv` | Export a formula-safe, RFC 4180 CSV |
| `bun run desk account` | Read Alpaca paper balance, positions and orders; no order writes |
| `bun run desk capture-paper --after ISO --until ISO --out events.json` | Read account telemetry and all paginated broker activities, then export the hash-chain journal |
| `bun run desk templates` | Export the external Bot role and routine runbook |
| `bun run desk tradingview-discover --config config/desk.example.json` | Initialize and list actual provider MCP capabilities |
| `bun run desk tradingview-read --name EXACT_NAME --args query.json` | Invoke one discovered, allowlisted read tool |
| `bun run desk tradingview-preview --operation alert.create --args alert.json` | Review an exact configured setup operation and its argument hash |
| `bun run desk tradingview-setup --operation alert.create --args alert.json --approval approval.json --allow-setup-writes` | Execute the approved discovered setup operation once |
| `bun run desk journal-create --provider sheets --operation-id MY_ID --allow-journal-writes --destination-out destination.json` | Create a configured remote journal; use `--provider notion --parent-page-id ID` for Notion |
| `bun run desk journal-sync --provider sheets --destination destination.json --allow-journal-writes` | Append journal rows with stable export IDs and explicit remote write opt-in |
| `bun run desk journal-reconcile --provider sheets --destination destination.json` | Read-only reconciliation of uncertain row exports |

A previously registered case ID cannot be reused for changed evidence or a changed plan. Create a new case ID for a new decision. Fresh execution evidence goes in the bundle's separate `updates` list; it does not overwrite the original research record. A rejected or expired plan requires a new case and new review. Unknown outcomes remain reserved until reconciled.

## Data and provider boundaries

`JsonDeskProvider` loads a concrete JSON file, not a fictitious live news feed. Its bundle contains:

```ts
interface DeskInputBundle {
  cases: DeskCase[];
  updates?: { caseId: string; quote: Evidence<Quote>; risk: Evidence<RiskSnapshot> }[];
  portfolio?: { risk: Evidence<RiskSnapshot>; quotes: Evidence<Quote>[] };
  backtests?: DeskBacktestJob[];
}
```

Each evidence envelope has `source`, `observedAt`, `receivedAt`, `provenance`, `payload` and a SHA-256 `id`. Use the exported `evidence()` helper to construct it. IDs cover canonical plain JSON; nonfinite numbers and non-JSON values are rejected. Evidence is deep-copied and frozen at ingest and stored in a write-protected evidence table. Claim integrity and source authenticity are different: the hash detects changed content, while the provider/operator is responsible for source authenticity. Actual Alpaca account data are independently fetched and compared before any external entry.

A case contains a sourced Scout finding, daily/four-hour chart report, exact plan, historical backtest report, current account/risk evidence and current quote. The plan binds the Scout, chart and backtest evidence IDs. The backtest report must match the strategy ID and parameter hash, including the baseline sensitivity run. The default strategy gate requires three years of history, 30 completed trades, a full profitable recent year, explicit costs and three distinct parameter settings evaluated on the same dataset. No generated fixture is accepted as historical evidence.

The raw-bar engine in `src/desk/backtest.ts` implements a specific long-only Desk Signal rule. A job includes split-adjustment convention, complete daily OHLCV bars, event source/coverage and each event's announcement time, all risk/cost parameters, evaluation start and the latest completed signal bar. It executes next-bar limit entries, strict trade-through assumptions, stop-first handling of ambiguous bars, no target profit on the entry bar, explicit per-side fees and slippage, holding deadlines and three-loss suspension. Baseline and two perturbations actually execute; the last-year acceptance result is derived from their closed trades. Residual positions remain open. Nightly routines recompute the supplied raw job and compare its outcomes and order fields to the immutable plan. A missing job is `NOT_RUN` and does not masquerade as a completed backtest.

The `prepare` input uses research seeds containing all case fields except `plan` and `backtest`, plus a `backtests` array. A computed plan receives the seed's Scout and chart evidence IDs and its new backtest evidence ID. No-current-signal results are reported as skipped. Insufficient historical performance still fails Strategist even if a mechanically valid current plan was produced.

## Permissions, approvals and risk

The host obtains one frozen `DeskWorkflow.toolsFor(role)` object per agent. It must never provide the entire workflow, raw SQLite handle, credentialed broker or arbitrary code execution to an untrusted agent. The orchestrator itself is trusted code. Role tool objects expose only that role's workflow operations, and transitions enforce the previous stage. Only Trader has order submission, reconciliation and emergency tools. Risk approval is compared to an immutable Risk transition, not merely a mutable status field.

Defaults are USD 10,000 paper, 1% current-equity risk per trade, 2% daily mark-to-market loss, five open/pending symbols, 100% gross exposure, no leverage/shorts and a USD 5 minimum stock price. Rules may be tightened, not loosened. Pending buys reserve cash and symbol capacity. Unknown or ambiguous correlation pairs, missing group labels, or event coverage that stops before the holding horizon reject the plan. Correlated or same-group bets share a 1% aggregate stop-risk cap. Earnings, Fed, CPI and major events in the prohibited holding window veto the trade.

Risk signs the exact canonical plan hash, case hash, risk evidence identity, approval time and expiry. Trader rechecks all of them, then requires quote and portfolio evidence at most 60 seconds old. Price more than 0.5% from entry sends the plan back for new strategy review. Durable active-order state prevents parallel cases from borrowing the same stale account snapshot. A reservation and order intent are committed together before I/O; unknown/pending states retain the reservation. Confirmed fills must appear in the next authoritative portfolio snapshot before further exposure is allowed.

Portfolio-only checks also run in Trader/Risk routines when there are no new ideas. Unresolved realized fees set a separate accounting pause for new entries; they never become an invented three-loss streak or an assumed final zero commission. Complete activity coverage, matched fills and account reconciliation after the quiet settlement interval can clear that accounting pause. Existing holdings remain monitored and reconciled. Daily losses, three losses, stale quotes, missing stops or crossed stops latch a kill. New entries stay disabled. The emergency path cancels orders, requests position closure, and rereads orders, positions and account. An unknown response or residual position remains unresolved; the code never reports flat merely because a close request was sent. Local simulation will not fabricate liquidation from a stale cached price. Restarts keep the kill latch; there is no automatic unpause.

The weekly review computes net outcomes from journal entries, compares complete equal-duration historical windows, and pauses strategies below their historical lower range. Missing actual costs also pause the affected strategy. No-trade weeks and synthetic-only benchmarks are reported explicitly. Paused strategies cannot pass another Strategist or Trader gate. An operator review and new verified evidence are required before resumption.

## Alpaca paper and live transports

`AlpacaPaperBroker` pins the paper endpoint. A paper instance cannot select a live or custom endpoint. Write access defaults off. Example environment variable names are `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER_TRADE=True`. To use supplied real evidence with paper:

```bash
bun run desk run-once --input data/desk-input.json --broker alpaca-paper --allow-paper-orders --journal data/alpaca-paper.sqlite
```

The adapter submits `type: limit`, `order_class: bracket`, whole-share quantity, exact take-profit/stop-loss prices and a deterministic `client_order_id`. It first checks for that ID, independently reads account/positions/open orders, compares the supplied account evidence to broker truth, requires the broker clock to confirm an open session, then rechecks approval, quote/risk freshness, session-close deadline and the kill latch immediately before POST. Redirects are disabled so credentials cannot be forwarded to another endpoint.

A timeout, 5xx, malformed acknowledgement, conflict or uncertain response is reconciled by client ID and then by order ID with nested legs. A missing lookup after a possible POST is not proof that no order was sent. Persistent intent prevents another POST after restart. Partial parent fills do not count as protected by held child orders. A fully filled parent can use a correctly sized conditional held stop when the matching target is active. Done-for-day orders still reserve exposure. Completed exits are recognized from nested child fills. Any unprotected or oversized fill triggers the emergency flow.

`AlpacaLiveBroker` is a distinct explicit transport. It requires separate live credentials, an expected account ID, actual clean Alpaca paper evidence, a historical strategy-matched benchmark and a fresh human approval artifact. The approval binds the exact plan and client order ID; its ID is atomically consumed before the first attempted write and remains consumed if the outcome is unknown. The reference plan must satisfy the actual account's 1%/cash rules, and the approved live quantity is at most 10% of that reference. The gate reads pinned evidence files on every entry, verifies their hashes and derives actual PnL, cost coverage, drawdown and unresolved state from recorded broker outcomes/account history. A summary boolean cannot establish readiness. Missing fees, account reconciliation, sufficient observed paper days or historical benchmark coverage fails closed. The concrete gate requires at least 14 observed New York dates, 30 closed orders, flat period endpoints, observed drawdown at most 2% and a benchmark design committed before paper observation starts. It recomputes the expected range from at least 20 complete chronological holdout windows. Fees need explicit settled order records or full matched activities and a four-day quiet settlement buffer.

The CLI's live opt-in is deliberately explicit:

```bash
bun run desk run-once --input data/live-case.json --broker alpaca-live \
  --allow-live-orders --account-id EXPECTED_LIVE_ACCOUNT \
  --paper-readiness data/paper-readiness.json \
  --live-authorization data/one-order-human-approval.json \
  --journal data/alpaca-live.sqlite
```

It additionally requires `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY` and `ALPACA_PAPER_TRADE=False`. Those files must follow `src/desk/live-authorization.ts`; no fabricated readiness file is bundled. At least 14 days of actual clean paper history cannot be produced by running a synthetic demo. No external paper or live order was placed while implementing this repository.

## TradingView and Pine

The read client performs MCP initialization, session handling, paginated `tools/list` discovery and `tools/call`. There are no invented provider tool names. An exact operator allowlist and a discovered `readOnlyHint: true` are both required. Dangerous write-like names and destructive annotations are rejected. HTTPS OAuth bearer authentication is configured by the host after the real provider's consent flow. The source article's endpoint is an unverified configuration candidate, not a preauthorized session or proof that a service exists.

`TradingViewSetupClient` is a separate opt-in capability for operator-mapped, discovered watchlist/alert creation or maintenance. It produces a preview of the exact tool and argument hash. Writes need a bounded approval for those exact arguments, a durable unique operation ID and an explicitly enabled setup mapping. Unknown responses are not replayed. Ordinary research roles receive only the read client. An MCP setup capability cannot place broker orders.

`indicators/desk-signal.pine` is Pine v6. It contains EMA 8/21/50/200 ribbons; BUY/SELL conditions with RSI, volume and the **previous** 20 bars' high/low; confirmed swing zones; an ATR(14) 90th-percentile filter over 100 bars; and separate alerts. Closed-bar and confirmed-pivot handling avoid current-bar breakout self-reference and unconfirmed pivot labels. The source has explanatory comments. Actual TradingView compilation, adding it to a chart, provider OAuth and creating user watchlist alerts require the external account; none is claimed as completed here.

## Schedule and persistence

`src/desk/scheduler.ts` uses America/New_York calendar time and explicit sessions. It handles DST gaps/folds, holidays and early closes; 2026 NYSE sessions are included with sources. Outside calendar coverage it fails closed rather than inventing weekdays. Every routine has a stable UTC ID; SQLite `INSERT OR IGNORE` claims prevent two processes from running the same slot. A crash leaves the claim reserved until reviewed. There is no blind replay of a routine that may already have caused an external effect.

The schedule is Scout at 06:30 and every 30 minutes until close, chart scan at 08:30 then hourly, Strategist at 21:00, Risk 15 minutes after close and before every order, Trader every 15 minutes in the session, Chief briefs at 07:30 and close plus 30 minutes, Sunday review at 18:00. Read-only monitoring polls every five minutes. Normal 16:15/16:30 reviews shift with an actual early close.

SQLite uses WAL, full synchronous commits, transactional state changes, append-only event/evidence triggers and a verified SHA-256 event chain. Original research and every provider output remain inspectable. Runtime state can be reconstructed/audited against the event record. The local simulator persists cash, positions, orders, daily baseline and quote watermarks across restart.

CSV fields are exactly `TIME,BOT,TICKER,IDEA,SOURCE,SCORE,ENTRY,STOP,TARGET,SIZE,RISK CHECK,STATUS,RESULT,LESSON`. Formula-like values are neutralized even after leading whitespace/control characters and all values are CSV-quoted. Google Sheets/Notion exporter modules also support explicitly enabled provider writes, destination creation, durable export IDs, duplicate reconciliation and ambiguous-outcome tracking. They are unconfigured until actual OAuth credentials and destinations are supplied. The CLI uses `SHEETS_OAUTH_ACCESS_TOKEN` or `NOTION_ACCESS_TOKEN`; credentials must already have consent and destination permissions. Remote mutation commands require `--allow-journal-writes`, while reconciliation is read-only. No remote spreadsheet or database is claimed to exist.

## Verification and external work remaining

The desk tests exercise exact stage permissions, provenance/hash tampering, backtest/plan mismatch, approval expiry, stale clocks, no chase, portfolio/correlation/event failures, atomic reservations, crash recovery, CSV injection, DST/holiday scheduling, local bracket/stop gaps, MCP discovery/setup permissions, broker account disagreement and ambiguous Alpaca submissions. All external transports in tests are injected fake providers. Synthetic success tests prove software behavior, not trading performance.

External work is explicit: real market/news/X providers, authoritative account credentials and event/correlation data; TradingView endpoint and consent; actual Pine Editor compilation and chart/alert installation; hosted Grok Bot/team creation; a supervised always-on host; Google Sheets/Notion destination authorization; real historical datasets and at least 14 observed paper days. The local CLI and source adapters are implemented. Their external account sessions and long-running performance evidence have not been created in this session.

Primary protocol references: [Alpaca orders](https://docs.alpaca.markets/us/docs/orders-at-alpaca), [working with orders](https://docs.alpaca.markets/us/docs/working-with-orders), [lookup by client order ID](https://docs.alpaca.markets/us/reference/getorderbyclientorderid), [lookup by order ID](https://docs.alpaca.markets/us/reference/getorderbyorderid-1), [TradingView Pine documentation](https://www.tradingview.com/pine-script-docs/), [NYSE sessions](https://www.nyse.com/trade/hours-calendars).
