import { createHash } from "node:crypto";
import { buildSnapshot } from "../engine/state";
import { composePolicy, DEFAULT_POLICY_CONFIG } from "../engine/policy";
import { DEFAULT_RISK_LIMITS, evaluateRisk } from "../engine/risk";
import { quoteEconomics as productionQuoteEconomics } from "../engine/economics";
import { DeterministicDecisionProvider, validateDecisionBattery } from "../engine/decisions";
import type { AccountState, BookObservation, DecisionBattery, DecisionProvider, ExecutionHealth, MarketSnapshot, MidObservation, PolicyConfig, RiskLimits, RiskOrder, SnapshotInput, SnapshotOptions, TradeObservation } from "../engine/types";
import { avellanedaStoikov } from "../quant/avellaneda-stoikov";
import { finite, nonnegative, positive, seededUniform } from "../quant/math";
import { performanceMetrics } from "./metrics";
import type { EquityPoint, FillMeasurement } from "./metrics";

export type ReplayBaseline = "rules" | "llm" | "jev" | "jev_gated";
export const REPLAY_BASELINES: readonly ReplayBaseline[] = ["rules", "llm", "jev", "jev_gated"];

export interface ReplayFrame {
  book: BookObservation;
  decisionTs: number;
  /** Held-out future prints used only by execution simulation, never features. */
  tradesAfterDecision: TradeObservation[];
  settlementTs: number;
  settlementMid: number;
  referencePrice?: SnapshotInput["referencePrice"];
  spotPrice?: SnapshotInput["spotPrice"];
  fundingRate?: SnapshotInput["fundingRate"];
  baseline24h?: SnapshotInput["baseline24h"];
}

export interface RecordedDecision {
  block: number;
  battery: DecisionBattery;
  /** Actual bill or explicitly declared provider unit-cost calculation. */
  costUsd: number;
  provenance: { kind: "provider_recording"; requestId: string; costBasis: string; capturedAtMs?: number };
}

export interface ReplayDataset {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  symbol: string;
  provenance: { kind: "synthetic" | "historical"; source: string; description: string };
  frames: ReplayFrame[];
  recordings?: Partial<Record<Exclude<ReplayBaseline, "rules">, RecordedDecision[]>>;
}

export interface ReplayConfig {
  initialEquityUsd: number;
  orderSize: number;
  tickSize: number;
  gamma: number;
  kappa: number;
  horizonSeconds: number;
  minimumHalfSpread: number;
  makerFeeBps: number;
  /** A modeled extra cost, not a fill above a limit price. */
  slippageCostBps: number;
  expectedFillProbability: number;
  adverseSelectionBps: number;
  minNetEdgeUsd: number;
  maxGasUsdPerHour: number;
  /** The upstream Kuru market is spot; unbacked sells are disabled by default. */
  allowShort: boolean;
  gasUsdPerSubmit: number;
  gasUsdPerCancel: number;
  executionLatencyMs: number;
  participationRate: number;
  minRestMs: number;
  maxRestMs: number;
  replaceThresholdTicks: number;
  periodsPerYear: number;
  snapshot: SnapshotOptions;
  policy: Partial<PolicyConfig>;
  risk: Partial<RiskLimits>;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  initialEquityUsd: 10_000, orderSize: 1, tickSize: 0.01, gamma: 0.01, kappa: 100,
  horizonSeconds: 10, minimumHalfSpread: 0.02,
  makerFeeBps: 1, slippageCostBps: 0.5, gasUsdPerSubmit: 0.01, gasUsdPerCancel: 0.005,
  expectedFillProbability: 0.25, adverseSelectionBps: 1, minNetEdgeUsd: 0, maxGasUsdPerHour: 10, allowShort: false,
  executionLatencyMs: 10, participationRate: 0.1, minRestMs: 1_000, maxRestMs: 5_000,
  replaceThresholdTicks: 1, periodsPerYear: 365.25 * 86_400,
  snapshot: { requireWarmup: true, minVolSamples: 20, maxHistoryGapMs: 5_000 },
  policy: {},
  risk: { maxPosition: 10, maxOrderSize: 1, maxDailyLossUsd: 200, maxDrawdownFraction: 0.05, maxLeverage: 1 },
};

interface SimOrder extends RiskOrder { remaining: number; createdAt: number; expiresAt: number }
export interface ReplayFill { ts: number; side: "buy" | "sell"; price: number; size: number; feesUsd: number; referenceMid: number; realizedPnlUsd: number | null }
export interface ReplayEvent { block: number; snapshotId: string; action: string; reasons: string[]; inventory: number; equityUsd: number }
export interface ReplayResult {
  baseline: ReplayBaseline;
  status: "COMPLETED" | "NOT_RUN";
  reason: string | null;
  metrics: ReturnType<typeof performanceMetrics> | null;
  equity: EquityPoint[];
  fills: ReplayFill[];
  events: ReplayEvent[];
  modelIds: string[];
  missingRecordings: { block: number; snapshotId: string }[];
  endState: { inventory: number; openOrders: number; killed: boolean; residualExposureUsd: number };
  limitations: string[];
}

const LIMITATIONS = [
  "Synthetic input is an engineering fixture, never historical performance or evidence of alpha.",
  "L2/trade-through fills are a conservative execution model, not queue-position or L3 reconstruction.",
  "Latency, participation, gas, fees and extra slippage costs are common declared assumptions.",
  "Inventory is marked to observed settlement prices; unfilled residual exposure is reported, never invented as flattened.",
  "Recorded decisions are reusable only for the exact snapshot including portfolio state; counterfactual state changes need matching recordings.",
];

export function validateReplayDataset(data: ReplayDataset): void {
  if (!data || data.schemaVersion !== 1 || !data.id || !data.sessionId || !data.symbol ||
      !data.provenance || !["historical", "synthetic"].includes(data.provenance.kind) || !data.provenance.source ||
      !Array.isArray(data.frames) || data.frames.length < 2) throw new RangeError("invalid replay dataset or provenance");
  let previousSettlement = -Infinity, previousBlock = -1;
  for (const frame of data.frames) {
    finite(frame.decisionTs, "decisionTs"); finite(frame.settlementTs, "settlementTs"); positive(frame.settlementMid, "settlementMid");
    if (!frame.book || frame.book.ts <= previousSettlement || frame.book.ts >= frame.decisionTs ||
        frame.settlementTs <= frame.decisionTs || frame.book.block <= previousBlock) throw new RangeError("replay frames must be ordered and nonoverlapping");
    let previousTrade = frame.decisionTs;
    if (!Array.isArray(frame.tradesAfterDecision)) throw new RangeError("future trade tape is required, even when empty");
    for (const trade of frame.tradesAfterDecision) {
      positive(trade.price, "trade price"); positive(trade.size, "trade size"); finite(trade.ts, "trade time");
      if (!Number.isSafeInteger(frame.book.block) || trade.ts <= previousTrade || trade.ts > frame.settlementTs ||
          (trade.side !== "buy" && trade.side !== "sell")) throw new RangeError("invalid future execution tape");
      previousTrade = trade.ts;
    }
    previousSettlement = frame.settlementTs; previousBlock = frame.book.block;
  }
  for (const baseline of ["llm", "jev", "jev_gated"] as const) {
    const keys = new Set<number>();
    const versions = new Set<string>();
    for (const recorded of data.recordings?.[baseline] ?? []) {
      validateDecisionBattery(recorded.battery);
      nonnegative(recorded.costUsd, "recorded decision cost");
      if (!Number.isSafeInteger(recorded.block) || keys.has(recorded.block)) throw new RangeError("duplicate recorded block");
      keys.add(recorded.block);
      if (recorded.provenance?.kind !== "provider_recording" || !recorded.provenance.requestId || !recorded.provenance.costBasis) throw new RangeError("recording provenance and cost basis are required");
      const expected = baseline === "llm" ? "llm" : "jev";
      if (recorded.battery.source !== expected) throw new RangeError("recorded provider source does not match baseline");
      versions.add(recorded.battery.modelId);
      if (/latest|auto$/i.test(recorded.battery.modelId)) throw new RangeError("recordings must use a pinned model version");
    }
    if (versions.size > 1) throw new RangeError("a baseline cannot mix model versions; compare them as separate runs");
  }
}

function resolveConfig(config: Partial<ReplayConfig>): ReplayConfig {
  const result: ReplayConfig = { ...DEFAULT_REPLAY_CONFIG, ...config,
    snapshot: { ...DEFAULT_REPLAY_CONFIG.snapshot, ...config.snapshot },
    policy: { ...DEFAULT_REPLAY_CONFIG.policy, ...config.policy },
    risk: { ...DEFAULT_REPLAY_CONFIG.risk, ...config.risk } };
  for (const key of ["initialEquityUsd", "orderSize", "tickSize", "kappa", "horizonSeconds", "maxRestMs", "periodsPerYear", "maxGasUsdPerHour"] as const) positive(result[key], key);
  for (const key of ["gamma", "minimumHalfSpread", "slippageCostBps", "makerFeeBps", "gasUsdPerSubmit", "gasUsdPerCancel", "executionLatencyMs", "minRestMs", "replaceThresholdTicks", "adverseSelectionBps", "minNetEdgeUsd"] as const) nonnegative(result[key], key);
  if (!(result.participationRate > 0 && result.participationRate <= 1) || result.maxRestMs < result.minRestMs ||
      !(result.expectedFillProbability >= 0 && result.expectedFillProbability <= 1) || typeof result.allowShort !== "boolean") throw new RangeError("invalid participation, probability, shorting or residence settings");
  return result;
}

interface ResolverResult { battery: DecisionBattery; costUsd: number }
type Resolver = (snapshot: MarketSnapshot, frame: ReplayFrame) => Promise<ResolverResult | null>;

async function simulate(data: ReplayDataset, baseline: ReplayBaseline, cfg: ReplayConfig, resolve: Resolver): Promise<ReplayResult> {
  let cash = cfg.initialEquityUsd, inventory = 0, averageEntry = 0, entryFeePerUnit = 0;
  let peak = cash, dayStartEquity = cash, currentDay = "", positionOpenedAtMs: number | null = null;
  let realizedPnl = 0, decisionCost = 0, executionCost = 0, killed = false, decisions = 0, quotingDecisions = 0;
  let submitted = 0, rejected = 0;
  let orders: SimOrder[] = [];
  const equity: EquityPoint[] = [], fills: ReplayFill[] = [], events: ReplayEvent[] = [];
  const closedTradePnls: number[] = [], measurements: FillMeasurement[] = [], modelIds = new Set<string>();
  const mids: MidObservation[] = [], pastTrades: TradeObservation[] = [], latencies: number[] = [];
  const missingRecordings: ReplayResult["missingRecordings"] = [];
  const gasHistory: { at: number; usd: number }[] = [];
  let operationTime = data.frames[0]!.decisionTs;
  let notRunReason: string | null = null;
  let lastMid = (data.frames[0]!.book.bid + data.frames[0]!.book.ask) / 2;
  const account = (mid: number): AccountState => {
    const value = cash + inventory * mid;
    peak = Math.max(peak, value);
    return { inventory, equityUsd: value, peakEquityUsd: peak, dayStartEquityUsd: dayStartEquity,
      realizedPnlUsd: realizedPnl, unrealizedPnlUsd: inventory * (mid - averageEntry), positionOpenedAtMs };
  };
  const health = (): ExecutionHealth => ({ apiErrors: 0, fillRatio: submitted ? Math.min(1, fills.length / submitted) : null,
    rejectRate: decisions ? rejected / decisions : null, slippageBps: measurements.length ? cfg.slippageCostBps : null, latenciesMs: latencies.slice(-10) });
  const snapshotFor = (frame: ReplayFrame, decisionTs = frame.decisionTs) => buildSnapshot({
    sessionId: data.sessionId, symbol: data.symbol, block: frame.book.block, decisionTs,
    book: frame.book, mids, trades: pastTrades, flowWindowStartMs: data.frames[0]!.book.ts,
    referencePrice: frame.referencePrice, spotPrice: frame.spotPrice, fundingRate: frame.fundingRate,
    baseline24h: frame.baseline24h, account: account((frame.book.bid + frame.book.ask) / 2), health: health(),
  }, cfg.snapshot);
  const charge = (cost: number) => { cash -= cost; executionCost += cost; gasHistory.push({ at: operationTime, usd: cost }); };
  const cancel = () => { if (orders.length) charge(cfg.gasUsdPerCancel); orders = []; };
  const applyFill = (order: SimOrder, size: number, trade: TradeObservation, mid: number, settlementMid: number) => {
    const signed = order.side === "buy" ? size : -size;
    const notional = size * order.price;
    const fees = notional * (cfg.makerFeeBps + cfg.slippageCostBps) / 10_000;
    cash -= signed * order.price + fees;
    executionCost += fees;
    const oldInventory = inventory;
    let closedPnl: number | null = null;
    if (oldInventory !== 0 && Math.sign(oldInventory) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(oldInventory), size);
      closedPnl = closing * (order.price - averageEntry) * Math.sign(oldInventory) - closing * (entryFeePerUnit + fees / size);
      closedTradePnls.push(closedPnl); realizedPnl += closedPnl;
    }
    inventory += signed;
    if (Math.abs(inventory) < 1e-10) { inventory = 0; averageEntry = 0; entryFeePerUnit = 0; positionOpenedAtMs = null; }
    else if (oldInventory === 0 || Math.sign(oldInventory) !== Math.sign(inventory)) {
      averageEntry = order.price; entryFeePerUnit = fees / size; positionOpenedAtMs = trade.ts;
    } else if (Math.sign(oldInventory) === Math.sign(signed)) {
      averageEntry = (averageEntry * Math.abs(oldInventory) + order.price * size) / Math.abs(inventory);
      entryFeePerUnit = (entryFeePerUnit * Math.abs(oldInventory) + fees) / Math.abs(inventory);
    }
    order.remaining -= size;
    fills.push({ ts: trade.ts, side: order.side, price: order.price, size, feesUsd: fees, referenceMid: mid, realizedPnlUsd: closedPnl });
    measurements.push({ notional, slippageBps: cfg.slippageCostBps,
      adverseSelectionBps: (order.side === "buy" ? mid - settlementMid : settlementMid - mid) / mid * 10_000 });
  };
  const processTrade = (trade: TradeObservation, mid: number, settlementMid: number) => {
    if (orders.some(order => trade.ts >= order.expiresAt)) cancel();
    let liquidity = trade.size * cfg.participationRate;
    for (const order of orders) {
      if (liquidity <= 0 || trade.ts <= order.createdAt || trade.ts >= order.expiresAt) continue;
      // Touching a quote is insufficient evidence of a fill when queue priority is unknown.
      const priceTolerance = Math.max(cfg.tickSize * 1e-7, Math.abs(order.price) * Number.EPSILON * 8);
      const crossed = order.side === "buy" ? trade.side === "sell" && trade.price < order.price - priceTolerance : trade.side === "buy" && trade.price > order.price + priceTolerance;
      if (crossed) {
        const size = Math.min(order.remaining, liquidity);
        applyFill(order, size, trade, mid, settlementMid); liquidity -= size;
      }
    }
    orders = orders.filter(order => order.remaining > 1e-10 && trade.ts < order.expiresAt);
  };
  for (const frame of data.frames) {
    operationTime = frame.decisionTs;
    while (gasHistory.length && gasHistory[0]!.at < operationTime - 3_600_000) gasHistory.shift();
    const mid = (frame.book.bid + frame.book.ask) / 2;
    lastMid = frame.settlementMid;
    const day = new Date(frame.decisionTs).toISOString().slice(0, 10);
    if (day !== currentDay) { dayStartEquity = cash + inventory * mid; currentDay = day; }
    if (cash + inventory * mid <= 0) { killed = true; notRunReason = "Account insolvency invalidated subsequent return estimates"; break; }
    const snapshot = snapshotFor(frame);
    mids.push({ ts: frame.book.ts, mid });
    // Keep enough continuous feature history; the same bound applies to every baseline.
    while (mids.length && mids[0]!.ts < frame.book.ts - 1_805_000) mids.shift();
    while (pastTrades.length && pastTrades[0]!.ts < frame.book.ts - 60_000) pastTrades.shift();
    let resolved: ResolverResult | null = null;
    if (snapshot.readiness.ready && !killed) {
      resolved = await resolve(snapshot, frame);
      if (!resolved) {
        missingRecordings.push({ block: frame.book.block, snapshotId: snapshot.id });
        notRunReason = "No matching versioned provider recording for the exact state; partial replay is not a comparable benchmark";
        break;
      }
      decisions++; decisionCost += resolved.costUsd; cash -= resolved.costUsd;
      modelIds.add(resolved.battery.modelId); latencies.push(resolved.battery.latencyMs);
    }
    const battery = resolved?.battery ?? null;
    const now = battery?.decidedAtMs ?? frame.decisionTs;
    const policyConfig: Partial<PolicyConfig> = { ...cfg.policy, allowDeterministicFallback: baseline === "rules" };
    if (baseline === "jev") Object.assign(policyConfig, { minQuoteConfidence: 0, minWideConfidence: 0, minInventoryConfidence: 0, minDirectionConfidence: 0 });
    const policy = composePolicy(snapshot, battery, policyConfig, now);
    let action = policy.action;
    let reasons = [...policy.reasons];
    const arrival = now + cfg.executionLatencyMs;
    const fillsBeforeDecision = fills.length;
    for (const trade of frame.tradesAfterDecision.filter(trade => trade.ts <= arrival)) processTrade(trade, mid, frame.settlementMid);
    const inventoryChangedWhileDeciding = fills.length !== fillsBeforeDecision;
    if (inventoryChangedWhileDeciding) { action = "hold"; reasons = ["inventory_changed_while_deciding"]; cancel(); }
    if (arrival >= frame.settlementTs) { action = "hold"; reasons = ["execution_missed_frame_deadline"]; }
    const expired = orders.some(order => arrival >= order.expiresAt);
    if (expired) cancel();
    let riskSnapshot = snapshotFor(frame, Math.max(frame.decisionTs, arrival + 0.001));
    const existingRisk = evaluateRisk({ snapshot: riskSnapshot, orders: [], openOrders: orders.map(order => ({ ...order, size: order.remaining })),
      decisionLatencyMs: battery?.latencyMs ?? 0, nowMs: riskSnapshot.decisionTs, killed }, cfg.risk);
    if (existingRisk.kill || action === "kill") { killed = true; action = "kill"; reasons.push(...existingRisk.reasons); cancel(); }
    if (action === "pull_quotes") cancel();
    if (!killed && !inventoryChangedWhileDeciding && arrival < frame.settlementTs &&
        (action === "quote_both" || action === "quote_wide" || action === "reduce_inventory")) {
      const size = action === "reduce_inventory" ? Math.min(cfg.orderSize * policy.sizeMultiplier, Math.abs(inventory)) : cfg.orderSize * policy.sizeMultiplier;
      if (size > 0 && snapshot.vol.short !== null) {
        const quote = avellanedaStoikov({ mid, inventory: inventory - policy.skew * cfg.orderSize / 4, gamma: cfg.gamma, sigma: snapshot.vol.short * mid,
          timeRemaining: cfg.horizonSeconds, kappa: cfg.kappa, tickSize: cfg.tickSize,
          minHalfSpread: cfg.minimumHalfSpread, bestBid: snapshot.book.bid, bestAsk: snapshot.book.ask });
        const bid = Math.min(Math.floor((quote.reservationPrice - quote.halfSpread * policy.spreadMultiplier) / cfg.tickSize) * cfg.tickSize,
          (Math.ceil(frame.book.ask / cfg.tickSize) - 1) * cfg.tickSize);
        const ask = Math.max(Math.ceil((quote.reservationPrice + quote.halfSpread * policy.spreadMultiplier) / cfg.tickSize) * cfg.tickSize,
          (Math.floor(frame.book.bid / cfg.tickSize) + 1) * cfg.tickSize);
        let wanted: RiskOrder[] = action === "reduce_inventory" ? [{ side: policy.reduceSide!, price: policy.reduceSide === "buy" ? bid : ask, size }] : [{ side: "buy", price: bid, size }, { side: "sell", price: ask, size }];
        if (!cfg.allowShort) wanted = wanted.filter(order => order.side === "buy" ? order.size * order.price <= cash : order.size <= Math.max(0, inventory));
        const unchanged = orders.length === wanted.length && orders.every((order, i) => order.side === wanted[i]!.side &&
          Math.abs(order.price - wanted[i]!.price) < cfg.tickSize * cfg.replaceThresholdTicks && Math.abs(order.remaining - wanted[i]!.size) < 1e-10);
        const resting = orders.length > 0 && arrival - Math.min(...orders.map(order => order.createdAt)) < cfg.minRestMs;
        const economics = productionQuoteEconomics({ bid, ask, size, mid, fillProbability: cfg.expectedFillProbability,
          makerFeeBps: cfg.makerFeeBps, slippageBps: 2 * cfg.slippageCostBps, adverseSelectionBps: cfg.adverseSelectionBps,
          gasUsd: 2 * cfg.gasUsdPerSubmit + cfg.gasUsdPerCancel, decisionUsd: resolved?.costUsd ?? 0 });
        const gasSpent = gasHistory.reduce((sum, item) => sum + item.usd, 0);
        const economicVeto = economics.netEdgeUsd < cfg.minNetEdgeUsd;
        const gasVeto = gasSpent + economics.assumptions.gasUsd > cfg.maxGasUsdPerHour;
        if (economicVeto || gasVeto || !wanted.length) {
          action = "hold";
          reasons.push(economicVeto ? "cost_exceeds_expected_capture" : gasVeto ? "hourly_gas_budget" : "spot_funding_unavailable");
        }
        if (wanted.length && !unchanged && !resting && !economicVeto && !gasVeto) {
          cancel();
          // Reserve the submission cost before the final risk check.
          charge(cfg.gasUsdPerSubmit);
          riskSnapshot = snapshotFor(frame, Math.max(frame.decisionTs, arrival + 0.001));
          const verdict = evaluateRisk({ snapshot: riskSnapshot, orders: wanted, openOrders: [], decisionLatencyMs: battery?.latencyMs ?? 0,
            nowMs: riskSnapshot.decisionTs, killed }, cfg.risk);
          if (verdict.ok) {
            orders = wanted.map(order => ({ ...order, remaining: order.size, createdAt: arrival, expiresAt: arrival + cfg.maxRestMs }));
            submitted += wanted.length;
          } else {
            // A rejected pre-send operation did not consume chain gas.
            charge(-cfg.gasUsdPerSubmit); rejected++;
            reasons.push(...verdict.reasons);
            if (verdict.kill) { killed = true; action = "kill"; }
          }
        }
        if (orders.length) quotingDecisions++;
      }
    }
    for (const trade of frame.tradesAfterDecision.filter(trade => trade.ts > arrival)) processTrade(trade, mid, frame.settlementMid);
    pastTrades.push(...frame.tradesAfterDecision);
    const value = cash + inventory * frame.settlementMid;
    peak = Math.max(peak, value);
    equity.push({ ts: frame.settlementTs, equity: value });
    events.push({ block: frame.book.block, snapshotId: snapshot.id, action, reasons, inventory, equityUsd: value });
    if (value <= 0) { killed = true; cancel(); break; }
  }
  const status = notRunReason ? "NOT_RUN" : "COMPLETED";
  const metrics = status === "COMPLETED" ? performanceMetrics({ initialEquity: cfg.initialEquityUsd, equity, closedTradePnls,
    fills: measurements, decisions, quotingDecisions: Math.min(decisions, quotingDecisions), decisionCostUsd: decisionCost,
    executionCostUsd: executionCost, periodsPerYear: cfg.periodsPerYear }) : null;
  return { baseline, status, reason: notRunReason, metrics, equity, fills, events, modelIds: [...modelIds], missingRecordings,
    endState: { inventory, openOrders: orders.length, killed, residualExposureUsd: Math.abs(inventory) * lastMid }, limitations: [...LIMITATIONS] };
}

export async function replayBaseline(data: ReplayDataset, baseline: ReplayBaseline, config: Partial<ReplayConfig> = {}): Promise<ReplayResult> {
  validateReplayDataset(data);
  const cfg = resolveConfig(config);
  let replayClock = 0;
  const deterministic = new DeterministicDecisionProvider({ clock: () => replayClock, timeoutMs: DEFAULT_POLICY_CONFIG.maxDecisionAgeMs });
  const recordings = new Map((baseline === "rules" ? [] : data.recordings?.[baseline] ?? []).map(row => [row.block, row]));
  return simulate(data, baseline, cfg, async (snapshot, frame) => {
    if (baseline === "rules") {
      replayClock = snapshot.decisionTs + 1;
      return { battery: await deterministic.decide(snapshot, { deadlineMs: frame.settlementTs }), costUsd: 0 };
    }
    const row = recordings.get(frame.book.block);
    if (!row || row.battery.snapshotId !== snapshot.id || row.battery.sessionId !== snapshot.sessionId) return null;
    return { battery: row.battery, costUsd: row.costUsd };
  });
}

/**
 * Explicit opt-in capture path. Calls the supplied real provider but ONLY simulates orders.
 * The CLI never invokes it automatically and never spends API credits during fixture replay.
 */
export async function captureProviderReplay(data: ReplayDataset, baseline: Exclude<ReplayBaseline, "rules">, createProvider: (replayClock: () => number) => DecisionProvider,
  cost: (battery: DecisionBattery) => { usd: number; basis: string }, config: Partial<ReplayConfig> = {}) {
  validateReplayDataset(data);
  const recordings: RecordedDecision[] = [];
  let historicalStart = 0, wallStart = performance.now();
  // The relative network latency remains measured. Only the clock origin maps onto historical data.
  const replayClock = () => historicalStart + performance.now() - wallStart;
  const provider = createProvider(replayClock);
  const result = await simulate(data, baseline, resolveConfig(config), async (snapshot, frame) => {
    historicalStart = snapshot.decisionTs + 1; wallStart = performance.now();
    const battery = await provider.decide(snapshot, { deadlineMs: frame.settlementTs });
    validateDecisionBattery(battery);
    if (battery.snapshotId !== snapshot.id || battery.sessionId !== snapshot.sessionId ||
        battery.source !== (baseline === "llm" ? "llm" : "jev")) throw new RangeError("capture provider returned a mismatched decision");
    const charge = cost(battery); nonnegative(charge.usd, "provider cost");
    if (!charge.basis) throw new RangeError("capture cost basis is required");
    const recorded: RecordedDecision = { block: frame.book.block, battery, costUsd: charge.usd,
      provenance: { kind: "provider_recording", requestId: createHash("sha256").update(JSON.stringify(battery)).digest("hex"), costBasis: charge.basis, capturedAtMs: Date.now() } };
    recordings.push(recorded);
    return { battery, costUsd: charge.usd };
  });
  return { result, recordings };
}

export async function compareBaselines(data: ReplayDataset, config: Partial<ReplayConfig> = {}) {
  const resolved = resolveConfig(config);
  const results: ReplayResult[] = [];
  // Sequential to keep large replay arrays bounded and deterministic.
  for (const baseline of REPLAY_BASELINES) results.push(await replayBaseline(data, baseline, resolved));
  return {
    schemaVersion: 1, datasetId: data.id, datasetHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    provenance: data.provenance, config: resolved, results,
    comparisonStatus: results.every(result => result.status === "COMPLETED") ? "ALL_BASELINES_REPLAYED" : "INCOMPLETE_MISSING_PROVIDER_EVIDENCE",
    providerCallsDuringReplay: 0,
    noProfitabilityClaim: true,
  };
}

/** Small deterministic fixture; fake market data are labeled at the dataset and report roots. */
export function syntheticReplayDataset(count = 240, seed = 2026): ReplayDataset {
  if (!Number.isInteger(count) || count < 30 || count > 100_000) throw new RangeError("synthetic frame count must be 30..100000");
  const random = seededUniform(seed);
  const frames: ReplayFrame[] = [];
  let mid = 100;
  const start = Date.UTC(2026, 10, 1);
  for (let i = 0; i < count; i++) {
    const ts = start + i * 1_000;
    mid = Math.max(1, mid + (100 - mid) * 0.03 + (random() - 0.5) * 0.08);
    const bid = Math.floor((mid - 0.02) * 100) / 100;
    const ask = bid + 0.04;
    const book: BookObservation = { block: i + 1, ts, bid, ask,
      bids: [[bid, 100], [bid - 0.01, 150], [bid - 0.02, 200]],
      asks: [[ask, 100], [ask + 0.01, 150], [ask + 0.02, 200]] };
    const settlementMid = (bid + ask) / 2 + (random() - 0.5) * 0.04;
    frames.push({ book, decisionTs: ts + 1,
      tradesAfterDecision: [
        { ts: ts + 300, side: random() < 0.5 ? "sell" : "buy", price: bid - random() * 0.12, size: 2 + random() * 10 },
        { ts: ts + 600, side: random() < 0.5 ? "sell" : "buy", price: ask + random() * 0.12, size: 2 + random() * 10 },
      ], settlementTs: ts + 900, settlementMid });
  }
  return { schemaVersion: 1, id: `synthetic-${seed}-${count}`, sessionId: `synthetic-session-${seed}`, symbol: "SYNTH-USD",
    provenance: { kind: "synthetic", source: "seeded fixture generator in src/evaluation/replay.ts", description: "Invented prices and prints for engineering acceptance only; not market history or live provider output." }, frames };
}
