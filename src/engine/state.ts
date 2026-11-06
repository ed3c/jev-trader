import { createHash } from "node:crypto";
import type { Level, MarketSnapshot, MidObservation, SnapshotInput, SnapshotOptions, TimedValue } from "./types";

export class SnapshotValidationError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SnapshotValidationError";
  }
}

const fail = (code: string, detail: string): never => { throw new SnapshotValidationError(code, detail); };
const finite = (n: number, label: string) => {
  if (typeof n !== "number" || !Number.isFinite(n)) fail("invalid_number", label);
  return n;
};
const positive = (n: number, label: string) => {
  if (finite(n, label) <= 0) fail("nonpositive_number", label);
  return n;
};
const nonnegative = (n: number, label: string) => {
  if (finite(n, label) < 0) fail("negative_number", label);
  return n;
};
const probability = (n: number | null, label: string) => {
  if (n !== null && (finite(n, label) < 0 || n > 1)) fail("invalid_probability", label);
};
const timestamp = (ts: number, decisionTs: number, label: string) => {
  nonnegative(ts, label);
  if (ts >= decisionTs) fail("future_observation", `${label} must precede decisionTs`);
};

/** Stable even when a persisted object's property order changes on deserialization. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return `{${Object.keys(v).sort().map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotFingerprint(snapshot: Omit<MarketSnapshot, "id"> | MarketSnapshot): string {
  const { id: _id, ...data } = snapshot as MarketSnapshot;
  return createHash("sha256").update(canonical(data)).digest("hex");
}

export function verifySnapshot(snapshot: MarketSnapshot): boolean {
  return typeof snapshot.id === "string" && /^[a-f0-9]{64}$/.test(snapshot.id) && snapshotFingerprint(snapshot) === snapshot.id;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function levels(rows: Level[], side: "bid" | "ask", best: number): Level[] {
  if (!Array.isArray(rows) || !rows.length) fail("empty_book", side);
  let previous = side === "bid" ? Infinity : -Infinity;
  for (const [i, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length !== 2) fail("invalid_level", `${side}[${i}]`);
    const [price, size] = row;
    positive(price, `${side}[${i}].price`);
    positive(size, `${side}[${i}].size`);
    if (side === "bid" ? price >= previous : price <= previous) fail("unordered_book", side);
    previous = price;
  }
  if (Math.abs(rows[0]![0] - best) > Math.max(1e-12, best * 1e-10)) fail("inconsistent_touch", side);
  return rows.slice(0, 3).map(([p, q]) => [p, q]);
}

function returnBps(history: MidObservation[], now: number, mid: number, duration: number, maxGap: number): number | null {
  const target = now - duration;
  let anchor = -1;
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.ts <= target) anchor = i;
    else break;
  }
  if (anchor < 0 || target - history[anchor]!.ts > maxGap) return null;
  for (let i = anchor + 1; i < history.length; i++) {
    if (history[i]!.ts - history[i - 1]!.ts > maxGap) return null;
  }
  return (mid / history[anchor]!.mid - 1) * 10_000;
}

function realizedVol(history: MidObservation[], now: number, duration: number, maxGap: number) {
  const rows = history.filter((v) => v.ts >= now - duration);
  let squared = 0, seconds = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i]!.ts - rows[i - 1]!.ts;
    if (dt > maxGap) return { value: null, samples: 0 };
    squared += Math.log(rows[i]!.mid / rows[i - 1]!.mid) ** 2;
    seconds += dt / 1000;
  }
  return { value: rows.length >= 2 && seconds > 0 ? Math.sqrt(squared / seconds) : null, samples: Math.max(0, rows.length - 1) };
}

/**
 * Pure point-in-time feature construction. Bad or future data is rejected; unavailable
 * measurements stay null. Warmup and stale-data decisions are carried in readiness.
 */
export function buildSnapshot(input: SnapshotInput, options: SnapshotOptions = {}): MarketSnapshot {
  const cfg = {
    maxDataAgeMs: options.maxDataAgeMs ?? 1000,
    maxCrossAgeMs: options.maxCrossAgeMs ?? 10_000,
    maxFundingAgeMs: options.maxFundingAgeMs ?? 3_600_000,
    maxBaselineAgeMs: options.maxBaselineAgeMs ?? 3_600_000,
    maxHistoryGapMs: options.maxHistoryGapMs ?? 5000,
    minVolSamples: options.minVolSamples ?? 20,
    requireWarmup: options.requireWarmup ?? true,
  };
  for (const [k, v] of Object.entries(cfg)) if (typeof v === "number") positive(v, k);
  if (!Number.isInteger(cfg.minVolSamples)) fail("invalid_config", "minVolSamples must be an integer");
  if (!input.sessionId?.trim() || !input.symbol?.trim()) fail("missing_identity", "sessionId and symbol are required");
  positive(input.decisionTs, "decisionTs");
  if (!Number.isSafeInteger(input.block) || input.block < 0) fail("invalid_block", "block");
  if (input.book.block !== input.block) fail("book_block_mismatch", "book is not from the requested block");
  timestamp(input.book.ts, input.decisionTs, "book.ts");
  positive(input.book.bid, "book.bid");
  positive(input.book.ask, "book.ask");
  if (input.book.bid >= input.book.ask) fail("crossed_book", "best bid must be below best ask");
  const horizonBlocks = input.horizonBlocks ?? 10;
  if (!Number.isSafeInteger(horizonBlocks) || horizonBlocks <= 0) fail("invalid_horizon", "horizonBlocks");
  const bids = levels(input.book.bids, "bid", input.book.bid);
  const asks = levels(input.book.asks, "ask", input.book.ask);
  const mid = (input.book.bid + input.book.ask) / 2;
  const microprice = (input.book.ask * bids[0]![1] + input.book.bid * asks[0]![1]) / (bids[0]![1] + asks[0]![1]);
  const depthBid = bids.reduce((sum, row) => sum + row[1], 0);
  const depthAsk = asks.reduce((sum, row) => sum + row[1], 0);
  const reasons: string[] = [], missing: string[] = [];

  const mids = new Map<number, number>();
  for (const [i, sample] of (input.mids ?? []).entries()) {
    timestamp(sample.ts, input.decisionTs, `mids[${i}].ts`);
    positive(sample.mid, `mids[${i}].mid`);
    if (sample.ts > input.book.ts) fail("book_behind_history", `mids[${i}] is newer than the selected book`);
    if (mids.has(sample.ts) && mids.get(sample.ts) !== sample.mid) fail("conflicting_observation", `mids[${i}].ts`);
    mids.set(sample.ts, sample.mid);
  }
  if (mids.has(input.book.ts) && Math.abs(mids.get(input.book.ts)! - mid) > Math.max(1e-12, mid * 1e-10)) fail("conflicting_observation", "book mid");
  mids.set(input.book.ts, mid);
  const history = [...mids].map(([ts, value]) => ({ ts, mid: value })).sort((a, b) => a.ts - b.ts);
  const returnsBps = {
    m1: returnBps(history, input.book.ts, mid, 60_000, cfg.maxHistoryGapMs),
    m5: returnBps(history, input.book.ts, mid, 300_000, cfg.maxHistoryGapMs),
    m30: returnBps(history, input.book.ts, mid, 1_800_000, cfg.maxHistoryGapMs),
  };
  for (const [key, value] of Object.entries(returnsBps)) if (value === null) missing.push(`return_${key}`);
  const short = realizedVol(history, input.book.ts, 60_000, cfg.maxHistoryGapMs);
  const medium = realizedVol(history, input.book.ts, 300_000, cfg.maxHistoryGapMs);
  const warmup = short.samples >= cfg.minVolSamples && short.value !== null;
  if (cfg.requireWarmup && !warmup) reasons.push("volatility_warmup");
  if (short.value === null) missing.push("vol_short");
  if (medium.value === null) missing.push("vol_medium");
  if (bids.length < 3 || asks.length < 3) missing.push("depth_three_levels");

  const observed = (v: TimedValue | undefined, name: string, age: number, positiveOnly: boolean) => {
    if (!v) { missing.push(name); return null; }
    timestamp(v.ts, input.decisionTs, `${name}.ts`);
    if (positiveOnly) positive(v.value, name); else finite(v.value, name);
    if (input.decisionTs - v.ts >= age) { missing.push(`${name}_stale`); return null; }
    return v.value;
  };
  const referencePrice = observed(input.referencePrice, "reference_price", cfg.maxCrossAgeMs, true);
  const spotPrice = observed(input.spotPrice, "spot_price", cfg.maxCrossAgeMs, true);
  const fundingRate = observed(input.fundingRate, "funding_rate", cfg.maxFundingAgeMs, false);
  const queueAhead = observed(input.queueAhead, "queue_ahead", cfg.maxDataAgeMs, false);
  if (queueAhead !== null) nonnegative(queueAhead, "queue_ahead");
  let vs24h: number | null = null, depthVs24h: number | null = null;
  if (input.baseline24h) {
    timestamp(input.baseline24h.ts, input.decisionTs, "baseline24h.ts");
    nonnegative(input.baseline24h.realizedVol, "baseline24h.realizedVol");
    positive(input.baseline24h.depth, "baseline24h.depth");
    if (input.decisionTs - input.baseline24h.ts < cfg.maxBaselineAgeMs) {
      if (short.value !== null && input.baseline24h.realizedVol > 0) vs24h = short.value / input.baseline24h.realizedVol;
      depthVs24h = (depthBid + depthAsk) / input.baseline24h.depth;
    } else missing.push("baseline24h_stale");
  } else missing.push("baseline24h");

  let windowSeconds: number | null = null;
  if (input.flowWindowStartMs !== undefined) {
    timestamp(input.flowWindowStartMs, input.decisionTs, "flowWindowStartMs");
    if (input.flowWindowStartMs < input.book.ts) windowSeconds = Math.min(60, (input.book.ts - input.flowWindowStartMs) / 1000);
  }
  if (windowSeconds === null) missing.push("flow_window_coverage");
  let buyVolume: number | null = null, sellVolume: number | null = null, tradeIntensity: number | null = null, vwap: number | null = null;
  if (input.trades !== undefined) {
    buyVolume = 0; sellVolume = 0;
    let count = 0, notional = 0;
    for (const [i, trade] of input.trades.entries()) {
      timestamp(trade.ts, input.decisionTs, `trades[${i}].ts`);
      positive(trade.price, `trades[${i}].price`);
      positive(trade.size, `trades[${i}].size`);
      if (trade.side !== "buy" && trade.side !== "sell") fail("invalid_side", `trades[${i}].side`);
      if (trade.ts > input.book.ts) fail("book_behind_flow", `trades[${i}] is newer than the selected book`);
      if (trade.ts < Math.max(input.book.ts - 60_000, input.flowWindowStartMs ?? 0)) continue;
      if (trade.side === "buy") buyVolume += trade.size; else sellVolume += trade.size;
      count++;
      notional += trade.size * trade.price;
    }
    tradeIntensity = windowSeconds === null ? null : count / windowSeconds;
    if (buyVolume + sellVolume > 0) vwap = notional / (buyVolume + sellVolume);
  } else missing.push("trade_feed");
  let cancelIntensity: number | null = null;
  if (input.cancellations !== undefined) {
    let count = 0;
    for (const [i, ts] of input.cancellations.entries()) {
      timestamp(ts, input.decisionTs, `cancellations[${i}]`);
      if (ts > input.book.ts) fail("book_behind_flow", `cancellations[${i}] is newer than the selected book`);
      if (ts >= Math.max(input.book.ts - 60_000, input.flowWindowStartMs ?? 0)) count++;
    }
    cancelIntensity = windowSeconds === null ? null : count / windowSeconds;
  } else missing.push("cancel_feed");

  const a = input.account;
  finite(a.inventory, "inventory");
  positive(a.equityUsd, "equityUsd");
  positive(a.peakEquityUsd, "peakEquityUsd");
  positive(a.dayStartEquityUsd, "dayStartEquityUsd");
  finite(a.realizedPnlUsd, "realizedPnlUsd");
  finite(a.unrealizedPnlUsd, "unrealizedPnlUsd");
  if (a.peakEquityUsd < a.equityUsd) fail("invalid_account", "peakEquityUsd is below current equity");
  if (a.positionOpenedAtMs !== null) timestamp(a.positionOpenedAtMs, input.decisionTs, "positionOpenedAtMs");
  const positionAgeMs = a.inventory === 0 ? 0 : a.positionOpenedAtMs === null ? null : input.decisionTs - a.positionOpenedAtMs;
  if (positionAgeMs === null) { reasons.push("unknown_position_age"); missing.push("position_opened_at"); }
  const grossExposureUsd = a.grossExposureUsd ?? Math.abs(a.inventory) * mid;
  nonnegative(grossExposureUsd, "grossExposureUsd");
  if (grossExposureUsd + 1e-9 < Math.abs(a.inventory) * mid) fail("invalid_account", "grossExposureUsd understates this position");
  const h = input.health;
  if (!Number.isSafeInteger(h.apiErrors) || h.apiErrors < 0) fail("invalid_health", "apiErrors");
  probability(h.fillRatio, "fillRatio");
  probability(h.rejectRate, "rejectRate");
  if (h.slippageBps !== null) finite(h.slippageBps, "slippageBps");
  for (const [i, latency] of h.latenciesMs.entries()) nonnegative(latency, `latenciesMs[${i}]`);
  if (h.fillRatio === null) missing.push("fill_ratio");
  if (h.rejectRate === null) missing.push("reject_rate");
  if (h.slippageBps === null) missing.push("slippage");
  const fresh = input.decisionTs - input.book.ts < cfg.maxDataAgeMs;
  if (!fresh) reasons.push("stale_book");

  const data: Omit<MarketSnapshot, "id"> = {
    schemaVersion: 1, sessionId: input.sessionId, symbol: input.symbol, block: input.block,
    decisionTs: input.decisionTs, bookTs: input.book.ts, horizonBlocks,
    price: { mid, microprice, returnsBps },
    book: { bid: input.book.bid, ask: input.book.ask, spreadBps: (input.book.ask - input.book.bid) / mid * 10_000, bids, asks, depthBid, depthAsk, imbalance: (depthBid - depthAsk) / (depthBid + depthAsk), queueAhead },
    flow: { windowSeconds, buyVolume, sellVolume, tradeIntensity, cancelIntensity, vwap },
    vol: { short: short.value, medium: medium.value, vs24h, samples: short.samples },
    cross: { referencePrice, divergenceBps: referencePrice === null ? null : (mid / referencePrice - 1) * 10_000, basisBps: spotPrice === null ? null : (mid / spotPrice - 1) * 10_000, fundingRate, depthVs24h },
    account: {
      inventory: a.inventory, equityUsd: a.equityUsd, peakEquityUsd: a.peakEquityUsd, dayStartEquityUsd: a.dayStartEquityUsd,
      realizedPnlUsd: a.realizedPnlUsd, unrealizedPnlUsd: a.unrealizedPnlUsd, positionOpenedAtMs: a.positionOpenedAtMs,
      grossExposureUsd, dayPnlUsd: a.equityUsd - a.dayStartEquityUsd, drawdownFraction: (a.peakEquityUsd - a.equityUsd) / a.peakEquityUsd,
      positionAgeMs, leverage: grossExposureUsd / a.equityUsd,
    },
    health: { apiErrors: h.apiErrors, fillRatio: h.fillRatio, rejectRate: h.rejectRate, slippageBps: h.slippageBps, latenciesMs: h.latenciesMs.slice(-10) },
    readiness: { ready: reasons.length === 0, fresh, warmup, reasons, missing },
  };
  // Overflow is just as unsafe as invalid source data. JSON would otherwise turn Infinity into null.
  const checkDerived = (value: unknown): void => {
    if (typeof value === "number" && !Number.isFinite(value)) fail("numeric_overflow", "derived feature");
    if (value !== null && typeof value === "object") for (const v of Object.values(value)) checkDerived(v);
  };
  checkDerived(data);
  return freeze({ ...data, id: snapshotFingerprint(data) });
}

/**
 * Numeric transport state. Ordering of tuple fields is documented in STATE_SCHEMA.
 * The byte/4 estimate is a budget signal, never the provider's billable token count.
 */
export const STATE_SCHEMA = "p=[mid,microprice,return1mBps,return5mBps,return30mBps]; b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead]; d=[bidLevels,askLevels] as [price,size]; f=[windowSeconds,buyVolume,sellVolume,tradesPerSecond,cancelsPerSecond,vwap]; v=[shortVol,mediumVol,shortVs24h,shortSamples] (log-return vol per sqrt(second)); x=[referencePrice,divergenceBps,spotBasisBps,fundingRate,depthVs24h]; a=[inventory,equityUsd,dayPnlUsd,drawdownFraction,unrealizedPnlUsd,positionAgeMs,leverage]; h=[apiErrors,fillRatio,rejectRate,slippageBps,last10LatenciesMs]. null means unavailable. ageMs is source book age. Never infer missing measurements.";

export function compactSnapshot(snapshot: MarketSnapshot, budget = 400) {
  if (!verifySnapshot(snapshot)) fail("snapshot_modified", "fingerprint mismatch");
  const round = (n: number | null) => n === null ? null : Number(n.toPrecision(6));
  const map = (values: (number | null)[]) => values.map(round);
  const s = snapshot;
  const state = {
    symbol: s.symbol, block: s.block, horizonBlocks: s.horizonBlocks, ageMs: round(s.decisionTs - s.bookTs),
    p: map([s.price.mid, s.price.microprice, s.price.returnsBps.m1, s.price.returnsBps.m5, s.price.returnsBps.m30]),
    b: map([s.book.bid, s.book.ask, s.book.spreadBps, s.book.imbalance, s.book.depthBid, s.book.depthAsk, s.book.queueAhead]),
    d: [s.book.bids.map(map), s.book.asks.map(map)],
    f: map([s.flow.windowSeconds, s.flow.buyVolume, s.flow.sellVolume, s.flow.tradeIntensity, s.flow.cancelIntensity, s.flow.vwap]),
    v: map([s.vol.short, s.vol.medium, s.vol.vs24h, s.vol.samples]),
    x: map([s.cross.referencePrice, s.cross.divergenceBps, s.cross.basisBps, s.cross.fundingRate, s.cross.depthVs24h]),
    a: map([s.account.inventory, s.account.equityUsd, s.account.dayPnlUsd, s.account.drawdownFraction, s.account.unrealizedPnlUsd, s.account.positionAgeMs, s.account.leverage]),
    h: [s.health.apiErrors, s.health.fillRatio, s.health.rejectRate, s.health.slippageBps, map(s.health.latenciesMs)],
    ready: s.readiness.ready, warm: s.readiness.warmup,
  };
  const json = JSON.stringify(state);
  const estimatedTokens = Math.ceil(new TextEncoder().encode(json).byteLength / 4);
  return { state, json, estimatedTokens, tokenEstimateMethod: "utf8_bytes_div4" as const, exceedsBudget: estimatedTokens > budget };
}
