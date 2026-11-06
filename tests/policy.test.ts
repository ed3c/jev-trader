import { expect, test } from "bun:test";
import { DeterministicDecisionProvider } from "../src/engine/decisions";
import { composePolicy } from "../src/engine/policy";
import { buildSnapshot } from "../src/engine/state";
import type { DecisionBattery } from "../src/engine/types";

function snapshot(inventory = 0) {
  return buildSnapshot({
    sessionId: "s", symbol: "MON-USDC", block: 1, decisionTs: 100_001,
    book: { block: 1, ts: 100_000, bid: 99, ask: 101, bids: [[99, 10]], asks: [[101, 10]] },
    trades: [], flowWindowStartMs: 99_000,
    account: { inventory, equityUsd: 10_000, peakEquityUsd: 10_000, dayStartEquityUsd: 10_000, realizedPnlUsd: 0, unrealizedPnlUsd: 0, positionOpenedAtMs: inventory ? 99_000 : null },
    health: { apiErrors: 0, fillRatio: null, rejectRate: null, slippageBps: null, latenciesMs: [] },
  }, { requireWarmup: false });
}
function battery(s = snapshot()): DecisionBattery {
  return {
    snapshotId: s.id, sessionId: s.sessionId, source: "jev", modelId: "jev-1.14.0", requestedAtMs: 100_002, decidedAtMs: 100_003, validUntilMs: 100_252,
    latencyMs: 1, inputTokens: 100, outputTokens: 0, calibration: "unverified",
    regime: { choice: "mean_reverting", confidence: 0.9, probabilities: { trending: 0.1, mean_reverting: 0.8, high_vol: 0.1, crisis: 0 } },
    direction: { choice: "up", confidence: 0.9, probabilities: { up: 0.8, down: 0.1, neutral: 0.1 } },
    toxicFlow: 0.1, liquidityStressed: 0.1,
    quoteEnvironment: { score: 2.5, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 } },
    inventoryPressure: { score: 0, confidence: 0.9, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } },
  };
}

test("high confidence can quote both sides while marginal conditions reduce size and widen", () => {
  const s = snapshot(), b = battery(s);
  const normal = composePolicy(s, b, {}, 100_004);
  expect(normal.action).toBe("quote_both");
  expect(normal.sizeMultiplier).toBe(1);
  b.quoteEnvironment = { score: 1.5, confidence: 0.6, probabilities: { "0": 0, "1": 0.5, "2": 0.5, "3": 0 } };
  const marginal = composePolicy(s, b, {}, 100_004);
  expect(marginal.action).toBe("quote_wide");
  expect(marginal.sizeMultiplier).toBe(0.25);
  expect(marginal.spreadMultiplier).toBe(2);
  b.quoteEnvironment.confidence = 0.2;
  expect(composePolicy(s, b, {}, 100_004).action).toBe("hold");
});

test("toxicity veto takes precedence over a favorable quality score", () => {
  const s = snapshot(), b = battery(s); b.toxicFlow = 0.6;
  expect(composePolicy(s, b, {}, 100_004).action).toBe("pull_quotes");
});

test("liquidity stress widens approved quotes but never overrides a do-not-quote score", () => {
  const s = snapshot(), b = battery(s); b.liquidityStressed = 0.8;
  expect(composePolicy(s, b, {}, 100_004).action).toBe("quote_wide");
  b.quoteEnvironment = { score: 0, confidence: 0.9, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
  expect(composePolicy(s, b, {}, 100_004).action).toBe("pull_quotes");
});

test("inventory pressure only requests the exposure-reducing side", () => {
  const s = snapshot(10), b = battery(s);
  b.inventoryPressure = { score: 3, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } };
  const p = composePolicy(s, b, {}, 100_004);
  expect(p.action).toBe("reduce_inventory");
  expect(p.reduceSide).toBe("sell");
});

test("a direction probability is not substituted for its separate confidence", () => {
  const s = snapshot(), b = battery(s); b.direction.confidence = 0.2;
  expect(composePolicy(s, b, {}, 100_004).skew).toBe(0);
});

test("expired, wrong-session, malformed and altered evidence cannot authorize orders", () => {
  const s = snapshot(), b = battery(s);
  expect(composePolicy(s, b, {}, b.validUntilMs).reasons).toContain("decision_expired");
  const wrong = { ...b, sessionId: "other" };
  expect(composePolicy(s, wrong, {}, 100_004).reasons).toContain("decision_binding_mismatch");
  const malformed = structuredClone(b); malformed.direction.probabilities.up = 10;
  expect(composePolicy(s, malformed, {}, 100_004).reasons).toContain("invalid_decision");
  const altered = structuredClone(s); altered.price.mid = 200;
  expect(composePolicy(altered, b, {}, 100_004).action).toBe("kill");
});

test("stale data pulls resting quotes even without a model answer", () => {
  const s = snapshot();
  expect(composePolicy(s, null, {}, 101_001).action).toBe("pull_quotes");
});

test("deterministic fallback requires explicit opt-in and stays small/wide without confidence claims", async () => {
  const s = snapshot(), b = await new DeterministicDecisionProvider({ clock: () => 100_002 }).decide(s);
  expect(composePolicy(s, b, {}, 100_004).action).toBe("hold");
  const fallback = composePolicy(s, b, { allowDeterministicFallback: true }, 100_004);
  expect(fallback.action).toBe("quote_wide");
  expect(fallback.fallback).toBe(true);
  expect(fallback.sizeMultiplier).toBe(0.25);
  expect(b.quoteEnvironment.confidence).toBeNull();
  expect(composePolicy(s, null, { allowDeterministicFallback: true }, 100_004).action).toBe("hold");
});

test("invalid policy thresholds fail closed", () => {
  const s = snapshot();
  expect(composePolicy(s, battery(s), { minQuoteConfidence: NaN }, 100_004).action).toBe("kill");
});
