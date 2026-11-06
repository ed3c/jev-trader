import { describe, expect, test } from "bun:test";
import { buildSnapshot, compactSnapshot, verifySnapshot } from "../src/engine/state";
import type { SnapshotInput } from "../src/engine/types";

function input(): SnapshotInput {
  const ts = 2_000_000;
  return {
    sessionId: "paper-session", symbol: "MON-USDC", block: 100, decisionTs: ts + 1,
    book: { block: 100, ts, bid: 99, ask: 101, bids: [[99, 30], [98, 20], [97, 10]], asks: [[101, 10], [102, 5], [103, 5]] },
    mids: Array.from({ length: 61 }, (_, i) => ({ ts: ts - (60 - i) * 1000, mid: 99 + i / 60 })),
    trades: [], flowWindowStartMs: ts - 60_000,
    account: { inventory: 0, equityUsd: 10_000, peakEquityUsd: 10_000, dayStartEquityUsd: 10_000, realizedPnlUsd: 0, unrealizedPnlUsd: 0, positionOpenedAtMs: null },
    health: { apiErrors: 0, fillRatio: null, rejectRate: null, slippageBps: null, latenciesMs: [] },
  };
}

describe("point-in-time feature engine", () => {
  test("derives microprice, top-three depth, time-window returns and volatility from observed data", () => {
    const s = buildSnapshot(input());
    expect(s.price.mid).toBe(100);
    expect(s.price.microprice).toBe(100.5);
    expect(s.book.depthBid).toBe(60);
    expect(s.book.depthAsk).toBe(20);
    expect(s.book.imbalance).toBe(0.5);
    expect(s.price.returnsBps.m1).toBeCloseTo((100 / 99 - 1) * 10_000, 8);
    expect(s.price.returnsBps.m5).toBeNull();
    expect(s.price.returnsBps.m30).toBeNull();
    expect(s.vol.short).toBeGreaterThan(0);
    expect(s.vol.samples).toBe(60);
    expect(s.readiness.ready).toBe(true);
  });

  test("does not substitute a block-count return for an unavailable clock-time window", () => {
    const i = input();
    i.mids = Array.from({ length: 101 }, (_, n) => ({ ts: i.book.ts - (100 - n) * 300, mid: 99 + n / 100 }));
    const s = buildSnapshot(i);
    expect(s.price.returnsBps.m1).toBeNull();
    expect(s.readiness.missing).toContain("return_m1");
  });

  test("rejects same-time/future observations, invalid numbers and mismatched source blocks", () => {
    const future = input(); future.mids!.push({ ts: future.decisionTs, mid: 100 });
    expect(() => buildSnapshot(future)).toThrow("future_observation");
    const nan = input(); nan.book.bids[0]![1] = NaN;
    expect(() => buildSnapshot(nan)).toThrow("invalid_number");
    const wrongBlock = input(); wrongBlock.book.block--;
    expect(() => buildSnapshot(wrongBlock)).toThrow("book_block_mismatch");
    const newer = input(); newer.decisionTs += 10; newer.mids!.push({ ts: newer.book.ts + 1, mid: 101 });
    expect(() => buildSnapshot(newer)).toThrow("book_behind_history");
  });

  test("rejects crossed, empty, unordered or inconsistent books instead of producing a quote", () => {
    const crossed = input(); crossed.book.ask = 98;
    expect(() => buildSnapshot(crossed)).toThrow("crossed_book");
    const empty = input(); empty.book.bids = [];
    expect(() => buildSnapshot(empty)).toThrow("empty_book");
    const unsorted = input(); unsorted.book.bids = [[99, 10], [100, 10]];
    expect(() => buildSnapshot(unsorted)).toThrow("unordered_book");
    const inconsistent = input(); inconsistent.book.bid = 98.5;
    expect(() => buildSnapshot(inconsistent)).toThrow("inconsistent_touch");
  });

  test("stale books and gaps fail readiness while missing optional measurements remain explicit", () => {
    const stale = input(); stale.decisionTs += 1000;
    const s = buildSnapshot(stale);
    expect(s.readiness.ready).toBe(false);
    expect(s.readiness.reasons).toContain("stale_book");
    const gappy = input(); gappy.mids = [gappy.mids![0]!, gappy.mids!.at(-1)!];
    const gap = buildSnapshot(gappy);
    expect(gap.price.returnsBps.m1).toBeNull();
    expect(gap.vol.short).toBeNull();
    expect(gap.readiness.reasons).toContain("volatility_warmup");
    expect(gap.cross.fundingRate).toBeNull();
    expect(gap.book.queueAhead).toBeNull();
    expect(gap.flow.cancelIntensity).toBeNull();
  });

  test("aggregates observed flow and keeps unmeasured rates null", () => {
    const i = input();
    i.trades = [{ ts: i.book.ts - 300, side: "buy", price: 101, size: 3 }, { ts: i.book.ts - 200, side: "sell", price: 99, size: 1 }];
    i.cancellations = [i.book.ts - 500, i.book.ts - 400];
    const s = buildSnapshot(i);
    expect(s.flow.buyVolume).toBe(3);
    expect(s.flow.sellVolume).toBe(1);
    expect(s.flow.vwap).toBe(100.5);
    expect(s.flow.tradeIntensity).toBeCloseTo(2 / 60);
    expect(s.flow.cancelIntensity).toBeCloseTo(2 / 60);
    delete i.flowWindowStartMs;
    expect(buildSnapshot(i).flow.tradeIntensity).toBeNull();
    delete i.trades;
    expect(buildSnapshot(i).flow.buyVolume).toBeNull();
  });

  test("computes separate cross-venue divergence and spot basis only when fresh sources exist", () => {
    const i = input();
    i.referencePrice = { ts: i.book.ts - 20, value: 99.5 };
    i.spotPrice = { ts: i.book.ts - 20, value: 99 };
    i.fundingRate = { ts: i.book.ts - 20, value: -0.0001 };
    const s = buildSnapshot(i);
    expect(s.cross.divergenceBps).toBeCloseTo((100 / 99.5 - 1) * 10_000);
    expect(s.cross.basisBps).toBeCloseTo((100 / 99 - 1) * 10_000);
    expect(s.cross.fundingRate).toBe(-0.0001);
    i.referencePrice.ts -= 20_000;
    const stale = buildSnapshot(i);
    expect(stale.cross.referencePrice).toBeNull();
    expect(stale.readiness.missing).toContain("reference_price_stale");
  });

  test("unknown inventory age blocks trading and underreported exposure is rejected", () => {
    const i = input(); i.account.inventory = 3;
    expect(buildSnapshot(i).readiness.reasons).toContain("unknown_position_age");
    i.account.positionOpenedAtMs = i.book.ts - 1000;
    i.account.grossExposureUsd = 1;
    expect(() => buildSnapshot(i)).toThrow("grossExposureUsd understates");
  });

  test("fingerprints bind immutable data and survive property-order changes", () => {
    const s = buildSnapshot(input());
    expect(verifySnapshot(s)).toBe(true);
    expect(Object.isFrozen(s.account)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as unknown as typeof s;
    expect(verifySnapshot(reordered)).toBe(true);
    const changed = structuredClone(s); changed.account.inventory = 1;
    expect(verifySnapshot(changed)).toBe(false);
  });

  test("reports compact-state token estimates separately from provider usage", () => {
    const s = buildSnapshot(input()), compact = compactSnapshot(s);
    expect(compact.estimatedTokens).toBeLessThan(400);
    expect(compact.tokenEstimateMethod).toBe("utf8_bytes_div4");
    expect(compact.exceedsBudget).toBe(false);
    expect(compactSnapshot(s, 1).exceedsBudget).toBe(true);
  });
});
