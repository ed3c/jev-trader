import { describe, expect, test } from "bun:test";
import { calibrationMetrics, chronologicalCalibrationSplit, evaluatePlatt, fitPlatt } from "../src/evaluation/calibration";
import type { CalibrationSample } from "../src/evaluation/calibration";
import { performanceMetrics } from "../src/evaluation/metrics";

function samples(start: number): CalibrationSample[] {
  return Array.from({ length: 200 }, (_, i) => {
    const high = Math.floor(i / 10) % 2 === 0;
    return { id: `${start}-${i}`, modelId: "jev-fixed-version", predictionAt: start + i * 2, outcomeAt: start + i * 2 + 1,
      probability: high ? 0.9 : 0.1, outcome: i % 10 < (high ? 6 : 4) ? 1 : 0 };
  });
}

describe("probability calibration", () => {
  test("Brier, log-loss and reliability bins match simple analytic values", () => {
    const data: CalibrationSample[] = [
      { id: "a", modelId: "v1", predictionAt: 1, outcomeAt: 2, probability: 0.8, outcome: 1 },
      { id: "b", modelId: "v1", predictionAt: 3, outcomeAt: 4, probability: 0.2, outcome: 0 },
    ];
    const metrics = calibrationMetrics(data);
    expect(metrics.brier).toBeCloseTo(0.04, 12);
    expect(metrics.logLoss).toBeCloseTo(-Math.log(0.8), 12);
    expect(metrics.ece).toBeCloseTo(0.2, 12);
    expect(metrics.reliability.filter(bin => bin.count === 0).every(bin => bin.observed === null && bin.predicted === null)).toBe(true);
  });
  test("purges labels which were unavailable at the split", () => {
    const data = samples(0);
    data[49] = { ...data[49]!, outcomeAt: 150 };
    const split = chronologicalCalibrationSplit(data, 100);
    expect(split.purged.some(sample => sample.id === "0-49")).toBe(true);
    expect(split.training.every(sample => sample.outcomeAt <= 100)).toBe(true);
    expect(split.validation.every(sample => sample.predictionAt > 100)).toBe(true);
  });
  test("Platt scaling improves an overconfident held-out dataset without overlapping training", () => {
    const training = samples(0), validation = samples(1_000);
    const fit = fitPlatt(training, 500);
    const result = evaluatePlatt(fit, validation);
    expect(result.calibrated.ece).toBeLessThan(result.raw.ece);
    expect(result.calibrated.logLoss).toBeLessThan(result.raw.logLoss);
    expect(result.calibrated.brier).toBeLessThan(result.raw.brier);
    expect(() => fitPlatt(training, 100)).toThrow("unavailable");
    expect(() => evaluatePlatt(fit, training)).toThrow("overlaps");
    expect(() => evaluatePlatt(fit, validation.map(sample => ({ ...sample, modelId: "new-version" })))).toThrow("version mismatch");
  });
  test("duplicate, nonfuture and malformed calibration labels fail", () => {
    const data = samples(0);
    expect(() => calibrationMetrics([data[0]!, data[0]!])).toThrow();
    expect(() => calibrationMetrics([{ ...data[0]!, outcomeAt: 0 }])).toThrow();
    expect(() => calibrationMetrics([{ ...data[0]!, probability: NaN }])).toThrow();
  });
});

describe("performance metrics", () => {
  test("cost, coverage, drawdown and closed-trade statistics are auditable", () => {
    const metrics = performanceMetrics({ initialEquity: 100, equity: [{ ts: 1, equity: 110 }, { ts: 2, equity: 99 }],
      closedTradePnls: [10, -5], fills: [{ notional: 20, slippageBps: 2, adverseSelectionBps: 3 }, { notional: 10, slippageBps: 5, adverseSelectionBps: -3 }],
      decisions: 100, quotingDecisions: 20, decisionCostUsd: 0.01, executionCostUsd: 1, periodsPerYear: 365 });
    expect(metrics.netPnlUsd).toBe(-1);
    expect(metrics.maxDrawdown).toBeCloseTo(0.1, 12);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.averageWinLossRatio).toBe(2);
    expect(metrics.coverage).toBe(0.2);
    expect(metrics.costPerMillionDecisionsUsd).toBe(100);
    expect(metrics.slippageBps).toBe(3);
    expect(metrics.adverseSelectionBps).toBe(1);
  });
  test("undefined ratios are null and chronology is enforced", () => {
    const input = { initialEquity: 100, equity: [{ ts: 1, equity: 100 }, { ts: 2, equity: 100 }], closedTradePnls: [], fills: [], decisions: 2,
      quotingDecisions: 0, decisionCostUsd: 0, executionCostUsd: 0, periodsPerYear: 365 };
    const result = performanceMetrics(input);
    expect(result.sharpe).toBeNull(); expect(result.sortino).toBeNull(); expect(result.winRate).toBeNull();
    expect(() => performanceMetrics({ ...input, equity: [...input.equity].reverse() })).toThrow();
  });
});
