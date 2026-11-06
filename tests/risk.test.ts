import { expect, test } from "bun:test";
import { evaluateRisk } from "../src/engine/risk";
import { buildSnapshot } from "../src/engine/state";
import type { RiskInput, SnapshotInput } from "../src/engine/types";

function snapshotInput(): SnapshotInput {
  return {
    sessionId: "s", symbol: "MON-USDC", block: 1, decisionTs: 4_000_001,
    book: { block: 1, ts: 4_000_000, bid: 99, ask: 101, bids: [[99, 100]], asks: [[101, 100]] },
    account: { inventory: 0, equityUsd: 100_000, peakEquityUsd: 100_000, dayStartEquityUsd: 100_000, realizedPnlUsd: 0, unrealizedPnlUsd: 0, positionOpenedAtMs: null },
    health: { apiErrors: 0, fillRatio: null, rejectRate: null, slippageBps: null, latenciesMs: [] },
  };
}
function riskInput(raw = snapshotInput()): RiskInput {
  return { snapshot: buildSnapshot(raw, { requireWarmup: false }), orders: [{ side: "buy", price: 99, size: 100 }], openOrders: [], decisionLatencyMs: 10, nowMs: 4_000_020 };
}

test("ordinary valid post-only orders pass the deterministic gate", () => {
  expect(evaluateRisk(riskInput()).ok).toBe(true);
});

test("pending/resting orders count without netting the opposite side", () => {
  const raw = snapshotInput(); raw.account.inventory = 900; raw.account.positionOpenedAtMs = 3_900_000;
  const r = riskInput(raw); r.openOrders = [{ side: "buy", price: 99, size: 200 }, { side: "sell", price: 101, size: 200 }];
  const verdict = evaluateRisk(r, { maxLeverage: 2 });
  expect(verdict.ok).toBe(false);
  expect(verdict.reasons).toContain("max_position");
  expect(verdict.worstCasePosition).toBe(1200);
  expect(verdict.kill).toBe(false);
});

test("oversized and crossing orders are rejected without changing their side", () => {
  const r = riskInput(); r.orders[0]!.size = 201;
  expect(evaluateRisk(r).reasons).toContain("max_order_size");
  r.orders[0]!.size = 100; r.orders[0]!.price = 101;
  expect(evaluateRisk(r).reasons).toContain("not_post_only");
  expect(r.orders[0]!.side).toBe("buy");
  r.orders = [{ side: "buy", price: 100.5, size: 100 }, { side: "sell", price: 100, size: 100 }];
  expect(evaluateRisk(r).reasons).toContain("self_crossing_orders");
});

test("daily loss, drawdown, stale data and API failure thresholds latch at equality", () => {
  const day = snapshotInput(); day.account.equityUsd -= 2;
  const loss = evaluateRisk(riskInput(day));
  expect(loss.kill).toBe(true); expect(loss.reasons).toContain("max_daily_loss");
  const drawdown = snapshotInput(); drawdown.account.equityUsd = 95_000;
  const dd = evaluateRisk(riskInput(drawdown));
  expect(dd.kill).toBe(true); expect(dd.reasons).toContain("max_drawdown");
  const stale = riskInput(); stale.nowMs = stale.snapshot.bookTs + 1000;
  expect(evaluateRisk(stale).reasons).toContain("stale_data");
  const errors = snapshotInput(); errors.health.apiErrors = 3;
  expect(evaluateRisk(riskInput(errors)).reasons).toContain("max_api_errors");
});

test("age and projected leverage are checked against observed positions", () => {
  const raw = snapshotInput(); raw.account.inventory = 10; raw.account.positionOpenedAtMs = 100_000;
  expect(evaluateRisk(riskInput(raw)).reasons).toContain("max_inventory_age");
  const lowEquity = snapshotInput(); lowEquity.account = { ...lowEquity.account, equityUsd: 100, peakEquityUsd: 100, dayStartEquityUsd: 100 };
  expect(evaluateRisk(riskInput(lowEquity)).reasons).toContain("max_leverage");
});

test("latency rejects a late decision, and a persisted kill cannot be cleared by good data", () => {
  const late = riskInput(); late.decisionLatencyMs = 251;
  const verdict = evaluateRisk(late);
  expect(verdict.ok).toBe(false);
  expect(verdict.kill).toBe(false);
  expect(verdict.reasons).toContain("max_decision_latency");
  const killed = riskInput(); killed.killed = true;
  expect(evaluateRisk(killed).kill).toBe(true);
  expect(evaluateRisk(killed).reasons).toContain("kill_switch_latched");
});

test("nonfinite inputs, tampered snapshots and invalid limits fail closed", () => {
  const invalid = riskInput(); invalid.orders[0]!.size = NaN;
  expect(evaluateRisk(invalid).kill).toBe(true);
  const changed = riskInput(); changed.snapshot = structuredClone(changed.snapshot); changed.snapshot.account.inventory = NaN;
  expect(evaluateRisk(changed).kill).toBe(true);
  expect(evaluateRisk(riskInput(), { maxLeverage: NaN }).reasons).toContain("invalid_risk_limits");
});
