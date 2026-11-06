import { describe, expect, test } from "bun:test";
import { DEFAULT_JEV_MODEL, DecisionError, DeterministicDecisionProvider, JEV_ENDPOINT, JevDecisionProvider, validateDecisionBattery } from "../src/engine/decisions";
import { buildSnapshot } from "../src/engine/state";

function snapshot() {
  return buildSnapshot({
    sessionId: "s", symbol: "MON-USDC", block: 1, decisionTs: 100_001,
    book: { block: 1, ts: 100_000, bid: 99, ask: 101, bids: [[99, 10]], asks: [[101, 10]] },
    trades: [], flowWindowStartMs: 99_000,
    account: { inventory: 0, equityUsd: 10_000, peakEquityUsd: 10_000, dayStartEquityUsd: 10_000, realizedPnlUsd: 0, unrealizedPnlUsd: 0, positionOpenedAtMs: null },
    health: { apiErrors: 0, fillRatio: null, rejectRate: null, slippageBps: null, latenciesMs: [] },
  }, { requireWarmup: false });
}

function response() {
  return {
    model: DEFAULT_JEV_MODEL,
    answers: {
      regime: { type: "choice", choice: "mean_reverting", confidence: 0.9, probabilities: { trending: 0.1, mean_reverting: 0.8, high_vol: 0.05, crisis: 0.05 } },
      direction: { type: "choice", choice: "up", confidence: 0.85, probabilities: { up: 0.7, down: 0.1, neutral: 0.2 } },
      toxic_flow: { type: "noul", noul: 0.1 },
      liquidity_stressed: { type: "noul", noul: 0.1 },
      quote_environment: { type: "score", score: 2.8, confidence: 0.9, legend: { "0": "Do not quote", "1": "Marginal", "2": "Standard", "3": "Excellent" }, probabilities: { "0": 0, "1": 0, "2": 0.2, "3": 0.8 } },
      inventory_pressure: { type: "score", score: 0, confidence: 0.9, legend: { "0": "None", "1": "Mild", "2": "Strong", "3": "Reduce" }, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } },
    },
    usage: { input_tokens: 456, output_tokens: 42 },
  };
}

function provider(payload: unknown, extra: Partial<ConstructorParameters<typeof JevDecisionProvider>[0]> = {}) {
  let now = 100_002;
  return new JevDecisionProvider({
    apiKey: "test-key", clock: () => now,
    fetch: (async () => { now += 5; return Response.json(payload); }) as unknown as typeof fetch,
    ...extra,
  });
}

describe("direct six-question Jev provider", () => {
  test("uses the official REST shape, pinned model, one call and billable usage", async () => {
    let calls = 0, now = 100_002;
    const p = new JevDecisionProvider({ apiKey: "test-key", clock: () => now, fetch: (async (url, init) => {
      calls++;
      expect(url).toBe(JEV_ENDPOINT);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(DEFAULT_JEV_MODEL);
      expect(Object.keys(body.questions)).toHaveLength(6);
      expect(body.questions.quote_environment.criteria).toBeArray();
      expect(body.questions.quote_environment.legend).toBeUndefined();
      expect(body.state.p[0]).toBe(100);
      now += 5;
      return Response.json(response());
    }) as typeof fetch });
    const s = snapshot(), b = await p.decide(s, { deadlineMs: 100_300 });
    expect(calls).toBe(1);
    expect(b.modelId).toBe(DEFAULT_JEV_MODEL);
    expect(b.snapshotId).toBe(s.id);
    expect(b.sessionId).toBe(s.sessionId);
    expect(b.inputTokens).toBe(456);
    expect(b.latencyMs).toBe(5);
    expect(b.calibration).toBe("unverified");
  });

  test("rejects moving model aliases and absent keys before a network request", () => {
    expect(() => new JevDecisionProvider({ apiKey: "test-key", modelId: "jev-latest" })).toThrow("unpinned_model");
    expect(() => new JevDecisionProvider({ apiKey: "" })).toThrow("missing_api_key");
  });

  test("rejects malformed answers rather than inventing confidence or repairing probabilities", async () => {
    const mutations: ((raw: any) => void)[] = [
      (r) => delete r.answers.toxic_flow,
      (r) => delete r.answers.direction.confidence,
      (r) => { r.answers.direction.confidence = null; },
      (r) => { r.answers.direction.probabilities.up = 1.5; },
      (r) => { r.answers.direction.probabilities.up = 0.1; },
      (r) => { r.answers.direction.choice = "down"; },
      (r) => { r.answers.quote_environment.score = 0.1; },
      (r) => { r.answers.toxic_flow.type = "score"; },
      (r) => { r.usage.input_tokens = -1; },
      (r) => { r.model = "jev-1.13.0"; },
    ];
    for (const mutate of mutations) {
      const raw = response(); mutate(raw);
      await expect(provider(raw).decide(snapshot())).rejects.toBeInstanceOf(DecisionError);
    }
  });

  test("deadline abort releases a hung fetch and does not retry", async () => {
    let calls = 0, aborted = false;
    const p = provider(response(), { timeoutMs: 5, fetch: ((_url, init) => {
      calls++;
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    await expect(p.decide(snapshot())).rejects.toThrow("deadline");
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });

  test("rejects a completed response whose observation time missed the block deadline", async () => {
    await expect(provider(response()).decide(snapshot(), { deadlineMs: 100_004 })).rejects.toThrow("deadline");
  });

  test("caller abort and invalid compact budget prevent unauthorized or oversized work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(provider(response()).decide(snapshot(), { signal: controller.signal })).rejects.toThrow("aborted");
    await expect(provider(response(), { maxSnapshotEstimatedTokens: 1 }).decide(snapshot())).rejects.toThrow("snapshot_budget");
  });

  test("does not expose keys or upstream bodies in errors", async () => {
    const p = provider(response(), { fetch: (async () => { throw new Error("secret-test-key"); }) as unknown as typeof fetch });
    try { await p.decide(snapshot()); throw new Error("expected failure"); } catch (error) {
      expect((error as Error).message).toBe("transport_error: TypeSafe request failed");
    }
  });

  test("deterministic baseline has explicit provenance and no claimed model confidence", async () => {
    const b = await new DeterministicDecisionProvider({ clock: () => 100_002 }).decide(snapshot());
    expect(b.source).toBe("deterministic");
    expect(b.inputTokens).toBe(0);
    expect(b.direction.confidence).toBeNull();
    expect(b.quoteEnvironment.confidence).toBeNull();
    validateDecisionBattery(b);
    const invalid = structuredClone(b); invalid.direction.confidence = 1;
    expect(() => validateDecisionBattery(invalid)).toThrow("deterministic rules must not claim");
  });
});
