import { assessStrategyEvidence } from "../evaluation/strategy";
import { evidence, hash, immutable, validatePlan, validateRules, verifyEvidence } from "./evidence";
import { DeskJournal } from "./journal";
import { assessDeskRisk, assessPortfolioSafety } from "./risk";
import { DEFAULT_DESK_RULES, requireCapability } from "./types";
import type { Approval, BrokerOrder, CaseState, DeskBroker, DeskCase, DeskRole, DeskRules, DeskStage, Evidence, JournalRow, Quote, RiskSnapshot } from "./types";

export interface DeskOptions { rules?: Partial<DeskRules>; allowSyntheticDemo?: boolean; now?: () => number }
export class DeskWorkflow {
  readonly rules: Readonly<DeskRules>;
  private readonly syntheticDemo: boolean;
  private readonly clock: () => number;
  constructor(private readonly journal: DeskJournal, private readonly broker: DeskBroker, options: DeskOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.rules = immutable({ ...DEFAULT_DESK_RULES, ...options.rules }); validateRules(this.rules);
    this.syntheticDemo = options.allowSyntheticDemo === true;
    if (this.syntheticDemo && broker.mode !== "local-paper") throw new Error("synthetic_evidence_cannot_reach_external_broker");
  }
  private assertNow(now: number): void { if (!Number.isFinite(now) || Math.abs(this.clock() - now) > 1000) throw new Error("untrusted_or_stale_workflow_clock"); }
  state(id: string): CaseState | null { return this.journal.load<CaseState>(`case:${id}`); }
  private input(id: string): DeskCase { const input = this.journal.load<DeskCase>(`input:${id}`); if (!input) throw new Error("case_not_registered"); return input; }
  private expected(id: string, stage: DeskStage): CaseState {
    const state = this.state(id); if (!state || state.stage !== stage) throw new Error(`invalid_transition:${state?.stage ?? "ABSENT"}->${stage}`); return state;
  }
  private log(input: DeskCase, role: DeskRole, state: CaseState, now: number, detail = ""): void {
    const row: JournalRow = { TIME: new Date(now).toISOString(), BOT: role, TICKER: input.symbol, IDEA: input.idea,
      SOURCE: [input.scout, input.chart, input.backtest, input.risk, input.quote].map(item => `${item.source} @ ${new Date(item.observedAt).toISOString()} #${item.id}`).join(" | "),
      SCORE: input.chart.payload.score, ENTRY: input.plan.entry, STOP: input.plan.stop, TARGET: input.plan.target, SIZE: input.plan.quantity,
      "RISK CHECK": role === "risk" || role === "trader" ? detail : "", STATUS: state.stage,
      RESULT: state.order ? JSON.stringify(state.order) : detail, LESSON: state.stage === "REJECTED" ? detail : "" };
    this.journal.append("row", row, `${input.id}:${role}:${state.stage}:${hash(state)}`, now);
  }
  private transition(id: string, role: DeskRole, stage: DeskStage, now: number, changes: Partial<CaseState> = {}, detail = ""): CaseState {
    requireCapability(role, "journal.append");
    const before = this.state(id); if (!before) throw new Error("case_not_registered");
    const state = immutable({ ...before, ...changes, stage, version: (before.version ?? 0) + 1 });
    this.journal.atomic(() => { this.journal.append("case_transition", { id, role, before: before.stage, state }, `${id}:transition:${hash(state)}`, now); this.journal.save(`case:${id}`, state);
      if (role === "trader" && ["FILLED", "CLOSED", "REJECTED"].includes(stage) && this.journal.load<{ caseId: string }>("desk:execution-lock")?.caseId === id) this.journal.release("desk:execution-lock");
      this.log(this.input(id), role, state, now, detail); });
    return state;
  }
  register(inputValue: DeskCase, now: number): CaseState {
    this.assertNow(now);
    const input = immutable(inputValue);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || input.symbol !== input.plan.symbol || !input.idea.trim()) throw new Error("invalid_case_identity");
    validatePlan(input.plan);
    for (const item of [input.scout, input.chart, input.backtest, input.risk, input.quote]) verifyEvidence(item, now);
    const requiredIds = [input.scout.id, input.chart.id, input.backtest.id];
    if (!requiredIds.every(id => input.plan.evidenceIds.includes(id))) throw new Error("plan_must_bind_all_research_evidence");
    const caseHash = hash(input), existing = this.state(input.id);
    if (existing) { if (existing.caseHash !== caseHash) throw new Error("immutable_case_conflict"); return existing; }
    const state: CaseState = { id: input.id, caseHash, stage: "NEW" };
    this.journal.atomic(() => {
      for (const item of [input.scout, input.chart, input.backtest, input.risk, input.quote]) this.journal.putEvidence(item);
      this.journal.save(`input:${input.id}`, input); this.journal.save(`case:${input.id}`, state);
      this.journal.append("case_registered", { id: input.id, caseHash }, `${input.id}:registered`, now);
    });
    return state;
  }
  scout(id: string, now: number, role: DeskRole = "scout"): CaseState {
    this.assertNow(now);
    if (role !== "scout") throw new Error("only_scout_can_scout"); requireCapability(role, "research.read"); this.expected(id, "NEW");
    const input = this.input(id), finding = input.scout.payload;
    verifyEvidence(input.scout, now, 24 * 3_600_000);
    if (!Number.isFinite(finding.importance) || finding.importance < 1 || finding.importance > 10 || !finding.catalyst.trim() || !finding.relevance.trim() || finding.rumor !== false || finding.paidPromotion !== false) return this.reject(id, role, now, "unsubstantiated_or_promoted_scout_signal");
    return this.transition(id, role, "SCOUTED", now, {}, `${input.symbol} | ${input.idea} | ${input.scout.id} | Chart Analyst`);
  }
  chart(id: string, now: number, role: DeskRole = "chart"): CaseState {
    this.assertNow(now);
    if (role !== "chart") throw new Error("only_chart_can_analyze"); requireCapability(role, "market.read"); this.expected(id, "SCOUTED");
    const input = this.input(id), chart = input.chart.payload;
    verifyEvidence(input.chart, now, 24 * 3_600_000);
    if (![chart.support, chart.resistance, chart.ma50, chart.ma200, chart.volume, chart.averageVolume20].every(n => Number.isFinite(n) && n > 0) ||
        chart.support >= chart.resistance || !Number.isInteger(chart.score) || chart.score < 1 || chart.score > 10 || !Number.isFinite(chart.rsi14) || chart.rsi14 < 0 || chart.rsi14 > 100 ||
        !Array.isArray(chart.explanation) || chart.explanation.length !== 3 || chart.explanation.some(line => typeof line !== "string" || !line.trim())) return this.reject(id, role, now, "incomplete_chart_evidence");
    if (chart.score < 7 || chart.dailyTrend !== "bullish" || chart.fourHourTrend !== "bullish" || chart.deskSignal !== "BUY") return this.reject(id, role, now, "chart_score_or_trend_or_signal_failed");
    return this.transition(id, role, "CHARTED", now, {}, `${input.symbol} | ${input.idea} | ${input.chart.id} | Strategist`);
  }
  strategize(id: string, now: number, role: DeskRole = "strategist"): CaseState {
    this.assertNow(now);
    if (role !== "strategist") throw new Error("only_strategist_can_plan"); requireCapability(role, "backtest.run"); this.expected(id, "CHARTED");
    const input = this.input(id), planHash = hash(input.plan), failedKey = `failed:${hash({ strategy: input.plan.strategyId, symbol: input.symbol, parameters: input.plan.parametersHash, dataset: input.backtest.payload.datasetHash })}`;
    if (this.journal.load(failedKey)) return this.reject(id, role, now, "unchanged_failed_idea_already_recorded");
    if (input.backtest.payload.strategyId !== input.plan.strategyId || input.backtest.payload.parametersHash !== input.plan.parametersHash || !input.backtest.payload.sensitivityRuns.some(run => run.parameterHash === input.plan.parametersHash)) return this.reject(id, role, now, "plan_not_bound_to_backtested_strategy_and_parameters");
    if (this.journal.load(`desk:strategy-paused:${input.plan.strategyId}:${input.plan.parametersHash}`)) return this.reject(id, role, now, "strategy_paused_by_weekly_review");
    const result = assessStrategyEvidence(input.backtest.payload);
    const synthetic = [input.scout, input.chart, input.backtest, input.risk, input.quote].some(item => item.provenance === "synthetic") || input.backtest.payload.provenance === "synthetic";
    const reasons = result.reasons.filter(reason => !(this.syntheticDemo && synthetic && reason === "synthetic_data_is_not_strategy_acceptance_evidence"));
    if (synthetic && !this.syntheticDemo) reasons.push("synthetic_research_cannot_qualify_strategy");
    if (input.backtest.payload.historyEnd > input.backtest.observedAt || input.backtest.payload.evaluationEnd > now) reasons.push("backtest_contains_future_data");
    if (input.backtest.provenance !== "historical" && !this.syntheticDemo) reasons.push("historical_backtest_provenance_required");
    if (reasons.length) { this.journal.save(failedKey, { id, at: now, reasons }); return this.reject(id, role, now, reasons.join(";")); }
    return this.transition(id, role, "STRATEGIZED", now, { planHash }, synthetic ? "SYNTHETIC DEMONSTRATION ONLY; no historical acceptance" : "Historical strategy evidence passed paper acceptance gates");
  }
  approve(id: string, now: number, role: DeskRole = "risk", currentRisk?: Evidence<RiskSnapshot>, currentQuote?: Evidence<Quote>): CaseState {
    this.assertNow(now);
    if (role !== "risk") throw new Error("only_risk_can_approve"); requireCapability(role, "risk.approve"); const state = this.expected(id, "STRATEGIZED"), input = this.input(id);
    if (this.journal.load("desk:kill")) return this.reject(id, role, now, "desk_kill_latched");
    if (this.journal.load("desk:accounting-pause")) return this.reject(id, role, now, "realized_outcome_costs_unreconciled");
    const riskEvidence = currentRisk ?? input.risk, quoteEvidence = currentQuote ?? input.quote;
    const decision = assessDeskRisk(input.plan, riskEvidence, quoteEvidence, now, this.rules);
    this.journal.putEvidence(riskEvidence); this.journal.putEvidence(quoteEvidence);
    if (!decision.approved) { if (decision.kill) this.latchKill(decision.reasons.join(";"), now); return this.reject(id, role, now, decision.reasons.join(";")); }
    const approval: Approval = { planHash: state.planHash!, caseHash: state.caseHash, riskEvidenceId: riskEvidence.id, approvedAt: now,
      expiresAt: Math.min(now + this.rules.approvalTtlMs, input.plan.holdingUntil), mode: this.broker.mode === "alpaca-live" ? "live" : "paper",
      synthetic: [input.scout, input.chart, input.backtest, input.risk, input.quote].some(item => item.provenance === "synthetic") };
    return this.transition(id, role, "APPROVED", now, { approval }, `APPROVED ${approval.planHash}; expires ${new Date(approval.expiresAt).toISOString()}; risk USD ${decision.riskUsd}`);
  }
  async execute(id: string, quote: Evidence<Quote>, risk: Evidence<RiskSnapshot>, now: number, role: DeskRole = "trader"): Promise<CaseState> {
    this.assertNow(now);
    requireCapability(role, "orders.submit"); if (role !== "trader") throw new Error("only_trader_can_execute");
    const state = this.expected(id, "APPROVED"), input = this.input(id), approval = state.approval;
    if (this.journal.load("desk:kill")) return this.reject(id, role, now, "desk_kill_latched");
    if (this.journal.load("desk:accounting-pause")) return this.reject(id, role, now, "realized_outcome_costs_unreconciled");
    const approvalEvent = this.journal.events().find(event => event.kind === "case_transition" && (event.payload as { id: string; state: CaseState }).id === id && (event.payload as { state: CaseState }).state.stage === "APPROVED");
    if (!approvalEvent || hash((approvalEvent.payload as { state: CaseState }).state) !== hash(state)) return this.reject(id, role, now, "approval_not_issued_by_durable_risk_transition");
    if (!approval || approval.planHash !== hash(input.plan) || approval.caseHash !== hash(input) || approval.mode !== (this.broker.mode === "alpaca-live" ? "live" : "paper")) { this.latchKill("approval_or_plan_tampered", now); return this.reject(id, role, now, "approval_or_plan_tampered"); }
    if (approval.expiresAt <= now || approval.approvedAt > now) return this.reject(id, role, now, "approval_expired_return_to_risk");
    if (this.broker.mode !== "local-paper" && (approval.synthetic || quote.provenance === "synthetic" || risk.provenance === "synthetic")) return this.reject(id, role, now, "synthetic_evidence_cannot_reach_external_broker");
    if (this.journal.load(`desk:strategy-paused:${input.plan.strategyId}:${input.plan.parametersHash}`)) return this.reject(id, role, now, "strategy_paused_by_weekly_review");
    const decision = assessDeskRisk(input.plan, risk, quote, now, this.rules);
    if (!decision.approved) { if (decision.kill) this.latchKill(decision.reasons.join(";"), now); return this.reject(id, role, now, decision.reasons.join(";")); }
    const clientOrderId = `desk-${hash({ caseId: id, planHash: approval.planHash }).slice(0, 40)}`;
    const request = immutable({ clientOrderId, plan: input.plan, planHash: approval.planHash, approval, quoteObservedAt: quote.observedAt, riskObservedAt: risk.observedAt, quoteEvidenceId: quote.id, currentRiskEvidenceId: risk.id });
    let reservationFailure: string | null = null;
    this.journal.atomic(() => {
      if (!this.journal.claim("desk:execution-lock", { caseId: id, at: now })) { reservationFailure = "concurrent_or_unresolved_submission"; return; }
      const activeIds = this.journal.load<string[]>("desk:active-cases") ?? [];
      for (const activeId of activeIds) {
        if (activeId === id) continue;
        const active = this.state(activeId);
        if (!active || ["UNKNOWN", "SUBMITTED"].includes(active.stage)) { reservationFailure = "unresolved_order_blocks_new_submission"; break; }
        if (active.stage === "FILLED" && !risk.payload.positions.some(position => position.symbol === active.order?.symbol && position.quantity >= (active.order?.filledQuantity ?? Infinity) && position.stop !== null)) { reservationFailure = "broker_portfolio_does_not_include_confirmed_inventory"; break; }
      }
      if (reservationFailure) { this.journal.release("desk:execution-lock"); return; }
      this.journal.putEvidence(quote); this.journal.putEvidence(risk);
      this.journal.save("desk:active-cases", [...new Set([...activeIds, id])]);
      this.journal.append("order_intent", request, `${id}:order-intent`, now);
      // Persist UNKNOWN before crossing the network boundary: after a crash only reconciliation is permitted.
      this.journal.save(`case:${id}`, { ...state, stage: "UNKNOWN", reason: "submission_in_progress" });
      this.journal.save(`order:${clientOrderId}`, { caseId: id, request });
    });
    if (reservationFailure) return this.reject(id, role, now, reservationFailure);
    let order: BrokerOrder;
    try { order = await this.broker.submitBracket(request); }
    catch (error) { order = { id: "", clientOrderId, planHash: approval.planHash, symbol: input.symbol, status: "unknown", filledQuantity: 0, filledPrice: null, bracketProtected: false, reason: String(error) }; }
    return this.recordOrder(id, order, this.clock());
  }
  private recordOrder(id: string, order: BrokerOrder, now: number): CaseState {
    const input = this.input(id), state = this.state(id)!;
    if (order.planHash !== state.planHash || order.symbol !== input.symbol || order.clientOrderId !== `desk-${hash({ caseId: id, planHash: state.planHash }).slice(0, 40)}`) { this.latchKill("broker_order_identity_mismatch", now); return this.transition(id, "trader", "UNKNOWN", now, { reason: "broker_order_identity_mismatch" }); }
    if (!Number.isFinite(order.filledQuantity) || order.filledQuantity < 0 || (order.filledPrice !== null && (!Number.isFinite(order.filledPrice) || order.filledPrice <= 0)) || (state.order && order.filledQuantity < state.order.filledQuantity) || !["unknown", "rejected", "cancelled", "filled", "closed", "accepted"].includes(order.status)) { this.latchKill("invalid_or_regressing_broker_order", now); return this.transition(id, "trader", "UNKNOWN", now, { reason: "invalid_or_regressing_broker_order" }); }
    if (order.status !== "closed" && order.filledQuantity > 0 && (!order.bracketProtected || order.filledPrice === null || Math.abs(order.filledPrice - input.plan.entry) / input.plan.entry > this.rules.maxPriceDeviationFraction || order.filledQuantity > input.plan.quantity)) this.latchKill("unprotected_fill_or_slippage_or_oversize", now);
    const stage: DeskStage = order.status === "unknown" ? "UNKNOWN" : (order.status === "rejected" || order.status === "cancelled") ? (order.filledQuantity > 0 ? "UNKNOWN" : "REJECTED") : order.status === "filled" ? "FILLED" : order.status === "closed" ? "CLOSED" : "SUBMITTED";
    // Polls may repeat the same state with new partial fill data; record separately from role-transition rows.
    if (state.order && hash(state.order) === hash(order)) return state;
    if (state.order && state.stage === stage) {
      const updated = immutable({ ...state, order });
      this.journal.atomic(() => { this.journal.append("order_update", { id, order }, `${id}:order-update:${hash(order)}`, now); this.journal.save(`case:${id}`, updated); });
      return updated;
    }
    return this.transition(id, "trader", stage, now, { order, reason: order.reason ?? "" }, order.reason ?? order.status);
  }
  async reconcile(id: string, now: number): Promise<CaseState> {
    this.assertNow(now);
    const state = this.state(id); if (!state || !["UNKNOWN", "SUBMITTED", "FILLED"].includes(state.stage)) throw new Error("case_not_reconcilable");
    const clientOrderId = `desk-${hash({ caseId: id, planHash: state.planHash }).slice(0, 40)}`;
    const order = await this.broker.findOrder(clientOrderId);
    if (!order) { this.journal.append("reconciliation_missing", { id, clientOrderId, action: "DO_NOT_RESUBMIT" }, `${id}:missing:${now}`, now); return state; }
    return this.recordOrder(id, order, this.clock());
  }
  private reject(id: string, role: DeskRole, now: number, reason: string): CaseState { return this.transition(id, role, "REJECTED", now, { reason }, reason); }
  latchKill(reason: string, now: number): void {
    this.journal.atomic(() => { this.journal.save("desk:kill", { reason, at: now }); this.journal.append("kill_switch", { reason, at: now }, `kill:${now}:${hash(reason)}`, now); });
  }
  async emergency(now: number): Promise<unknown> {
    const kill = this.journal.load("desk:kill"); if (!kill) throw new Error("emergency_requires_latched_kill");
    requireCapability("trader", "orders.cancel"); requireCapability("trader", "positions.close");
    const result = await this.broker.emergencyFlatten();
    this.journal.append("emergency_reconciliation", { kill, result }, `emergency:${now}:${hash(result)}`, now);
    return result; // The latch remains set even when flat. No automatic restart.
  }
  /** Called by Trader and Risk even with an empty idea inbox. */
  async monitorPortfolio(risk: Evidence<RiskSnapshot> | null, quotes: readonly Evidence<Quote>[], now: number): Promise<{ reasons: string[]; entryPaused?: boolean; emergency?: unknown }> {
    this.assertNow(now);
    let reasons: string[], entryPaused = false;
    try {
      const actual = this.broker.readAccountRisk ? await this.broker.readAccountRisk() : risk?.payload;
      if (!actual) throw new Error("authoritative_portfolio_unavailable");
      entryPaused = actual.accountingPending === true;
      if (entryPaused) this.journal.save("desk:accounting-pause", { at: this.clock(), reason: "realized_outcome_costs_unreconciled" });
      else this.journal.release("desk:accounting-pause");
      const at = this.clock();
      const payload: RiskSnapshot = { asset: { symbol: "UNKNOWN", tradable: false, assetClass: "us_equity", leveraged: false, correlationGroup: null }, correlations: null,
        events: { status: "unknown", completeThrough: 0, items: [] }, ...(risk?.payload ?? {}), ...actual };
      const snapshot = this.broker.readAccountRisk ? evidence({ source: `broker://${this.broker.mode}/portfolio`, provenance: this.broker.mode === "local-paper" ? "synthetic" : "observed", observedAt: at, receivedAt: at, payload }) : risk!;
      this.journal.putEvidence(snapshot);
      reasons = assessPortfolioSafety(snapshot, quotes, at, this.rules);
    } catch (error) { reasons = [`portfolio_monitor_failed:${String(error)}`]; }
    if (reasons.length) { this.latchKill(reasons.join(";"), this.clock()); return { reasons, emergency: await this.emergency(this.clock()) }; }
    return { reasons, entryPaused };
  }
  async run(input: DeskCase, now: number): Promise<CaseState> {
    this.register(input, now);
    if (this.state(input.id)!.stage === "NEW") this.scout(input.id, now);
    if (this.state(input.id)!.stage === "SCOUTED") this.chart(input.id, now);
    if (this.state(input.id)!.stage === "CHARTED") this.strategize(input.id, now);
    if (this.state(input.id)!.stage === "STRATEGIZED") this.approve(input.id, now);
    if (this.state(input.id)!.stage === "APPROVED") await this.execute(input.id, input.quote, input.risk, now);
    else if (["UNKNOWN", "SUBMITTED", "FILLED"].includes(this.state(input.id)!.stage)) await this.reconcile(input.id, now);
    if (this.journal.load("desk:kill")) await this.emergency(now);
    return this.state(input.id)!;
  }
  /** Role-scoped closures are the only objects suitable for exposing to agent tool runtimes. */
  toolsFor(role: DeskRole): Readonly<Record<string, (...args: any[]) => unknown>> {
    const all = {
      chief: { brief: (now: number) => this.chiefBrief(now) },
      scout: { scout: (id: string, now: number) => this.scout(id, now, "scout") },
      chart: { analyze: (id: string, now: number) => this.chart(id, now, "chart") },
      strategist: { strategize: (id: string, now: number) => this.strategize(id, now, "strategist") },
      risk: { approve: async (id: string, now: number) => { const result = this.approve(id, now, "risk"); if (this.journal.load("desk:kill")) await this.emergency(this.clock()); return result; }, kill: async (reason: string, now: number) => { this.assertNow(now); this.latchKill(reason, now); return this.emergency(this.clock()); } },
      trader: { execute: async (id: string, quote: Evidence<Quote>, risk: Evidence<RiskSnapshot>, now: number) => { const result = await this.execute(id, quote, risk, now, "trader"); if (this.journal.load("desk:kill")) await this.emergency(this.clock()); return result; }, reconcile: async (id: string, now: number) => { const result = await this.reconcile(id, now); if (this.journal.load("desk:kill")) await this.emergency(this.clock()); return result; }, emergency: (now: number) => this.emergency(now) },
    };
    return Object.freeze(all[role]);
  }
  chiefBrief(now: number): { time: string; counts: Record<string, number>; kill: unknown; externalNotificationsSent: false } {
    requireCapability("chief", "journal.read");
    const latest = new Map<string, string>(); for (const event of this.journal.events()) if (event.kind === "row") { const row = event.payload as JournalRow; latest.set(event.event_key.split(":")[0]!, row.STATUS); }
    const counts: Record<string, number> = {}; for (const stage of latest.values()) counts[stage] = (counts[stage] ?? 0) + 1;
    const result = { time: new Date(now).toISOString(), counts, kill: this.journal.load("desk:kill"), externalNotificationsSent: false as const };
    this.journal.append("brief", result, `brief:${now}`, now); return result;
  }
}

export function rankScoutCases(inputs: readonly DeskCase[]): DeskCase[] {
  return [...inputs].filter(item => item.scout.payload.rumor === false && item.scout.payload.paidPromotion === false)
    .sort((a, b) => b.scout.payload.importance - a.scout.payload.importance || a.id.localeCompare(b.id)).slice(0, 5);
}
