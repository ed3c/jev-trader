import { describe, expect, test } from "bun:test";
import { DeterministicDecisionProvider } from "../src/engine/decisions";
import type { DecisionBattery, DecisionProvider } from "../src/engine/types";
import { captureProviderReplay, compareBaselines, replayBaseline, syntheticReplayDataset, validateReplayDataset } from "../src/evaluation/replay";
import type { ReplayBaseline, ReplayConfig } from "../src/evaluation/replay";
import { assessStrategyEvidence, backtestPairs, failedIdeaFingerprint } from "../src/evaluation/strategy";
import type { StrategyEvidence } from "../src/evaluation/strategy";
import { simulateOU } from "../src/quant/ou";

/** Local protocol fixture only. This class never represents actual provider output. */
function fixtureProvider(source: "llm" | "jev", confidence: number): DecisionProvider {
  return {
    name: `unit-test-${source}-v1`,
    async decide(snapshot, options) {
      const rules = new DeterministicDecisionProvider({ clock: () => snapshot.decisionTs + 1 });
      const base = await rules.decide(snapshot, options);
      const result: DecisionBattery = { ...base, source, modelId: `unit-test-${source}-v1`,
        regime: { choice: "mean_reverting", probabilities: { trending: 0.1, mean_reverting: 0.8, high_vol: 0.1, crisis: 0 }, confidence },
        direction: { choice: "neutral", probabilities: { up: 0.2, down: 0.2, neutral: 0.6 }, confidence },
        quoteEnvironment: { score: 2.5, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 }, confidence },
        inventoryPressure: { score: 0, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence }, toxicFlow: 0.1, liquidityStressed: 0.1 };
      return result;
    },
  };
}

describe("chronological full-policy replay", () => {
  test("runs rule baseline offline and reports missing provider evidence without fake results", async () => {
    const result = await compareBaselines(syntheticReplayDataset(40));
    expect(result.providerCallsDuringReplay).toBe(0);
    expect(result.provenance.kind).toBe("synthetic");
    expect(result.results[0]!.status).toBe("COMPLETED");
    for (const baseline of result.results.slice(1)) {
      expect(baseline.status).toBe("NOT_RUN"); expect(baseline.metrics).toBeNull();
      expect(baseline.missingRecordings.length).toBe(1);
    }
    expect(result.comparisonStatus).toBe("INCOMPLETE_MISSING_PROVIDER_EVIDENCE");
  });

  test("replays all provider recordings against exact independently evolving portfolio states", async () => {
    const dataset = syntheticReplayDataset(40);
    const config: Partial<ReplayConfig> = { gasUsdPerSubmit: 0.00001, gasUsdPerCancel: 0.00001,
      expectedFillProbability: 1, makerFeeBps: 0, slippageCostBps: 0, adverseSelectionBps: 0 };
    const captured = new Map<ReplayBaseline, Awaited<ReturnType<typeof captureProviderReplay>>>();
    for (const baseline of ["llm", "jev", "jev_gated"] as const) {
      const record = await captureProviderReplay(dataset, baseline, () => fixtureProvider(baseline === "llm" ? "llm" : "jev", 0.1),
        () => ({ usd: 0.00001, basis: "unit-test fixture, not a real provider bill" }), config);
      captured.set(baseline, record);
      dataset.recordings = { ...dataset.recordings, [baseline]: record.recordings };
    }
    const result = await compareBaselines(dataset, config);
    expect(result.comparisonStatus).toBe("ALL_BASELINES_REPLAYED");
    for (const baseline of ["llm", "jev", "jev_gated"] as const) {
      const replay = result.results.find(row => row.baseline === baseline)!;
      expect(replay.metrics).toEqual(captured.get(baseline)!.result.metrics);
      expect(replay.fills).toEqual(captured.get(baseline)!.result.fills);
    }
    const plain = result.results.find(row => row.baseline === "jev")!;
    const gated = result.results.find(row => row.baseline === "jev_gated")!;
    expect(plain.metrics!.coverage).toBeGreaterThan(gated.metrics!.coverage);
    expect(gated.metrics!.fillCount).toBe(0);
  });

  test("a changed snapshot cannot reuse a provider decision from another state", async () => {
    const dataset = syntheticReplayDataset(35);
    const captured = await captureProviderReplay(dataset, "jev", () => fixtureProvider("jev", 0.95),
      () => ({ usd: 0, basis: "unit-test fixture" }));
    dataset.recordings = { jev: captured.recordings };
    const first = dataset.recordings.jev![0]!;
    first.battery.snapshotId = "a".repeat(64);
    const result = await replayBaseline(dataset, "jev");
    expect(result.status).toBe("NOT_RUN"); expect(result.metrics).toBeNull();
  });

  test("touching a quote does not invent queue-priority fills and gas still costs money", async () => {
    const dataset = syntheticReplayDataset(40);
    for (const frame of dataset.frames) {
      frame.book.bid = 99.98; frame.book.ask = 100.02;
      frame.book.bids = [[99.98, 100], [99.97, 100], [99.96, 100]];
      frame.book.asks = [[100.02, 100], [100.03, 100], [100.04, 100]];
      frame.settlementMid = 100;
      frame.tradesAfterDecision = [
        { ts: frame.book.ts + 300, side: "sell", price: 99.96, size: 1 },
        { ts: frame.book.ts + 600, side: "buy", price: 100.04, size: 1 },
      ];
    }
    const result = await replayBaseline(dataset, "rules", { gamma: 0, gasUsdPerSubmit: 0.0001, gasUsdPerCancel: 0.0001,
      expectedFillProbability: 1, makerFeeBps: 0, slippageCostBps: 0, adverseSelectionBps: 0 });
    expect(result.metrics!.fillCount).toBe(0);
    expect(result.metrics!.netPnlUsd).toBeLessThan(0);
    expect(result.metrics!.executionCostUsd).toBeGreaterThan(0);
  });

  test("the production risk engine vetoes oversized replay orders", async () => {
    const result = await replayBaseline(syntheticReplayDataset(40), "rules", { risk: { maxOrderSize: 0.01 },
      gasUsdPerSubmit: 0, gasUsdPerCancel: 0, expectedFillProbability: 1, makerFeeBps: 0, slippageCostBps: 0, adverseSelectionBps: 0 });
    expect(result.metrics!.fillCount).toBe(0);
    expect(result.events.some(event => event.reasons.includes("max_order_size"))).toBe(true);
  });

  test("future tape is never allowed into the decision-time input", () => {
    const dataset = syntheticReplayDataset(30);
    dataset.frames[0]!.tradesAfterDecision[0]!.ts = dataset.frames[0]!.decisionTs;
    expect(() => validateReplayDataset(dataset)).toThrow("execution tape");
  });

  test("economics vetoes costly churn and spot replay never opens an unbacked short", async () => {
    const data = syntheticReplayDataset(50);
    const expensive = await replayBaseline(data, "rules", { gasUsdPerSubmit: 10 });
    expect(expensive.metrics!.fillCount).toBe(0);
    expect(expensive.events.some(event => event.reasons.includes("cost_exceeds_expected_capture"))).toBe(true);
    const cheap = await replayBaseline(data, "rules", { gasUsdPerSubmit: 0, gasUsdPerCancel: 0,
      expectedFillProbability: 1, makerFeeBps: 0, slippageCostBps: 0, adverseSelectionBps: 0 });
    expect(cheap.events.every(event => event.inventory >= 0)).toBe(true);
    expect(cheap.fills.length).toBeGreaterThan(0);
  });
});

describe("strategy evidence and pair research", () => {
  const year = 365.25 * 86_400_000;
  const start = Date.UTC(2020, 0, 1), end = start + 4 * year;
  const hash = "a".repeat(64);
  const evidence: StrategyEvidence = {
    provenance: "historical", source: "test-only evidence schema", datasetHash: hash,
    historyStart: start, historyEnd: end, evaluationStart: end - 2 * year, evaluationEnd: end,
    trades: Array.from({ length: 40 }, (_, i) => ({ openedAt: end - 2 * year + i * year / 20, closedAt: end - 2 * year + i * year / 20 + 86_400_000, netPnlUsd: i % 3 ? 2 : -1 })),
    feesIncluded: true, slippageIncluded: true, maxDrawdown: 0.1,
    sensitivityRuns: ["base", "less", "more"].map(parameterHash => ({ parameterHash, datasetHash: hash, netPnlUsd: 10, maxDrawdown: 0.12 })),
  };
  test("even fully eligible research evidence never grants live approval", () => {
    const result = assessStrategyEvidence(evidence);
    expect(result.status).toBe("ELIGIBLE_FOR_PAPER");
    expect(result.liveApproved).toBe(false);
  });
  test("rejects synthetic history, insufficient trades and brittle parameters", () => {
    expect(assessStrategyEvidence({ ...evidence, provenance: "synthetic" }).status).toBe("REJECTED");
    expect(assessStrategyEvidence({ ...evidence, trades: evidence.trades.slice(0, 10) }).reasons).toContain("fewer_than_required_completed_trades");
    expect(assessStrategyEvidence({ ...evidence, sensitivityRuns: [evidence.sensitivityRuns[0]!] }).reasons).toContain("need_baseline_and_at_least_two_parameter_perturbations");
    expect(assessStrategyEvidence({ ...evidence, feesIncluded: false }).status).toBe("REJECTED");
  });
  test("failed-idea identity ignores object property ordering", () => {
    const a = failedIdeaFingerprint({ symbol: "A/B", strategy: "pairs", parameters: { entry: 2, exit: 0.5 }, datasetHash: hash });
    const b = failedIdeaFingerprint({ symbol: "A/B", strategy: "pairs", parameters: { exit: 0.5, entry: 2 }, datasetHash: hash });
    expect(a).toBe(b);
  });
  test("pair signals execute on a later bar, with both-leg costs and a training prefix", () => {
    const spread = simulateOU({ mean: 0, theta: 0.2, sigma: 0.05, initial: 0, dt: 1, count: 1_800, seed: 17 });
    const bars = spread.map((point, i) => ({ ts: start + i * 1_000, b: Math.exp(4 + i / 10_000), a: Math.exp(1 + 0.8 * (4 + i / 10_000) + point.value) }));
    const result = backtestPairs(bars, { trainingEnd: bars[999]!.ts, initialEquityUsd: 10_000, grossNotionalUsd: 1_000,
      feeBpsPerLeg: 1, slippageBpsPerLeg: 2, minHalfLife: 1_000, maxHalfLife: 60_000, entryZ: 1.5, exitZ: 0.3, stopZ: 4,
      periodsPerYear: 365.25 * 86_400, provenance: "synthetic" });
    expect(result.fit.trainingEnd).toBe(bars[999]!.ts);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.every(trade => trade.openedAt > bars[1_000]!.ts && trade.closedAt > trade.openedAt)).toBe(true);
    expect(result.metrics.executionCostUsd).toBeGreaterThan(0);
    expect(result.liveApproved).toBe(false);
    expect(result.fit.cointegration).toBe("NOT_TESTED");
  });
});
