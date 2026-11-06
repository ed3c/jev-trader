import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskJournal } from "../src/desk/journal";
import { DeskWorkflow } from "../src/desk/workflow";
import { evidence } from "../src/desk/evidence";
import { syntheticDeskCase } from "../src/desk/fixtures";
import { LocalPaperBroker } from "../src/integrations/paper-broker";
import { assessPortfolioSafety } from "../src/desk/risk";
import { DEFAULT_DESK_RULES } from "../src/desk/types";
import { claimDueDeskJobs, nyseCalendar2026 } from "../src/desk/scheduler";
import { reviewDeskWeek } from "../src/desk/review";
import { runDeskRoutine } from "../src/desk/runner";

const START = Date.parse("2026-11-06T15:00:00Z");
const journals: DeskJournal[] = [], directories: string[] = [];
afterEach(() => { for (const journal of journals.splice(0)) { try { journal.close(); } catch {} } for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function store(path = ":memory:") { const journal = new DeskJournal(path); journals.push(journal); return journal; }
function harness(journal = store()) {
  const clock = { now: START }, input = syntheticDeskCase(START), paper = new LocalPaperBroker(journal, 10_000, () => clock.now);
  const desk = new DeskWorkflow(journal, paper, { now: () => clock.now, allowSyntheticDemo: true });
  return { journal, clock, input, paper, desk };
}
function quote(h: ReturnType<typeof harness>, bid: number, ask = bid + .01) {
  return evidence({ source: "local://test/quote", observedAt: h.clock.now, receivedAt: h.clock.now, provenance: "synthetic", payload: { symbol: h.input.symbol, bid, ask, last: bid } });
}

test("local paper stop gaps fill at available bid and trigger OCO close rather than an invented stop price", async () => {
  const h = harness(); h.paper.mark(h.input.quote); await h.desk.run(h.input, h.clock.now);
  h.clock.now += 1000; h.paper.mark(quote(h, 97));
  const state = await h.desk.reconcile(h.input.id, h.clock.now);
  expect(state.stage).toBe("CLOSED"); expect(h.paper.snapshot().positions).toHaveLength(0); expect(h.paper.snapshot().cash).toBe(9880);
  expect(h.journal.events().filter(event => event.kind === "paper_exit").map(event => (event.payload as any).price)).toEqual([97]);
});

test("pending paper entry expires even while market stays above its limit", async () => {
  const h = harness(); h.paper.mark(quote(h, 100.09, 100.1));
  expect((await h.desk.run(h.input, h.clock.now)).stage).toBe("SUBMITTED");
  h.clock.now += 900_001; h.paper.mark(quote(h, 101, 101.01));
  expect((await h.desk.reconcile(h.input.id, h.clock.now)).stage).toBe("REJECTED"); expect(h.paper.snapshot().openOrders).toHaveLength(0);
});

test("paper evidence hashes, freshness and persisted timestamp ordering are enforced after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "desk-paper-")); directories.push(directory); const path = join(directory, "ledger.sqlite"), first = store(path), h = harness(first);
  h.paper.mark(h.input.quote); first.close();
  const second = store(path), restarted = new LocalPaperBroker(second, 10_000, () => START);
  const old = evidence({ source: h.input.quote.source, provenance: h.input.quote.provenance, observedAt: START - 2000, receivedAt: START, payload: h.input.quote.payload });
  expect(() => restarted.mark(old)).toThrow("out_of_order");
  expect(() => restarted.mark({ ...h.input.quote, payload: { ...h.input.quote.payload, bid: 1 } })).toThrow("hash_mismatch");
  const stale = new LocalPaperBroker(second, 10_000, () => START + 60_001);
  expect(() => stale.mark(h.input.quote)).toThrow("stale");
});

test("stale cached price cannot claim successful emergency liquidation", async () => {
  const h = harness(); h.paper.mark(h.input.quote); await h.desk.run(h.input, h.clock.now);
  h.clock.now += 60_001; h.desk.latchKill("stale", h.clock.now);
  const result = await h.paper.emergencyFlatten(); expect(result.confirmed).toBe(false); expect(result.openPositions).toBe(1);
});

test("paper day-start equity rolls in New York time and does not reset lifetime realized outcomes", async () => {
  const h = harness(); h.paper.mark(h.input.quote); await h.desk.run(h.input, h.clock.now);
  h.clock.now += 1000; h.paper.mark(quote(h, 106)); expect(h.paper.snapshot().cash).toBe(10240);
  h.clock.now = Date.parse("2026-11-07T05:01:00Z");
  expect(h.paper.snapshot().dayStartEquity).toBe(10240); expect(h.paper.snapshot().equity).toBe(10240);
});

test("portfolio-only guard detects daily loss and stale prices without a new trade plan", () => {
  const h = harness(), payload = { ...h.input.risk.payload, equity: 9800, cash: 5800, positions: [{ symbol: "DEMO", quantity: 40, marketPrice: 100, stop: 98, correlationGroup: "a" }] };
  const risk = evidence({ source: "local://portfolio", observedAt: START, receivedAt: START, provenance: "synthetic", payload });
  expect(assessPortfolioSafety(risk, [], START, DEFAULT_DESK_RULES)).toContain("daily_loss_limit");
  expect(assessPortfolioSafety(risk, [], START, DEFAULT_DESK_RULES)).toContain("missing_position_quote:DEMO");
});

test("scheduled Trader handles an empty inbox and persists its completed routine", async () => {
  const h = harness(), job = claimDueDeskJobs(START, nyseCalendar2026(), h.journal).find(item => item.role === "trader")!;
  expect(job).toBeDefined();
  const result = await runDeskRoutine(job, h.journal, h.desk, { async read() { return { cases: [] }; } }, START, h.paper);
  expect((result as any).transitions[0].portfolioGuard.reasons).toEqual([]);
  expect(h.journal.load<{ status: string }>(`routine:${job.id}`)?.status).toBe("completed");
});

test("missing scheduled Trader provider data latches a durable kill and records failed routine", async () => {
  const h = harness(), job = claimDueDeskJobs(START, nyseCalendar2026(), h.journal).find(item => item.role === "trader")!;
  await runDeskRoutine(job, h.journal, h.desk, { async read() { throw new Error("provider disconnected"); } }, START, h.paper);
  expect(h.journal.load("desk:kill")).not.toBeNull(); expect(h.journal.load<{ status: string }>(`routine:${job.id}`)?.status).toBe("failed");
});


test("weekly underperformance pauses the exact strategy and parameter set before another plan executes", async () => {
  const h = harness();
  h.input.backtest = evidence({ source: "https://test.invalid/backtest", observedAt: START - 1000, receivedAt: START, provenance: "historical", payload: { ...h.input.backtest.payload, provenance: "historical" } });
  h.input.plan.evidenceIds = [h.input.scout.id, h.input.chart.id, h.input.backtest.id];
  h.paper.mark(h.input.quote); await h.desk.run(h.input, h.clock.now);
  h.clock.now += 1000; h.paper.mark(quote(h, 97)); await h.desk.reconcile(h.input.id, h.clock.now);
  const result = reviewDeskWeek(h.journal, h.clock.now);
  expect(result.reports[0]?.status).toBe("PAUSED_BELOW_EXPECTATIONS"); expect(result.reports[0]?.actualNetPnlUsd).toBe(-120);
  const second = { ...h.input, id: "post-review-case" };
  expect((await h.desk.run(second, h.clock.now)).reason).toBe("strategy_paused_by_weekly_review");
});

test("weekly report exposes missing historical benchmark instead of claiming synthetic outperformance", async () => {
  const h = harness(); h.paper.mark(h.input.quote); await h.desk.run(h.input, h.clock.now);
  h.clock.now += 1000; h.paper.mark(quote(h, 106)); await h.desk.reconcile(h.input.id, h.clock.now);
  const result = reviewDeskWeek(h.journal, h.clock.now);
  expect(result.reports[0]?.status).toBe("NO_HISTORICAL_BENCHMARK"); expect(result.reports[0]?.simulation).toBe(true);
});
