import { finite, mean, nonnegative, positive, sampleVariance } from "../quant/math";

export interface EquityPoint { ts: number; equity: number }
export interface FillMeasurement { notional: number; slippageBps: number; adverseSelectionBps: number }
export interface PerformanceInput {
  initialEquity: number;
  equity: readonly EquityPoint[];
  closedTradePnls: readonly number[];
  fills: readonly FillMeasurement[];
  decisions: number;
  quotingDecisions: number;
  decisionCostUsd: number;
  executionCostUsd: number;
  /** Caller declares the replay interval annualization, never guessed from a tiny sample. */
  periodsPerYear: number;
  riskFreePerPeriod?: number;
}

export function performanceMetrics(input: PerformanceInput) {
  positive(input.initialEquity, "initialEquity"); positive(input.periodsPerYear, "periodsPerYear");
  nonnegative(input.decisionCostUsd, "decisionCostUsd");
  finite(input.executionCostUsd, "executionCostUsd");
  const rf = finite(input.riskFreePerPeriod ?? 0, "riskFreePerPeriod");
  if (!Number.isInteger(input.decisions) || input.decisions < 0 || !Number.isInteger(input.quotingDecisions) ||
      input.quotingDecisions < 0 || input.quotingDecisions > input.decisions) throw new RangeError("invalid decision counts");
  let previousTime = -Infinity, previousEquity = input.initialEquity, peak = input.initialEquity, maxDrawdown = 0;
  const returns: number[] = [];
  for (const point of input.equity) {
    finite(point.ts, "equity timestamp"); finite(point.equity, "equity");
    if (point.ts <= previousTime) throw new RangeError("equity observations must be chronological");
    if (previousEquity <= 0) throw new RangeError("returns undefined after account insolvency");
    returns.push(point.equity / previousEquity - 1 - rf);
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
    previousTime = point.ts; previousEquity = point.equity;
  }
  const avg = returns.length ? mean(returns) : 0;
  const std = returns.length > 1 ? Math.sqrt(sampleVariance(returns)) : 0;
  const downside = returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length) : 0;
  const totalNotional = input.fills.reduce((sum, fill) => sum + nonnegative(fill.notional, "fill notional"), 0);
  const weighted = (key: "slippageBps" | "adverseSelectionBps") => totalNotional ? input.fills.reduce((sum, fill) => sum + fill.notional * finite(fill[key], key), 0) / totalNotional : null;
  input.closedTradePnls.forEach(pnl => finite(pnl, "closed trade pnl"));
  const wins = input.closedTradePnls.filter(pnl => pnl > 0);
  const losses = input.closedTradePnls.filter(pnl => pnl < 0);
  return {
    finalEquityUsd: previousEquity,
    netPnlUsd: previousEquity - input.initialEquity,
    netReturn: previousEquity / input.initialEquity - 1,
    sharpe: std > 0 ? avg / std * Math.sqrt(input.periodsPerYear) : null,
    sortino: downside > 0 ? avg / downside * Math.sqrt(input.periodsPerYear) : null,
    maxDrawdown,
    closedTrades: input.closedTradePnls.length,
    winRate: input.closedTradePnls.length ? wins.length / input.closedTradePnls.length : null,
    averageWinUsd: wins.length ? mean(wins) : null,
    averageLossUsd: losses.length ? mean(losses) : null,
    averageWinLossRatio: wins.length && losses.length ? mean(wins) / -mean(losses) : null,
    slippageBps: weighted("slippageBps"),
    adverseSelectionBps: weighted("adverseSelectionBps"),
    fillCount: input.fills.length,
    coverage: input.decisions ? input.quotingDecisions / input.decisions : 0,
    costPerMillionDecisionsUsd: input.decisions ? input.decisionCostUsd / input.decisions * 1_000_000 : null,
    decisionCostUsd: input.decisionCostUsd,
    executionCostUsd: input.executionCostUsd,
    undefinedRatioReason: "null means insufficient variation, downside, trades or fills; never infinity or fabricated zero",
    annualization: { periodsPerYear: input.periodsPerYear, assumption: "Regular observation intervals and finite-sample estimates; not a performance guarantee" },
  };
}
