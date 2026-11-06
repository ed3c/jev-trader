import { hash, validatePlan, verifyEvidence } from "../desk/evidence";
import { DeskJournal } from "../desk/journal";
import type { BracketRequest, BrokerOrder, CaseState, DeskBroker, EmergencyResult, Quote, RiskSnapshot } from "../desk/types";

import { checkAlpacaLiveAuthorization } from "../desk/live-authorization";
import type { AlpacaLiveGatePaths } from "../desk/live-authorization";

const LIVE_BASE = "https://api.alpaca.markets";
const PAPER_BASE = "https://paper-api.alpaca.markets";
export interface AlpacaOptions {
  apiKey: string; secretKey: string; journal: DeskJournal;
  /** Writes require deliberate opt-in. Read-only account inspection is the default. */
  allowPaperOrders?: boolean; paper?: boolean; baseUrl?: string;
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
}
interface StoredSubmission { request: BracketRequest; state: "reserved" | "confirmed" | "unknown" | "rejected"; order?: BrokerOrder }
export interface LiveReadiness {
  paperDays: number; cleanPaperDays: number; paperMatchesBacktest: boolean;
  realHistoricalBacktestPassed: boolean; auditedJournal: boolean; brokerRiskControlsVerified: boolean;
  proposedQuantity: number; fullPlannedQuantity: number;
  approval: { planHash: string; expiresAt: number; approvedBy: string; approved: boolean } | null;
}
/** Informational checklist only. Live transport requires checkAlpacaLiveAuthorization and recorded broker evidence. */
export function assessAlpacaLiveReadiness(value: LiveReadiness, planHash: string, now: number): { eligible: boolean; reasons: string[]; liveTransportEnabled: false } {
  const reasons: string[] = [];
  if (!Number.isFinite(value.paperDays) || value.paperDays < 14) reasons.push("at_least_14_paper_days_required");
  if (!Number.isFinite(value.cleanPaperDays) || value.cleanPaperDays < 14) reasons.push("at_least_14_clean_days_required");
  if (!value.paperMatchesBacktest || !value.realHistoricalBacktestPassed) reasons.push("historical_and_paper_consistency_required");
  if (!value.auditedJournal || !value.brokerRiskControlsVerified) reasons.push("audit_and_broker_controls_required");
  if (!Number.isInteger(value.proposedQuantity) || value.proposedQuantity <= 0 || !Number.isInteger(value.fullPlannedQuantity) || value.fullPlannedQuantity <= 0 || value.proposedQuantity > Math.floor(value.fullPlannedQuantity * .1)) reasons.push("tiny_live_size_maximum_ten_percent");
  if (!value.approval || value.approval.approved !== true || !value.approval.approvedBy.trim() || value.approval.planHash !== planHash || !Number.isFinite(value.approval.expiresAt) || value.approval.expiresAt <= now) reasons.push("current_per_order_human_approval_required");
  return { eligible: reasons.length === 0, reasons, liveTransportEnabled: false };
}

export interface AlpacaLiveOptions extends Omit<AlpacaOptions, "paper" | "baseUrl" | "allowPaperOrders">, AlpacaLiveGatePaths { allowLiveOrders: boolean }

class AlpacaRestBroker implements DeskBroker {
  readonly mode: "alpaca-paper" | "alpaca-live";
  private readonly transport: typeof fetch;
  private readonly clock: () => number;
  private readonly timeout: number;
  private readonly journal: DeskJournal;
  constructor(private readonly options: AlpacaOptions, private readonly live?: AlpacaLiveOptions) {
    this.mode = live ? "alpaca-live" : "alpaca-paper";
    if (!options.apiKey || !options.secretKey) throw new Error("alpaca_paper_credentials_required");
    if (!live && (options.paper === false || (options.baseUrl && options.baseUrl !== PAPER_BASE))) throw new Error("live_or_custom_broker_endpoint_forbidden");
    this.transport = options.fetch ?? fetch; this.clock = options.now ?? Date.now;
    this.timeout = options.timeoutMs ?? 10_000; this.journal = options.journal;
    if (live && (!live.allowLiveOrders || !live.expectedAccountId || !live.readinessReportFile || !live.orderAuthorizationFile)) throw new Error("explicit_live_configuration_and_authorization_files_required");
    this.journal.claim("desk:external-broker-mode", this.mode);
    if (this.journal.load("desk:external-broker-mode") !== this.mode) throw new Error("paper_and_live_require_separate_journals");
  }
  private bindAccount(accountId: unknown): asserts accountId is string {
    if (typeof accountId !== "string" || !accountId || (this.live && accountId !== this.live.expectedAccountId)) throw new Error("broker_account_identity_mismatch");
    this.journal.claim("alpaca:verified-account-id", accountId);
    if (this.journal.load("alpaca:verified-account-id") !== accountId) throw new Error("broker_credentials_changed_account");
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<Response> {
    return this.transport(`${this.live ? LIVE_BASE : PAPER_BASE}${path}`, { method, headers: { "APCA-API-KEY-ID": this.options.apiKey, "APCA-API-SECRET-KEY": this.options.secretKey, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeout), redirect: "error" });
  }
  private async read(path: string): Promise<unknown> {
    const response = await this.request(path); if (!response.ok) throw new Error(`alpaca_read_failed:${response.status}`); return response.json();
  }
  async account(): Promise<unknown> { return this.read("/v2/account"); }
  async positions(): Promise<unknown> { return this.read("/v2/positions"); }
  async openOrders(): Promise<unknown> { return this.read("/v2/orders?status=open&nested=true"); }
  async calendar(start: string, end: string): Promise<unknown> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("invalid_calendar_range");
    return this.read(`/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  }
  async readAccountRisk(): Promise<Pick<RiskSnapshot, "equity" | "cash" | "dayStartEquity" | "lossStreak" | "positions" | "openOrders" | "accountingPending">> {
    const [accountRaw, positionsRaw, ordersRaw] = await Promise.all([this.account(), this.positions(), this.openOrders()]);
    const account = accountRaw as Record<string, unknown>;
    if (!account || typeof account.id !== "string" || !Array.isArray(positionsRaw) || !Array.isArray(ordersRaw) || (this.live && account.id !== this.live.expectedAccountId)) throw new Error("broker_portfolio_unavailable");
    this.bindAccount(account.id);
    const equity = Number(account.equity), cash = Number(account.cash), dayStartEquity = Number(account.last_equity);
    if (![equity, cash, dayStartEquity].every(Number.isFinite)) throw new Error("broker_portfolio_invalid");
    const orders = ordersRaw as Record<string, unknown>[];
    const flatten = (values: Record<string, unknown>[]): Record<string, unknown>[] => values.flatMap(order => [order, ...(Array.isArray(order.legs) ? flatten(order.legs as Record<string, unknown>[]) : [])]);
    const children = flatten(orders);
    const positions = (positionsRaw as Record<string, unknown>[]).map(position => {
      const stops = children.filter(order => order.symbol === position.symbol && order.side === "sell" && ["stop", "stop_limit"].includes(String(order.type)) && ["new", "accepted", "held", "pending_new"].includes(String(order.status)) && Number(order.qty) >= Number(position.qty));
      return { symbol: String(position.symbol), quantity: Number(position.qty), marketPrice: Number(position.current_price), stop: stops.length === 1 && Number.isFinite(Number(stops[0]!.stop_price)) ? Number(stops[0]!.stop_price) : null, correlationGroup: null };
    });
    const openOrders = orders.filter(order => order.side === "buy").map(order => ({ symbol: String(order.symbol), quantity: Number(order.qty), entry: Number(order.limit_price), stop: null, correlationGroup: null }));
    // Unknown realized costs pause entries. They are never converted into a claimed
    // three-loss streak or a guessed final zero commission.
    let lossStreak = 0, accountingPending = false;
    const latest = new Map<string, { ts: number; payload: any }>();
    for (const event of this.journal.events()) if (event.kind === (this.live ? "alpaca_live_verified_order" : "alpaca_paper_verified_order") && (event.payload as any).order.status === "closed") latest.set((event.payload as any).order.clientOrderId, { ts: event.ts, payload: event.payload });
    const outcomes = [...latest.values()].sort((a, b) => b.ts - a.ts);
    let settledFeeBound = 0;
    const unknownFees = outcomes.some(event => event.payload.execution?.feesUsd == null);
    if (unknownFees) {
      accountingPending = true;
      const firstIntent = this.journal.events().find(event => event.kind === "alpaca_intent");
      const baseline = this.journal.events().find(event => event.kind === "alpaca_account_telemetry" && (event.payload as any).accountId === account.id);
      // A complete quiet account window can establish settled total costs; a fresh
      // activity page before fees settle cannot. Unattributed cash flows keep the pause.
      if (firstIntent && baseline && !positions.length && !openOrders.length && this.clock() - outcomes[0]!.ts >= 4 * 86_400_000) {
        try {
          const after = new Date(firstIntent.ts - 1).toISOString(), until = new Date(this.clock()).toISOString();
          await this.captureActivities(after, until);
          const expected = new Map<string, { quantity: number; notional: number; side: string }>();
          let grossPnl = 0;
          for (const event of outcomes) {
            const order = event.payload.order, execution = event.payload.execution;
            if (!execution || !Number.isFinite(execution.entryFilledQty) || !Number.isFinite(execution.entryFilledPrice) || !Array.isArray(execution.exits)) throw new Error("outcome_details_missing");
            expected.set(order.id, { quantity: execution.entryFilledQty, notional: execution.entryFilledQty * execution.entryFilledPrice, side: "buy" });
            grossPnl -= execution.entryFilledQty * execution.entryFilledPrice;
            for (const exit of execution.exits) if (exit.qty > 0) {
              if (!exit.id || !Number.isFinite(exit.qty) || !Number.isFinite(exit.price)) throw new Error("outcome_exit_missing");
              expected.set(exit.id, { quantity: exit.qty, notional: exit.qty * exit.price, side: "sell" }); grossPnl += exit.qty * exit.price;
            }
          }
          const filled = new Map<string, { quantity: number; notional: number }>();
          for (const event of this.journal.events()) if (event.kind === "alpaca_account_activity" && (event.payload as any).accountId === account.id) {
            const activity = (event.payload as any).activity, at = Date.parse(activity.transaction_time ?? activity.created_at ?? activity.date);
            if (!Number.isFinite(at)) throw new Error("activity_time_unknown");
            if (at < firstIntent.ts || at > this.clock()) continue;
            if (activity.activity_type === "FILL") {
              const match = expected.get(activity.order_id), quantity = Number(activity.qty), price = Number(activity.price);
              if (!match || match.side !== activity.side || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) throw new Error("unattributed_fill");
              const previous = filled.get(activity.order_id) ?? { quantity: 0, notional: 0 };
              filled.set(activity.order_id, { quantity: previous.quantity + quantity, notional: previous.notional + quantity * price });
            } else {
              if (!["FEE", "PTC", "PTR"].includes(activity.activity_type) || !Number.isFinite(Number(activity.net_amount)) || activity.status !== "executed" || (activity.currency !== undefined && activity.currency !== "USD")) throw new Error("nontrade_flow_unreconciled");
              settledFeeBound -= Number(activity.net_amount);
            }
          }
          if (settledFeeBound < 0 || filled.size !== expected.size || [...expected].some(([id, value]) => !filled.has(id) || Math.abs(filled.get(id)!.quantity - value.quantity) > 1e-8 || Math.abs(filled.get(id)!.notional - value.notional) > .01)) throw new Error("fills_or_fees_unreconciled");
          const initial = baseline.payload as any;
          if (initial.positions.length || initial.openOrders.length || Math.abs(equity - initial.equity - grossPnl + settledFeeBound) > .01) throw new Error("account_equity_unreconciled");
          accountingPending = false;
        } catch { accountingPending = true; }
      }
    }
    for (const event of outcomes) {
      const execution = event.payload.execution;
      if (!execution || !Number.isFinite(execution.entryFilledQty) || !Number.isFinite(execution.entryFilledPrice) || !Array.isArray(execution.exits) ||
          execution.exits.some((exit: any) => !Number.isFinite(exit.qty) || (exit.qty > 0 && !Number.isFinite(exit.price)))) { accountingPending = true; break; }
      const gross = execution.exits.reduce((sum: number, exit: any) => sum + exit.qty * (exit.price ?? 0), 0) - execution.entryFilledQty * execution.entryFilledPrice;
      if (execution.feesUsd == null && accountingPending) { if (gross < 0) lossStreak++; else break; }
      else if (gross - (execution.feesUsd ?? settledFeeBound) < 0) lossStreak++;
      else break;
    }
    const result = { equity, cash, dayStartEquity, lossStreak, positions, openOrders, accountingPending };
    this.journal.append("alpaca_account_telemetry", { accountId: account.id, mode: this.mode, equity, cash, dayStartEquity, positions: positionsRaw, openOrders: ordersRaw }, `alpaca:account:${this.clock()}:${hash({ account, positions: positionsRaw, orders: ordersRaw })}`, this.clock());
    return result;
  }
  /** Read-only capture of paginated broker activities for fee/outcome reconciliation. */
  async captureActivities(after: string, until: string): Promise<{ records: number; complete: true }> {
    if (!Number.isFinite(Date.parse(after)) || !Number.isFinite(Date.parse(until)) || Date.parse(after) >= Date.parse(until) || Date.parse(until) > this.clock()) throw new Error("invalid_activity_capture_period");
    let pageToken = "", records = 0;
    const account = await this.account() as Record<string, unknown>;
    if (typeof account.id !== "string" || (this.live && account.id !== this.live.expectedAccountId)) throw new Error("activity_account_mismatch");
    this.bindAccount(account.id);
    for (let page = 0; page < 100; page++) {
      const rows = await this.read(`/v2/account/activities?after=${encodeURIComponent(after)}&until=${encodeURIComponent(until)}&direction=asc&page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`);
      if (!Array.isArray(rows)) throw new Error("activities_response_invalid");
      for (const row of rows) {
        if (!row || typeof row.id !== "string") throw new Error("activity_id_missing");
        this.journal.append("alpaca_account_activity", { accountId: account.id, mode: this.mode, activity: row }, `alpaca:activity:${account.id}:${row.id}`, this.clock()); records++;
      }
      if (rows.length < 100) {
        this.journal.append("alpaca_activity_coverage", { accountId: account.id, mode: this.mode, after, until, complete: true }, `alpaca:activity-coverage:${account.id}:${after}:${until}`, this.clock());
        return { records, complete: true };
      }
      const last = rows.at(-1)?.id;
      if (!last || last === pageToken) throw new Error("activities_pagination_stalled"); pageToken = last;
    }
    throw new Error("activities_capture_incomplete_page_limit");
  }
  private convert(value: unknown, request: BracketRequest): BrokerOrder {
    const order = value as Record<string, unknown>;
    if (!order || order.client_order_id !== request.clientOrderId || order.symbol !== request.plan.symbol || order.side !== "buy" ||
        Number(order.qty) !== request.plan.quantity || Number(order.limit_price) !== request.plan.entry || order.order_class !== "bracket") throw new Error("alpaca_order_does_not_match_approved_plan");
    const legs = Array.isArray(order.legs) ? order.legs as Record<string, unknown>[] : [];
    const stop = legs.find(leg => Number(leg.stop_price) === request.plan.stop && leg.side === "sell" && !["canceled", "expired", "rejected"].includes(String(leg.status)));
    const target = legs.find(leg => Number(leg.limit_price) === request.plan.target && leg.side === "sell" && !["canceled", "expired", "rejected"].includes(String(leg.status)));
    const quantity = Number(order.filled_qty ?? 0), filledPrice = order.filled_avg_price == null ? null : Number(order.filled_avg_price);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > request.plan.quantity || (filledPrice !== null && (!Number.isFinite(filledPrice) || filledPrice <= 0))) throw new Error("invalid_alpaca_fill");
    const status = String(order.status);
    const normalized: BrokerOrder["status"] = status === "filled" ? "filled" : ["canceled", "expired"].includes(status) ? "cancelled" : status === "rejected" ? "rejected" :
      ["new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding", "done_for_day", "pending_cancel"].includes(status) ? "accepted" : "unknown";
    const exitQuantity = legs.reduce((sum, leg) => sum + (leg.side === "sell" ? Number(leg.filled_qty ?? 0) : 0), 0);
    if (!Number.isFinite(exitQuantity) || exitQuantity < 0 || exitQuantity > quantity) throw new Error("invalid_alpaca_exit_fills");
    const closed = quantity > 0 && exitQuantity === quantity && (normalized === "filled" || normalized === "cancelled" || normalized === "rejected");
    const liveLeg = (leg: Record<string, unknown> | undefined) => !!leg && ["new", "accepted", "pending_new", "accepted_for_bidding"].includes(String(leg.status));
    const protectiveStop = stop && (liveLeg(stop) || String(stop.status) === "held") && Number(stop.qty) - Number(stop.filled_qty ?? 0) >= quantity - exitQuantity && stop.symbol === request.plan.symbol && ["stop", "stop_limit"].includes(String(stop.type));
    const protectiveTarget = liveLeg(target) && Number(target!.qty) - Number(target!.filled_qty ?? 0) >= quantity - exitQuantity && target!.symbol === request.plan.symbol && target!.type === "limit";
    const protectedFill = quantity === request.plan.quantity && !!protectiveStop && !!protectiveTarget;
    return { id: String(order.id ?? ""), clientOrderId: request.clientOrderId, planHash: request.planHash, symbol: request.plan.symbol,
      status: closed ? "closed" : normalized, filledQuantity: quantity, filledPrice, bracketProtected: closed || protectedFill,
      ...(quantity > 0 && !closed && !protectedFill ? { reason: "bracket_legs_not_verified" } : {}) };
  }
  private unknown(request: BracketRequest, reason: string): BrokerOrder {
    return { id: "", clientOrderId: request.clientOrderId, planHash: request.planHash, symbol: request.plan.symbol, status: "unknown", filledQuantity: 0, filledPrice: null, bracketProtected: false, reason };
  }
  async findOrder(clientOrderId: string): Promise<BrokerOrder | null> {
    const account = await this.account() as Record<string, unknown>; this.bindAccount(account?.id);
    const stored = this.journal.load<StoredSubmission>(`alpaca:${clientOrderId}`);
    if (!stored) throw new Error("alpaca_reconciliation_requires_durable_intent");
    const response = await this.request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`alpaca_reconciliation_failed:${response.status}`);
    const parent = await response.json() as Record<string, unknown>;
    if (typeof parent.id !== "string" || !parent.id) throw new Error("alpaca_order_id_missing");
    const rawOrder = await this.read(`/v2/orders/${encodeURIComponent(parent.id)}?nested=true`);
    const order = this.convert(rawOrder, stored.request);
    this.journal.save(`alpaca:${clientOrderId}`, { ...stored, state: order.status === "unknown" ? "unknown" : "confirmed", order });
    const accountId = this.journal.load<string>("alpaca:verified-account-id");
    if (accountId) this.recordVerifiedOrder(order, stored.request, accountId, rawOrder);
    this.journal.append("alpaca_reconciled", { clientOrderId, order }, `alpaca:${clientOrderId}:reconciled:${hash(order)}`, this.clock());
    return order;
  }
  async submitBracket(request: BracketRequest): Promise<BrokerOrder> {
    if (this.live ? !this.live.allowLiveOrders : !this.options.allowPaperOrders) throw new Error("alpaca_writes_not_enabled");
    validatePlan(request.plan);
    const now = this.clock();
    if (request.approval.mode !== (this.live ? "live" : "paper") || request.approval.synthetic || request.approval.planHash !== request.planHash || hash(request.plan) !== request.planHash || request.approval.expiresAt <= now || request.approval.approvedAt > now) throw new Error("invalid_or_expired_alpaca_paper_approval");
    if (!/^desk-[a-f0-9]{40}$/.test(request.clientOrderId)) throw new Error("invalid_alpaca_client_order_id");
    const key = `alpaca:${request.clientOrderId}`, previous = this.journal.load<StoredSubmission>(key);
    if (previous) {
      if (hash(previous.request) !== hash(request)) throw new Error("alpaca_client_order_id_conflict");
      if (previous.state === "rejected" && previous.order) return previous.order;
      try { return await this.findOrder(request.clientOrderId) ?? this.unknown(request, "previous_submission_not_found_do_not_resubmit"); }
      catch { return this.unknown(request, "reconciliation_unavailable_do_not_resubmit"); }
    }
    // Reservation survives crashes. Even a crash before POST requires manual reconciliation, never blind replay.
    if (!this.journal.claim(key, { request, state: "reserved" } satisfies StoredSubmission)) return this.unknown(request, "concurrent_submission_reserved");
    this.journal.append("alpaca_intent", request, `${key}:intent`, now);
    // A stable client ID may already exist at the broker after local restoration. Check before sending.
    try {
      const existing = await this.findOrder(request.clientOrderId);
      if (existing) return existing;
    } catch {
      const order = this.unknown(request, "preflight_reconciliation_unavailable_no_order_sent");
      this.journal.save(key, { request, state: "unknown", order }); return order;
    }
    let accountId: string;
    try { accountId = await this.verifyAccount(request); } catch (error) {
      const order: BrokerOrder = { ...this.unknown(request, String(error)), status: "rejected" }; this.journal.save(key, { request, state: "rejected", order }); return order;
    }
    const freshNow = this.clock();
    if (request.approval.expiresAt <= freshNow || request.approval.approvedAt > freshNow || !Number.isFinite(request.quoteObservedAt) || !Number.isFinite(request.riskObservedAt) || request.quoteObservedAt > freshNow || request.riskObservedAt > freshNow || freshNow - request.quoteObservedAt > 60_000 || freshNow - request.riskObservedAt > 60_000) {
      const order: BrokerOrder = { ...this.unknown(request, "approval_or_market_evidence_expired_before_post"), status: "rejected" };
      this.journal.save(key, { request, state: "rejected", order }); return order;
    }
    try {
      this.assertAuthority(request, freshNow);
      if (this.live) {
        const authorization = checkAlpacaLiveAuthorization(this.live, request, freshNow);
        const actual = this.journal.getEvidence<RiskSnapshot>(request.currentRiskEvidenceId)!.payload;
        const full = authorization.fullSizePlan;
        if (full.quantity * (full.entry - full.stop) > actual.equity * .01 + 1e-8 || full.quantity * full.entry > Math.min(actual.cash, actual.equity) + 1e-8) throw new Error("live_reference_plan_exceeds_actual_account_risk");
        const key = `live-auth:${authorization.id}`;
        if (!this.journal.claim(key, { authorizationHash: hash(authorization), clientOrderId: request.clientOrderId })) throw new Error("live_human_approval_already_consumed");
        if (authorization.expiresAt <= this.clock()) throw new Error("live_authorization_expired_at_write_boundary");
      }
      this.assertAuthority(request, this.clock());
    } catch (error) {
      const order: BrokerOrder = { ...this.unknown(request, String(error)), status: "rejected" }; this.journal.save(key, { request, state: "rejected", order }); return order;
    }
    const body = { symbol: request.plan.symbol, qty: String(request.plan.quantity), side: "buy", type: "limit", time_in_force: "gtc",
      limit_price: request.plan.entry.toFixed(2), client_order_id: request.clientOrderId, order_class: "bracket", extended_hours: false,
      take_profit: { limit_price: request.plan.target.toFixed(2) }, stop_loss: { stop_price: request.plan.stop.toFixed(2) } };
    let response: Response;
    try { response = await this.request("/v2/orders", "POST", body); }
    catch { return this.reconcileAmbiguous(request, "submission_transport_ambiguous"); }
    if (response.status >= 500 || response.status === 408 || response.status === 429 || response.status === 409 || response.status === 422) return this.reconcileAmbiguous(request, `submission_http_${response.status}_reconcile_required`);
    if (!response.ok) {
      const order: BrokerOrder = { ...this.unknown(request, `submission_rejected_http_${response.status}`), status: "rejected" };
      this.journal.save(key, { request, state: "rejected", order }); return order;
    }
    try {
      const parent = await response.json() as Record<string, unknown>;
      if (typeof parent.id !== "string" || !parent.id) throw new Error("alpaca_order_id_missing");
      const rawOrder = await this.read(`/v2/orders/${encodeURIComponent(parent.id)}?nested=true`);
      const order = this.convert(rawOrder, request);
      this.journal.save(key, { request, state: "confirmed", order });
      this.journal.append("alpaca_order", order, `${key}:response`, this.clock());
      this.recordVerifiedOrder(order, request, accountId, rawOrder); return order;
    } catch { return this.reconcileAmbiguous(request, "submission_response_unverifiable"); }
  }
  private assertAuthority(request: BracketRequest, now: number): void {
    if (request.approval.expiresAt <= now || request.approval.approvedAt > now) throw new Error("approval_expired_at_write_boundary");
    if (this.journal.load("desk:kill")) throw new Error("kill_latched_before_broker_write");
    const sessionClose = this.journal.load<number>("alpaca:session-close");
    if (!Number.isFinite(sessionClose) || sessionClose! <= now) throw new Error("broker_session_closed_at_write_boundary");
    const intent = this.journal.load<{ caseId: string; request: BracketRequest }>(`order:${request.clientOrderId}`);
    if (!intent || hash(intent.request) !== hash(request)) throw new Error("durable_order_intent_required");
    const state = this.journal.load<CaseState>(`case:${intent.caseId}`);
    const approvalEvent = this.journal.events().find(event => event.kind === "case_transition" && (event.payload as any).id === intent.caseId && (event.payload as any).role === "risk" && (event.payload as any).state.stage === "APPROVED");
    if (!state || state.stage !== "UNKNOWN" || !approvalEvent || hash((approvalEvent.payload as any).state.approval) !== hash(request.approval) ||
        this.journal.load<{ caseId: string }>("desk:execution-lock")?.caseId !== intent.caseId) throw new Error("durable_risk_approval_and_execution_reservation_required");
    const quote = this.journal.getEvidence<Quote>(request.quoteEvidenceId), risk = this.journal.getEvidence<RiskSnapshot>(request.currentRiskEvidenceId);
    if (!quote || !risk || quote.provenance !== "observed" || risk.provenance !== "observed") throw new Error("observed_market_and_risk_evidence_required");
    verifyEvidence(quote, now, 60_000); verifyEvidence(risk, now, 60_000);
    if (quote.observedAt !== request.quoteObservedAt || risk.observedAt !== request.riskObservedAt || quote.payload.symbol !== request.plan.symbol ||
        Math.abs(quote.payload.ask - request.plan.entry) / request.plan.entry > .005) throw new Error("fresh_quote_and_exact_entry_required");
  }
  private async verifyAccount(request: BracketRequest): Promise<string> {
    const [accountValue, positionsValue, ordersValue, clockValue] = await Promise.all([this.account(), this.positions(), this.openOrders(), this.read("/v2/clock")]);
    const account = accountValue as Record<string, unknown>, marketClock = clockValue as Record<string, unknown>;
    const observedAt = Date.parse(String(marketClock?.timestamp)), sessionClose = Date.parse(String(marketClock?.next_close));
    if (marketClock?.is_open !== true || !Number.isFinite(observedAt) || !Number.isFinite(sessionClose) || observedAt > this.clock() + 1000 || this.clock() - observedAt > 60_000 || sessionClose <= this.clock()) throw new Error("broker_market_session_closed_or_unknown");
    this.journal.save("alpaca:session-close", sessionClose);
    if (!account || typeof account.id !== "string" || account.status !== "ACTIVE" || account.trading_blocked !== false || account.account_blocked !== false ||
        (this.live && account.id !== this.live.expectedAccountId) || !Array.isArray(positionsValue) || !Array.isArray(ordersValue)) throw new Error("broker_account_not_verified_active_or_expected");
    const equity = Number(account.equity), cash = Number(account.cash), dayStart = Number(account.last_equity);
    if (![equity, cash, dayStart].every(Number.isFinite) || equity <= 0 || cash < 0 || dayStart <= 0 || (dayStart - equity) / dayStart >= .02 - 1e-10 ||
        request.plan.quantity * (request.plan.entry - request.plan.stop) > equity * .01 + 1e-8) throw new Error("broker_account_risk_limit");
    const positions = positionsValue as Record<string, unknown>[], orders = ordersValue as Record<string, unknown>[];
    const buys = orders.filter(order => order.side === "buy");
    if (positions.some(position => !(Number(position.qty) > 0) || !Number.isFinite(Number(position.market_value))) || buys.some(order => !Number.isFinite(Number(order.qty)) || Number(order.qty) <= 0 || !Number.isFinite(Number(order.limit_price)) || Number(order.limit_price) <= 0)) throw new Error("broker_existing_exposure_unknown");
    if ([...positions, ...buys].some(item => item.symbol === request.plan.symbol)) throw new Error("broker_existing_or_pending_symbol");
    if (new Set([...positions, ...buys].map(item => item.symbol)).size >= 5) throw new Error("broker_position_limit");
    const reserved = buys.reduce((sum, order) => sum + Number(order.qty) * Number(order.limit_price), 0), notional = request.plan.quantity * request.plan.entry;
    if (notional + reserved > cash + 1e-8 || positions.reduce((sum, position) => sum + Math.abs(Number(position.market_value)), 0) + reserved + notional > equity + 1e-8) throw new Error("broker_cash_or_gross_exposure_limit");
    const risk = this.journal.getEvidence<RiskSnapshot>(request.currentRiskEvidenceId);
    if (!risk || Math.abs(risk.payload.equity - equity) > .01 || Math.abs(risk.payload.cash - cash) > .01 || Math.abs(risk.payload.dayStartEquity - dayStart) > .01 ||
        risk.payload.positions.length !== positions.length || positions.some(position => !risk.payload.positions.some(snapshot => snapshot.symbol === position.symbol && snapshot.quantity === Number(position.qty))) ||
        risk.payload.openOrders.length !== buys.length || buys.some(order => !risk.payload.openOrders.some(snapshot => snapshot.symbol === order.symbol && snapshot.quantity === Number(order.qty) && snapshot.entry === Number(order.limit_price)))) throw new Error("risk_snapshot_disagrees_with_authoritative_broker_account");
    this.bindAccount(account.id);
    if (this.journal.events().some(event => ["alpaca_paper_verified_order", "alpaca_live_verified_order"].includes(event.kind) && (event.payload as any).order.status === "closed")) {
      const accounting = await this.readAccountRisk();
      if (accounting.accountingPending || accounting.lossStreak >= 3) throw new Error("broker_realized_outcome_costs_unreconciled_or_loss_limit");
    }
    this.journal.append("alpaca_account_telemetry", { accountId: account.id, mode: this.mode, equity, cash, dayStartEquity: dayStart, positions, openOrders: orders }, `alpaca:account:${this.clock()}:${hash({ account, positions, orders })}`, this.clock());
    return account.id;
  }
  private recordVerifiedOrder(order: BrokerOrder, request: BracketRequest, accountId: string, raw: unknown): void {
    const kind = this.live ? "alpaca_live_verified_order" : "alpaca_paper_verified_order";
    const rawOrder = raw as Record<string, unknown>;
    const execution = { entryFilledQty: order.filledQuantity, entryFilledPrice: order.filledPrice, feesUsd: null,
      exits: (Array.isArray(rawOrder.legs) ? rawOrder.legs as Record<string, unknown>[] : []).map(leg => ({ id: String(leg.id ?? ""), qty: Number(leg.filled_qty ?? 0), price: leg.filled_avg_price == null ? null : Number(leg.filled_avg_price), status: String(leg.status), side: String(leg.side), type: String(leg.type) })) };
    this.journal.append(kind, { accountId, strategyId: request.plan.strategyId, parametersHash: request.plan.parametersHash, order, execution }, `${kind}:${order.clientOrderId}:${hash(order)}`, this.clock());
  }
  private async reconcileAmbiguous(request: BracketRequest, reason: string): Promise<BrokerOrder> {
    const key = `alpaca:${request.clientOrderId}`;
    this.journal.save(key, { request, state: "unknown" });
    this.journal.append("alpaca_ambiguous", { clientOrderId: request.clientOrderId, reason, action: "RECONCILE_ONLY" }, `${key}:ambiguous`, this.clock());
    let order: BrokerOrder;
    try { order = await this.findOrder(request.clientOrderId) ?? this.unknown(request, `${reason};broker_not_found_is_not_proof_of_non_submission`); }
    catch { order = this.unknown(request, `${reason};reconciliation_unavailable`); }
    this.journal.save(key, { request, state: order.status === "unknown" ? "unknown" : "confirmed", order }); return order;
  }
  async emergencyFlatten(): Promise<EmergencyResult> {
    if (this.live ? !this.live.allowLiveOrders : !this.options.allowPaperOrders) return { confirmed: false, openOrders: null, openPositions: null, reason: "alpaca_paper_writes_not_enabled" };
    try {
      if (!this.journal.load("desk:kill")) throw new Error("emergency_requires_kill_latch");
      const before = await this.account() as Record<string, unknown>;
      if (!before.id || (this.live && before.id !== this.live.expectedAccountId)) throw new Error("emergency_account_mismatch");
      this.bindAccount(before.id);
      const cancel = await this.request("/v2/orders", "DELETE");
      if (!cancel.ok) throw new Error(`cancel_failed:${cancel.status}`);
      // Broker emergency liquidation is intentionally separate from ordinary limit-bracket entries.
      const close = await this.request("/v2/positions?cancel_orders=true", "DELETE");
      if (!close.ok) throw new Error(`close_failed:${close.status}`);
      const [orders, positions, account] = await Promise.all([this.openOrders(), this.positions(), this.account()]);
      if (!Array.isArray(orders) || !Array.isArray(positions) || !account || typeof account !== "object") throw new Error("invalid_emergency_reconciliation");
      return { confirmed: orders.length === 0 && positions.length === 0, openOrders: orders.length, openPositions: positions.length,
        ...(orders.length || positions.length ? { reason: "broker_not_yet_flat_keep_trader_paused" } : {}) };
    } catch { return { confirmed: false, openOrders: null, openPositions: null, reason: "emergency_outcome_unknown_keep_trader_paused" }; }
  }
}

/** Paper constructor cannot be switched to live by an environment variable or custom URL. */
export class AlpacaPaperBroker extends AlpacaRestBroker {
  constructor(options: AlpacaOptions) { super(options); }
}
/** Live is a distinct transport; every entry revalidates real-paper artifacts and human approval. */
export class AlpacaLiveBroker extends AlpacaRestBroker {
  constructor(options: AlpacaLiveOptions) { super({ ...options, paper: false }, options); }
}
