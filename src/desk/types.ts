import type { StrategyEvidence } from "../evaluation/strategy";

export type DeskRole = "chief" | "scout" | "chart" | "strategist" | "risk" | "trader";
export type DeskCapability = "journal.read" | "journal.append" | "market.read" | "research.read" | "backtest.run" | "risk.approve" | "orders.submit" | "orders.cancel" | "positions.close";
export const ROLE_CAPABILITIES: Readonly<Record<DeskRole, readonly DeskCapability[]>> = Object.freeze({
  chief: Object.freeze(["journal.read", "journal.append"] as DeskCapability[]),
  scout: Object.freeze(["journal.read", "journal.append", "market.read", "research.read"] as DeskCapability[]),
  chart: Object.freeze(["journal.read", "journal.append", "market.read"] as DeskCapability[]),
  strategist: Object.freeze(["journal.read", "journal.append", "market.read", "backtest.run"] as DeskCapability[]),
  risk: Object.freeze(["journal.read", "journal.append", "market.read", "risk.approve"] as DeskCapability[]),
  trader: Object.freeze(["journal.read", "journal.append", "market.read", "orders.submit", "orders.cancel", "positions.close"] as DeskCapability[]),
});
export function requireCapability(role: DeskRole, capability: DeskCapability): void {
  if (!ROLE_CAPABILITIES[role]?.includes(capability)) throw new Error(`permission_denied:${role}:${capability}`);
}

export interface Evidence<T> {
  readonly id: string;
  readonly source: string;
  readonly observedAt: number;
  readonly receivedAt: number;
  readonly provenance: "historical" | "observed" | "synthetic";
  readonly payload: T;
}
export interface ScoutFinding { importance: number; catalyst: string; relevance: string; rumor: boolean; paidPromotion: boolean }
export interface ChartReport {
  dailyTrend: "bullish" | "bearish" | "sideways";
  fourHourTrend: "bullish" | "bearish" | "sideways";
  support: number; resistance: number; rsi14: number; ma50: number; ma200: number;
  volume: number; averageVolume20: number; deskSignal: "BUY" | "SELL" | "NONE";
  score: number; explanation: [string, string, string];
}
export interface TradePlan {
  symbol: string; side: "buy"; entry: number; stop: number; target: number; quantity: number;
  holdingUntil: number; thesis: string; strategyId: string; parametersHash: string;
  evidenceIds: string[];
}
export interface Quote { symbol: string; bid: number; ask: number; last: number }
export interface DeskPosition { symbol: string; quantity: number; marketPrice: number; stop: number | null; correlationGroup: string | null }
export interface OpenCommitment { symbol: string; quantity: number; entry: number; stop: number | null; correlationGroup: string | null }
export interface RiskSnapshot {
  equity: number; cash: number; dayStartEquity: number; lossStreak: number; accountingPending?: boolean;
  positions: DeskPosition[]; openOrders: OpenCommitment[];
  asset: { symbol: string; tradable: boolean; assetClass: "us_equity"; leveraged: boolean; correlationGroup: string | null };
  correlations: { a: string; b: string; coefficient: number }[] | null;
  events: { status: "known" | "unknown"; completeThrough: number; items: { kind: "earnings" | "fed" | "cpi" | "major"; at: number; symbol?: string }[] };
}
export interface DeskRules {
  paperCapital: number; maxRiskFraction: number; maxDailyLossFraction: number; maxPositions: number;
  maxGrossExposureFraction: number; correlationThreshold: number; maxCorrelatedRiskFraction: number;
  minPrice: number; maxQuoteAgeMs: number; maxRiskAgeMs: number; approvalTtlMs: number;
  maxPriceDeviationFraction: number; maxLossStreak: number;
}
export const DEFAULT_DESK_RULES: Readonly<DeskRules> = Object.freeze({
  paperCapital: 10_000, maxRiskFraction: 0.01, maxDailyLossFraction: 0.02, maxPositions: 5,
  maxGrossExposureFraction: 1, correlationThreshold: 0.7, maxCorrelatedRiskFraction: 0.01,
  minPrice: 5, maxQuoteAgeMs: 60_000, maxRiskAgeMs: 60_000, approvalTtlMs: 15 * 60_000,
  maxPriceDeviationFraction: 0.005, maxLossStreak: 3,
});
export interface DeskCase {
  id: string; symbol: string; idea: string;
  scout: Evidence<ScoutFinding>; chart: Evidence<ChartReport>;
  backtest: Evidence<StrategyEvidence & { strategyId: string; parametersHash: string }>; plan: TradePlan;
  risk: Evidence<RiskSnapshot>; quote: Evidence<Quote>;
}
export type DeskStage = "NEW" | "SCOUTED" | "CHARTED" | "STRATEGIZED" | "APPROVED" | "SUBMITTED" | "FILLED" | "REJECTED" | "UNKNOWN" | "CLOSED";
export interface Approval {
  planHash: string; caseHash: string; riskEvidenceId: string; approvedAt: number; expiresAt: number;
  mode: "paper" | "live"; synthetic: boolean;
}
export interface CaseState { id: string; caseHash: string; version?: number; stage: DeskStage; planHash?: string; approval?: Approval; order?: BrokerOrder; reason?: string }
export interface BracketRequest { clientOrderId: string; plan: TradePlan; planHash: string; approval: Approval; quoteObservedAt: number; riskObservedAt: number; quoteEvidenceId: string; currentRiskEvidenceId: string }
export interface BrokerOrder {
  id: string; clientOrderId: string; planHash: string; symbol: string;
  status: "accepted" | "filled" | "cancelled" | "rejected" | "unknown" | "closed";
  filledQuantity: number; filledPrice: number | null; bracketProtected: boolean;
  reason?: string;
}
export interface EmergencyResult { confirmed: boolean; openOrders: number | null; openPositions: number | null; reason?: string }
export interface DeskBroker {
  readonly mode: "local-paper" | "alpaca-paper" | "alpaca-live";
  submitBracket(request: BracketRequest): Promise<BrokerOrder>;
  findOrder(clientOrderId: string): Promise<BrokerOrder | null>;
  readAccountRisk?(): Promise<Pick<RiskSnapshot, "equity" | "cash" | "dayStartEquity" | "lossStreak" | "positions" | "openOrders" | "accountingPending">>;
  emergencyFlatten(): Promise<EmergencyResult>;
}
export interface JournalRow {
  TIME: string; BOT: string; TICKER: string; IDEA: string; SOURCE: string; SCORE: string | number;
  ENTRY: string | number; STOP: string | number; TARGET: string | number; SIZE: string | number;
  "RISK CHECK": string; STATUS: string; RESULT: string; LESSON: string;
}
