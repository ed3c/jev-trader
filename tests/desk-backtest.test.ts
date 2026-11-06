import { describe, expect, test } from "bun:test";
import { DEFAULT_DESK_BREAKOUT_PARAMETERS, DESK_BREAKOUT_STRATEGY, computeDeskSignals, executeDeskBacktest, verifyDeskBacktestBinding, type DeskBacktestJob, type DeskDailyBar } from "../src/desk/backtest";
import { syntheticDeskCase } from "../src/desk/fixtures";
import { hash, validatePlan } from "../src/desk/evidence";

const DAY = 86_400_000;
/** Deliberately synthetic protocol fixture, with observable signal/fill/stop bars. */
function jobFixture(): DeskBacktestJob {
  const bars: DeskDailyBar[] = [];
  for (let day = Date.UTC(2025, 0, 2); bars.length < 300; day += DAY) {
    const weekday = new Date(day).getUTCDay(); if (weekday === 0 || weekday === 6) continue;
    const close = 100 + .4 * Math.sin(bars.length / 11) + .002 * bars.length;
    bars.push({ openAt: day + 14.5 * 3_600_000, closeAt: day + 21 * 3_600_000, open: close, high: close + 3, low: close - 3, close, volume: 1000 });
  }
  const breakout = (index: number) => {
    const previousHigh = Math.max(...bars.slice(index - 20, index).map(b => b.high));
    const b = bars[index]!, open = bars[index - 1]!.close, close = previousHigh + .2;
    Object.assign(b, { open, high: close + .1, low: open - 1, close, volume: 3000 });
  };
  breakout(215);
  const entry = Math.floor(bars[215]!.close * 100 + 1e-8) / 100;
  Object.assign(bars[216]!, { open: entry - .05, high: entry + .3, low: entry - .2, close: entry + .1 });
  // Both bracket sides trade on the following bar: the conservative stop must win.
  Object.assign(bars[217]!, { open: entry, high: entry + 30, low: entry - 20, close: entry });
  breakout(299);
  const last = bars.at(-1)!;
  return { caseId: "raw-bars-case", dataset: { symbol: "TEST", source: "local://synthetic-desk-backtest", provenance: "synthetic", adjustment: "split_adjusted", bars,
    events: { source: "local://synthetic-event-calendar", completeFrom: bars[0]!.openAt, completeThrough: last.closeAt + 12 * DAY, items: [] } },
    parameters: { ...DEFAULT_DESK_BREAKOUT_PARAMETERS }, evaluationStart: bars[199]!.closeAt, planSignalAt: last.closeAt };
}
function completed(job: DeskBacktestJob) { const result = executeDeskBacktest(job, job.dataset.bars.at(-1)!.closeAt + 1000); if (result.status !== "COMPLETED") throw new Error(result.reasons.join(",")); return result; }

describe("concrete nightly same-rule backtesting", () => {
  test("closed-bar indicators use only the prefix and match the defined volume/breakout filter", () => {
    const job = jobFixture(), prefix = computeDeskSignals(job.dataset.bars.slice(0, 216));
    expect(prefix).toEqual(computeDeskSignals(job.dataset.bars).slice(0, 216));
    expect(prefix[198]!.warm).toBeFalse();
    expect(prefix[215]!.buy).toBeTrue();
    expect(prefix[215]!.atr!).toBeLessThanOrEqual(prefix[215]!.atr90!);
    const withoutVolume = structuredClone(job.dataset.bars); withoutVolume[215]!.volume = 100;
    expect(computeDeskSignals(withoutVolume)[215]!.buy).toBeFalse();
  });
  test("runs actual next-bar limit fills with stop-first ambiguity and both-side costs", () => {
    const job = jobFixture(), result = completed(job), trade = result.baseline.trades[0]!;
    expect(result.strategyId).toBe(DESK_BREAKOUT_STRATEGY);
    expect(trade.openedAt).toBe(job.dataset.bars[216]!.openAt);
    expect(trade.closedAt).toBe(job.dataset.bars[217]!.closeAt);
    expect(trade.reason).toBe("stop"); expect(trade.netPnlUsd).toBeLessThan(0);
    expect(result.baseline.metrics.executionCostUsd).toBeGreaterThan(0);
    const noCosts = completed({ ...job, parameters: { ...job.parameters, feeBpsPerSide: 0, slippageBpsPerSide: 0 } });
    expect(result.baseline.metrics.netPnlUsd).toBeLessThan(noCosts.baseline.metrics.netPnlUsd);
    expect(result.sensitivity).toHaveLength(2);
    expect(new Set(result.evidence.payload.sensitivityRuns.map(r => r.parameterHash)).size).toBe(3);
    expect(result.evidence.payload.sensitivityRuns.every(r => r.datasetHash === result.datasetHash)).toBeTrue();
  });
  test("the last signal is not a fabricated fill and generated plan binds exact risk rules", () => {
    const job = jobFixture(), result = completed(job), plan = result.plan!;
    expect(plan).not.toBeNull(); validatePlan(plan);
    expect(plan.entry).toBe(Math.floor((job.dataset.bars.at(-1)!.close + 1e-10) * 100) / 100);
    expect((plan.entry - plan.stop) * plan.quantity).toBeLessThanOrEqual(100);
    expect(plan.entry * plan.quantity).toBeLessThanOrEqual(10_000);
    expect(plan.parametersHash).toBe(hash(job.parameters));
    expect(plan.evidenceIds).toContain(result.evidence.id);
    expect(result.baseline.pendingEntry).not.toBeNull();
    expect(result.baseline.trades.every(t => t.openedAt < job.planSignalAt)).toBeTrue();
    expect(result.acceptance.status).toBe("REJECTED");
    expect(result.acceptance.reasons).toContain("synthetic_data_is_not_strategy_acceptance_evidence");
    expect(result.acceptance.reasons).toContain("fewer_than_three_years_of_history");
  });
  test("a touch-only entry cannot fill and an opening gap below the stop cancels the setup", () => {
    for (const gap of [false, true]) {
      const job = jobFixture(), b = job.dataset.bars[216]!, entry = Math.floor((job.dataset.bars[215]!.close + 1e-10) * 100) / 100;
      Object.assign(b, gap ? { open: entry - 30, high: entry - 29, low: entry - 31, close: entry - 30 } : { open: entry + .1, high: entry + .3, low: entry, close: entry + .2 });
      const result = completed(job);
      expect(result.baseline.trades).toHaveLength(0);
      expect(result.baseline.counters.unfilledLimits).toBeGreaterThan(0);
    }
  });
  test("known events veto plans; later announcements cannot leak into earlier decisions", () => {
    const job = jobFixture(), signalAt = job.dataset.bars[215]!.closeAt;
    job.dataset.events!.items.push({ at: signalAt + 2 * DAY, knownAt: signalAt - DAY, kind: "fed" });
    expect(completed(job).baseline.counters.eventVetoes).toBeGreaterThan(0);
    expect(completed(job).baseline.trades).toHaveLength(0);
    job.dataset.events!.items[0]!.knownAt = signalAt + DAY;
    expect(completed(job).baseline.trades).toHaveLength(1);
    job.dataset.events!.items.push({ at: job.planSignalAt + DAY, knownAt: job.planSignalAt, kind: "earnings", symbol: "TEST" });
    const result = completed(job); expect(result.plan).toBeNull(); expect(result.planReason).toBe("scheduled_event_in_holding_window");
  });
  test("missing data, unknown calendars, stale plan bars, and future candles are NOT_RUN", () => {
    const job = jobFixture(), now = job.planSignalAt + 1000;
    const { events: _events, ...withoutEvents } = job.dataset;
    const unknown = executeDeskBacktest({ ...job, dataset: withoutEvents }, now);
    expect(unknown.status).toBe("NOT_RUN");
    if (unknown.status === "NOT_RUN") expect(unknown.reasons).toContain("complete_sourced_event_calendar_required");
    expect(executeDeskBacktest(job, job.planSignalAt - 1).status).toBe("NOT_RUN");
    expect(executeDeskBacktest({ ...job, planSignalAt: job.planSignalAt - DAY }, now).status).toBe("NOT_RUN");
    expect(executeDeskBacktest({ ...job, dataset: { ...job.dataset, bars: [] } }, now).status).toBe("NOT_RUN");
  });
  test("malformed OHLC, reorder, non-daily bars, and risk greater than 1% are rejected", () => {
    const job = jobFixture();
    const bad = structuredClone(job); bad.dataset.bars[5]!.low = bad.dataset.bars[5]!.high + 1;
    expect(() => completed(bad)).toThrow("invalid_or_nonchronological");
    const reordered = structuredClone(job); reordered.dataset.bars.reverse();
    expect(() => completed(reordered)).toThrow("invalid_or_nonchronological");
    expect(() => completed({ ...job, parameters: { ...job.parameters, riskFraction: .02 } })).toThrow("violate_desk_rules");
    expect(() => completed({ ...job, parameters: { ...job.parameters, feeBpsPerSide: NaN } })).toThrow("invalid_backtest_parameter");
  });
  test("nightly recomputation binds data, rule parameters, outcomes, and exact proposed order", () => {
    const job = jobFixture(), first = completed(job);
    const input = { ...syntheticDeskCase(job.planSignalAt + 1000, job.caseId, job.dataset.symbol), plan: first.plan!, backtest: first.evidence };
    const later = executeDeskBacktest(job, job.planSignalAt + 5000);
    expect(() => verifyDeskBacktestBinding(later, input)).not.toThrow();
    expect(() => verifyDeskBacktestBinding(later, { ...input, plan: { ...input.plan, entry: input.plan.entry + .01 } })).toThrow("plan_binding");
    expect(() => verifyDeskBacktestBinding(later, { ...input, backtest: { ...input.backtest, payload: { ...input.backtest.payload, datasetHash: "a".repeat(64) } } })).toThrow("evidence_binding");
    expect(() => verifyDeskBacktestBinding({ status: "NOT_RUN", reasons: ["missing"], caseId: input.id }, input)).toThrow("no_computed_plan");
  });
});
