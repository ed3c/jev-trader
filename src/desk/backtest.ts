import { assessStrategyEvidence, type ClosedStrategyTrade, type StrategyEvidence } from "../evaluation/strategy";
import { performanceMetrics } from "../evaluation/metrics";
import { evidence, hash, immutable } from "./evidence";
import type { DeskCase, Evidence, TradePlan } from "./types";

export const DESK_BREAKOUT_STRATEGY = "desk-signal-long-v1";
const DAY = 86_400_000;
export interface DeskDailyBar { openAt: number; closeAt: number; open: number; high: number; low: number; close: number; volume: number }
export interface DeskBarDataset {
  symbol: string;
  source: string;
  provenance: "historical" | "synthetic";
  /** All OHLC and volume must use one declared corporate-action convention. */
  adjustment: "split_adjusted" | "unadjusted";
  bars: DeskDailyBar[];
  events?: {
    source: string; completeFrom: number; completeThrough: number;
    /** knownAt prevents using an event announcement before it was public. */
    items: { at: number; knownAt: number; kind: "earnings" | "fed" | "cpi" | "major"; symbol?: string }[];
  };
}
export interface DeskBreakoutParameters {
  breakoutLength: number; volumeLength: number; volumeMultiple: number;
  stopAtrMultiple: number; targetRiskMultiple: number; maxHoldingDays: number;
  riskFraction: number; initialEquityUsd: number; feeBpsPerSide: number; slippageBpsPerSide: number;
}
export const DEFAULT_DESK_BREAKOUT_PARAMETERS: Readonly<DeskBreakoutParameters> = Object.freeze({
  breakoutLength: 20, volumeLength: 20, volumeMultiple: 1.5, stopAtrMultiple: 2, targetRiskMultiple: 2,
  maxHoldingDays: 10, riskFraction: 0.01, initialEquityUsd: 10_000, feeBpsPerSide: 1, slippageBpsPerSide: 2,
});
export interface DeskBacktestJob {
  caseId: string;
  dataset: DeskBarDataset;
  parameters: DeskBreakoutParameters;
  evaluationStart: number;
  /** The proposed order must come from the dataset's most recent completed bar. */
  planSignalAt: number;
}
export interface DeskSignal {
  at: number; buy: boolean; sell: boolean; warm: boolean;
  atr: number | null; rsi: number | null; atr90: number | null;
  ema8: number; ema21: number; ema50: number; ema200: number;
}
export type DeskBacktestEvidence = Evidence<StrategyEvidence & { strategyId: string; parametersHash: string }>;
interface Position { openedAt: number; quantity: number; entry: number; stop: number; target: number; holdingUntil: number; entryCost: number }
interface PlanNumbers { entry: number; stop: number; target: number; quantity: number; holdingUntil: number }
export interface DeskBacktestRun {
  parameters: DeskBreakoutParameters;
  parametersHash: string;
  trades: (ClosedStrategyTrade & { reason: "stop" | "target" | "holding_deadline" | "sell_signal"; quantity: number })[];
  equity: { ts: number; equity: number }[];
  metrics: ReturnType<typeof performanceMetrics>;
  residualPosition: Position | null;
  pendingEntry: PlanNumbers | null;
  counters: { signals: number; fills: number; unfilledLimits: number; eventVetoes: number; lossStreakVetoes: number; dailyLossVetoes: number; insufficientCash: number };
}
export type DeskBacktestResult = { status: "NOT_RUN"; reasons: string[]; caseId: string } | {
  status: "COMPLETED"; caseId: string; strategyId: typeof DESK_BREAKOUT_STRATEGY; datasetHash: string;
  evidence: DeskBacktestEvidence; plan: TradePlan | null; planReason: string | null;
  baseline: DeskBacktestRun; sensitivity: DeskBacktestRun[];
  acceptance: ReturnType<typeof assessStrategyEvidence>;
  warnings: string[];
};

function parameters(input: DeskBreakoutParameters): DeskBreakoutParameters {
  if (!input || Object.keys(input).sort().join(",") !== Object.keys(DEFAULT_DESK_BREAKOUT_PARAMETERS).sort().join(",")) throw new Error("backtest_parameters_must_be_explicit");
  for (const [key, value] of Object.entries(input)) if (!Number.isFinite(value)) throw new Error(`invalid_backtest_parameter:${key}`);
  if (![input.breakoutLength, input.volumeLength].every(n => Number.isInteger(n) && n >= 2 && n <= 200) ||
      input.volumeMultiple <= 0 || input.stopAtrMultiple <= 0 || input.targetRiskMultiple <= 0 ||
      !Number.isInteger(input.maxHoldingDays) || input.maxHoldingDays < 2 || input.maxHoldingDays > 10 ||
      input.riskFraction <= 0 || input.riskFraction > .01 || input.initialEquityUsd <= 0 ||
      input.feeBpsPerSide < 0 || input.feeBpsPerSide >= 100 || input.slippageBpsPerSide < 0 || input.slippageBpsPerSide >= 100) throw new Error("backtest_parameters_violate_desk_rules");
  return immutable(input);
}
function validateBars(bars: readonly DeskDailyBar[]): void {
  let previousClose = -Infinity;
  for (const bar of bars) {
    if (![bar.openAt, bar.closeAt, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.openAt <= previousClose || bar.closeAt <= bar.openAt || bar.closeAt - bar.openAt > DAY ||
        bar.open <= 0 || bar.close <= 0 || bar.low <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close) || bar.volume < 0) throw new Error("invalid_or_nonchronological_daily_bars");
    if (previousClose !== -Infinity && bar.openAt - previousClose < DAY / 3) throw new Error("daily_bars_required");
    previousClose = bar.closeAt;
  }
}
/** Same closed-bar conditions as desk-signal.pine. EMAs color the ribbon, not the BUY/SELL gate. */
export function computeDeskSignals(bars: readonly DeskDailyBar[], input: DeskBreakoutParameters = DEFAULT_DESK_BREAKOUT_PARAMETERS): DeskSignal[] {
  validateBars(bars); const p = parameters(input), result: DeskSignal[] = [], atrHistory: number[] = [];
  let atr: number | null = null, gain: number | null = null, loss: number | null = null, trSeed = 0, gainSeed = 0, lossSeed = 0;
  const ema = [0, 0, 0, 0], lengths = [8, 21, 50, 200];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!, priorClose = i ? bars[i - 1]!.close : b.close;
    for (let e = 0; e < lengths.length; e++) ema[e] = i ? 2 / (lengths[e]! + 1) * b.close + (1 - 2 / (lengths[e]! + 1)) * ema[e]! : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - priorClose), Math.abs(b.low - priorClose));
    if (i < 14) { trSeed += tr; if (i === 13) atr = trSeed / 14; } else atr = (atr! * 13 + tr) / 14;
    if (i > 0) {
      const change = b.close - priorClose, g = Math.max(change, 0), l = Math.max(-change, 0);
      if (i <= 14) { gainSeed += g; lossSeed += l; if (i === 14) { gain = gainSeed / 14; loss = lossSeed / 14; } }
      else { gain = (gain! * 13 + g) / 14; loss = (loss! * 13 + l) / 14; }
    }
    const rsi = gain === null || loss === null ? null : loss === 0 ? gain === 0 ? null : 100 : 100 - 100 / (1 + gain / loss);
    if (atr !== null) atrHistory.push(atr);
    const latestAtr = atrHistory.slice(-100), atr90 = latestAtr.length === 100 ? [...latestAtr].sort((a, b) => a - b)[89]! : null;
    const previous = bars.slice(Math.max(0, i - p.breakoutLength), i), volumes = bars.slice(Math.max(0, i + 1 - p.volumeLength), i + 1);
    const averageVolume = volumes.reduce((sum, item) => sum + item.volume, 0) / volumes.length;
    const warm = i >= 199 && previous.length === p.breakoutLength && volumes.length === p.volumeLength && rsi !== null && atr90 !== null;
    const allowed = warm && atr! <= atr90! && averageVolume > 0 && b.volume >= p.volumeMultiple * averageVolume;
    result.push({ at: b.closeAt, buy: allowed && b.close > Math.max(...previous.map(item => item.high)) && rsi! > 50,
      sell: allowed && b.close < Math.min(...previous.map(item => item.low)) && rsi! < 50,
      warm, atr, rsi, atr90, ema8: ema[0]!, ema21: ema[1]!, ema50: ema[2]!, ema200: ema[3]! });
  }
  return result;
}
function eventBlocked(dataset: DeskBarDataset, at: number, until: number): boolean {
  return dataset.events!.items.some(event => event.knownAt <= at && event.at >= at && event.at <= until && (!event.symbol || event.symbol === dataset.symbol));
}
function plannedEntry(bar: DeskDailyBar, signal: DeskSignal, p: DeskBreakoutParameters, equity: number, cash: number): PlanNumbers | null {
  if (!signal.buy || signal.atr === null || equity <= 0 || cash <= 0 || bar.close < 5) return null;
  const entry = Math.floor((bar.close + 1e-10) * 100) / 100, stop = Math.floor((entry - p.stopAtrMultiple * signal.atr) * 100) / 100;
  if (stop <= 0 || stop >= entry) return null;
  const target = Math.ceil((entry + p.targetRiskMultiple * (entry - stop) - 1e-10) * 100) / 100;
  const cost = (p.feeBpsPerSide + p.slippageBpsPerSide) / 10_000;
  // A planned stop risk budget also reserves entry and exit execution costs.
  const riskPerShare = entry - stop + (entry + stop) * cost;
  const quantity = Math.floor(Math.min(equity * p.riskFraction / riskPerShare, cash / (entry * (1 + cost))));
  return quantity > 0 ? { entry, stop, target, quantity, holdingUntil: bar.closeAt + p.maxHoldingDays * DAY } : null;
}
function run(dataset: DeskBarDataset, p: DeskBreakoutParameters, evaluationStart: number): DeskBacktestRun {
  const signals = computeDeskSignals(dataset.bars, p), unitCost = (p.feeBpsPerSide + p.slippageBpsPerSide) / 10_000;
  let cash = p.initialEquityUsd, executionCost = 0, position: Position | null = null, pending: PlanNumbers | null = null, pendingSell = false, lossStreak = 0;
  const trades: DeskBacktestRun["trades"] = [], equity: { ts: number; equity: number }[] = [];
  const counters = { signals: 0, fills: 0, unfilledLimits: 0, eventVetoes: 0, lossStreakVetoes: 0, dailyLossVetoes: 0, insufficientCash: 0 };
  const close = (price: number, at: number, reason: DeskBacktestRun["trades"][number]["reason"]) => {
    const pos = position!, exitCost = price * pos.quantity * unitCost;
    cash += price * pos.quantity - exitCost; executionCost += exitCost;
    const netPnlUsd = (price - pos.entry) * pos.quantity - pos.entryCost - exitCost;
    trades.push({ openedAt: pos.openedAt, closedAt: at, netPnlUsd, quantity: pos.quantity, reason });
    lossStreak = netPnlUsd < 0 ? lossStreak + 1 : 0; position = null;
  };
  for (let i = 0; i < dataset.bars.length; i++) {
    const bar = dataset.bars[i]!, signal = signals[i]!;
    if (bar.closeAt < evaluationStart) continue;
    const dayStartEquity = equity.at(-1)?.equity ?? p.initialEquityUsd;
    let enteredNow = false;
    // Only a previous closed-bar signal may create this bar's limit order.
    if (pending && !position) {
      if (bar.openAt >= pending.holdingUntil) counters.unfilledLimits++;
      else if (bar.low < pending.entry && (bar.open <= pending.entry || bar.low < pending.entry - .00000001)) {
        const fill = Math.min(bar.open, pending.entry), entryCost = fill * pending.quantity * unitCost;
        // Gap under the planned protective stop means the original setup is invalid.
        if (fill <= pending.stop || fill * pending.quantity + entryCost > cash) counters.unfilledLimits++;
        else {
          position = { ...pending, entry: fill, entryCost, openedAt: bar.openAt };
          cash -= fill * pending.quantity + entryCost; executionCost += entryCost; counters.fills++; enteredNow = true;
        }
      } else counters.unfilledLimits++;
      pending = null;
    }
    if (position) {
      const pos: Position = position;
      if (!enteredNow && bar.openAt >= pos.holdingUntil) close(bar.open, bar.openAt, "holding_deadline");
      else if (!enteredNow && pendingSell) close(bar.open, bar.openAt, "sell_signal");
      else if (bar.low <= pos.stop) close(Math.min(bar.open, pos.stop), bar.closeAt, "stop");
      // If both levels occur, the preceding stop branch wins. On the entry bar,
      // high may have preceded the limit fill, so no target profit is assumed.
      else if (!enteredNow && bar.high > pos.target) close(pos.target, bar.closeAt, "target");
    }
    pendingSell = false;
    const currentEquity = cash + (position ? (position as Position).quantity * bar.close : 0);
    equity.push({ ts: bar.closeAt, equity: currentEquity });
    if (currentEquity <= 0) break;
    if (position) { pendingSell = signal.sell; continue; }
    if (!signal.buy) continue;
    counters.signals++;
    if (currentEquity <= dayStartEquity * .98) { counters.dailyLossVetoes++; continue; }
    // Three losses require human review; the same replay must not silently reset it.
    if (lossStreak >= 3) { counters.lossStreakVetoes++; continue; }
    const plan = plannedEntry(bar, signal, p, currentEquity, cash);
    if (!plan) { counters.insufficientCash++; continue; }
    if (eventBlocked(dataset, bar.closeAt, plan.holdingUntil)) { counters.eventVetoes++; continue; }
    pending = plan;
  }
  const metrics = performanceMetrics({ initialEquity: p.initialEquityUsd, equity, closedTradePnls: trades.map(t => t.netPnlUsd),
    fills: [], decisions: equity.length, quotingDecisions: counters.signals, decisionCostUsd: 0, executionCostUsd: executionCost, periodsPerYear: 252 });
  return { parameters: p, parametersHash: hash(p), trades, equity, metrics, residualPosition: position, pendingEntry: pending, counters };
}

/** Executes three real computations on supplied bars; no fixture is silently substituted. */
export function executeDeskBacktest(job: DeskBacktestJob, now = Date.now()): DeskBacktestResult {
  const p = parameters(job.parameters), dataset = job.dataset;
  if (!job.caseId || !Number.isFinite(now) || !dataset?.source?.trim() || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(dataset.symbol) ||
      !["historical", "synthetic"].includes(dataset.provenance) || !["split_adjusted", "unadjusted"].includes(dataset.adjustment)) throw new Error("invalid_desk_backtest_identity");
  if (!Array.isArray(dataset.bars)) throw new Error("backtest_bars_required");
  validateBars(dataset.bars);
  const reasons: string[] = [], first = dataset.bars[0], last = dataset.bars.at(-1);
  if (!first || !last || dataset.bars.length < 202) return { status: "NOT_RUN", caseId: job.caseId, reasons: ["need_200_warmup_bars_and_at_least_two_evaluation_bars"] };
  if (!Number.isFinite(job.evaluationStart) || job.evaluationStart < first.openAt || job.evaluationStart >= last.closeAt) throw new Error("invalid_backtest_evaluation_period");
  if (dataset.bars.filter(bar => bar.closeAt < job.evaluationStart).length < 199) reasons.push("insufficient_pre_evaluation_warmup");
  if (last.closeAt > now) reasons.push("incomplete_or_future_market_bar");
  if (job.planSignalAt !== last.closeAt) reasons.push("plan_signal_must_be_latest_completed_bar");
  if (dataset.bars.some((bar, i) => i > 0 && bar.openAt - dataset.bars[i - 1]!.closeAt > 7 * DAY)) reasons.push("historical_data_gap_exceeds_seven_days");
  if (!dataset.events || !dataset.events.source?.trim() || !Number.isFinite(dataset.events.completeFrom) || !Number.isFinite(dataset.events.completeThrough) ||
      dataset.events.completeFrom > job.evaluationStart || dataset.events.completeThrough < last.closeAt + p.maxHoldingDays * DAY || !Array.isArray(dataset.events.items)) reasons.push("complete_sourced_event_calendar_required");
  else if (dataset.events.items.some(item => !Number.isFinite(item.at) || !Number.isFinite(item.knownAt) || item.knownAt > item.at || !["earnings", "fed", "cpi", "major"].includes(item.kind))) throw new Error("invalid_event_calendar");
  if (reasons.length) return { status: "NOT_RUN", caseId: job.caseId, reasons };
  const datasetHash = hash(dataset), baseline = run(dataset, p, job.evaluationStart);
  const sensitivity = [0.9, 1.1].map(factor => run(dataset, { ...p, volumeMultiple: p.volumeMultiple * factor }, job.evaluationStart));
  const payload: StrategyEvidence & { strategyId: string; parametersHash: string } = {
    provenance: dataset.provenance, source: dataset.source, datasetHash, historyStart: first.openAt, historyEnd: last.closeAt,
    evaluationStart: job.evaluationStart, evaluationEnd: last.closeAt, trades: baseline.trades.map(({ openedAt, closedAt, netPnlUsd }) => ({ openedAt, closedAt, netPnlUsd })),
    feesIncluded: true, slippageIncluded: true, maxDrawdown: baseline.metrics.maxDrawdown,
    sensitivityRuns: [baseline, ...sensitivity].map(result => ({ parameterHash: result.parametersHash, datasetHash,
      netPnlUsd: result.metrics.netPnlUsd, maxDrawdown: result.metrics.maxDrawdown })),
    strategyId: DESK_BREAKOUT_STRATEGY, parametersHash: baseline.parametersHash,
  };
  const resultEvidence = evidence({ source: `local://desk-backtest/${DESK_BREAKOUT_STRATEGY}`, observedAt: last.closeAt, receivedAt: now, provenance: dataset.provenance, payload });
  const signal = computeDeskSignals(dataset.bars, p).at(-1)!;
  const numbers = plannedEntry(last, signal, p, p.initialEquityUsd, p.initialEquityUsd);
  const blocked = numbers && eventBlocked(dataset, last.closeAt, numbers.holdingUntil);
  const plan: TradePlan | null = numbers && !blocked ? { symbol: dataset.symbol, side: "buy", ...numbers,
    thesis: "Confirmed prior-bar breakout with volume, RSI and ATR filters; fixed ATR bracket and capped whole-share risk.",
    strategyId: DESK_BREAKOUT_STRATEGY, parametersHash: baseline.parametersHash, evidenceIds: [resultEvidence.id] } : null;
  return { status: "COMPLETED", caseId: job.caseId, strategyId: DESK_BREAKOUT_STRATEGY, datasetHash, evidence: resultEvidence, plan,
    planReason: plan ? null : blocked ? "scheduled_event_in_holding_window" : "latest_bar_has_no_executable_buy_setup",
    baseline, sensitivity, acceptance: assessStrategyEvidence(payload), warnings: [
      "This tests one explicitly defined long-only daily-bar rule. It does not validate unrelated narrative or discretionary strategies.",
      "No-touch limit fills, next-bar entry, stop-first ambiguous bars, no entry-bar target profit; bars cannot prove queue priority or actual execution.",
      "Fees and slippage are explicit costs; gap losses can exceed a planned stop budget. No borrow, leverage, or short positions are modeled.",
      "The event calendar is caller-supplied; knownAt prevents use before announcement. Corporate-action adjustments and source completeness require independent verification.",
      "One position per symbol; portfolio correlation, news ranking and discretionary chart scores are not historical features of this mechanical rule.",
      "Residual inventory remains marked to market, never fabricated as closed. Three consecutive losses pause the same replay permanently.",
      "Sensitivity variants are reported on the same holdout and are never used to select parameters; new tuning requires a fresh future holdout.",
    ] };
}

/** A recomputation may have a new receipt time; its data, rules, outcomes, and planned order must be identical. */
export function verifyDeskBacktestBinding(result: DeskBacktestResult, input: DeskCase): void {
  if (result.status !== "COMPLETED" || !result.plan) throw new Error("desk_backtest_no_computed_plan");
  if (result.caseId !== input.id || input.symbol !== result.plan.symbol || hash(result.evidence.payload) !== hash(input.backtest.payload)) throw new Error("desk_backtest_evidence_binding_mismatch");
  for (const key of ["symbol", "side", "entry", "stop", "target", "quantity", "holdingUntil", "strategyId", "parametersHash"] as const) {
    if (result.plan[key] !== input.plan[key]) throw new Error(`desk_backtest_plan_binding_mismatch:${key}`);
  }
  if (!input.plan.evidenceIds.includes(input.backtest.id)) throw new Error("desk_backtest_missing_plan_evidence");
}
