import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { DeskJournal } from "../src/desk/journal";
import { syntheticDeskCase } from "../src/desk/fixtures";
import { evidence, hash } from "../src/desk/evidence";
import { DeskWorkflow } from "../src/desk/workflow";
import { AlpacaLiveBroker, AlpacaPaperBroker } from "../src/integrations/alpaca";
import type { BracketRequest, DeskCase, Evidence } from "../src/desk/types";

const START = Date.parse("2026-11-06T15:00:00Z");
const opened: DeskJournal[] = [], temporary: string[] = [];
afterEach(() => { for (const journal of opened.splice(0)) journal.close(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function store() { const journal = new DeskJournal(":memory:"); opened.push(journal); return journal; }
/** Test-only fixture provenance labels exercise gates; all transports below are injected fakes. */
function observedCase(now: number): DeskCase {
  const input = syntheticDeskCase(now, "mock-observed");
  const observed = <T>(item: Evidence<T>, provenance: "observed" | "historical" = "observed", payload = item.payload) => evidence({ source: `https://test.invalid/${item.id}`, observedAt: item.observedAt, receivedAt: item.receivedAt, provenance, payload });
  input.scout = observed(input.scout); input.chart = observed(input.chart); input.quote = observed(input.quote); input.risk = observed(input.risk);
  input.backtest = observed(input.backtest, "historical", { ...input.backtest.payload, provenance: "historical" });
  input.plan = { ...input.plan, evidenceIds: [input.scout.id, input.chart.id, input.backtest.id] };
  return input;
}
interface MockOptions { status?: string; filled?: number; stopStatus?: string; targetStatus?: string; stopQty?: number; onPreflight?: () => void; throwPost?: boolean; afterThrowExists?: boolean; account?: Record<string, unknown>; cancelFails?: boolean; closed?: boolean; marketClosed?: boolean; }
function harness(options: MockOptions = {}, ttl = 900_000) {
  let now = START, parentExists = false, postCount = 0, deleteCount = 0, posted: Record<string, unknown> | undefined;
  const journal = store(), input = observedCase(now), requests: string[] = [];
  const parent = () => {
    if (!posted) throw new Error("test parent missing");
    const filled = options.filled ?? input.plan.quantity, status = options.status ?? "filled", exitQty = options.closed ? filled : 0;
    return { ...posted, id: "test-parent", filled_qty: String(filled), filled_avg_price: filled ? String(input.plan.entry) : null, status,
      legs: [{ id: "test-stop", type: "stop", symbol: input.symbol, side: "sell", qty: String(options.stopQty ?? input.plan.quantity), stop_price: String(input.plan.stop), filled_qty: String(exitQty), filled_avg_price: exitQty ? String(input.plan.stop) : null, status: options.closed ? "filled" : options.stopStatus ?? "held" },
        { id: "test-target", type: "limit", symbol: input.symbol, side: "sell", qty: String(input.plan.quantity), limit_price: String(input.plan.target), filled_qty: "0", filled_avg_price: null, status: options.closed ? "canceled" : options.targetStatus ?? "new" }] };
  };
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET"; requests.push(`${method} ${String(url)}`);
    expect(String(url).startsWith("https://paper-api.alpaca.markets/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (path === "/v2/orders:by_client_order_id") {
      options.onPreflight?.(); return parentExists ? Response.json({ id: "test-parent" }) : new Response(null, { status: 404 });
    }
    if (path === "/v2/orders" && method === "POST") {
      postCount++; posted = JSON.parse(String(init?.body));
      if (options.throwPost) { parentExists = options.afterThrowExists === true; throw new Error("test timeout after request may have reached broker"); }
      parentExists = true; return Response.json({ id: "test-parent" });
    }
    if (path === "/v2/orders/test-parent") return Response.json(parent());
    if (path === "/v2/clock") return Response.json({ is_open: options.marketClosed !== true, timestamp: new Date(now).toISOString(), next_close: new Date(START + 3_600_000).toISOString() });
    if (path === "/v2/account") return Response.json({ id: "paper-account", status: "ACTIVE", trading_blocked: false, account_blocked: false,
      equity: "10000", cash: "10000", last_equity: "10000", ...options.account });
    if (method === "DELETE") { deleteCount++; return new Response(null, { status: options.cancelFails ? 500 : 204 }); }
    if (path === "/v2/positions" || path === "/v2/orders") return Response.json([]);
    throw new Error(`unexpected test URL: ${url}`);
  }) as typeof fetch;
  const broker = new AlpacaPaperBroker({ apiKey: "test-key", secretKey: "test-secret", journal, allowPaperOrders: true, fetch: transport, now: () => now });
  const desk = new DeskWorkflow(journal, broker, { now: () => now, rules: { approvalTtlMs: ttl } });
  return { journal, broker, desk, input, requests, get now() { return now; }, set now(value: number) { now = value; }, get postCount() { return postCount; }, get deleteCount() { return deleteCount; }, get posted() { return posted; },
    async run() { return desk.run(input, now); }, request() { return journal.events().find(event => event.kind === "order_intent")?.payload as BracketRequest; } };
}

test("paper adapter submits exactly one whole-share limit bracket with stable client ID and nested protection verification", async () => {
  const h = harness(); const state = await h.run();
  expect(state.stage).toBe("FILLED"); expect(state.order?.bracketProtected).toBe(true); expect(h.postCount).toBe(1);
  expect(h.posted).toMatchObject({ qty: "40", type: "limit", side: "buy", order_class: "bracket", extended_hours: false, limit_price: "100.00", take_profit: { limit_price: "106.00" }, stop_loss: { stop_price: "98.00" } });
  expect(String(h.posted?.client_order_id)).toMatch(/^desk-[a-f0-9]{40}$/);
  expect(h.requests.some(path => path.endsWith("/v2/orders/test-parent?nested=true"))).toBe(true);
  await h.broker.submitBracket(h.request()); expect(h.postCount).toBe(1);
  expect(h.journal.events().some(event => event.kind === "alpaca_paper_verified_order")).toBe(true);
});

test("lost POST response and absent lookup never authorize a second POST, including a new adapter instance", async () => {
  const h = harness({ throwPost: true });
  expect((await h.run()).stage).toBe("UNKNOWN"); expect(h.postCount).toBe(1);
  expect((await h.broker.submitBracket(h.request())).status).toBe("unknown"); expect(h.postCount).toBe(1);
  expect(h.journal.load("desk:execution-lock")).not.toBeNull();
  await h.desk.reconcile(h.input.id, h.now); expect(h.postCount).toBe(1);
});

test("a lost POST response reconciles the existing order rather than replaying it", async () => {
  const h = harness({ throwPost: true, afterThrowExists: true });
  expect((await h.run()).stage).toBe("FILLED"); expect(h.postCount).toBe(1);
});

test("an approval that expires during awaited preflight sends no POST", async () => {
  let h: ReturnType<typeof harness>;
  h = harness({ onPreflight: () => { h.now = START + 2000; } }, 1000);
  const state = await h.run(); expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("expired_before_post"); expect(h.postCount).toBe(0);
});

test("risk kill latched during preflight blocks the write boundary", async () => {
  let h: ReturnType<typeof harness>;
  h = harness({ onPreflight: () => h.journal.save("desk:kill", { reason: "concurrent risk veto", at: START }) });
  const state = await h.run(); expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("kill_latched"); expect(h.postCount).toBe(0);
});

test("broker account truth overrides a mismatching supplied risk snapshot", async () => {
  const h = harness({ account: { cash: "9999" } });
  const state = await h.run(); expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("disagrees_with_authoritative"); expect(h.postCount).toBe(0);
});

test("partial parent fill with held children remains unprotected and triggers verified emergency", async () => {
  const h = harness({ status: "partially_filled", filled: 1, stopStatus: "held", targetStatus: "held" });
  const state = await h.run(); expect(state.order?.bracketProtected).toBe(false); expect(h.journal.load("desk:kill")).not.toBeNull(); expect(h.deleteCount).toBe(2);
});

test("a full fill is protected by matched full-quantity held stop and active target, not an undersized stop", async () => {
  const h = harness({ stopQty: 1 });
  await h.run(); expect(h.journal.load("desk:kill")).not.toBeNull(); expect(h.deleteCount).toBe(2);
});

test("done_for_day remains pending and reserves exposure", async () => {
  const h = harness({ status: "done_for_day", filled: 0 });
  expect((await h.run()).stage).toBe("SUBMITTED"); expect(h.journal.load("desk:execution-lock")).not.toBeNull();
});

test("nested completed exit closes the case; failed emergency never claims a flat account", async () => {
  const h = harness({ closed: true }); expect((await h.run()).stage).toBe("CLOSED");
  const broken = harness({ status: "partially_filled", filled: 1, cancelFails: true });
  await broken.run(); const result = await broken.broker.emergencyFlatten(); expect(result.confirmed).toBe(false); expect(result.openPositions).toBeNull();
});

test("a bare caller-created approval cannot bypass durable Risk authority", async () => {
  const h = harness(); await h.run();
  const request = { ...h.request(), clientOrderId: `desk-${"b".repeat(40)}` };
  const order = await h.broker.submitBracket(request);
  // Existing broker ID identity is also verified; either route is closed to the fabricated intent.
  expect(order.status).toBe("unknown"); expect(h.postCount).toBe(1);
});

test("paper cannot point to live/custom URL, and live construction requires explicit distinct authorization", () => {
  expect(() => new AlpacaPaperBroker({ apiKey: "key", secretKey: "secret", journal: store(), paper: false })).toThrow("live_or_custom");
  expect(() => new AlpacaPaperBroker({ apiKey: "key", secretKey: "secret", journal: store(), baseUrl: "https://attacker.invalid" })).toThrow("live_or_custom");
  expect(() => new AlpacaLiveBroker({ apiKey: "key", secretKey: "secret", journal: store(), allowLiveOrders: false, expectedAccountId: "live", readinessReportFile: "/missing", orderAuthorizationFile: "/missing" })).toThrow("explicit_live");
});

test("read-only paper default never reaches POST", async () => {
  const h = harness(); await h.run();
  const reader = new AlpacaPaperBroker({ apiKey: "key", secretKey: "secret", journal: h.journal, fetch: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch, now: () => START });
  await expect(reader.submitBracket(h.request())).rejects.toThrow("writes_not_enabled");
});


test("distinct live transport enforces the real gate and atomically consumes an exact approval under injected-only I/O", async () => {
  // This entire history is an explicitly fabricated protocol fixture, never an accepted user report.
  const directory = mkdtempSync(join(tmpdir(), "alpaca-live-transport-test-only-")); temporary.push(directory);
  const day = 86_400_000, start = START - 19 * day, end = START - day, duration = end - start;
  const input = observedCase(START); input.id = "mock-live-first"; input.plan = { ...input.plan, quantity: 4 };
  const historyEnd = start - 2 * day, evaluationStart = historyEnd - 21 * duration;
  const historical = { ...input.backtest.payload, historyStart: historyEnd - 4 * 365.25 * day, historyEnd, evaluationStart, evaluationEnd: historyEnd,
    trades: Array.from({ length: 42 }, (_, i) => ({ openedAt: evaluationStart + Math.floor(i / 2) * duration + (i % 2 ? duration / 2 + 1 : 1), closedAt: evaluationStart + Math.floor(i / 2) * duration + (i % 2 ? duration - 1 : duration / 2), netPnlUsd: 15 })) };
  input.backtest = evidence({ source: "https://test.invalid/historical-protocol-fixture", observedAt: START - 1000, receivedAt: START, provenance: "historical", payload: historical });
  input.plan.evidenceIds = [input.scout.id, input.chart.id, input.backtest.id];
  const paperLedger = store(), rows: { kind: string; ts: number; payload: any; key: string }[] = [];
  const orderDay = (i: number) => 1 + Math.floor(i * 13 / 29);
  for (let n = 0; n <= 18; n++) {
    const count = Array.from({ length: 30 }, (_, i) => i).filter(i => orderDay(i) <= n).length;
    rows.push({ kind: "alpaca_account_telemetry", ts: start + n * day, key: `telemetry-${n}`, payload: { accountId: "test-paper-gate", mode: "alpaca-paper", equity: 10_000 + count, cash: 10_000 + count, dayStartEquity: 10_000, positions: [], openOrders: [] } });
  }
  for (let n = 0; n < 30; n++) rows.push({ kind: "alpaca_paper_verified_order", ts: start + orderDay(n) * day - 3_600_000 + n, key: `closed-${n}`, payload: {
    accountId: "test-paper-gate", strategyId: input.plan.strategyId, parametersHash: input.plan.parametersHash,
    order: { id: `entry-${n}`, clientOrderId: `client-${n}`, planHash: hash(input.plan), symbol: input.symbol, status: "closed", filledQuantity: 1, filledPrice: 100, bracketProtected: true },
    execution: { entryFilledQty: 1, entryFilledPrice: 100, feesUsd: 0, exits: [{ id: `exit-${n}`, qty: 1, price: 101, status: "filled", side: "sell", type: "limit" }] } } });
  for (const row of rows.sort((a, b) => a.ts - b.ts)) paperLedger.append(row.kind, row.payload, row.key, row.ts);
  const bindFile = (name: string, value: unknown) => { const path = join(directory, name), bytes = JSON.stringify(value); writeFileSync(path, bytes); return { path, sha: createHash("sha256").update(bytes).digest("hex") }; };
  const ledger = bindFile("fabricated-paper-history.json", paperLedger.events());
  const range = bindFile("fabricated-range.json", { version: 1, source: "chronological-historical-holdout", strategyId: input.plan.strategyId, parametersHash: input.plan.parametersHash,
    datasetHash: historical.datasetHash, backtestHash: hash(historical), initialEquityUsd: 10_000, windowDurationMs: duration, createdAt: start - day });
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const report = bindFile("fabricated-report.json", { version: 1, source: "alpaca-paper", eligible: true, paperAccountId: "test-paper-gate", strategyId: input.plan.strategyId, parametersHash: input.plan.parametersHash,
    generatedAt: end + 2000, startedAt: start, endedAt: end, observedDates: Array.from({ length: 19 }, (_, n) => formatter.format(start + n * day)), filledOrders: 30, closedTrades: 30, unresolvedOrders: 0, ruleViolations: 0,
    netPnlUsd: 30, expectedNetPnlRangeUsd: [30, 30], maxDrawdownFraction: 0, backtest: historical, paperJournalPath: ledger.path, paperJournalSha256: ledger.sha, expectedRangePath: range.path, expectedRangeSha256: range.sha });
  const authorizationPath = join(directory, "fabricated-operator-approval.json");
  function authorize(caseId: string) {
    const planHash = hash(input.plan), clientOrderId = `desk-${hash({ caseId, planHash }).slice(0, 40)}`;
    writeFileSync(authorizationPath, JSON.stringify({ id: "one-human-yes", clientOrderId, version: 1, approved: true, approvedBy: "test-only-human", accountId: "test-live-account", planHash,
      issuedAt: START - 1, expiresAt: START + 600_000, reportSha256: report.sha, fullSizePlan: { ...input.plan, quantity: 40 } }));
  }
  authorize(input.id);
  let posts = 0, posted: any = null;
  const transport = (async (url: any, init?: RequestInit) => {
    expect(String(url).startsWith("https://api.alpaca.markets/")).toBe(true);
    const path = new URL(String(url)).pathname;
    if (path === "/v2/clock") return Response.json({ is_open: true, timestamp: new Date(START).toISOString(), next_close: new Date(START + 3_600_000).toISOString() });
    if (path === "/v2/account") return Response.json({ id: "test-live-account", status: "ACTIVE", trading_blocked: false, account_blocked: false, equity: "10000", cash: "10000", last_equity: "10000" });
    if (path === "/v2/orders:by_client_order_id") return new Response(null, { status: 404 });
    if (path === "/v2/orders" && init?.method === "POST") { posts++; posted = JSON.parse(String(init.body)); return Response.json({ id: "live-test-parent" }); }
    if (path === "/v2/orders/live-test-parent") return Response.json({ ...posted, id: "live-test-parent", filled_qty: "4", filled_avg_price: "100", status: "filled", legs: [
      { id: "live-test-stop", symbol: input.symbol, type: "stop", side: "sell", stop_price: "98", qty: "4", filled_qty: "0", filled_avg_price: null, status: "canceled" },
      { id: "live-test-target", symbol: input.symbol, type: "limit", side: "sell", limit_price: "106", qty: "4", filled_qty: "4", filled_avg_price: "106", status: "filled" },
    ] });
    if (path === "/v2/positions" || path === "/v2/orders") return Response.json([]);
    throw new Error(`Unexpected injected URL ${url}`);
  }) as typeof fetch;
  const journal = store(), broker = new AlpacaLiveBroker({ apiKey: "test-live-key", secretKey: "test-live-secret", journal, fetch: transport, now: () => START,
    allowLiveOrders: true, expectedAccountId: "test-live-account", readinessReportFile: report.path, orderAuthorizationFile: authorizationPath });
  const desk = new DeskWorkflow(journal, broker, { now: () => START });
  expect((await desk.run(input, START)).stage).toBe("CLOSED"); expect(posts).toBe(1);
  expect(journal.load("live-auth:one-human-yes")).not.toBeNull();
  const recorded = journal.events().find(event => event.kind === "alpaca_live_verified_order")!.payload as any;
  journal.append("alpaca_live_verified_order", { ...recorded, execution: { ...recorded.execution, feesUsd: 0 } }, "test-provider-known-zero-fee", START);
  const second = { ...input, id: "mock-live-second" }; authorize(second.id);
  const rejected = await desk.run(second, START); expect(rejected.stage).toBe("REJECTED"); expect(rejected.reason).toContain("approval_already_consumed"); expect(posts).toBe(1);
});


test("external entries fail closed outside the broker's confirmed market session", async () => {
  const h = harness({ marketClosed: true });
  const result = await h.run(); expect(result.stage).toBe("REJECTED"); expect(result.reason).toContain("market_session_closed"); expect(h.postCount).toBe(0);
});

test("unknown post-fill fees pause fresh entries without inventing a three-loss streak or a settled zero cost", async () => {
  const h = harness({ closed: true }); expect((await h.run()).stage).toBe("CLOSED");
  const account = await h.broker.readAccountRisk();
  expect(account.accountingPending).toBe(true);
  const monitor = await h.desk.monitorPortfolio(h.input.risk, [h.input.quote], h.now);
  expect(monitor.reasons).toEqual([]); expect(monitor.entryPaused).toBe(true);
  expect(h.journal.load("desk:accounting-pause")).not.toBeNull(); expect(h.journal.load("desk:kill")).toBeNull();
  expect(h.postCount).toBe(1);
});
