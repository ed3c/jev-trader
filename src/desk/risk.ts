import { verifyEvidence, validatePlan } from "./evidence";
import type { DeskRules, Evidence, Quote, RiskSnapshot, TradePlan } from "./types";

export interface RiskDecision { approved: boolean; reasons: string[]; kill: boolean; riskUsd: number; grossAfterUsd: number }
/** Every relevant portfolio pair and event horizon must be known. Empty is not unknown. */
export function assessDeskRisk(plan: TradePlan, riskEvidence: Evidence<RiskSnapshot>, quoteEvidence: Evidence<Quote>, now: number, rules: DeskRules): RiskDecision {
  const reasons: string[] = [];
  let kill = false, riskUsd = 0, grossAfterUsd = 0;
  try { validatePlan(plan); verifyEvidence(riskEvidence, now, rules.maxRiskAgeMs); verifyEvidence(quoteEvidence, now, rules.maxQuoteAgeMs); }
  catch (error) { return { approved: false, reasons: [String(error)], kill: /stale/.test(String(error)), riskUsd, grossAfterUsd }; }
  const risk = riskEvidence.payload, quote = quoteEvidence.payload;
  if (risk.accountingPending === true) reasons.push("realized_outcome_costs_unreconciled");
  if (![risk.equity, risk.cash, risk.dayStartEquity].every(n => Number.isFinite(n) && n >= 0) || risk.equity <= 0 || risk.dayStartEquity <= 0 || !Number.isInteger(risk.lossStreak) || risk.lossStreak < 0) reasons.push("invalid_account_snapshot");
  if (![quote.bid, quote.ask, quote.last].every(n => Number.isFinite(n) && n > 0) || quote.bid > quote.ask || quote.symbol !== plan.symbol) reasons.push("invalid_quote");
  if (Math.abs(quote.ask - plan.entry) / plan.entry > rules.maxPriceDeviationFraction) reasons.push("price_moved_over_limit_return_to_strategist");
  if (plan.holdingUntil <= now) reasons.push("holding_horizon_expired");
  if (plan.entry < rules.minPrice || quote.last < rules.minPrice) reasons.push("penny_stock_forbidden");
  if (!risk.asset || risk.asset.symbol !== plan.symbol || risk.asset.assetClass !== "us_equity" || risk.asset.tradable !== true || risk.asset.leveraged !== false) reasons.push("asset_not_eligible_or_leverage_unknown");
  if (risk.cash > risk.equity) reasons.push("account_leverage_or_short_exposure_unknown");
  const lossFraction = (risk.dayStartEquity - risk.equity) / risk.dayStartEquity;
  if (lossFraction >= rules.maxDailyLossFraction - 1e-10) { reasons.push("daily_loss_limit"); kill = true; }
  if (risk.lossStreak >= rules.maxLossStreak) { reasons.push("loss_streak_limit"); kill = true; }
  if (!Array.isArray(risk.positions) || !Array.isArray(risk.openOrders)) return { approved: false, reasons: [...reasons, "positions_or_open_orders_unknown"], kill, riskUsd, grossAfterUsd };
  const commitments = [
    ...risk.positions.map(position => ({ ...position, entry: position.marketPrice })),
    ...risk.openOrders,
  ];
  for (const item of commitments) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(item.symbol) || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isInteger(item.quantity) || !Number.isFinite(item.entry) || item.entry <= 0) reasons.push("invalid_existing_exposure");
    if (item.stop === null || !Number.isFinite(item.stop) || item.stop <= 0 || item.stop >= item.entry) reasons.push("existing_position_missing_valid_stop");
    if (!item.correlationGroup) reasons.push("existing_correlation_group_unknown");
  }
  if (!risk.asset?.correlationGroup) reasons.push("candidate_correlation_group_unknown");
  if (commitments.some(item => item.symbol === plan.symbol)) reasons.push("existing_symbol_or_pending_order");
  if (new Set(commitments.map(item => item.symbol)).size >= rules.maxPositions) reasons.push("position_limit");
  riskUsd = (plan.entry - plan.stop) * plan.quantity;
  if (riskUsd > risk.equity * rules.maxRiskFraction + 1e-8) reasons.push("per_trade_risk_limit");
  const reserved = risk.openOrders.reduce((sum, order) => sum + order.entry * order.quantity, 0);
  if (plan.entry * plan.quantity + reserved > risk.cash + 1e-8) reasons.push("insufficient_unreserved_cash_no_leverage");
  grossAfterUsd = commitments.reduce((sum, item) => sum + item.entry * item.quantity, 0) + plan.entry * plan.quantity;
  if (grossAfterUsd > risk.equity * rules.maxGrossExposureFraction + 1e-8) reasons.push("gross_exposure_limit_no_leverage");
  if (risk.correlations === null || !Array.isArray(risk.correlations)) reasons.push("correlation_data_unknown");
  let correlatedRisk = riskUsd;
  for (const item of commitments) {
    const sameGroup = item.correlationGroup !== null && item.correlationGroup === risk.asset?.correlationGroup;
    const matching = risk.correlations?.filter(pair => (pair.a === plan.symbol && pair.b === item.symbol) || (pair.b === plan.symbol && pair.a === item.symbol)) ?? [];
    if (matching.length !== 1 || !Number.isFinite(matching[0]?.coefficient) || Math.abs(matching[0]!.coefficient) > 1) { reasons.push(`correlation_missing_or_ambiguous:${item.symbol}`); continue; }
    if (sameGroup || Math.abs(matching[0]!.coefficient) >= rules.correlationThreshold) correlatedRisk += Math.max(0, item.entry - (item.stop ?? 0)) * item.quantity;
  }
  if (correlatedRisk > risk.equity * rules.maxCorrelatedRiskFraction + 1e-8) reasons.push("correlated_risk_limit");
  if (!risk.events || risk.events.status !== "known" || !Number.isFinite(risk.events.completeThrough) || risk.events.completeThrough < plan.holdingUntil || !Array.isArray(risk.events.items)) reasons.push("event_calendar_unknown_or_incomplete");
  else for (const event of risk.events.items) {
    if (!Number.isFinite(event.at) || !["earnings", "fed", "cpi", "major"].includes(event.kind) || (event.kind === "earnings" && !event.symbol)) { reasons.push("invalid_event_calendar"); continue; }
    if (event.at >= now - 24 * 3_600_000 && event.at <= plan.holdingUntil && (!event.symbol || event.symbol === plan.symbol)) reasons.push(`event_blackout:${event.kind}`);
  }
  return { approved: reasons.length === 0, reasons: [...new Set(reasons)], kill, riskUsd, grossAfterUsd };
}

/** Hard kill checks run even when no new idea is being considered. */
export function assessPortfolioSafety(riskEvidence: Evidence<RiskSnapshot>, quotes: readonly Evidence<Quote>[], now: number, rules: DeskRules): string[] {
  const reasons: string[] = [];
  try { verifyEvidence(riskEvidence, now, rules.maxRiskAgeMs); }
  catch (error) { return [`portfolio_evidence_unavailable:${String(error)}`]; }
  const value = riskEvidence.payload;
  if (![value.equity, value.cash, value.dayStartEquity].every(Number.isFinite) || value.equity <= 0 || value.dayStartEquity <= 0 || value.cash < 0) reasons.push("portfolio_account_invalid");
  if ((value.dayStartEquity - value.equity) / value.dayStartEquity >= rules.maxDailyLossFraction - 1e-10) reasons.push("daily_loss_limit");
  if (!Number.isInteger(value.lossStreak) || value.lossStreak < 0 || value.lossStreak >= rules.maxLossStreak) reasons.push("loss_streak_limit_or_unknown");
  if (!Array.isArray(value.positions) || !Array.isArray(value.openOrders)) return [...reasons, "portfolio_positions_or_orders_unknown"];
  if (new Set([...value.positions, ...value.openOrders].map(item => item.symbol)).size > rules.maxPositions) reasons.push("portfolio_position_limit");
  if (value.positions.reduce((sum, position) => sum + Math.abs(position.quantity * position.marketPrice), 0) + value.openOrders.reduce((sum, order) => sum + Math.abs(order.entry * order.quantity), 0) > value.equity * rules.maxGrossExposureFraction + 1e-8) reasons.push("portfolio_gross_exposure_limit");
  for (const position of value.positions) {
    if (!Number.isInteger(position.quantity) || position.quantity <= 0 || position.stop === null || !Number.isFinite(position.stop) || position.stop <= 0) reasons.push(`unprotected_or_invalid_position:${position.symbol}`);
    const quote = quotes.find(item => item.payload.symbol === position.symbol);
    if (!quote) { reasons.push(`missing_position_quote:${position.symbol}`); continue; }
    try { verifyEvidence(quote, now, rules.maxQuoteAgeMs); }
    catch { reasons.push(`stale_or_invalid_position_quote:${position.symbol}`); continue; }
    if (!Number.isFinite(quote.payload.bid) || quote.payload.bid <= 0 || quote.payload.ask < quote.payload.bid) reasons.push(`invalid_position_quote:${position.symbol}`);
    if (position.stop !== null && quote.payload.bid <= position.stop) reasons.push(`position_stop_breached:${position.symbol}`);
  }
  return [...new Set(reasons)];
}
