/** All timestamps are Unix milliseconds. Prices are quote currency per base unit. */
export type TradeSide = "buy" | "sell";
export type Level = [price: number, size: number];

export interface BookObservation {
  block: number;
  /** Source observation time, not the time a cached response was fetched again. */
  ts: number;
  bid: number;
  ask: number;
  bids: Level[];
  asks: Level[];
}

export interface MidObservation { ts: number; mid: number }
export interface TradeObservation { ts: number; side: TradeSide; price: number; size: number }
export interface TimedValue { ts: number; value: number }

export interface AccountState {
  inventory: number;
  equityUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  positionOpenedAtMs: number | null;
  /** Includes other instruments. Defaults to |inventory| * mid for one instrument. */
  grossExposureUsd?: number;
}

export interface ExecutionHealth {
  apiErrors: number;
  /** null means unmeasured, not zero. */
  fillRatio: number | null;
  rejectRate: number | null;
  slippageBps: number | null;
  latenciesMs: number[];
}

export interface SnapshotInput {
  sessionId: string;
  symbol: string;
  block: number;
  /** Must be strictly after every supplied source observation. */
  decisionTs: number;
  horizonBlocks?: number;
  book: BookObservation;
  mids?: MidObservation[];
  /** Undefined means no trade feed. An empty array means an observed quiet window. */
  trades?: TradeObservation[];
  /** Start of continuously observed flow. Required for trustworthy per-second intensities. */
  flowWindowStartMs?: number;
  /** Optional event timestamps from a separate cancellation feed. */
  cancellations?: number[];
  /** Actual observed queue ahead, if the venue exposes it. Never guessed from L2. */
  queueAhead?: TimedValue;
  referencePrice?: TimedValue;
  /** Spot/index reference for a derivative basis, distinct from another venue's price. */
  spotPrice?: TimedValue;
  fundingRate?: TimedValue;
  /** Independently measured 24h baselines, not a short-history extrapolation. */
  baseline24h?: { ts: number; realizedVol: number; depth: number };
  account: AccountState;
  health: ExecutionHealth;
}

export interface SnapshotOptions {
  maxDataAgeMs?: number;
  maxCrossAgeMs?: number;
  maxFundingAgeMs?: number;
  maxBaselineAgeMs?: number;
  maxHistoryGapMs?: number;
  minVolSamples?: number;
  /** Warmup can be enforced by the caller; it defaults to true. */
  requireWarmup?: boolean;
}

export interface MarketSnapshot {
  schemaVersion: 1;
  /** SHA-256 of this immutable snapshot's data, excluding this identifier. */
  id: string;
  sessionId: string;
  symbol: string;
  block: number;
  decisionTs: number;
  bookTs: number;
  horizonBlocks: number;
  price: {
    mid: number;
    microprice: number;
    returnsBps: { m1: number | null; m5: number | null; m30: number | null };
  };
  book: {
    bid: number;
    ask: number;
    spreadBps: number;
    bids: Level[];
    asks: Level[];
    depthBid: number;
    depthAsk: number;
    imbalance: number;
    queueAhead: number | null;
  };
  flow: {
    windowSeconds: number | null;
    buyVolume: number | null;
    sellVolume: number | null;
    tradeIntensity: number | null;
    cancelIntensity: number | null;
    vwap: number | null;
  };
  vol: {
    /** Root mean squared log return per sqrt(second), on irregular time intervals. */
    short: number | null;
    medium: number | null;
    vs24h: number | null;
    samples: number;
  };
  cross: {
    referencePrice: number | null;
    divergenceBps: number | null;
    basisBps: number | null;
    fundingRate: number | null;
    depthVs24h: number | null;
  };
  account: AccountState & {
    grossExposureUsd: number;
    dayPnlUsd: number;
    drawdownFraction: number;
    positionAgeMs: number | null;
    leverage: number;
  };
  health: ExecutionHealth;
  readiness: { ready: boolean; fresh: boolean; warmup: boolean; reasons: string[]; missing: string[] };
}

export type Regime = "trending" | "mean_reverting" | "high_vol" | "crisis";
export type Direction = "up" | "down" | "neutral";
export interface ChoiceAnswer<T extends string> {
  choice: T;
  probabilities: Record<T, number>;
  /** Unavailable for deterministic rules; never replace this with max(probabilities). */
  confidence: number | null;
}
export interface ScoreAnswer {
  score: number;
  probabilities: Record<"0" | "1" | "2" | "3", number>;
  confidence: number | null;
}
export interface DecisionBattery {
  snapshotId: string;
  sessionId: string;
  source: "jev" | "llm" | "deterministic";
  modelId: string;
  requestedAtMs: number;
  decidedAtMs: number;
  validUntilMs: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Raw provider outputs and rule scores are not venue-calibration evidence. */
  calibration: "unverified";
  regime: ChoiceAnswer<Regime>;
  direction: ChoiceAnswer<Direction>;
  toxicFlow: number;
  liquidityStressed: number;
  quoteEnvironment: ScoreAnswer;
  inventoryPressure: ScoreAnswer;
}
export interface DecisionOptions { deadlineMs?: number; signal?: AbortSignal }
export interface DecisionProvider {
  readonly name: string;
  decide(snapshot: MarketSnapshot, options?: DecisionOptions): Promise<DecisionBattery>;
}

export type PolicyAction = "quote_both" | "quote_wide" | "reduce_inventory" | "pull_quotes" | "hold" | "kill";
export interface PolicyConfig {
  toxicFlowThreshold: number;
  liquidityStressThreshold: number;
  minQuoteScore: number;
  minQuoteConfidence: number;
  minWideScore: number;
  minWideConfidence: number;
  inventoryReduceScore: number;
  minInventoryConfidence: number;
  minDirectionConfidence: number;
  minDirectionProbability: number;
  maxDecisionAgeMs: number;
  maxDataAgeMs: number;
  wideSpreadMultiplier: number;
  lowConfidenceSizeMultiplier: number;
  /** Explicit opt-in. Deterministic fallback quotes are still subject to all hard risk limits. */
  allowDeterministicFallback: boolean;
}
export interface PolicyDecision {
  action: PolicyAction;
  reasons: string[];
  snapshotId: string;
  sizeMultiplier: number;
  spreadMultiplier: number;
  /** -1 means sell bias, +1 buy bias. Pricing must still use inventory and venue ticks. */
  skew: number;
  /** Only meaningful for reduce_inventory. */
  reduceSide: TradeSide | null;
  fallback: boolean;
}

/** Open and uncertain/pending orders both count until cancellation is confirmed. */
export interface RiskOrder { side: TradeSide; price: number; size: number }
export interface RiskLimits {
  maxPosition: number;
  maxOrderSize: number;
  maxDailyLossUsd: number;
  maxDrawdownFraction: number;
  maxInventoryAgeMs: number;
  maxDataAgeMs: number;
  maxLeverage: number;
  maxApiErrors: number;
  maxDecisionLatencyMs: number;
}
export interface RiskInput {
  snapshot: MarketSnapshot;
  orders: RiskOrder[];
  openOrders: RiskOrder[];
  decisionLatencyMs: number;
  nowMs: number;
  killed?: boolean;
}
export interface RiskVerdict {
  ok: boolean;
  /** Persist this latch before any further attempt to trade. No model can reset it. */
  kill: boolean;
  reasons: string[];
  worstCasePosition: number;
  worstCaseLeverage: number;
}
