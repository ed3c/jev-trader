import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { DeterministicDecisionProvider } from "../src/engine/decisions";
import { Journal } from "../src/engine/journal";
import { PaperVenue } from "../src/execution/paper";
import type { ExecutionFill, ExecutionUpdate } from "../src/execution/types";
import { Trader } from "../src/trader";

function fixture(journal = new Journal(":memory:")) {
  const venue = new PaperVenue(async () => { throw new Error("No market read expected"); }, 0.01, 1, 1, 0, 0);
  const trader = new Trader(venue, new DeterministicDecisionProvider(), { config: loadConfig({}), journal, sourceLabel: "synthetic" });
  const update: ExecutionUpdate = {
    operationId: "cost-test", block: 1, status: "unknown", txHash: "0xreceipt", orders: [], canceledIds: [], gasMon: 2, gasUsd: 0.04,
    reason: "receipt_effects_mismatch", intent: { operationId: "cost-test", sessionId: trader.sessionId, snapshotId: "s", block: 1,
      createdAtMs: 1, deadlineMs: 100, orders: [], cancelIds: [], postOnly: true, reduceOnly: false },
  };
  // Drive the adapter update boundary directly, including a receipt with unresolved effects.
  const apply = (value: ExecutionUpdate) => (trader as unknown as { applyUpdate(value: ExecutionUpdate): void }).applyUpdate(value);
  const applyFill = (value: ExecutionFill) => (trader as unknown as { applyFill(value: ExecutionFill): void }).applyFill(value);
  return { journal, trader, update, apply, applyFill };
}

interface FeeAccount {
  position: number; costUsd: number; openEntryFeesUsd: number; consecutiveLosses: number;
  totals: { fills: number; realizedUsd: number; feesUsd: number };
}
function account(journal: Journal) { return journal.load<FeeAccount>("engine")!; }
function trade(id: string, side: "buy" | "sell", size: number, price: number, feeUsd: number, baseAdjustment?: number): ExecutionFill {
  return { id, orderId: id, side, size, price, feeUsd, baseAdjustment, block: 1, ts: 1, simulated: true, txHash: null };
}

test("known receipt fees are charged while effects remain unresolved and never twice", () => {
  const { journal, trader, update, apply } = fixture();
  apply(update);
  expect(trader.status().totals.gasMon).toBe(2);
  expect(trader.status().totals.gasUsd).toBe(0.04);
  expect(trader.status().pending).toHaveLength(1);
  apply(update);
  apply({ ...update, status: "confirmed", reason: undefined, gasUsd: 0.06 });
  expect(trader.status().totals.gasMon).toBe(2);
  expect(trader.status().totals.gasUsd).toBe(0.04);
  expect(trader.status().pending).toHaveLength(0);
  expect(journal.records().filter(row => row.kind === "execution_cost")).toHaveLength(1);
  journal.close();
});

test("contradictory cost identities fail closed instead of silently changing the ledger", () => {
  const { journal, trader, update, apply } = fixture();
  apply(update);
  expect(() => apply({ ...update, status: "confirmed", gasMon: 3 })).toThrow("Conflicting execution cost");
  expect(journal.failed).toBe(true);
  expect(trader.status().accountingVerified).toBe(false);
  journal.close();
});

test("receipt effects and immediate fills roll back together if a later fill is invalid", () => {
  const { journal, trader, update, apply } = fixture();
  apply({ ...update, status: "prepared", gasMon: 0, gasUsd: 0 });
  const before = journal.load<{ pending: ExecutionUpdate[]; totals: { gasMon: number } }>("engine")!;
  const fill = { id: "receipt-fill", orderId: "taker:receipt", side: "buy" as const, price: 1, size: 2,
    block: 1, ts: 1, feeUsd: 0, simulated: true, txHash: null };
  expect(() => apply({ ...update, status: "confirmed", fills: [fill, { ...fill, id: "invalid", size: Number.NaN }] })).toThrow("Invalid fill");
  const after = journal.load<typeof before>("engine")!;
  expect(after.pending).toEqual(before.pending);
  expect(after.totals.gasMon).toBe(before.totals.gasMon);
  expect(journal.records().filter(row => row.kind === "fill")).toHaveLength(0);
  expect(trader.status().accountingVerified).toBe(false);
  journal.close();
});

test("a base rebate changes inventory without consuming extra gross order size or double-counting PnL", () => {
  const { journal, trader } = fixture();
  const applyFill = (value: unknown) => (trader as unknown as { applyFill(value: unknown): void }).applyFill(value);
  const fill = { id: "buy", orderId: "bid", side: "buy", price: 100, size: 10,
    block: 1, ts: 1, feeUsd: 0, simulated: false, txHash: "0xfill" };
  applyFill(fill);
  applyFill({ ...fill, id: "sell", orderId: "ask", side: "sell", price: 110, feeUsd: -1.1, baseAdjustment: 0.01 });
  const state = journal.load<{ position: number; costUsd: number; filledSizes: Record<string, number>;
    bankrollUsd: number; totals: { realizedUsd: number; feesUsd: number } }>("engine")!;
  expect(state.position).toBeCloseTo(0.01);
  expect(state.costUsd).toBeCloseTo(1.1);
  expect(state.filledSizes.ask).toBe(10);
  expect(state.totals.realizedUsd).toBe(100);
  expect(state.totals.feesUsd).toBe(-1.1);
  expect(state.bankrollUsd - state.costUsd + state.totals.realizedUsd - state.totals.feesUsd).toBeCloseTo(10100);
  journal.close();
});

test("three net losses latch the kill even when every closing fill has a gross gain", () => {
  const { journal, trader, applyFill } = fixture();
  for (let cycle = 0; cycle < 3; cycle++) {
    applyFill(trade(`entry-${cycle}`, "buy", 1, 100, 0.2));
    expect(account(journal).consecutiveLosses).toBe(cycle);
    applyFill(trade(`exit-${cycle}`, "sell", 1, 100.1, 0.2));
    expect(account(journal).consecutiveLosses).toBe(cycle + 1);
    expect(account(journal).openEntryFeesUsd).toBe(0);
  }
  expect(trader.killed).toBe("three_consecutive_losses");
  expect(trader.status().position).toBe(0);
  expect(trader.status().totals.realizedUsd).toBeCloseTo(0.3);
  expect(trader.status().totals.feesUsd).toBeCloseTo(1.2);
  expect(trader.status().totals.pnlUsd).toBeCloseTo(-0.9);
  journal.close();
});

test.each(["entry", "exit"] as const)("a signed %s rebate turns a gross loss into a net win and resets the streak", rebateAt => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("loss-entry", "buy", 1, 100, 0.2));
  applyFill(trade("loss-exit", "sell", 1, 100.1, 0.2));
  expect(account(journal).consecutiveLosses).toBe(1);
  applyFill(trade("rebate-entry", "buy", 1, 100, rebateAt === "entry" ? -0.2 : 0));
  applyFill(trade("rebate-exit", "sell", 1, 99.9, rebateAt === "exit" ? -0.2 : 0));
  expect(account(journal).consecutiveLosses).toBe(0);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(trader.killed).toBeNull();
  expect(trader.status().totals.pnlUsd).toBeCloseTo(-0.2);
  journal.close();
});

test("partial closes consume entry fees proportionally once", () => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("entry", "buy", 3, 100, 1.5));
  applyFill(trade("partial-loss-1", "sell", 1, 100.25, 0.05));
  expect(account(journal).openEntryFeesUsd).toBe(1);
  expect(account(journal).consecutiveLosses).toBe(1);
  applyFill(trade("partial-win", "sell", 1, 100.75, 0.05));
  expect(account(journal).openEntryFeesUsd).toBe(0.5);
  expect(account(journal).consecutiveLosses).toBe(0);
  applyFill(trade("partial-loss-2", "sell", 1, 100.25, 0.05));
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(1);
  expect(trader.status().totals.realizedUsd).toBe(1.25);
  expect(trader.status().totals.feesUsd).toBeCloseTo(1.65);
  expect(trader.status().totals.pnlUsd).toBeCloseTo(-0.4);
  journal.close();
});

test("increasing inventory combines entry fee carry before later partial closes", () => {
  const { journal, applyFill } = fixture();
  applyFill(trade("entry-1", "buy", 1, 100, 0.2));
  applyFill(trade("entry-2", "buy", 2, 100, 0.4));
  expect(account(journal).openEntryFeesUsd).toBeCloseTo(0.6);
  applyFill(trade("exit-1", "sell", 1, 100.1, 0));
  expect(account(journal).openEntryFeesUsd).toBeCloseTo(0.4);
  expect(account(journal).consecutiveLosses).toBe(1);
  applyFill(trade("exit-2", "sell", 2, 100.3, 0));
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(0);
  journal.close();
});

test("entry fee carry and net loss streak survive durable restart and duplicate replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-fee-carry-"));
  const path = join(directory, "engine.sqlite");
  let active: Journal | null = new Journal(path);
  try {
    let run = fixture(active);
    const entry = trade("entry", "buy", 2, 100, 0.4);
    const partial = trade("partial", "sell", 1, 100.1, 0.1);
    run.applyFill(entry); run.applyFill(partial);
    expect(account(active).openEntryFeesUsd).toBe(0.2);
    expect(account(active).consecutiveLosses).toBe(1);
    active.close(); active = new Journal(path); run = fixture(active);
    expect(account(active).openEntryFeesUsd).toBe(0.2);
    run.applyFill({ ...entry, ts: 2 }); run.applyFill({ ...partial, ts: 2 });
    expect(account(active).openEntryFeesUsd).toBe(0.2);
    expect(account(active).consecutiveLosses).toBe(1);
    expect(account(active).totals.fills).toBe(2);
    expect(account(active).totals.feesUsd).toBe(0.5);
    run.applyFill(trade("remaining", "sell", 1, 100.1, 0.1));
    expect(account(active).openEntryFeesUsd).toBe(0);
    expect(account(active).consecutiveLosses).toBe(2);
    run.applyFill(trade("last-entry", "buy", 1, 100, 0.2));
    run.applyFill(trade("last-exit", "sell", 1, 100.1, 0.1));
    expect(run.trader.killed).toBe("three_consecutive_losses");
    active.close(); active = new Journal(path); run = fixture(active);
    expect(run.trader.killed).toBe("three_consecutive_losses");
    expect(account(active).consecutiveLosses).toBe(3);
    expect(account(active).openEntryFeesUsd).toBe(0);
    expect(run.trader.status().totals.feesUsd).toBeCloseTo(0.9);
  } finally {
    active?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("closing the net quantity after a base entry fee allocates that fee exactly once", () => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("base-fee-entry", "buy", 10, 100, 25, -0.25));
  expect(account(journal).position).toBe(9.75);
  expect(account(journal).costUsd).toBe(975);
  expect(account(journal).openEntryFeesUsd).toBe(25);
  applyFill(trade("net-size-exit", "sell", 9.75, 102, 0));
  expect(account(journal).position).toBe(0);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(1);
  expect(trader.status().totals.realizedUsd).toBe(19.5);
  expect(trader.status().totals.feesUsd).toBe(25);
  expect(trader.status().totals.pnlUsd).toBe(-5.5);
  journal.close();
});

test("a base exit rebate belongs to the close and its residual inventory carries no fee twice", () => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("entry", "buy", 1, 100.25, 0));
  applyFill(trade("rebated-exit", "sell", 1, 100, -0.5, 0.005));
  expect(account(journal).position).toBe(0.005);
  expect(account(journal).costUsd).toBe(0.5);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(0);
  applyFill(trade("rebate-disposal", "sell", 0.005, 100, 0));
  expect(account(journal).position).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(0);
  expect(trader.status().totals.realizedUsd).toBe(-0.25);
  expect(trader.status().totals.feesUsd).toBe(-0.5);
  expect(trader.status().totals.pnlUsd).toBe(0.25);
  journal.close();
});

test("a reversing fill divides its fee between the closing and new opening portions", () => {
  const { journal, trader, applyFill } = fixture();
  // Exercise the ledger's reversal branch directly; the spot order risk gate prevents unbacked sells.
  applyFill(trade("entry", "buy", 1, 100, 0.3));
  applyFill(trade("reverse", "sell", 2, 100.25, 0.2));
  expect(account(journal).position).toBe(-1);
  expect(account(journal).openEntryFeesUsd).toBe(0.1);
  expect(account(journal).consecutiveLosses).toBe(1);
  applyFill(trade("close-short", "buy", 1, 100.2, 0));
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(2);
  expect(trader.status().totals.pnlUsd).toBeCloseTo(-0.2);
  journal.close();
});

test("an exact-flat base adjustment realizes all fee carry from a gross reversal", () => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("short-entry", "sell", 1, 100, 1));
  applyFill(trade("gross-reversal-net-close", "buy", 1.25, 80, 20, -0.25));
  expect(account(journal).position).toBe(0);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(1);
  expect(trader.status().totals.realizedUsd).toBe(20);
  expect(trader.status().totals.feesUsd).toBe(21);
  expect(trader.status().totals.pnlUsd).toBe(-1);
  journal.close();
});

test("an entry fully consumed by a rounded base fee is a realized loss with no carry", () => {
  const { journal, trader, applyFill } = fixture();
  applyFill(trade("fee-consumed-entry", "buy", 1, 100, 100, -1));
  expect(account(journal).position).toBe(0);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(1);
  expect(trader.status().totals.pnlUsd).toBe(-100);
  journal.close();
});

test("entry fee carry remains attached to real inventory dust until the exact close", () => {
  const { journal, applyFill } = fixture();
  applyFill(trade("entry", "buy", 1, 100, 0.2));
  applyFill(trade("partial", "sell", 0.999, 100, 0));
  expect(account(journal).position).toBeGreaterThan(0);
  expect(account(journal).openEntryFeesUsd).toBeCloseTo(0.0002, 12);
  applyFill(trade("dust-close", "sell", account(journal).position, 100, 0));
  expect(account(journal).position).toBe(0);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(2);
  journal.close();
});

test("legacy open inventory without entry fee carry requires explicit checkpoint migration", () => {
  const { journal, applyFill } = fixture();
  applyFill(trade("entry", "buy", 1, 100, 0.2));
  const legacy = journal.load<Record<string, unknown>>("engine")!;
  delete legacy.openEntryFeesUsd; journal.save("engine", legacy);
  expect(() => fixture(journal)).toThrow("Checkpoint entry fee carry is missing for open inventory");
  expect(journal.load<Record<string, unknown>>("engine")!.openEntryFeesUsd).toBeUndefined();
  journal.close();
});

test("legacy flat inventory can initialize zero fee carry while preserving its history", () => {
  const { journal, applyFill } = fixture();
  applyFill(trade("entry", "buy", 1, 100, 0.2));
  applyFill(trade("exit", "sell", 1, 100.1, 0.2));
  const legacy = journal.load<Record<string, unknown>>("engine")!;
  delete legacy.openEntryFeesUsd; journal.save("engine", legacy);
  const restarted = fixture(journal);
  expect(account(journal).openEntryFeesUsd).toBe(0);
  expect(account(journal).consecutiveLosses).toBe(1);
  expect(restarted.trader.status().totals.feesUsd).toBe(0.4);
  expect(restarted.trader.status().totals.pnlUsd).toBeCloseTo(-0.3);
  journal.close();
});

for (const [label, carry] of [["null", null], ["positive", 0.1], ["negative", -0.1]] as const) {
  test(`${label} unallocated flat checkpoint fee carry fails closed`, () => {
    const { journal } = fixture();
    const saved = journal.load<Record<string, unknown>>("engine")!;
    saved.openEntryFeesUsd = carry; journal.save("engine", saved);
    expect(() => fixture(journal)).toThrow("Invalid checkpoint entry fee carry");
    journal.close();
  });
}
