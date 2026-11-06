import { createHash } from "node:crypto";
import { fitPairs, meanReversionSignal, pairsZScore } from "../quant/ou";
import { finite, nonnegative, positive } from "../quant/math";
import { performanceMetrics } from "./metrics";

export interface ClosedStrategyTrade { openedAt: number; closedAt: number; netPnlUsd: number }
export interface StrategyEvidence {
  provenance: "historical" | "synthetic";
  source: string;
  datasetHash: string;
  historyStart: number;
  historyEnd: number;
  /** A historical data span is not enough: these timestamps define the evaluated holdout. */
  evaluationStart: number;
  evaluationEnd: number;
  trades: ClosedStrategyTrade[];
  feesIncluded: boolean;
  slippageIncluded: boolean;
  maxDrawdown: number;
  /** Distinct, non-identical settings, evaluated on the same held-out dataset. */
  sensitivityRuns: { parameterHash: string; datasetHash: string; netPnlUsd: number; maxDrawdown: number }[];
}

/** Implements the desk's three-year / 30-trade / recent-year / robustness gates. */
export function assessStrategyEvidence(evidence: StrategyEvidence, limits: { minimumTrades?: number; maximumDrawdown?: number } = {}) {
  const minimumTrades = limits.minimumTrades ?? 30;
  const maximumDrawdown = limits.maximumDrawdown ?? 0.2;
  if (!Number.isInteger(minimumTrades) || minimumTrades < 30 || !(maximumDrawdown > 0 && maximumDrawdown <= 1)) throw new RangeError("invalid strategy acceptance limits");
  const reasons: string[] = [];
  for (const key of ["historyStart", "historyEnd", "evaluationStart", "evaluationEnd", "maxDrawdown"] as const) finite(evidence[key], key);
  if (evidence.historyStart >= evidence.historyEnd || evidence.evaluationStart < evidence.historyStart ||
      evidence.evaluationEnd > evidence.historyEnd || evidence.evaluationStart >= evidence.evaluationEnd) throw new RangeError("inconsistent historical/evaluation periods");
  if (!evidence.source || !/^[a-f0-9]{64}$/.test(evidence.datasetHash)) throw new RangeError("strategy evidence requires a source and SHA-256 dataset hash");
  if (evidence.provenance !== "historical") reasons.push("synthetic_data_is_not_strategy_acceptance_evidence");
  const threeYears = 3 * 365.25 * 86_400_000;
  if (evidence.historyEnd - evidence.historyStart < threeYears) reasons.push("fewer_than_three_years_of_history");
  if (evidence.trades.length < minimumTrades) reasons.push("fewer_than_required_completed_trades");
  if (!evidence.feesIncluded || !evidence.slippageIncluded) reasons.push("fees_or_slippage_omitted");
  if (evidence.maxDrawdown < 0 || evidence.maxDrawdown > maximumDrawdown) reasons.push("maximum_drawdown_exceeded");
  let previousClose = -Infinity;
  for (const trade of evidence.trades) {
    finite(trade.openedAt, "openedAt"); finite(trade.closedAt, "closedAt"); finite(trade.netPnlUsd, "netPnlUsd");
    if (trade.openedAt < evidence.evaluationStart || trade.closedAt > evidence.evaluationEnd ||
        trade.closedAt <= trade.openedAt || trade.closedAt < previousClose) throw new RangeError("strategy trades must be chronological and inside the evaluation period");
    previousClose = trade.closedAt;
  }
  const recentStart = evidence.evaluationEnd - 365.25 * 86_400_000;
  if (evidence.evaluationStart > recentStart) reasons.push("most_recent_year_not_fully_evaluated");
  const recent = evidence.trades.filter(trade => trade.closedAt >= recentStart);
  const recentNetPnlUsd = recent.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  if (!recent.length || recentNetPnlUsd <= 0) reasons.push("recent_year_not_profitable_after_costs");
  const hashes = new Set<string>();
  for (const run of evidence.sensitivityRuns) {
    finite(run.netPnlUsd, "sensitivity PnL"); nonnegative(run.maxDrawdown, "sensitivity drawdown");
    if (!run.parameterHash || hashes.has(run.parameterHash)) reasons.push("sensitivity_parameters_not_distinct");
    hashes.add(run.parameterHash);
    if (run.datasetHash !== evidence.datasetHash) reasons.push("sensitivity_dataset_mismatch");
    if (run.netPnlUsd <= 0 || run.maxDrawdown > maximumDrawdown) reasons.push("parameter_sensitivity_failed");
  }
  if (hashes.size < 3) reasons.push("need_baseline_and_at_least_two_parameter_perturbations");
  return { status: reasons.length ? "REJECTED" as const : "ELIGIBLE_FOR_PAPER" as const,
    reasons: [...new Set(reasons)], completedTrades: evidence.trades.length, recentYearTrades: recent.length,
    recentYearNetPnlUsd: recentNetPnlUsd, liveApproved: false };
}

export function failedIdeaFingerprint(input: { symbol: string; strategy: string; parameters: unknown; datasetHash: string }): string {
  if (!input.symbol || !input.strategy || !input.datasetHash) throw new RangeError("failed idea fingerprint requires identity and dataset");
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return createHash("sha256").update(stable(input)).digest("hex");
}

export interface PairBar { ts: number; a: number; b: number }
/** Research backtest: training prefix, next-bar fills, both legs, and explicit round-trip costs. */
export function backtestPairs(bars: readonly PairBar[], input: {
  trainingEnd: number; initialEquityUsd: number; grossNotionalUsd: number;
  feeBpsPerLeg: number; slippageBpsPerLeg: number; minHalfLife: number; maxHalfLife: number;
  entryZ?: number; exitZ?: number; stopZ?: number; periodsPerYear: number;
  provenance: "synthetic" | "historical";
}) {
  positive(input.initialEquityUsd, "initialEquityUsd"); positive(input.grossNotionalUsd, "grossNotionalUsd");
  if (input.grossNotionalUsd > input.initialEquityUsd) throw new RangeError("research backtest disallows leverage");
  nonnegative(input.feeBpsPerLeg, "feeBpsPerLeg"); nonnegative(input.slippageBpsPerLeg, "slippageBpsPerLeg");
  let previous = -Infinity;
  for (const bar of bars) {
    finite(bar.ts, "bar timestamp"); positive(bar.a, "price a"); positive(bar.b, "price b");
    if (bar.ts <= previous) throw new RangeError("pair bars must be strictly chronological");
    previous = bar.ts;
  }
  const fit = fitPairs(bars.map(bar => ({ time: bar.ts, value: bar.a })), bars.map(bar => ({ time: bar.ts, value: bar.b })), input.trainingEnd);
  const heldOut = bars.filter(bar => bar.ts > input.trainingEnd);
  if (heldOut.length < 3) throw new RangeError("insufficient held-out pair bars");
  let balance = input.initialEquityUsd, costs = 0, decisions = 0, entries = 0;
  let pending: "long_spread" | "short_spread" | "close" | "hold" = "hold";
  let position: { side: "long_spread" | "short_spread"; openedAt: number; qa: number; qb: number; a: number; b: number; entryCost: number } | null = null;
  const trades: ClosedStrategyTrade[] = [], equity: { ts: number; equity: number }[] = [];
  const unitCost = (input.feeBpsPerLeg + input.slippageBpsPerLeg) / 10_000;
  for (const bar of heldOut) {
    if (pending === "close" && position) {
      const exitCost = (Math.abs(position.qa * bar.a) + Math.abs(position.qb * bar.b)) * unitCost;
      const pnl = position.qa * (bar.a - position.a) + position.qb * (bar.b - position.b) - exitCost;
      balance += pnl; costs += exitCost;
      trades.push({ openedAt: position.openedAt, closedAt: bar.ts, netPnlUsd: pnl - position.entryCost });
      position = null;
    } else if ((pending === "long_spread" || pending === "short_spread") && !position) {
      const sign = pending === "long_spread" ? 1 : -1;
      const gross = Math.min(input.grossNotionalUsd, balance);
      const notionalA = gross / (1 + Math.abs(fit.hedgeRatio));
      const qa = sign * notionalA / bar.a;
      const qb = -sign * fit.hedgeRatio * notionalA / bar.b;
      const entryCost = gross * unitCost;
      position = { side: pending, openedAt: bar.ts, qa, qb, a: bar.a, b: bar.b, entryCost };
      balance -= entryCost; costs += entryCost; entries++;
    }
    const value = balance + (position ? position.qa * (bar.a - position.a) + position.qb * (bar.b - position.b) : 0);
    equity.push({ ts: bar.ts, equity: value });
    if (value <= 0) break;
    const zScore = pairsZScore(bar.a, bar.b, bar.ts, fit);
    pending = meanReversionSignal({ zScore, position: position?.side ?? "flat", halfLife: fit.ou.halfLife,
      minHalfLife: input.minHalfLife, maxHalfLife: input.maxHalfLife, entryZ: input.entryZ, exitZ: input.exitZ, stopZ: input.stopZ });
    decisions++;
  }
  return { provenance: input.provenance, fit, trades, equity,
    metrics: performanceMetrics({ initialEquity: input.initialEquityUsd, equity, closedTradePnls: trades.map(trade => trade.netPnlUsd),
      fills: [], decisions, quotingDecisions: entries, decisionCostUsd: 0, executionCostUsd: costs, periodsPerYear: input.periodsPerYear }),
    residualPosition: position, pendingSignal: pending, liveApproved: false,
    warnings: ["Cointegration was not tested; AR(1) fit is only a diagnostic.", "Bar data do not prove executable paired fills or intrabar stop behavior.",
      "Signals execute on the following bar; an unfilled final signal and residual position are reported."],
  };
}
