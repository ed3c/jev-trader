import { verifySnapshot } from "./state";
import type { RiskInput, RiskLimits, RiskOrder, RiskVerdict } from "./types";

/** Engineering defaults for the $100 upstream demo. Configure explicitly for each account. */
export const DEFAULT_RISK_LIMITS: Readonly<RiskLimits> = Object.freeze({
  maxPosition: 1000,
  maxOrderSize: 200,
  maxDailyLossUsd: 2,
  maxDrawdownFraction: 0.05,
  maxInventoryAgeMs: 3_600_000,
  maxDataAgeMs: 1000,
  maxLeverage: 1,
  maxApiErrors: 3,
  maxDecisionLatencyMs: 250,
});

/**
 * Deterministic absolute veto before every send. Cancellation/flattening recovery is a
 * separate executor path: a kill does not authorize increasing exposure or mark a fill.
 */
export function evaluateRisk(input: RiskInput, limits: Partial<RiskLimits> = {}): RiskVerdict {
  const cfg = { ...DEFAULT_RISK_LIMITS, ...limits };
  const reasons: string[] = [];
  let kill = false;
  const reject = (reason: string, latch = false) => { reasons.push(reason); kill ||= latch; };
  const verdict = (position = 0, leverage = 0): RiskVerdict => ({ ok: reasons.length === 0, kill, reasons: [...new Set(reasons)], worstCasePosition: position, worstCaseLeverage: leverage });
  if (Object.values(cfg).some((v) => !Number.isFinite(v) || v <= 0) || cfg.maxDrawdownFraction > 1 || !Number.isSafeInteger(cfg.maxApiErrors)) {
    reject("invalid_risk_limits", true); return verdict();
  }
  if (input.killed) reject("kill_switch_latched", true);
  const s = input.snapshot;
  try { if (!verifySnapshot(s)) { reject("snapshot_modified", true); return verdict(); } }
  catch { reject("invalid_snapshot", true); return verdict(); }
  const required = [input.nowMs, input.decisionLatencyMs, s?.decisionTs, s?.bookTs, s?.price?.mid, s?.book?.bid, s?.book?.ask, s?.account?.inventory, s?.account?.equityUsd, s?.account?.dayPnlUsd, s?.account?.drawdownFraction, s?.account?.grossExposureUsd, s?.health?.apiErrors];
  if (required.some((v) => typeof v !== "number" || !Number.isFinite(v))) { reject("nonfinite_risk_input", true); return verdict(); }
  if (s.price.mid <= 0 || s.book.bid <= 0 || s.book.ask <= s.book.bid || s.account.equityUsd <= 0 || s.account.grossExposureUsd < 0 || s.account.drawdownFraction < 0 || input.decisionLatencyMs < 0 || !Number.isSafeInteger(s.health.apiErrors) || s.health.apiErrors < 0) {
    reject("invalid_risk_input", true); return verdict();
  }
  if (input.nowMs < s.decisionTs || s.bookTs >= s.decisionTs) reject("future_snapshot", true);
  if (input.nowMs - s.bookTs >= cfg.maxDataAgeMs || !s.readiness.fresh) reject("stale_data", true);
  if (!s.readiness.ready) reject("snapshot_not_ready");
  if (s.account.dayPnlUsd <= -cfg.maxDailyLossUsd) reject("max_daily_loss", true);
  if (s.account.drawdownFraction >= cfg.maxDrawdownFraction) reject("max_drawdown", true);
  if (s.health.apiErrors >= cfg.maxApiErrors) reject("max_api_errors", true);
  if (input.decisionLatencyMs > cfg.maxDecisionLatencyMs) reject("max_decision_latency");
  if (s.account.inventory !== 0) {
    const age = s.account.positionAgeMs;
    if (age === null || !Number.isFinite(age) || age < 0) reject("unknown_inventory_age", true);
    else if (age + (input.nowMs - s.decisionTs) >= cfg.maxInventoryAgeMs) reject("max_inventory_age", true);
  }
  if (Math.abs(s.account.inventory) > cfg.maxPosition) reject("existing_position_limit", true);

  const validOrder = (order: RiskOrder) => order && (order.side === "buy" || order.side === "sell") && Number.isFinite(order.price) && order.price > 0 && Number.isFinite(order.size) && order.size > 0;
  if (!Array.isArray(input.orders) || !Array.isArray(input.openOrders) || [...input.orders, ...input.openOrders].some((o) => !validOrder(o))) {
    reject("invalid_order", true); return verdict();
  }
  if (input.orders.some((o) => o.size > cfg.maxOrderSize)) reject("max_order_size");
  if (input.openOrders.some((o) => o.size > cfg.maxOrderSize)) reject("existing_order_size", true);
  for (const order of input.orders) {
    if (order.side === "buy" ? order.price >= s.book.ask : order.price <= s.book.bid) reject("not_post_only");
  }
  if (input.orders.some((buy) => buy.side === "buy" && input.orders.some((sell) => sell.side === "sell" && buy.price >= sell.price))) reject("self_crossing_orders");
  const all = [...input.openOrders, ...input.orders];
  const buys = all.filter((o) => o.side === "buy").reduce((sum, o) => sum + o.size, 0);
  const sells = all.filter((o) => o.side === "sell").reduce((sum, o) => sum + o.size, 0);
  // Opposing orders are not a hedge: only one side may fill during a jump.
  const worstCasePosition = Math.max(Math.abs(s.account.inventory), Math.abs(s.account.inventory + buys), Math.abs(s.account.inventory - sells));
  const conservativeMark = Math.max(s.price.mid, ...all.map((o) => o.price));
  const otherExposure = Math.max(0, s.account.grossExposureUsd - Math.abs(s.account.inventory) * s.price.mid);
  const worstCaseLeverage = (otherExposure + worstCasePosition * conservativeMark) / s.account.equityUsd;
  if (!Number.isFinite(worstCasePosition) || !Number.isFinite(worstCaseLeverage)) {
    reject("risk_projection_overflow", true); return verdict();
  }
  if (worstCasePosition > cfg.maxPosition) reject("max_position");
  if (s.account.grossExposureUsd / s.account.equityUsd > cfg.maxLeverage) reject("existing_leverage_limit", true);
  if (worstCaseLeverage > cfg.maxLeverage) reject("max_leverage");
  return verdict(worstCasePosition, worstCaseLeverage);
}
