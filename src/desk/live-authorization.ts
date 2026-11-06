import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assessStrategyEvidence } from "../evaluation/strategy";
import type { StrategyEvidence } from "../evaluation/strategy";
import { hash, validatePlan } from "./evidence";
import type { BracketRequest, BrokerOrder, TradePlan } from "./types";

export interface AlpacaPaperReadinessReport {
  version: 1; source: "alpaca-paper"; eligible: true; paperAccountId: string;
  strategyId: string; parametersHash: string; generatedAt: number;
  startedAt: number; endedAt: number; observedDates: string[];
  filledOrders: number; closedTrades: number; unresolvedOrders: number; ruleViolations: number;
  netPnlUsd: number; expectedNetPnlRangeUsd: [number, number]; maxDrawdownFraction: number;
  backtest: StrategyEvidence & { strategyId: string; parametersHash: string };
  /** Full journal export, including genesis and every hash-chain field. */
  paperJournalPath: string; paperJournalSha256: string;
  /** Precommitted comparison design; the range is recomputed from the holdout. */
  expectedRangePath: string; expectedRangeSha256: string;
}
export interface AlpacaExpectedRangeArtifact {
  version: 1; source: "chronological-historical-holdout";
  strategyId: string; parametersHash: string; datasetHash: string; backtestHash: string;
  initialEquityUsd: number; windowDurationMs: number; createdAt: number;
}
export interface AlpacaLiveOrderAuthorization {
  /** The adapter must reserve this human approval ID before its first POST. */
  id: string; clientOrderId: string;
  version: 1; approved: true; approvedBy: string; accountId: string;
  planHash: string; issuedAt: number; expiresAt: number; reportSha256: string;
  fullSizePlan: TradePlan;
}
export interface AlpacaLiveGatePaths { readinessReportFile: string; orderAuthorizationFile: string; expectedAccountId: string }
export interface PaperEvidenceMetrics {
  filledOrders: number; closedTrades: number; unresolvedOrders: number; ruleViolations: number;
  netPnlUsd: number; maxDrawdownFraction: number; initialEquityUsd: number; observedDates: string[];
  feeEvidence: "explicit_order_fees" | "complete_account_activities";
}
export interface PaperAuditEvent { seq: number; event_key: string; ts: number; kind: string; payload: any; previous_hash: string; event_hash: string }
interface ExitFill { id: string; qty: number; price: number | null; status: string; side: string; type: string }
interface Execution { entryFilledQty: number; entryFilledPrice: number | null; feesUsd: number | null; exits: ExitFill[] }
interface VerifiedOrder { accountId: string; strategyId: string; parametersHash: string; order: BrokerOrder; execution?: Execution }
const DAY = 86_400_000, MAX_REPORT_BYTES = 64 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const moneyEqual = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= .01;
const exactEnough = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function readBoundJson(path: string, expectedHash?: string): { value: any; digest: string } {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_REPORT_BYTES) throw new Error("live_evidence_artifact_too_large");
  const digest = sha(bytes);
  if (expectedHash !== undefined && digest !== expectedHash) throw new Error("live_evidence_artifact_hash_mismatch");
  return { value: JSON.parse(bytes.toString("utf8")), digest };
}

/** Integrity checking is not a signature proving broker authenticity. */
export function verifyPaperJournalExport(value: unknown, generatedAt: number): PaperAuditEvent[] {
  if (!Array.isArray(value) || !value.length || value.length > 500_000) throw new Error("live_paper_journal_invalid");
  let previous = "GENESIS";
  const keys = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const event = value[i] as PaperAuditEvent;
    if (!event || event.seq !== i + 1 || typeof event.event_key !== "string" || !event.event_key || keys.has(event.event_key) ||
        !positive(event.ts) || event.ts > generatedAt || typeof event.kind !== "string" || !event.kind || event.previous_hash !== previous ||
        event.event_hash !== hash({ eventKey: event.event_key, ts: event.ts, kind: event.kind, payload: event.payload, previous })) throw new Error("live_paper_journal_integrity_failure");
    keys.add(event.event_key); previous = event.event_hash;
  }
  return value as PaperAuditEvent[];
}
function quantile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/** Use all complete, nonoverlapping chronological holdout windows, including losing ones. */
export function deriveExpectedPaperRange(report: AlpacaPaperReadinessReport, artifact: AlpacaExpectedRangeArtifact, initialEquityUsd: number): [number, number] {
  const backtest = report.backtest;
  if (!artifact || artifact.version !== 1 || artifact.source !== "chronological-historical-holdout" || artifact.strategyId !== report.strategyId ||
      artifact.parametersHash !== report.parametersHash || artifact.datasetHash !== backtest.datasetHash || artifact.backtestHash !== hash(backtest) ||
      !positive(artifact.createdAt) || artifact.createdAt > report.startedAt || backtest.historyEnd > artifact.createdAt ||
      backtest.evaluationEnd > artifact.createdAt || !positive(artifact.windowDurationMs) || artifact.windowDurationMs !== report.endedAt - report.startedAt ||
      !positive(artifact.initialEquityUsd) || !moneyEqual(artifact.initialEquityUsd, initialEquityUsd)) throw new Error("live_expected_range_not_precommitted_or_strategy_matched");
  const count = Math.floor((backtest.evaluationEnd - backtest.evaluationStart) / artifact.windowDurationMs);
  if (count < 20 || count > 10_000) throw new Error("live_expected_range_requires_twenty_complete_holdout_windows");
  const windows = Array<number>(count).fill(0);
  for (const trade of backtest.trades) {
    // Windows use (start, end], matching realized cash changes at their ending boundary.
    const index = Math.ceil((trade.closedAt - backtest.evaluationStart) / artifact.windowDurationMs) - 1;
    if (index >= 0 && index < count) windows[index]! += trade.netPnlUsd;
  }
  windows.sort((a, b) => a - b);
  return [quantile(windows, .05), quantile(windows, .95)];
}

function activityFeeTotal(events: PaperAuditEvent[], report: AlpacaPaperReadinessReport, expectedFills: Map<string, { symbol: string; side: string; qty: number; notional: number }>): number {
  const covered = events.some(event => {
    if (event.kind !== "alpaca_activity_coverage" || event.payload?.accountId !== report.paperAccountId || event.payload?.mode !== "alpaca-paper" || event.payload?.complete !== true) return false;
    const after = Date.parse(event.payload.after), until = Date.parse(event.payload.until);
    return Number.isFinite(after) && Number.isFinite(until) && after < report.startedAt && until > report.endedAt && event.ts >= until;
  });
  if (!covered) throw new Error("live_paper_fees_unknown_without_complete_activity_coverage");
  const activities = new Map<string, any>();
  for (const event of events) if (event.kind === "alpaca_account_activity" && event.payload?.accountId === report.paperAccountId && event.payload?.mode === "alpaca-paper") {
    const activity = event.payload.activity;
    if (!activity || typeof activity.id !== "string" || !activity.id) throw new Error("live_invalid_account_activity");
    const previous = activities.get(activity.id);
    if (previous && hash(previous) !== hash(activity)) throw new Error("live_conflicting_account_activity");
    activities.set(activity.id, activity);
  }
  let fees = 0, latestFillAt = -Infinity;
  const actual = new Map<string, { symbol: string; side: string; qty: number; notional: number }>();
  for (const activity of activities.values()) {
    const at = Date.parse(activity.transaction_time ?? activity.created_at ?? activity.date);
    if (!Number.isFinite(at)) throw new Error("live_account_activity_time_unknown");
    if (at < report.startedAt || at > report.endedAt) continue;
    if (activity.activity_type === "FILL") {
      const qty = Number(activity.qty), price = Number(activity.price);
      if (!positive(qty) || !positive(price) || typeof activity.order_id !== "string" || !["buy", "sell"].includes(activity.side) || !["fill", "partial_fill"].includes(activity.type)) throw new Error("live_invalid_fill_activity");
      const expected = expectedFills.get(activity.order_id);
      if (!expected || expected.symbol !== activity.symbol || expected.side !== activity.side) throw new Error("live_unattributed_or_mixed_strategy_fill");
      const total = actual.get(activity.order_id) ?? { symbol: activity.symbol, side: activity.side, qty: 0, notional: 0 };
      total.qty += qty; total.notional += qty * price; actual.set(activity.order_id, total); latestFillAt = Math.max(latestFillAt, at);
    } else if (["FEE", "PTC", "PTR"].includes(activity.activity_type)) {
      const amount = Number(activity.net_amount);
      if (!Number.isFinite(amount) || (activity.currency !== undefined && activity.currency !== "USD") || activity.status !== "executed") throw new Error("live_invalid_fee_activity");
      if ((activity.activity_type !== "PTR" && amount > 0) || (activity.activity_type === "PTR" && amount < 0)) throw new Error("live_fee_activity_sign_unknown");
      fees -= amount;
    } else throw new Error("live_nontrade_cash_or_corporate_action_requires_reconciliation");
  }
  if (actual.size !== expectedFills.size || [...expectedFills].some(([id, expected]) => {
    const found = actual.get(id); return !found || !exactEnough(found.qty, expected.qty) || !moneyEqual(found.notional, expected.notional);
  })) throw new Error("live_fill_activities_do_not_reconcile_to_orders");
  // Fees may post after fills. Complete activities after a quiet settlement buffer plus
  // equity reconciliation establish an explicit zero; a missing field never does.
  if (!Number.isFinite(latestFillAt) || report.endedAt - latestFillAt < 4 * DAY) throw new Error("live_fee_settlement_observation_incomplete");
  if (!nonnegative(fees)) throw new Error("live_fee_rebates_require_explicit_review");
  return fees;
}

/** Dedicated paper account only; drawdown is the maximum observed in recorded telemetry. */
export function derivePaperEvidenceMetrics(events: PaperAuditEvent[], report: AlpacaPaperReadinessReport): PaperEvidenceMetrics {
  const window = events.filter(event => event.ts >= report.startedAt && event.ts <= report.endedAt);
  if (window.some(event => ["kill_switch", "alpaca_ambiguous", "emergency_reconciliation"].includes(event.kind))) throw new Error("live_paper_journal_contains_rule_or_ambiguous_events");
  const telemetry = window.filter(event => event.kind === "alpaca_account_telemetry");
  if (telemetry.length < 14 || telemetry[0]!.ts !== report.startedAt || telemetry.at(-1)!.ts !== report.endedAt) throw new Error("live_paper_observation_window_not_covered");
  const dates = new Set<string>();
  let peak = 0, maxDrawdownFraction = 0, previousTs = -Infinity;
  for (const event of telemetry) {
    const value = event.payload;
    if (value?.accountId !== report.paperAccountId || value.mode !== "alpaca-paper" || !positive(value.equity) || !nonnegative(value.cash) || !positive(value.dayStartEquity) ||
        !Array.isArray(value.positions) || !Array.isArray(value.openOrders) || event.ts < previousTs || (Number.isFinite(previousTs) && event.ts - previousTs > 4 * DAY) ||
        value.cash > value.equity + .01 || (value.dayStartEquity - value.equity) / value.dayStartEquity >= .02 - 1e-10) throw new Error("live_paper_telemetry_invalid_incomplete_or_daily_limit");
    for (const position of value.positions) if (!positive(Number(position.qty)) || !Number.isFinite(Number(position.market_value))) throw new Error("live_paper_short_or_unknown_exposure");
    previousTs = event.ts; dates.add(dateFormatter.format(event.ts)); peak = Math.max(peak, value.equity);
    maxDrawdownFraction = Math.max(maxDrawdownFraction, (peak - value.equity) / peak);
  }
  const first = telemetry[0]!.payload, last = telemetry.at(-1)!.payload;
  if (first.positions.length || first.openOrders.length || last.positions.length || last.openOrders.length || !moneyEqual(first.cash, first.equity) || !moneyEqual(last.cash, last.equity)) throw new Error("live_paper_window_requires_confirmed_flat_endpoints");
  if (maxDrawdownFraction > .02 + 1e-10) throw new Error("live_paper_observed_drawdown_exceeded");
  const latest = new Map<string, { ts: number; value: VerifiedOrder }>(), intents = new Set<string>();
  for (const event of window) {
    if (event.kind === "alpaca_intent") {
      const request = event.payload as BracketRequest;
      if (!request || typeof request.clientOrderId !== "string" || request.plan?.strategyId !== report.strategyId || request.plan?.parametersHash !== report.parametersHash) throw new Error("live_paper_mixed_strategy_intent");
      intents.add(request.clientOrderId);
    }
    if (event.kind !== "alpaca_paper_verified_order") continue;
    const value = event.payload as VerifiedOrder, order = value?.order;
    if (value?.accountId !== report.paperAccountId || value.strategyId !== report.strategyId || value.parametersHash !== report.parametersHash || !order ||
        typeof order.clientOrderId !== "string" || !order.clientOrderId || typeof order.id !== "string" || !order.id || !nonnegative(order.filledQuantity) ||
        !["accepted", "unknown", "filled", "closed", "cancelled", "rejected"].includes(order.status)) throw new Error("live_paper_order_identity_or_outcome_invalid");
    const previous = latest.get(order.clientOrderId);
    if (previous && (event.ts < previous.ts || order.filledQuantity < previous.value.order.filledQuantity || (previous.value.order.status === "closed" && order.status !== "closed"))) throw new Error("live_paper_order_history_regresses");
    latest.set(order.clientOrderId, { ts: event.ts, value });
  }
  if ([...intents].some(id => !latest.has(id))) throw new Error("live_paper_order_intent_has_no_confirmed_outcome");
  let filledOrders = 0, closedTrades = 0, unresolvedOrders = 0, grossPnlUsd = 0, explicitFees = 0, feesKnown = true;
  const expectedFills = new Map<string, { symbol: string; side: string; qty: number; notional: number }>();
  for (const { value } of latest.values()) {
    const { order, execution } = value;
    if (order.status === "unknown" || order.status === "accepted" || order.status === "filled" || (order.filledQuantity > 0 && order.status !== "closed")) unresolvedOrders++;
    if (!order.filledQuantity) continue;
    filledOrders++;
    if (order.status !== "closed") continue;
    closedTrades++;
    if (!execution || !positive(execution.entryFilledQty) || !positive(execution.entryFilledPrice) || !exactEnough(execution.entryFilledQty, order.filledQuantity) ||
        !positive(order.filledPrice) || !exactEnough(execution.entryFilledPrice, order.filledPrice) || !Array.isArray(execution.exits)) throw new Error("live_paper_execution_details_missing_or_mismatched");
    if (expectedFills.has(order.id)) throw new Error("live_paper_duplicate_broker_order_id");
    const entryNotional = execution.entryFilledQty * execution.entryFilledPrice;
    expectedFills.set(order.id, { symbol: order.symbol, side: "buy", qty: execution.entryFilledQty, notional: entryNotional });
    let exitQuantity = 0, exitNotional = 0;
    for (const exit of execution.exits) {
      if (!nonnegative(exit.qty) || typeof exit.id !== "string" || !exit.id) throw new Error("live_paper_exit_details_invalid");
      if (!exit.qty) continue;
      if (exit.side !== "sell" || !positive(exit.price) || !["limit", "stop", "stop_limit"].includes(exit.type) ||
          !["filled", "canceled", "cancelled", "expired"].includes(exit.status) || expectedFills.has(exit.id)) throw new Error("live_paper_exit_details_invalid");
      exitQuantity += exit.qty; exitNotional += exit.qty * exit.price;
      expectedFills.set(exit.id, { symbol: order.symbol, side: "sell", qty: exit.qty, notional: exit.qty * exit.price });
    }
    if (!exactEnough(exitQuantity, execution.entryFilledQty)) throw new Error("live_paper_closed_status_has_residual_inventory");
    grossPnlUsd += exitNotional - entryNotional;
    if (execution.feesUsd === null || execution.feesUsd === undefined) feesKnown = false;
    else { if (!nonnegative(execution.feesUsd)) throw new Error("live_paper_fee_amount_invalid"); explicitFees += execution.feesUsd; }
  }
  if (unresolvedOrders || filledOrders < 30 || closedTrades < 30) throw new Error("live_paper_requires_thirty_closed_confirmed_orders_without_residuals");
  const fees = feesKnown ? explicitFees : activityFeeTotal(events, report, expectedFills);
  if (!feesKnown && fees + .01 < explicitFees) throw new Error("live_paper_activity_fees_below_recorded_fees");
  const netPnlUsd = grossPnlUsd - fees;
  if (!moneyEqual(last.equity - first.equity, netPnlUsd)) throw new Error("live_paper_pnl_does_not_reconcile_to_account_equity");
  const observedDates = [...dates].sort();
  if (observedDates.length < 14) throw new Error("live_paper_requires_fourteen_observed_dates");
  return { filledOrders, closedTrades, unresolvedOrders, ruleViolations: 0, netPnlUsd, maxDrawdownFraction, initialEquityUsd: first.equity, observedDates,
    feeEvidence: feesKnown ? "explicit_order_fees" : "complete_account_activities" };
}

/** Re-read every artifact for every attempted live write. Unknown evidence fails closed. */
export function checkAlpacaLiveAuthorization(paths: AlpacaLiveGatePaths, request: BracketRequest, now: number): AlpacaLiveOrderAuthorization {
  if (!positive(now)) throw new Error("live_authorization_clock_invalid");
  validatePlan(request.plan);
  const authorization = readBoundJson(paths.orderAuthorizationFile).value as AlpacaLiveOrderAuthorization;
  const reportResult = readBoundJson(paths.readinessReportFile), report = reportResult.value as AlpacaPaperReadinessReport;
  if (!paths.expectedAccountId || authorization.version !== 1 || authorization.approved !== true || !authorization.approvedBy?.trim() ||
      typeof authorization.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(authorization.id) || !/^desk-[a-f0-9]{40}$/.test(request.clientOrderId) ||
      authorization.clientOrderId !== request.clientOrderId || authorization.accountId !== paths.expectedAccountId ||
      authorization.planHash !== request.planHash || hash(request.plan) !== request.planHash || request.approval.mode !== "live" ||
      !positive(authorization.issuedAt) || !positive(authorization.expiresAt) || authorization.issuedAt > now || authorization.expiresAt <= now ||
      authorization.expiresAt <= authorization.issuedAt || authorization.expiresAt - authorization.issuedAt > 15 * 60_000 || authorization.reportSha256 !== reportResult.digest) throw new Error("live_per_order_authorization_missing_expired_or_mismatched");
  validatePlan(authorization.fullSizePlan);
  if (hash({ ...authorization.fullSizePlan, quantity: request.plan.quantity }) !== hash(request.plan) || request.plan.quantity > Math.floor(authorization.fullSizePlan.quantity * .1)) throw new Error("live_order_exceeds_ten_percent_or_changes_reference_plan");
  if (report.version !== 1 || report.source !== "alpaca-paper" || report.eligible !== true || !report.paperAccountId || report.paperAccountId === paths.expectedAccountId ||
      report.strategyId !== request.plan.strategyId || report.parametersHash !== request.plan.parametersHash || report.backtest?.strategyId !== report.strategyId || report.backtest?.parametersHash !== report.parametersHash ||
      !positive(report.generatedAt) || report.generatedAt > authorization.issuedAt || !positive(report.startedAt) || !positive(report.endedAt) || report.endedAt > report.generatedAt ||
      report.endedAt - report.startedAt < 14 * DAY || now - report.endedAt > 7 * DAY || report.backtest.historyEnd > report.startedAt || report.backtest.evaluationEnd > report.startedAt ||
      !Array.isArray(report.observedDates) || !Array.isArray(report.expectedNetPnlRangeUsd) || report.expectedNetPnlRangeUsd.length !== 2 || !report.expectedNetPnlRangeUsd.every(Number.isFinite)) throw new Error("live_requires_current_clean_strategy_matched_real_paper_report");
  if (assessStrategyEvidence(report.backtest).status !== "ELIGIBLE_FOR_PAPER" || !report.backtest.sensitivityRuns.some(run => run.parameterHash === request.plan.parametersHash)) throw new Error("live_historical_strategy_acceptance_missing");
  const events = verifyPaperJournalExport(readBoundJson(report.paperJournalPath, report.paperJournalSha256).value, report.generatedAt);
  const actual = derivePaperEvidenceMetrics(events, report);
  if (report.filledOrders !== actual.filledOrders || report.closedTrades !== actual.closedTrades || report.unresolvedOrders !== actual.unresolvedOrders ||
      report.ruleViolations !== actual.ruleViolations || !moneyEqual(report.netPnlUsd, actual.netPnlUsd) || !exactEnough(report.maxDrawdownFraction, actual.maxDrawdownFraction) ||
      hash([...report.observedDates].sort()) !== hash(actual.observedDates)) throw new Error("live_paper_report_summary_disagrees_with_broker_evidence");
  const range = deriveExpectedPaperRange(report, readBoundJson(report.expectedRangePath, report.expectedRangeSha256).value, actual.initialEquityUsd);
  if (!exactEnough(range[0], report.expectedNetPnlRangeUsd[0]) || !exactEnough(range[1], report.expectedNetPnlRangeUsd[1]) ||
      actual.netPnlUsd < range[0] - .01 || actual.netPnlUsd > range[1] + .01) throw new Error("live_paper_results_outside_precommitted_backtest_range");
  if (authorization.fullSizePlan.quantity * (authorization.fullSizePlan.entry - authorization.fullSizePlan.stop) > actual.initialEquityUsd * .01 + .01 ||
      authorization.fullSizePlan.quantity * authorization.fullSizePlan.entry > actual.initialEquityUsd + .01) throw new Error("live_full_size_reference_exceeds_paper_risk_budget");
  return authorization;
}
