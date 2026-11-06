import { compactSnapshot, verifySnapshot } from "./state";
import type { ChoiceAnswer, DecisionBattery, DecisionOptions, DecisionProvider, Direction, MarketSnapshot, Regime, ScoreAnswer } from "./types";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Version documented by the provider on 2026-11-06. Changes require explicit re-evaluation. */
export const DEFAULT_JEV_MODEL = "jev-1.14.0";

// Each question is independent. No question refers to an answer from another question.
export const JEV_QUESTIONS = {
  regime: {
    type: "choice",
    instructions: {
      task: "Which market regime best describes these observed data? Missing fields are unknown.",
      fields: "p=[mid,microprice,returns1mBps,5mBps,30mBps]; v=[shortVol,mediumVol,shortVs24h,samples] in log-return/sqrt(second); b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead]; f=[windowSeconds,buyVolume,sellVolume,tradesPerSecond,cancelsPerSecond,vwap].",
    },
    criteria: { trending: "Persistent directional movement", mean_reverting: "Reversion around a local center", high_vol: "Elevated irregular volatility", crisis: "Dislocated or severely impaired trading" },
  },
  direction: {
    type: "choice",
    instructions: {
      task: "Predict mid-price direction over horizonBlocks, allowing a neutral outcome. This judgment does not authorize an order.",
      fields: "p=[mid,microprice,returns1mBps,5mBps,30mBps]; b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead]; f=[windowSeconds,buyVolume,sellVolume,tradesPerSecond,cancelsPerSecond,vwap]; x=[referencePrice,divergenceBps,spotBasisBps,fundingRate,depthVs24h]. null is unknown.",
    },
    criteria: { up: "Mid rises by more than the current half spread", down: "Mid falls by more than the current half spread", neutral: "Neither meaningful directional move" },
  },
  toxic_flow: {
    type: "noul",
    instructions: {
      task: "Is aggressive flow likely informed, exposing a passive maker to adverse selection? Missing flow evidence is unknown, not proof of safety.",
      fields: "f=[windowSeconds,buyVolume,sellVolume,tradesPerSecond,cancelsPerSecond,vwap]; p=[mid,microprice,returns1mBps,5mBps,30mBps]; b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead].",
    },
  },
  liquidity_stressed: {
    type: "noul",
    instructions: {
      task: "Is observed liquidity stressed? Judge only available evidence; a missing 24h comparison is not evidence of normal depth.",
      fields: "b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead]; d=[bidLevels,askLevels] as [price,size]; x=[referencePrice,divergenceBps,spotBasisBps,fundingRate,depthVs24h]; f=[windowSeconds,buyVolume,sellVolume,tradesPerSecond,cancelsPerSecond,vwap].",
    },
  },
  quote_environment: {
    type: "score",
    instructions: {
      task: "How favorable is this observed market for passive post-only liquidity provision? Do not assume profitable fills, gas costs or unknown measurements.",
      fields: "b=[bid,ask,spreadBps,imbalance,bidDepth3,askDepth3,queueAhead]; v=[shortVol,mediumVol,shortVs24h,samples] per sqrt(second); h=[apiErrors,fillRatio,rejectRate,slippageBps,last10LatenciesMs]. null is unknown.",
    },
    // Current REST schema uses an ordered criteria array. `legend` is a response field.
    criteria: ["Do not quote", "Marginal; only conservative small wide quotes", "Standard quoting environment", "Excellent quoting environment"],
  },
  inventory_pressure: {
    type: "score",
    instructions: {
      task: "How urgently should the existing inventory be reduced, given the observed exposure and aging? Code owns absolute position and loss limits.",
      fields: "a=[inventory,equityUsd,dayPnlUsd,drawdownFraction,unrealizedPnlUsd,positionAgeMs,leverage]; p=[mid,microprice,returns1mBps,5mBps,30mBps]; v=[shortVol,mediumVol,shortVs24h,samples]. null is unknown.",
    },
    criteria: ["No reduction urgency", "Mild inventory skew", "Strong skew to reduce inventory", "Reduce inventory now"],
  },
} as const;

export class DecisionError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DecisionError";
  }
}
const bad = (message: string): never => { throw new DecisionError("invalid_response", message); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const obj = (value: unknown, name: string) => isObject(value) ? value : bad(`${name} must be an object`);
const finite = (value: unknown, name: string): number => typeof value === "number" && Number.isFinite(value) ? value : bad(`${name} must be finite`);
const prob = (value: unknown, name: string) => {
  const n = finite(value, name);
  return n >= 0 && n <= 1 ? n : bad(`${name} must be in [0,1]`);
};
const tokenCount = (value: unknown, name: string) => {
  const n = finite(value, name);
  return Number.isSafeInteger(n) && n >= 0 ? n : bad(`${name} must be a nonnegative integer`);
};
const confidence = (value: unknown, name: string, allowNull: boolean) => value === null && allowNull ? null : prob(value, name);

function distribution<T extends string>(value: unknown, keys: readonly T[], name: string): Record<T, number> {
  const raw = obj(value, name), expected = new Set<string>(keys);
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((k) => !expected.has(k))) bad(`${name} has unexpected or missing choices`);
  let sum = 0;
  const result = {} as Record<T, number>;
  for (const key of keys) { result[key] = prob(raw[key], `${name}.${key}`); sum += result[key]; }
  // The provider documents approximate normalization. Do not quietly repair larger errors.
  if (Math.abs(sum - 1) > 0.001) bad(`${name} does not sum to one`);
  return result;
}

const REGIMES = ["trending", "mean_reverting", "high_vol", "crisis"] as const;
const DIRECTIONS = ["up", "down", "neutral"] as const;
const SCORES = ["0", "1", "2", "3"] as const;

function choice<T extends string>(rawValue: unknown, keys: readonly T[], name: string, allowNull = false): ChoiceAnswer<T> {
  const raw = obj(rawValue, name);
  if (typeof raw.choice !== "string" || !keys.includes(raw.choice as T)) bad(`${name}.choice is unknown`);
  const probabilities = distribution(raw.probabilities, keys, `${name}.probabilities`);
  const selected = raw.choice as T;
  if (probabilities[selected] + 0.001 < Math.max(...Object.values<number>(probabilities))) bad(`${name}.choice is not a most-probable option`);
  return { choice: selected, probabilities, confidence: confidence(raw.confidence, `${name}.confidence`, allowNull) };
}

function score(rawValue: unknown, name: string, allowNull = false): ScoreAnswer {
  const raw = obj(rawValue, name), probabilities = distribution(raw.probabilities, SCORES, `${name}.probabilities`);
  const value = finite(raw.score, `${name}.score`);
  const expected = SCORES.reduce((sum, level) => sum + Number(level) * probabilities[level], 0);
  if (value < 0 || value > 3 || Math.abs(value - expected) > 0.02) bad(`${name}.score contradicts its distribution`);
  return { score: value, probabilities, confidence: confidence(raw.confidence, `${name}.confidence`, allowNull) };
}

function requiredAnswer(raw: Record<string, unknown>, key: string, type: string) {
  const value = obj(raw[key], `answers.${key}`);
  if (value.type !== type) bad(`answers.${key}.type must be ${type}`);
  return value;
}

/** Validate recorded baselines as strictly as live decisions; no metadata or probability repair. */
export function validateDecisionBattery(value: unknown): asserts value is DecisionBattery {
  const b = obj(value, "battery");
  if (!["jev", "llm", "deterministic"].includes(String(b.source))) bad("battery.source");
  if (typeof b.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshotId)) bad("battery.snapshotId");
  for (const key of ["sessionId", "modelId"] as const) if (typeof b[key] !== "string" || !(b[key] as string).trim()) bad(`battery.${key}`);
  const requested = finite(b.requestedAtMs, "requestedAtMs"), decided = finite(b.decidedAtMs, "decidedAtMs"), expiry = finite(b.validUntilMs, "validUntilMs");
  const latency = finite(b.latencyMs, "latencyMs");
  if (requested < 0 || decided < requested || expiry <= requested || latency < 0 || Math.abs(decided - requested - latency) > 1) bad("battery timing is inconsistent");
  tokenCount(b.inputTokens, "inputTokens"); tokenCount(b.outputTokens, "outputTokens");
  if (b.calibration !== "unverified") bad("raw battery cannot claim venue calibration");
  const allowNull = b.source === "deterministic";
  choice(b.regime, REGIMES, "regime", allowNull);
  choice(b.direction, DIRECTIONS, "direction", allowNull);
  score(b.quoteEnvironment, "quoteEnvironment", allowNull);
  score(b.inventoryPressure, "inventoryPressure", allowNull);
  prob(b.toxicFlow, "toxicFlow"); prob(b.liquidityStressed, "liquidityStressed");
  if (allowNull) {
    for (const key of ["regime", "direction", "quoteEnvironment", "inventoryPressure"] as const) {
      if (obj(b[key], key).confidence !== null) bad("deterministic rules must not claim model confidence");
    }
  }
}

export interface JevDecisionProviderOptions {
  /** Reads TYPESAFE_API_KEY, then the legacy TYPESAFE_AI_API_KEY alias if omitted. */
  apiKey?: string;
  modelId?: string;
  timeoutMs?: number;
  maxSnapshotEstimatedTokens?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

/** Direct REST, a single six-question request, no retries on the block's critical path. */
export class JevDecisionProvider implements DecisionProvider {
  readonly name: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly maxSnapshotEstimatedTokens: number;
  private readonly request: typeof globalThis.fetch;
  private readonly clock: () => number;

  constructor(options: JevDecisionProviderOptions = {}) {
    this.name = options.modelId ?? DEFAULT_JEV_MODEL;
    if (!/^jev-\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(this.name)) throw new DecisionError("unpinned_model", "Use an explicit versioned Jev model ID, not a moving alias");
    this.key = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_API_KEY ?? "";
    if (!this.key.trim() || /\s/.test(this.key)) throw new DecisionError("missing_api_key", "Set TYPESAFE_API_KEY");
    this.timeoutMs = options.timeoutMs ?? 250;
    this.maxSnapshotEstimatedTokens = options.maxSnapshotEstimatedTokens ?? 400;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new DecisionError("invalid_config", "timeoutMs must be positive");
    if (!Number.isSafeInteger(this.maxSnapshotEstimatedTokens) || this.maxSnapshotEstimatedTokens <= 0) throw new DecisionError("invalid_config", "maxSnapshotEstimatedTokens must be a positive integer");
    this.request = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? (() => performance.timeOrigin + performance.now());
  }

  async decide(snapshot: MarketSnapshot, options: DecisionOptions = {}): Promise<DecisionBattery> {
    if (!snapshot.readiness.ready) throw new DecisionError("snapshot_not_ready", snapshot.readiness.reasons.join(","));
    const compact = compactSnapshot(snapshot, this.maxSnapshotEstimatedTokens);
    if (compact.exceedsBudget) throw new DecisionError("snapshot_budget", `${compact.estimatedTokens} estimated state tokens exceed configured budget`);
    const requestedAtMs = this.clock();
    if (requestedAtMs < snapshot.decisionTs) throw new DecisionError("future_snapshot", "snapshot is newer than the request clock");
    const validUntilMs = Math.min(requestedAtMs + this.timeoutMs, options.deadlineMs ?? Infinity);
    if (!Number.isFinite(validUntilMs) || validUntilMs <= requestedAtMs) throw new DecisionError("deadline", "block deadline already passed");
    if (options.signal?.aborted) throw new DecisionError("aborted", "request was canceled before it started");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = (code: "aborted" | "deadline") => {
      const error = new DecisionError(code, code === "deadline" ? "decision missed its deadline" : "decision was canceled");
      controller.abort(error);
      rejectAbort?.(error);
    };
    const onAbort = () => abort("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => abort("deadline"), Math.max(1, Math.ceil(validUntilMs - requestedAtMs)));
    try {
      const operation = (async () => {
        const response = await this.request(JEV_ENDPOINT, {
          method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ model: this.name, state: compact.state, questions: JEV_QUESTIONS }),
        });
        // Do not include upstream response bodies, headers or credentials in operational errors.
        if (!response.ok) throw new DecisionError("http_error", `TypeSafe returned HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const raw = obj(payload, "response");
        if (raw.model !== this.name) throw new DecisionError("model_mismatch", "response model differs from the pinned model");
        const answers = obj(raw.answers, "answers"), usage = obj(raw.usage, "usage");
        if (Object.keys(answers).length !== 6 || Object.keys(answers).some((key) => !(key in JEV_QUESTIONS))) bad("expected exactly the requested six answers");
        const decidedAtMs = this.clock();
        if (decidedAtMs >= validUntilMs) throw new DecisionError("deadline", "decision arrived after its deadline");
        const battery: DecisionBattery = {
          snapshotId: snapshot.id, sessionId: snapshot.sessionId, source: "jev", modelId: this.name,
          requestedAtMs, decidedAtMs, validUntilMs, latencyMs: decidedAtMs - requestedAtMs,
          inputTokens: tokenCount(usage.input_tokens, "usage.input_tokens"), outputTokens: tokenCount(usage.output_tokens, "usage.output_tokens"), calibration: "unverified",
          regime: choice(requiredAnswer(answers, "regime", "choice"), REGIMES, "regime"),
          direction: choice(requiredAnswer(answers, "direction", "choice"), DIRECTIONS, "direction"),
          toxicFlow: prob(requiredAnswer(answers, "toxic_flow", "noul").noul, "toxic_flow.noul"),
          liquidityStressed: prob(requiredAnswer(answers, "liquidity_stressed", "noul").noul, "liquidity_stressed.noul"),
          quoteEnvironment: score(requiredAnswer(answers, "quote_environment", "score"), "quote_environment"),
          inventoryPressure: score(requiredAnswer(answers, "inventory_pressure", "score"), "inventory_pressure"),
        };
        validateDecisionBattery(battery);
        return battery;
      })();
      return await Promise.race([operation, abortPromise]);
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new DecisionError("transport_error", "TypeSafe request failed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Explicit rule baseline, not a calibrated Jev simulation. No API key or network is used. */
export class DeterministicDecisionProvider implements DecisionProvider {
  readonly name = "deterministic-v1";
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  constructor(options: { clock?: () => number; timeoutMs?: number } = {}) {
    this.clock = options.clock ?? (() => performance.timeOrigin + performance.now());
    this.timeoutMs = options.timeoutMs ?? 250;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new DecisionError("invalid_config", "timeoutMs must be positive");
  }
  async decide(snapshot: MarketSnapshot, options: DecisionOptions = {}): Promise<DecisionBattery> {
    if (options.signal?.aborted) throw new DecisionError("aborted", "request was canceled");
    if (!verifySnapshot(snapshot)) throw new DecisionError("snapshot_modified", "fingerprint mismatch");
    if (!snapshot.readiness.ready) throw new DecisionError("snapshot_not_ready", snapshot.readiness.reasons.join(","));
    const requestedAtMs = this.clock();
    if (requestedAtMs < snapshot.decisionTs) throw new DecisionError("future_snapshot", "snapshot is newer than the request clock");
    const validUntilMs = Math.min(requestedAtMs + this.timeoutMs, options.deadlineMs ?? Infinity);
    if (validUntilMs <= requestedAtMs) throw new DecisionError("deadline", "block deadline already passed");
    const s = snapshot;
    const ret = s.price.returnsBps.m1 ?? 0;
    const volume = (s.flow.buyVolume ?? 0) + (s.flow.sellVolume ?? 0);
    const flow = volume > 0 ? ((s.flow.buyVolume ?? 0) - (s.flow.sellVolume ?? 0)) / volume : 0;
    const directionalSignal = ret / 10 + s.book.imbalance + flow;
    const direction: Direction = directionalSignal > 0.5 ? "up" : directionalSignal < -0.5 ? "down" : "neutral";
    const regime: Regime = (s.vol.vs24h ?? 0) > 3 ? "high_vol" : Math.abs(ret) > 10 ? "trending" : "mean_reverting";
    const missingFlow = s.flow.buyVolume === null || s.flow.sellVolume === null;
    const toxicFlow = missingFlow ? 0.5 : Math.min(1, Math.abs(flow) * 0.8);
    const liquidityStressed = s.cross.depthVs24h === null ? 0.5 : s.cross.depthVs24h < 0.4 ? 1 : 0;
    const quoteScore = toxicFlow >= 0.6 || liquidityStressed >= 0.7 ? 0 : 1;
    const inventoryScore = s.account.leverage > 0.8 ? 3 : s.account.leverage > 0.5 ? 2 : s.account.inventory !== 0 ? 1 : 0;
    const dist = <T extends string>(keys: readonly T[], selected: T) => Object.fromEntries(keys.map((k) => [k, k === selected ? 1 : 0])) as Record<T, number>;
    const rubric = (value: number): ScoreAnswer => ({ score: value, confidence: null, probabilities: dist(SCORES, String(value) as typeof SCORES[number]) });
    const decidedAtMs = this.clock();
    if (decidedAtMs >= validUntilMs) throw new DecisionError("deadline", "rule decision missed deadline");
    const battery: DecisionBattery = {
      snapshotId: s.id, sessionId: s.sessionId, source: "deterministic", modelId: this.name, requestedAtMs, decidedAtMs, validUntilMs,
      latencyMs: decidedAtMs - requestedAtMs, inputTokens: 0, outputTokens: 0, calibration: "unverified",
      regime: { choice: regime, confidence: null, probabilities: dist(REGIMES, regime) },
      direction: { choice: direction, confidence: null, probabilities: dist(DIRECTIONS, direction) },
      toxicFlow, liquidityStressed, quoteEnvironment: rubric(quoteScore), inventoryPressure: rubric(inventoryScore),
    };
    validateDecisionBattery(battery);
    return battery;
  }
}
