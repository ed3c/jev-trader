import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/desk/evidence";
import { checkAlpacaLiveAuthorization, deriveExpectedPaperRange, derivePaperEvidenceMetrics, verifyPaperJournalExport } from "../src/desk/live-authorization";
import type { AlpacaExpectedRangeArtifact, AlpacaLiveGatePaths, AlpacaLiveOrderAuthorization, AlpacaPaperReadinessReport, PaperAuditEvent } from "../src/desk/live-authorization";
import type { BracketRequest, TradePlan } from "../src/desk/types";

// Every record in these tests is fabricated to exercise authorization semantics.
// None is historical research, an authenticated broker record, or a live-readiness report.
const DAY = 86_400_000, NOW = Date.parse("2026-11-06T15:00:00Z"), directories: string[] = [];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function chain(input: PaperAuditEvent[]): PaperAuditEvent[] {
  let previous = "GENESIS";
  return input.map((row, index) => {
    const event = { ...row, seq: index + 1, previous_hash: previous, event_hash: hash({ eventKey: row.event_key, ts: row.ts, kind: row.kind, payload: row.payload, previous }) };
    previous = event.event_hash; return event;
  });
}
function event(kind: string, ts: number, payload: unknown, key: string): PaperAuditEvent {
  return { seq: 0, event_key: key, ts, kind, payload, previous_hash: "", event_hash: "" };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jev-live-gate-test-only-")); directories.push(directory);
  const startedAt = NOW - 19 * DAY, endedAt = NOW - DAY, duration = endedAt - startedAt;
  const parametersHash = hash({ testOnly: true, strategy: "fixture" }), datasetHash = hash({ testOnly: true, dataset: "fixture" });
  const fullSizePlan: TradePlan = { symbol: "TEST", side: "buy", entry: 100, stop: 98, target: 106, quantity: 40,
    holdingUntil: NOW + 3 * DAY, thesis: "Authorization protocol test fixture; never submit", strategyId: "test-only-strategy", parametersHash, evidenceIds: [hash({ fixture: true })] };
  const plan = { ...fullSizePlan, quantity: 4 }, planHash = hash(plan), clientOrderId = `desk-${hash({ test: "one-order" }).slice(0, 40)}`;
  const request: BracketRequest = { clientOrderId, plan, planHash,
    approval: { planHash, caseHash: hash({ case: "test-only" }), riskEvidenceId: hash({ risk: "test-only" }), approvedAt: NOW - 100, expiresAt: NOW + 600_000, mode: "live", synthetic: false },
    quoteObservedAt: NOW - 10, riskObservedAt: NOW - 10, quoteEvidenceId: hash({ quote: "test-only" }), currentRiskEvidenceId: hash({ risk: "test-only" }) };
  const historyEnd = startedAt - 2 * DAY, evaluationStart = historyEnd - 21 * duration;
  const backtest: AlpacaPaperReadinessReport["backtest"] = { provenance: "historical", source: "test-only://fabricated-schema-do-not-use", datasetHash,
    strategyId: plan.strategyId, parametersHash, historyStart: historyEnd - 4 * 365.25 * DAY, historyEnd, evaluationStart, evaluationEnd: historyEnd,
    trades: Array.from({ length: 42 }, (_, i) => ({ openedAt: evaluationStart + Math.floor(i / 2) * duration + (i % 2 ? duration / 2 + 1 : 1),
      closedAt: evaluationStart + Math.floor(i / 2) * duration + (i % 2 ? duration - 1 : duration / 2), netPnlUsd: 15 })),
    feesIncluded: true, slippageIncluded: true, maxDrawdown: 0,
    sensitivityRuns: [parametersHash, hash({ test: "other1" }), hash({ test: "other2" })].map(parameterHash => ({ parameterHash, datasetHash, netPnlUsd: 630, maxDrawdown: 0 })) };
  let events: PaperAuditEvent[] = [];
  const orderDay = (i: number) => 1 + Math.floor(i * 13 / 29);
  for (let day = 0; day <= 18; day++) {
    const closed = Array.from({ length: 30 }, (_, i) => i).filter(i => orderDay(i) <= day).length;
    events.push(event("alpaca_account_telemetry", startedAt + day * DAY, { accountId: "test-paper-account", mode: "alpaca-paper", equity: 10_000 + closed,
      cash: 10_000 + closed, dayStartEquity: 10_000 + Math.max(0, closed - 3), positions: [], openOrders: [] }, `telemetry-${day}`));
  }
  for (let i = 0; i < 30; i++) {
    const at = startedAt + orderDay(i) * DAY - 3_600_000 + i;
    events.push(event("alpaca_intent", at - 1000, { ...request, clientOrderId: `paper-client-${i}` }, `intent-${i}`));
    events.push(event("alpaca_paper_verified_order", at, { accountId: "test-paper-account", strategyId: plan.strategyId, parametersHash,
      order: { id: `entry-${i}`, clientOrderId: `paper-client-${i}`, planHash, symbol: "TEST", status: "closed", filledQuantity: 1, filledPrice: 100, bracketProtected: true },
      execution: { entryFilledQty: 1, entryFilledPrice: 100, feesUsd: 0, exits: [{ id: `exit-${i}`, qty: 1, price: 101, status: "filled", side: "sell", type: "limit" }] } }, `closed-${i}`));
  }
  events.sort((a, b) => a.ts - b.ts || a.event_key.localeCompare(b.event_key)); events = chain(events);
  const artifact: AlpacaExpectedRangeArtifact = { version: 1, source: "chronological-historical-holdout", strategyId: plan.strategyId, parametersHash,
    datasetHash, backtestHash: hash(backtest), initialEquityUsd: 10_000, windowDurationMs: duration, createdAt: startedAt - DAY };
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const report: AlpacaPaperReadinessReport = { version: 1, source: "alpaca-paper", eligible: true, paperAccountId: "test-paper-account",
    strategyId: plan.strategyId, parametersHash, generatedAt: endedAt + 2000, startedAt, endedAt,
    observedDates: Array.from({ length: 19 }, (_, i) => formatter.format(startedAt + i * DAY)), filledOrders: 30, closedTrades: 30, unresolvedOrders: 0, ruleViolations: 0,
    netPnlUsd: 30, expectedNetPnlRangeUsd: [30, 30], maxDrawdownFraction: 0, backtest,
    paperJournalPath: join(directory, "test-journal.json"), paperJournalSha256: "", expectedRangePath: join(directory, "test-range.json"), expectedRangeSha256: "" };
  const authorization: AlpacaLiveOrderAuthorization = { id: "test-only-human-approval", clientOrderId, version: 1, approved: true,
    approvedBy: "test-only-human", accountId: "test-live-account", planHash, issuedAt: NOW - 100, expiresAt: NOW + 600_000, reportSha256: "", fullSizePlan };
  const paths: AlpacaLiveGatePaths = { readinessReportFile: join(directory, "test-report.json"), orderAuthorizationFile: join(directory, "test-authorization.json"), expectedAccountId: "test-live-account" };
  const write = (rechain = true) => {
    if (rechain) events = chain(events);
    const journalText = JSON.stringify(events), rangeText = JSON.stringify(artifact);
    report.paperJournalSha256 = digest(journalText); report.expectedRangeSha256 = digest(rangeText);
    writeFileSync(report.paperJournalPath, journalText); writeFileSync(report.expectedRangePath, rangeText);
    const reportText = JSON.stringify(report); writeFileSync(paths.readinessReportFile, reportText);
    authorization.reportSha256 = digest(reportText); writeFileSync(paths.orderAuthorizationFile, JSON.stringify(authorization));
  };
  const addActivities = () => {
    const captureAt = endedAt + 1000;
    for (const orderEvent of [...events].filter(item => item.kind === "alpaca_paper_verified_order")) {
      orderEvent.payload.execution.feesUsd = null;
      const i = orderEvent.payload.order.id.split("-")[1];
      for (const [side, id, price, at] of [["buy", `entry-${i}`, 100, orderEvent.ts - 1000], ["sell", `exit-${i}`, 101, orderEvent.ts]] as const) {
        events.push(event("alpaca_account_activity", captureAt, { accountId: "test-paper-account", mode: "alpaca-paper", activity: {
          id: `activity-${id}`, activity_type: "FILL", order_id: id, symbol: "TEST", qty: "1", price: String(price), side, type: "fill", transaction_time: new Date(at).toISOString() } }, `activity-event-${id}`));
      }
    }
    events.push(event("alpaca_activity_coverage", endedAt + 1001, { accountId: "test-paper-account", mode: "alpaca-paper", complete: true,
      after: new Date(startedAt - 1).toISOString(), until: new Date(endedAt + 1).toISOString() }, "activity-coverage"));
  };
  write();
  return { request, authorization, report, artifact, paths, get events() { return events; }, write, addActivities };
}

describe("live per-order authorization from recorded paper evidence", () => {
  test("a complete protocol fixture derives metrics and matches its precommitted holdout range", () => {
    const f = fixture();
    const events = verifyPaperJournalExport(f.events, f.report.generatedAt);
    const actual = derivePaperEvidenceMetrics(events, f.report);
    expect(actual.netPnlUsd).toBe(30); expect(actual.closedTrades).toBe(30); expect(actual.feeEvidence).toBe("explicit_order_fees");
    expect(deriveExpectedPaperRange(f.report, f.artifact, actual.initialEquityUsd)).toEqual([30, 30]);
    expect(checkAlpacaLiveAuthorization(f.paths, f.request, NOW).id).toBe(f.authorization.id);
  });

  test("the same plan cannot reuse one human approval for a different order ID", () => {
    const f = fixture(), other = { ...f.request, clientOrderId: `desk-${"d".repeat(40)}` };
    expect(() => checkAlpacaLiveAuthorization(f.paths, other, NOW)).toThrow("per_order_authorization");
  });

  test("missing approval ID, another account, expired approval and invalid clock fail closed", () => {
    const f = fixture();
    for (const now of [NaN, Infinity, 0]) expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, now)).toThrow("clock");
    f.authorization.id = ""; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("per_order_authorization");
    f.authorization.id = "test-only"; f.authorization.accountId = "another-account"; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("per_order_authorization");
    f.authorization.accountId = f.paths.expectedAccountId; f.authorization.expiresAt = NOW; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("per_order_authorization");
  });

  test("ten-percent sizing cannot change other plan terms or use an oversized reference", () => {
    const f = fixture();
    f.authorization.fullSizePlan.stop = 97; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("changes_reference_plan");
    f.authorization.fullSizePlan.stop = 98; f.authorization.fullSizePlan.quantity = 500; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("reference_exceeds_paper_risk_budget");
  });

  test("a favorable claimed PnL cannot replace broker-derived outcomes", () => {
    const f = fixture(); f.report.netPnlUsd = 60; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("summary_disagrees");
  });

  test("a broad claimed expected range cannot replace all chronological holdout windows", () => {
    const f = fixture(); f.report.expectedNetPnlRangeUsd = [-1000, 1000]; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("precommitted_backtest_range");
    f.report.expectedNetPnlRangeUsd = [30, 30]; f.artifact.createdAt = f.report.startedAt + 1; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("not_precommitted");
  });

  test("future historical results cannot qualify a currently approved live plan", () => {
    const f = fixture(); f.report.backtest.historyEnd = f.report.startedAt + 1; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("current_clean_strategy");
  });

  test("altered or truncated audit history fails even when its file hash is newly bound", () => {
    const f = fixture(); f.events[0]!.payload.equity = 20_000; f.write(false);
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("journal_integrity");
    const g = fixture(); g.events.shift(); g.write(false);
    expect(() => checkAlpacaLiveAuthorization(g.paths, g.request, NOW)).toThrow("journal_integrity");
  });

  test("fees are unknown until explicit costs or complete account activities reconcile", () => {
    const f = fixture(); for (const row of f.events) if (row.kind === "alpaca_paper_verified_order") row.payload.execution.feesUsd = null;
    f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("fees_unknown");
  });

  test("complete matching activities and account equity can establish an explicit zero fee", () => {
    const f = fixture(); f.addActivities(); f.write();
    const metrics = derivePaperEvidenceMetrics(verifyPaperJournalExport(f.events, f.report.generatedAt), f.report);
    expect(metrics.feeEvidence).toBe("complete_account_activities"); expect(metrics.netPnlUsd).toBe(30);
    expect(checkAlpacaLiveAuthorization(f.paths, f.request, NOW).clientOrderId).toBe(f.request.clientOrderId);
  });

  test("an incomplete activities page or unmatched fill cannot imply zero costs", () => {
    const f = fixture(); f.addActivities();
    f.events.find(row => row.kind === "alpaca_activity_coverage")!.payload.complete = false; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("complete_activity_coverage");
    const g = fixture(); g.addActivities();
    const activity = g.events.find(row => row.kind === "alpaca_account_activity")!;
    activity.payload.activity.qty = "2"; g.write();
    expect(() => checkAlpacaLiveAuthorization(g.paths, g.request, NOW)).toThrow("activities_do_not_reconcile");
  });

  test("unexplained account cash changes and mixed activity require reconciliation", () => {
    const f = fixture(), last = f.events.findLast(row => row.kind === "alpaca_account_telemetry")!;
    last.payload.equity += 100; last.payload.cash += 100; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("pnl_does_not_reconcile");
    const g = fixture(); g.addActivities();
    g.events.push(event("alpaca_account_activity", g.report.endedAt + 1001, { accountId: "test-paper-account", mode: "alpaca-paper", activity: {
      id: "deposit-test", activity_type: "CSD", date: new Date(g.report.startedAt + DAY).toISOString(), net_amount: "100", status: "executed" } }, "deposit-event"));
    g.write(); expect(() => checkAlpacaLiveAuthorization(g.paths, g.request, NOW)).toThrow("nontrade_cash");
  });

  test("closed labels cannot conceal residual exit quantities or unconfirmed intents", () => {
    const f = fixture(); f.events.find(row => row.kind === "alpaca_paper_verified_order")!.payload.execution.exits[0].qty = .5; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("residual_inventory");
    const g = fixture(); g.events.push(event("alpaca_intent", g.report.endedAt - 1, { ...g.request, clientOrderId: "missing-outcome" }, "missing-intent")); g.write();
    expect(() => checkAlpacaLiveAuthorization(g.paths, g.request, NOW)).toThrow("no_confirmed_outcome");
  });

  test("unobserved dates, non-flat endpoints and actual drawdowns cannot be self-certified", () => {
    const f = fixture(); f.report.observedDates[0] = "2026-01-01"; f.write();
    expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("summary_disagrees");
    const g = fixture(); g.events.findLast(row => row.kind === "alpaca_account_telemetry")!.payload.openOrders = [{ id: "still-open" }]; g.write();
    expect(() => checkAlpacaLiveAuthorization(g.paths, g.request, NOW)).toThrow("confirmed_flat_endpoints");
    const h = fixture(), middle = h.events.filter(row => row.kind === "alpaca_account_telemetry")[7]!;
    middle.payload.equity = 9700; middle.payload.cash = 9700; middle.payload.dayStartEquity = 9700; h.write();
    expect(() => checkAlpacaLiveAuthorization(h.paths, h.request, NOW)).toThrow("drawdown_exceeded");
  });

  test("known ambiguous or kill events block an otherwise favorable paper report", () => {
    for (const kind of ["kill_switch", "alpaca_ambiguous"]) {
      const f = fixture(); f.events.push(event(kind, f.report.endedAt - 1, { reason: "test incident" }, `test-${kind}`)); f.write();
      expect(() => checkAlpacaLiveAuthorization(f.paths, f.request, NOW)).toThrow("rule_or_ambiguous_events");
    }
  });
});
