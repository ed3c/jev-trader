import { evidence, hash } from "./evidence";
import type { StrategyEvidence } from "../evaluation/strategy";
import type { ChartReport, DeskCase, Quote, RiskSnapshot, ScoutFinding, TradePlan } from "./types";

/** Synthetic protocol fixture. Its numbers never count as historical strategy acceptance. */
export function syntheticDeskCase(now = Date.now(), id = "synthetic-demo", symbol = "DEMO"): DeskCase {
  const make = <T>(kind: string, payload: T) => evidence({ source: `local://synthetic-desk/${kind}`, observedAt: now - 1000, receivedAt: now, provenance: "synthetic" as const, payload });
  const scout = make<ScoutFinding>("scout", { importance: 8, catalyst: "Synthetic volume breakout fixture", relevance: "Exercises evidence handoffs only", rumor: false, paidPromotion: false });
  const chart = make<ChartReport>("chart", { dailyTrend: "bullish", fourHourTrend: "bullish", support: 98, resistance: 106, rsi14: 58, ma50: 96, ma200: 90,
    volume: 2_000_000, averageVolume20: 1_000_000, deskSignal: "BUY", score: 8, explanation: ["Synthetic daily and four-hour uptrend.", "Synthetic volume exceeds its reference average.", "Synthetic BUY indicator exercises the pipeline."] });
  const historyEnd = now - 2 * 86_400_000, year = 365.25 * 86_400_000, datasetHash = hash({ fixture: "synthetic-protocol-only", version: 1 }), parametersHash = hash({ strategy: "desk-signal-fixture", stop: .02, target: .06 });
  const backtest = make<StrategyEvidence & { strategyId: string; parametersHash: string }>("backtest", { provenance: "synthetic", source: "local://synthetic-desk/not-historical-data", datasetHash,
    strategyId: "desk-signal-fixture", parametersHash,
    historyStart: historyEnd - 4 * year, historyEnd, evaluationStart: historyEnd - 1.5 * year, evaluationEnd: historyEnd,
    trades: Array.from({ length: 36 }, (_, i) => ({ openedAt: historyEnd - 350 * 86_400_000 + i * 8 * 86_400_000, closedAt: historyEnd - 349 * 86_400_000 + i * 8 * 86_400_000, netPnlUsd: i % 3 ? 20 : -10 })),
    feesIncluded: true, slippageIncluded: true, maxDrawdown: .05,
    sensitivityRuns: [parametersHash, hash({ stop: .018, target: .06 }), hash({ stop: .022, target: .06 })].map(parameterHash => ({ parameterHash, datasetHash, netPnlUsd: 100, maxDrawdown: .06 })) });
  const plan: TradePlan = { symbol, side: "buy", entry: 100, stop: 98, target: 106, quantity: 40, holdingUntil: now + 3 * 86_400_000,
    thesis: "Synthetic software test only", strategyId: "desk-signal-fixture", parametersHash, evidenceIds: [scout.id, chart.id, backtest.id] };
  const risk = make<RiskSnapshot>("risk", { equity: 10_000, cash: 10_000, dayStartEquity: 10_000, lossStreak: 0, positions: [], openOrders: [],
    asset: { symbol, tradable: true, assetClass: "us_equity", leveraged: false, correlationGroup: "synthetic-equities" }, correlations: [],
    events: { status: "known", completeThrough: plan.holdingUntil + 86_400_000, items: [] } });
  const quote = make<Quote>("quote", { symbol, bid: 99.99, ask: 100, last: 100 });
  return { id, symbol, idea: "Synthetic end-to-end desk demonstration", scout, chart, backtest, plan, risk, quote };
}
