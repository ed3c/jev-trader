import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidence, hash } from "../src/desk/evidence";
import { syntheticDeskCase } from "../src/desk/fixtures";
import { DeskJournal } from "../src/desk/journal";
import { assessDeskRisk } from "../src/desk/risk";
import { DeskWorkflow } from "../src/desk/workflow";
import { DEFAULT_DESK_RULES } from "../src/desk/types";
import type { BracketRequest, BrokerOrder, CaseState, DeskBroker, DeskCase, EmergencyResult, Evidence, RiskSnapshot } from "../src/desk/types";
import { LocalPaperBroker } from "../src/integrations/paper-broker";

const START = Date.parse("2026-11-06T15:00:00Z");
const journals: DeskJournal[] = [], temporaryDirectories: string[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) { try { journal.close(); } catch { /* Already closed to simulate restart. */ } }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function journal(path = ":memory:"): DeskJournal { const value = new DeskJournal(path); journals.push(value); return value; }
function temporaryJournal(): string { const directory = mkdtempSync(join(tmpdir(), "jev-desk-workflow-")); temporaryDirectories.push(directory); return join(directory, "journal.sqlite"); }
function withPayload<T>(previous: Evidence<T>, payload: T, observedAt = previous.observedAt, receivedAt = previous.receivedAt): Evidence<T> {
  return evidence({ source: previous.source, provenance: previous.provenance, observedAt, receivedAt, payload });
}
function reply(request: BracketRequest, changes: Partial<BrokerOrder> = {}): BrokerOrder {
  return { id: `test-${request.clientOrderId}`, clientOrderId: request.clientOrderId, planHash: request.planHash, symbol: request.plan.symbol,
    status: "accepted", filledQuantity: 0, filledPrice: null, bracketProtected: false, ...changes };
}
class StubBroker implements DeskBroker {
  readonly mode: "local-paper" | "alpaca-paper";
  requests: BracketRequest[] = [];
  emergencyCalls = 0;
  orders = new Map<string, BrokerOrder>();
  onSubmit: (request: BracketRequest) => BrokerOrder = request => reply(request);
  emergencyResult: EmergencyResult = { confirmed: false, openOrders: null, openPositions: null, reason: "test_unknown_position" };
  constructor(mode: "local-paper" | "alpaca-paper" = "local-paper") { this.mode = mode; }
  async submitBracket(request: BracketRequest): Promise<BrokerOrder> { this.requests.push(request); const order = this.onSubmit(request); this.orders.set(request.clientOrderId, order); return order; }
  async findOrder(clientOrderId: string): Promise<BrokerOrder | null> { return this.orders.get(clientOrderId) ?? null; }
  async emergencyFlatten(): Promise<EmergencyResult> { this.emergencyCalls++; return this.emergencyResult; }
}
function environment(path?: string) {
  const clock = { now: START }, store = journal(path), broker = new StubBroker();
  const desk = new DeskWorkflow(store, broker, { allowSyntheticDemo: true, now: () => clock.now });
  return { clock, store, broker, desk };
}
function throughStrategy(desk: DeskWorkflow, input: DeskCase, now = START): CaseState {
  desk.register(input, now); desk.scout(input.id, now); desk.chart(input.id, now); return desk.strategize(input.id, now);
}
function approve(desk: DeskWorkflow, input: DeskCase, now = START): CaseState {
  expect(throughStrategy(desk, input, now).stage).toBe("STRATEGIZED"); return desk.approve(input.id, now);
}

describe("desk stage and approval authority", () => {
  test("the explicit synthetic demo traverses all roles and journals its real simulated fill", async () => {
    const store = journal(), paper = new LocalPaperBroker(store, 10_000, () => START);
    const desk = new DeskWorkflow(store, paper, { allowSyntheticDemo: true, now: () => START });
    const input = syntheticDeskCase(START);
    paper.mark(input.quote);
    const state = await desk.run(input, START);
    expect(state.stage).toBe("FILLED");
    expect(state.approval?.synthetic).toBe(true);
    expect(state.order?.filledQuantity).toBe(input.plan.quantity);
    expect(paper.snapshot().positions[0]?.quantity).toBe(input.plan.quantity);
    expect(store.rows().map(row => row.BOT)).toEqual(["scout", "chart", "strategist", "risk", "trader"]);
    expect(desk.chiefBrief(START).externalNotificationsSent).toBe(false);
    expect(() => store.verify()).not.toThrow();
  });

  test("role-scoped agent tools cannot skip stages or acquire broker writes", async () => {
    const { desk, broker } = environment(), input = syntheticDeskCase(START);
    desk.register(input, START);
    expect(() => desk.approve(input.id, START)).toThrow("invalid_transition");
    expect(() => desk.chart(input.id, START)).toThrow("invalid_transition");
    expect(() => desk.scout(input.id, START, "trader")).toThrow("only_scout");
    await expect(desk.execute(input.id, input.quote, input.risk, START, "scout")).rejects.toThrow("permission_denied");
    for (const role of ["chief", "scout", "chart", "strategist", "risk"] as const) {
      const tools = desk.toolsFor(role);
      expect(Object.isFrozen(tools)).toBe(true);
      expect(tools.execute).toBeUndefined(); expect(tools.emergency).toBeUndefined();
      expect(tools.broker).toBeUndefined(); expect(tools.journal).toBeUndefined();
    }
    expect(desk.toolsFor("trader").approve).toBeUndefined();
    expect(broker.requests.length).toBe(0);
  });

  test("synthetic strategy evidence cannot pass normal acceptance or reach an external broker", () => {
    const store = journal(), broker = new StubBroker();
    const desk = new DeskWorkflow(store, broker, { now: () => START });
    const state = throughStrategy(desk, syntheticDeskCase(START));
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("synthetic");
    expect(() => new DeskWorkflow(store, new StubBroker("alpaca-paper"), { allowSyntheticDemo: true, now: () => START })).toThrow("synthetic_evidence_cannot_reach_external_broker");
  });

  test("a passing backtest for different strategy parameters cannot qualify a plan", () => {
    const { desk, broker } = environment(), input = syntheticDeskCase(START);
    input.plan = { ...input.plan, parametersHash: hash({ different: "unbacktested parameters" }) };
    const state = throughStrategy(desk, input);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("not_bound_to_backtested");
    expect(broker.requests.length).toBe(0);
  });

  test("changing a registered case or substituting a different approved plan is rejected", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    approve(desk, input);
    expect(() => desk.register({ ...input, idea: "changed after approval" }, START)).toThrow("immutable_case_conflict");
    store.save(`input:${input.id}`, { ...input, plan: { ...input.plan, quantity: input.plan.quantity + 1 } });
    const state = await desk.execute(input.id, input.quote, input.risk, START);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("tampered");
    expect(store.load("desk:kill")).not.toBeNull(); expect(broker.requests.length).toBe(0);
  });

  test("a fabricated mutable approval cannot replace the durable Risk transition", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    const before = throughStrategy(desk, input);
    store.save(`case:${input.id}`, { ...before, stage: "APPROVED", approval: { planHash: hash(input.plan), caseHash: hash(input), riskEvidenceId: input.risk.id,
      approvedAt: START, expiresAt: START + 10_000, mode: "paper", synthetic: true } });
    const state = await desk.execute(input.id, input.quote, input.risk, START);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("durable_risk_transition");
    expect(broker.requests.length).toBe(0);
  });

  test("expired approval cannot be revived by fresh quotes or a caller's old timestamp", async () => {
    const { desk, clock, broker } = environment(), input = syntheticDeskCase(START);
    const approved = approve(desk, input);
    clock.now = approved.approval!.expiresAt;
    await expect(desk.execute(input.id, input.quote, input.risk, START)).rejects.toThrow("workflow_clock");
    const freshQuote = withPayload(input.quote, input.quote.payload, clock.now, clock.now), freshRisk = withPayload(input.risk, input.risk.payload, clock.now, clock.now);
    const state = await desk.execute(input.id, freshQuote, freshRisk, clock.now);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("approval_expired");
    expect(broker.requests.length).toBe(0);
  });

  test("a fresh price more than 0.5 percent past entry returns the plan without chasing", async () => {
    const { desk, broker } = environment(), input = syntheticDeskCase(START);
    approve(desk, input);
    const quote = withPayload(input.quote, { ...input.quote.payload, bid: 100.50, ask: 100.51, last: 100.51 });
    const state = await desk.execute(input.id, quote, input.risk, START);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("price_moved_over_limit");
    expect(broker.requests.length).toBe(0);
  });

  test("stale data latches kill even when the approval itself remains valid", async () => {
    const { desk, clock, store, broker } = environment(), input = syntheticDeskCase(START);
    approve(desk, input); clock.now += 60_001;
    const risk = withPayload(input.risk, input.risk.payload, clock.now, clock.now);
    const state = await desk.execute(input.id, input.quote, risk, clock.now);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("stale_evidence");
    expect(store.load("desk:kill")).not.toBeNull(); expect(broker.requests.length).toBe(0);
  });
});

describe("desk hard risk vetoes", () => {
  const failures: { name: string; reason: string; change: (value: RiskSnapshot, input: DeskCase) => void; kill?: boolean }[] = [
    { name: "daily loss at two percent", reason: "daily_loss_limit", kill: true, change: risk => { risk.equity = 9800; risk.cash = 9800; } },
    { name: "three consecutive losses", reason: "loss_streak_limit", kill: true, change: risk => { risk.lossStreak = 3; } },
    { name: "missing event coverage", reason: "event_calendar_unknown_or_incomplete", change: risk => { risk.events.status = "unknown"; } },
    { name: "earnings inside planned hold", reason: "event_blackout:earnings", change: (risk, input) => { risk.events.items = [{ kind: "earnings", at: START + 86_400_000, symbol: input.symbol }]; } },
    { name: "missing correlations", reason: "correlation_data_unknown", change: risk => { risk.correlations = null; } },
    { name: "leveraged instrument", reason: "asset_not_eligible_or_leverage_unknown", change: risk => { risk.asset.leveraged = true; } },
    { name: "existing same-symbol pending entry", reason: "existing_symbol_or_pending_order", change: (risk, input) => { risk.openOrders = [{ symbol: input.symbol, quantity: 1, entry: 100, stop: 98, correlationGroup: "synthetic-equities" }]; } },
    { name: "cash already reserved by other orders", reason: "insufficient_unreserved_cash_no_leverage", change: risk => { risk.openOrders = [{ symbol: "OTHER", quantity: 70, entry: 100, stop: 99, correlationGroup: "other" }]; risk.correlations = [{ a: "DEMO", b: "OTHER", coefficient: 0 }]; } },
    { name: "risk greater than one percent", reason: "per_trade_risk_limit", change: (_risk, input) => { input.plan.quantity = 51; } },
  ];
  for (const failure of failures) test(failure.name, () => {
    const input = syntheticDeskCase(START), risk = structuredClone(input.risk.payload);
    failure.change(risk, input);
    const result = assessDeskRisk(input.plan, withPayload(input.risk, risk), input.quote, START, DEFAULT_DESK_RULES);
    expect(result.approved).toBe(false); expect(result.reasons).toContain(failure.reason);
    if (failure.kill) expect(result.kill).toBe(true);
  });

  test("desk limits can only be tightened", () => {
    expect(() => new DeskWorkflow(journal(), new StubBroker(), { rules: { maxRiskFraction: 0.02 } })).toThrow("may_only_be_tightened");
  });

  test("future or altered risk evidence cannot pass the veto", () => {
    const input = syntheticDeskCase(START), future = withPayload(input.risk, input.risk.payload, START + 1, START + 1);
    expect(assessDeskRisk(input.plan, future, input.quote, START, DEFAULT_DESK_RULES).approved).toBe(false);
    const tampered = { ...input.risk, payload: { ...input.risk.payload, equity: 1_000_000 } };
    const result = assessDeskRisk(input.plan, tampered, input.quote, START, DEFAULT_DESK_RULES);
    expect(result.approved).toBe(false); expect(result.reasons.join(";")).toContain("hash_mismatch");
  });
});

describe("durable desk order lifecycle", () => {
  test("an unknown submission survives restart and blocks another case without retrying", async () => {
    const path = temporaryJournal(), first = environment(path), input = syntheticDeskCase(START, "first");
    first.broker.onSubmit = request => reply(request, { status: "unknown", reason: "transport outcome unknown" });
    expect((await first.desk.run(input, START)).stage).toBe("UNKNOWN");
    const request = first.broker.requests[0]!;
    first.broker.orders.delete(request.clientOrderId); // A broker 404 is not proof that the POST did not happen.
    first.store.close();
    const store = journal(path), restarted = new DeskWorkflow(store, first.broker, { allowSyntheticDemo: true, now: () => START });
    expect((await restarted.run(input, START)).stage).toBe("UNKNOWN");
    expect(first.broker.requests.length).toBe(1);
    const other = syntheticDeskCase(START, "second", "OTHER");
    approve(restarted, other);
    expect((await restarted.execute(other.id, other.quote, other.risk, START)).stage).toBe("REJECTED");
    expect(first.broker.requests.length).toBe(1);
    expect(store.load("desk:execution-lock")).not.toBeNull();
  });

  test("confirmed inventory omitted from the next portfolio snapshot blocks another order", async () => {
    const { desk, broker } = environment(), first = syntheticDeskCase(START, "filled");
    broker.onSubmit = request => reply(request, { status: "filled", filledQuantity: request.plan.quantity, filledPrice: request.plan.entry, bracketProtected: true });
    expect((await desk.run(first, START)).stage).toBe("FILLED");
    const other = syntheticDeskCase(START, "other", "OTHER"); approve(desk, other);
    const state = await desk.execute(other.id, other.quote, other.risk, START);
    expect(state.stage).toBe("REJECTED"); expect(state.reason).toContain("confirmed_inventory");
    expect(broker.requests.length).toBe(1);
  });

  test("unprotected partial fill latches kill and an uncertain emergency never reports flat", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    broker.onSubmit = request => reply(request, { status: "accepted", filledQuantity: 1, filledPrice: request.plan.entry, bracketProtected: false });
    await desk.run(input, START);
    expect(store.load("desk:kill")).not.toBeNull(); expect(broker.emergencyCalls).toBe(1);
    const emergency = store.events().find(event => event.kind === "emergency_reconciliation")?.payload as { result: EmergencyResult };
    expect(emergency.result.confirmed).toBe(false); expect(emergency.result.openPositions).toBeNull();
    expect(store.load("desk:execution-lock")).not.toBeNull();
  });

  test("cancelling a partially filled entry preserves unknown inventory and reconciliation", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    broker.onSubmit = request => reply(request, { status: "cancelled", filledQuantity: 1, filledPrice: request.plan.entry, bracketProtected: false });
    expect((await desk.run(input, START)).stage).toBe("UNKNOWN");
    expect(store.load("desk:execution-lock")).not.toBeNull();
    expect((await desk.reconcile(input.id, START)).stage).toBe("UNKNOWN");
  });

  test("status can become unknown and recover without overwriting journal history", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    expect((await desk.run(input, START)).stage).toBe("SUBMITTED");
    const request = broker.requests[0]!;
    broker.orders.set(request.clientOrderId, reply(request, { status: "unknown", reason: "provider suspended" }));
    expect((await desk.reconcile(input.id, START)).stage).toBe("UNKNOWN");
    broker.orders.set(request.clientOrderId, reply(request));
    expect((await desk.reconcile(input.id, START)).stage).toBe("SUBMITTED");
    const count = store.events().length;
    await desk.reconcile(input.id, START);
    expect(store.events().length).toBe(count);
    expect(() => store.verify()).not.toThrow(); expect(broker.requests.length).toBe(1);
  });

  test("regressing cumulative fill quantity is not accepted as a new broker truth", async () => {
    const { desk, store, broker } = environment(), input = syntheticDeskCase(START);
    broker.onSubmit = request => reply(request, { filledQuantity: 5, filledPrice: request.plan.entry, bracketProtected: true });
    await desk.run(input, START);
    const request = broker.requests[0]!;
    broker.orders.set(request.clientOrderId, reply(request, { filledQuantity: 4, filledPrice: request.plan.entry, bracketProtected: true }));
    const state = await desk.reconcile(input.id, START);
    expect(state.stage).toBe("UNKNOWN"); expect(store.load("desk:kill")).not.toBeNull();
  });
});
