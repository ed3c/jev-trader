import { DeskJournal } from "./journal";
import { hash } from "./evidence";
import type { BracketRequest, DeskCase } from "./types";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}
/** Compare every observed weekly strategy outcome to complete historical windows of the same duration. */
export function reviewDeskWeek(journal: DeskJournal, now: number, windowMs = 7 * 86_400_000) {
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs <= 0) throw new Error("invalid_review_window");
  const events = journal.events(), strategies = new Map<string, DeskCase>(), intents = new Map<string, BracketRequest>();
  for (const event of events) {
    if (event.kind === "case_registered") { const input = journal.load<DeskCase>(`input:${(event.payload as { id: string }).id}`); if (input) strategies.set(`${input.plan.strategyId}:${input.plan.parametersHash}`, input); }
    if (event.kind === "order_intent") { const request = event.payload as BracketRequest; intents.set(request.clientOrderId, request); }
  }
  const reports = [];
  for (const [strategyKey, input] of strategies) {
    let actualNetPnlUsd = 0, completedTrades = 0, unknownCosts = false;
    const observedIds = new Set<string>();
    for (const event of events) {
      if (event.ts < now - windowMs || event.ts > now) continue;
      if (event.kind === "paper_exit" || event.kind === "paper_emergency_exit") {
        const exit = event.payload as { clientOrderId: string; pnl: number }, request = intents.get(exit.clientOrderId);
        if (request?.plan.strategyId === input.plan.strategyId && request.plan.parametersHash === input.plan.parametersHash && !observedIds.has(exit.clientOrderId)) {
          actualNetPnlUsd += exit.pnl; completedTrades++; observedIds.add(exit.clientOrderId);
        }
      }
    }
    const latestReal = new Map<string, any>();
    for (const event of events) if (event.ts >= now - windowMs && event.ts <= now && ["alpaca_paper_verified_order", "alpaca_live_verified_order"].includes(event.kind)) {
      const value = event.payload as any;
      if (value.strategyId === input.plan.strategyId && value.parametersHash === input.plan.parametersHash) latestReal.set(value.order.clientOrderId, value);
    }
    for (const value of latestReal.values()) if (value.order.status === "closed") {
      const execution = value.execution;
      if (!execution || !Number.isFinite(execution.feesUsd) || !execution.exits.every((exit: any) => Number.isFinite(exit.qty) && (exit.qty === 0 || Number.isFinite(exit.price)))) { unknownCosts = true; continue; }
      actualNetPnlUsd += execution.exits.reduce((sum: number, exit: any) => sum + exit.qty * (exit.price ?? 0), 0) - execution.entryFilledQty * execution.entryFilledPrice - execution.feesUsd;
      completedTrades++;
    }
    const baseline = input.backtest.payload, windows: number[] = [];
    for (let start = baseline.evaluationStart; start + windowMs <= baseline.evaluationEnd; start += windowMs) windows.push(baseline.trades.filter(trade => trade.closedAt >= start && trade.closedAt < start + windowMs).reduce((sum, trade) => sum + trade.netPnlUsd, 0));
    const expected = windows.length >= 20 && baseline.provenance === "historical" ? [percentile(windows, .05), percentile(windows, .95)] : null;
    const status = unknownCosts ? "PAUSED_UNKNOWN_COSTS" : completedTrades === 0 ? "NO_CLOSED_TRADES" : !expected ? "NO_HISTORICAL_BENCHMARK" : actualNetPnlUsd < expected[0]! ? "PAUSED_BELOW_EXPECTATIONS" : "WITHIN_HISTORICAL_RANGE";
    const report = { strategyKey, strategyId: input.plan.strategyId, parametersHash: input.plan.parametersHash, datasetHash: baseline.datasetHash,
      windowStart: now - windowMs, windowEnd: now, completedTrades, actualNetPnlUsd, expectedRangeUsd: expected, historicalWindows: windows.length, status,
      simulation: input.backtest.provenance === "synthetic", interpretation: "Diagnostic comparison of equal-duration outcomes; it does not establish profitability or guarantee future performance." };
    if (status.startsWith("PAUSED_")) journal.save(`desk:strategy-paused:${strategyKey}`, { reason: status, at: now });
    reports.push(report);
  }
  const result = { reviewedAt: now, windowMs, reports, automaticUnpause: false };
  journal.append("weekly_strategy_review", result, `weekly-strategy-review:${now}:${hash(result)}`, now);
  return result;
}
