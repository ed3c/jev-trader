import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { checkLiveAuthorization, strategyHash } from "../src/engine/authorization";
import { DeterministicDecisionProvider } from "../src/engine/decisions";
import { Journal } from "../src/engine/journal";
import type { DecisionProvider } from "../src/engine/types";
import { KuruVenue, type KuruSource } from "../src/execution/kuru";
import { PaperVenue } from "../src/execution/paper";
import type { ExecutionHooks, ExecutionIntent, ExecutionUpdate, MarketPrint, VenueFrame } from "../src/execution/types";
import type { Book } from "../src/market";
import { Trader } from "../src/trader";

const BASE = 100_000;
function clock() {
  let at = BASE;
  return { now: () => { at += 0.01; return at; }, advance: (ms: number) => { at += ms; }, block: (n: number) => { at = BASE + n * 300; } };
}
function book(block: number, mid = 0.02): Book {
  return {
    block, bid: mid - 0.00001, ask: mid + 0.00001, mid, spreadBps: 10, imbalance: 0,
    levels: { bids: [[mid - 0.00001, 2000], [mid - 0.00002, 2000]], asks: [[mid + 0.00001, 2000], [mid + 0.00002, 2000]] },
    depthBps: { "10": { bid: 2000, ask: 2000 } },
  };
}
function settings(extra: Record<string, string> = {}): Config {
  return loadConfig({
    BANKROLL_USD: "10000", MARGIN_MON: "1000", TRADE_SIZE_MON: "800", MAX_POSITION_MON: "2000",
    MIN_VOL_SAMPLES: "2", MIN_SPREAD_BPS: "20", EXPECTED_FILL_PROBABILITY: "1", SLIPPAGE_BPS: "0", ADVERSE_SELECTION_BPS: "0",
    MAX_GAS_USD_PER_HOUR: "100", MIN_QUOTE_LIFE_MS: "100000", MAX_QUOTE_LIFE_MS: "100000",
    ...extra,
  });
}
class InspectablePaper extends PaperVenue {
  readonly submitted: ExecutionIntent[] = [];
  responseMode: "normal" | "unknown" = "normal";
  beforeSubmit: ((intent: ExecutionIntent) => Promise<void>) | null = null;
  override async submit(intent: ExecutionIntent, b: Book, hooks: ExecutionHooks): Promise<ExecutionUpdate> {
    await this.beforeSubmit?.(intent);
    if (this.responseMode === "unknown") {
      if (!hooks.stillValid()) throw new Error("Execution invalidated");
      const p: ExecutionUpdate = { operationId: intent.operationId, block: intent.block, status: "prepared", txHash: "0xunknown",
        orders: [], canceledIds: [], gasMon: 0, gasUsd: 0, intent };
      hooks.beforeBroadcast(p);
      this.submitted.push(structuredClone(intent));
      return { ...p, status: "unknown", reason: "test_transport_uncertainty" };
    }
    const update = await super.submit(intent, b, hooks);
    this.submitted.push(structuredClone(intent));
    return update;
  }
}
function harness(extra: Record<string, string> = {}, provider?: (c: ReturnType<typeof clock>) => DecisionProvider,
  source?: (block: number, c: ReturnType<typeof clock>) => Promise<VenueFrame>) {
  const c = clock(), cfg = settings(extra), journal = new Journal(":memory:");
  const venue = new InspectablePaper(source ? (b) => source(b, c) : async (b) => ({ book: book(b), observedAtMs: c.now(), prints: [], fills: [], gap: false }), 0.000001, 200, 0.001, 0, 0);
  const model = provider?.(c) ?? new DeterministicDecisionProvider({ clock: c.now });
  const trader = new Trader(venue, model, { config: cfg, clock: c.now, journal, sourceLabel: "synthetic" });
  const step = async (b: number) => { c.block(b); await trader.onBlock(b); };
  return { trader, venue, c, cfg, journal, model, step };
}
async function warm(h: ReturnType<typeof harness>) { await h.step(1); await h.step(2); await h.step(3); }

test("a provider response that arrives after the deadline never becomes an order", async () => {
  const h = harness({}, (c) => {
    const baseline = new DeterministicDecisionProvider({ clock: c.now });
    return { name: "deliberately-late", async decide(s, options) { const b = await baseline.decide(s, options); c.advance(300); return b; } };
  });
  await warm(h);
  expect(h.venue.submitted).toHaveLength(0);
  expect(h.trader.status().totals.lateBlocks).toBeGreaterThan(0);
});

test("a new block invalidates an in-flight decision even if its provider ignores abort", async () => {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const h = harness({}, (c) => {
    const baseline = new DeterministicDecisionProvider({ clock: c.now });
    return { name: "abort-ignoring-test", async decide(s, options) {
      const result = await baseline.decide(s, options);
      if (++calls === 1) { entered(); await barrier; }
      return result;
    } };
  });
  await h.step(1); await h.step(2);
  h.c.block(3); const pending = h.trader.onBlock(3); await waiting;
  h.c.block(4); await h.trader.onBlock(4); release(); await pending;
  expect(h.venue.submitted.every((i) => i.block !== 3)).toBe(true);
  expect(h.venue.submitted.some((i) => i.block === 4)).toBe(true);
});

test("unknown execution keeps reservations and blocks subsequent writes", async () => {
  const h = harness(); h.venue.responseMode = "unknown";
  await warm(h);
  const status = h.trader.status();
  expect(status.pending).toHaveLength(1);
  expect(status.pending[0]!.intent.orders.length).toBeGreaterThan(0);
  expect(status.state).toBe("kill_recovery_pending");
  await h.step(4); await h.step(5);
  expect(h.venue.submitted).toHaveLength(1);
  expect(h.trader.status().pending).toHaveLength(1);
});

test("provider failures accumulate even while the market data feed is healthy", async () => {
  const h = harness({ MAX_API_ERRORS: "2", DETERMINISTIC_FALLBACK: "false" }, () => ({ name: "unavailable", async decide() { throw new Error("provider down"); } }));
  await warm(h); await h.step(4);
  expect(h.trader.killed).toBe("max_provider_errors");
  expect(h.venue.submitted.filter((i) => i.postOnly && i.orders.length > 0)).toHaveLength(0);
});

test("normal partial fills cannot make fill-ratio health invalid or double-count repeated prints", async () => {
  let prints: MarketPrint[] = [];
  const h = harness({}, undefined, async (n, c) => {
    const ts = c.now();
    if (n === 4) prints = [80, 80, 40].map((size, i) => ({ id: `partial-${i}`, block: 4, ts, side: "sell", price: 0.01995, size }));
    return { book: book(n), observedAtMs: ts, prints: n >= 4 ? prints : [], fills: [], gap: false };
  });
  await warm(h); await h.step(4); await h.step(5);
  expect(h.trader.status().position).toBeCloseTo(1200);
  expect(h.trader.status().totals.fills).toBe(3);
  expect(h.journal.records().filter((r) => r.kind === "loop_error")).toHaveLength(0);
});

test("paper restart does not consume a duplicate old print from the remaining order", async () => {
  const c = clock(), cfg = settings(), journal = new Journal(":memory:");
  let oldPrint: MarketPrint | null = null;
  const source = async (n: number): Promise<VenueFrame> => {
    const ts = c.now();
    if (n === 4) oldPrint = { id: "before-restart", block: 4, ts, side: "sell", price: 0.01995, size: 100 };
    const prints = n === 4 || n === 5 ? [oldPrint!] : n === 6 ? [{ id: "after-restart", block: 6, ts, side: "sell" as const, price: 0.01995, size: 100 }] : [];
    return { book: book(n), observedAtMs: ts, prints, fills: [], gap: false };
  };
  const model = new DeterministicDecisionProvider({ clock: c.now });
  const firstVenue = new PaperVenue(source, 0.000001, 200, 0.001, 0, 0);
  const first = new Trader(firstVenue, model, { config: cfg, clock: c.now, journal, sourceLabel: "synthetic" });
  for (let n = 1; n <= 4; n++) { c.block(n); await first.onBlock(n); }
  expect(first.status().position).toBe(1100);
  const restartedVenue = new PaperVenue(source, 0.000001, 200, 0.001, 0, 0);
  const restarted = new Trader(restartedVenue, model, { config: cfg, clock: c.now, journal, sourceLabel: "synthetic" });
  c.block(5); await restarted.onBlock(5);
  expect(restarted.status().position).toBe(1100);
  c.block(6); await restarted.onBlock(6);
  expect(restarted.status().position).toBe(1200);
  expect(restarted.status().totals.fills).toBe(2);
});

test("a failed multi-fill frame commits neither a partial account nor its final replay cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-atomic-fill-"));
  const databasePath = join(directory, "engine.sqlite");
  let writer: Journal | null = null, reader: Journal | null = null;
  try {
    const c = clock(), cfg = settings();
    writer = new Journal(databasePath);
    let prints: MarketPrint[] = [];
    const source = async (n: number): Promise<VenueFrame> => {
      const ts = c.now();
      if (n === 4) prints = [80, 80, 40].map((size, i) => ({ id: `crash-partial-${i}`, block: 4, ts, side: "sell", price: 0.01995, size }));
      return { book: book(n), observedAtMs: ts, prints: n >= 4 ? prints : [], fills: [], gap: false };
    };
    const firstVenue = new InspectablePaper(source, 0.000001, 200, 0.001, 0, 0);
    const first = new Trader(firstVenue, new DeterministicDecisionProvider({ clock: c.now }), { config: cfg, clock: c.now, journal: writer, sourceLabel: "synthetic" });
    for (let n = 1; n <= 3; n++) { c.block(n); await first.onBlock(n); }
    writer.db.exec(`CREATE TRIGGER fail_second_fill BEFORE INSERT ON events
      WHEN NEW.kind='fill' AND (SELECT COUNT(*) FROM events WHERE kind='fill')=1
      BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;`);
    c.block(4);
    await first.onBlock(4).catch(() => undefined);
    expect(writer.failed).toBe(true);
    expect(first.status().accountingVerified).toBe(false);
    const writeCount = firstVenue.submitted.length;
    c.block(5); await first.onBlock(5);
    expect(firstVenue.submitted).toHaveLength(writeCount);
    writer.db.exec("DROP TRIGGER fail_second_fill");
    writer.close(); writer = null;

    reader = new Journal(databasePath);
    const resumedVenue = new PaperVenue(source, 0.000001, 200, 0.001, 0, 0);
    const resumed = new Trader(resumedVenue, new DeterministicDecisionProvider({ clock: c.now }), { config: cfg, clock: c.now, journal: reader, sourceLabel: "synthetic" });
    c.block(6); await resumed.onBlock(6);
    expect(resumed.status().position).toBe(1200);
    expect(resumed.status().totals.fills).toBe(3);
  } finally {
    writer?.close(); reader?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared paper recovery write restores only its unfilled residual", async () => {
  const source = async (n: number): Promise<VenueFrame> => ({ book: book(n), observedAtMs: 2000, prints: [{ id: "later-taker", block: n, ts: 2000, side: "buy", price: 0.021, size: 500 }], fills: [], gap: false });
  const first = new PaperVenue(source, 0.000001, 200, 0.001, 0, 0);
  const intent: ExecutionIntent = { operationId: "recover-1", sessionId: "s", snapshotId: "evidence", block: 1, createdAtMs: 1000, deadlineMs: 1500,
    orders: [{ side: "sell", price: 0.01999, size: 200 }], cancelIds: [], postOnly: false, reduceOnly: true };
  let prepared!: ExecutionUpdate;
  const result = await first.submit(intent, book(1), { stillValid: () => true, beforeBroadcast: (p) => { prepared = structuredClone(p); } });
  expect(result.fills?.reduce((sum, f) => sum + f.size, 0)).toBe(200);
  const resumed = new PaperVenue(source, 0.000001, 200, 0.001, 0, 0);
  resumed.restore([prepared], []);
  expect((await resumed.read(2)).fills).toHaveLength(0);
});

test("kill status remains unresolved when residual spot inventory is below venue minimum", async () => {
  const h = harness({ MARGIN_MON: "50" }); await warm(h);
  await h.trader.halt("test_kill"); await h.step(4);
  expect(h.trader.status().position).toBe(50);
  expect(h.trader.status().state).toBe("kill_recovery_pending");
  expect(h.trader.killed).toBe("test_kill");
});

test("new data invalidates a recovery order priced from an older captured book", async () => {
  const h = harness({}, undefined, async (n, c) => ({ book: book(n, n >= 5 ? 0.03 : 0.02), observedAtMs: c.now(), prints: [], fills: [], gap: false }));
  await warm(h); await h.trader.halt("test_kill");
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  h.venue.beforeSubmit = async (i) => { if (!i.postOnly && i.orders.length && i.block === 4) { entered(); await barrier; } };
  h.c.block(4); const recovering = h.trader.onBlock(4); await waiting;
  h.c.block(5); await h.trader.onBlock(5); release(); await recovering;
  expect(h.venue.submitted.filter((i) => i.block === 4 && i.orders.length)).toHaveLength(0);
  expect(h.trader.status().position).toBe(1000);
});

test("shutdown waits for a busy loop to finish before closing its journal", async () => {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const h = harness({}, undefined, async (n, c) => { entered(); await barrier; return { book: book(n), observedAtMs: c.now(), prints: [], fills: [], gap: false }; });
  h.c.block(1); const processing = h.trader.onBlock(1); await waiting;
  let closed = false;
  const closing = h.trader.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  release(); await processing; await closing;
  expect(closed).toBe(true);
});

function kuruFixture() {
  const cfg = settings();
  const source = { tickSize: 0.000001, minSize: 200, sizeStep: 0.001,
    market: { wallet: {}, address: "0x0000000000000000000000000000000000000001", params: { pricePrecision: "1000000", sizePrecision: "1000" } } } as unknown as KuruSource;
  const intent: ExecutionIntent = { operationId: "live-operation", sessionId: "s", snapshotId: "evidence", block: 1, createdAtMs: 1000, deadlineMs: 1500,
    orders: [{ side: "buy", price: 0.01996, size: 200 }], cancelIds: [], postOnly: true, reduceOnly: false };
  const pending: ExecutionUpdate = { operationId: intent.operationId, block: 1, status: "sent", txHash: `0x${"1".repeat(64)}`, orders: [], canceledIds: [], gasMon: 0, gasUsd: 0, intent };
  const venue = new KuruVenue(source, cfg); venue.restore([pending], []);
  return { venue, source, cfg, pending, intent };
}

test("Kuru timeout and restart retain uncertain exposure without a second broadcast", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.method).toBe("eth_getTransactionReceipt");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: null });
  }) as typeof fetch;
  try {
    const f = kuruFixture(), [unknown] = await f.venue.poll(20);
    expect(unknown?.status).toBe("unknown");
    const restarted = new KuruVenue(f.source, f.cfg); restarted.restore([unknown!], []);
    await restarted.poll(21);
    await expect(restarted.submit({ ...f.intent, operationId: "must-not-send", block: 21 }, book(21), { stillValid: () => true, beforeBroadcast: () => { throw new Error("unexpected broadcast"); } })).rejects.toThrow("Unresolved transaction");
  } finally { globalThis.fetch = oldFetch; }
});

test("a successful Kuru receipt without expected order evidence cannot release a reservation", async () => {
  const oldFetch = globalThis.fetch;
  const f = kuruFixture();
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.method).toBe("eth_getTransactionReceipt");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { transactionHash: f.pending.txHash, status: "0x1", blockNumber: "0x2", effectiveGasPrice: "0x1", logs: [] } });
  }) as typeof fetch;
  try {
    const updates = await f.venue.poll(2);
    expect(updates.some((u) => u.status === "confirmed")).toBe(false);
    await expect(f.venue.submit({ ...f.intent, operationId: "must-not-send" }, book(2), { stillValid: () => true, beforeBroadcast: () => { throw new Error("unexpected broadcast"); } })).rejects.toThrow("Unresolved transaction");
  } finally { globalThis.fetch = oldFetch; }
});

test("live authorization binds the paper artifact to the same strategy and rejects invalid notional", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-auth-binding-"));
  try {
    const authorizationPath = join(directory, "authorization.json"), reportPath = join(directory, "paper-report.json");
    const cfg: Config = { ...settings(), dryRun: false, liveAuthorizationFile: authorizationPath };
    const now = 2_000_000_000, wallet = "0x0000000000000000000000000000000000000001";
    const evidence = { source: "real-market-paper", startedAtMs: now - 15 * 86_400_000, endedAtMs: now - 2000, observedDays: 15,
      orders: 100, fills: 100, unresolvedOperations: 0, ruleViolations: 0, matchesBacktest: true };
    const report = { version: 1, eligible: true, generatedAtMs: now - 1000, sessionId: "paper-session", strategyHash: strategyHash(cfg), paperEvidence: evidence };
    const save = () => {
      const bytes = JSON.stringify(report); writeFileSync(reportPath, bytes);
      writeFileSync(authorizationPath, JSON.stringify({ version: 1, approved: true, sessionId: "live-session", paperSessionId: "paper-session", wallet, market: cfg.market,
        strategyHash: strategyHash(cfg), issuedAtMs: now - 100, expiresAtMs: now + 1000, maxNotionalUsd: 1000, paperEvidenceReportPath: reportPath,
        paperEvidence: { ...evidence, reportSha256: createHash("sha256").update(bytes).digest("hex") } }));
    };
    save();
    expect(checkLiveAuthorization(cfg, "live-session", wallet, now, 100)).not.toBeNull();
    expect(() => checkLiveAuthorization(cfg, "live-session", wallet, now, NaN)).toThrow();
    report.strategyHash = "another-strategy"; save();
    expect(() => checkLiveAuthorization(cfg, "live-session", wallet, now, 100)).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("authorization digest changes with decision horizon, failure budget and transaction spend", () => {
  const cfg = settings(), original = strategyHash(cfg);
  const changes: Partial<Config>[] = [
    { horizonBlocks: cfg.horizonBlocks + 1 }, { maxApiErrors: cfg.maxApiErrors + 1 }, { minVolSamples: cfg.minVolSamples + 1 },
    { gasLimit: 700_000 }, { maxFeeGwei: cfg.maxFeeGwei + 1 }, { priorityFeeGwei: cfg.priorityFeeGwei + 1 },
    { jevUsdPerMTok: cfg.jevUsdPerMTok * 2 },
  ];
  for (const change of changes) expect(strategyHash({ ...cfg, ...change })).not.toBe(original);
});
