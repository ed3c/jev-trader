import { createHash } from "node:crypto";
import type { Evidence, TradePlan, DeskRules } from "./types";

/** JSON canonicalization rejects values that cannot be audited or hashed faithfully. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non_finite_evidence"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("evidence_must_be_plain_json");
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function immutable<T>(value: T): T { return freeze(JSON.parse(canonical(value)) as T); }
export function evidence<T>(input: Omit<Evidence<T>, "id">): Evidence<T> {
  if (!input.source.trim() || !Number.isFinite(input.observedAt) || !Number.isFinite(input.receivedAt) || input.receivedAt < input.observedAt) throw new Error("invalid_evidence_provenance");
  if (!["synthetic", "observed", "historical"].includes(input.provenance)) throw new Error("invalid_evidence_provenance");
  return immutable({ ...input, id: hash(input) });
}
export function verifyEvidence(input: Evidence<unknown>, now: number, maxAgeMs = Infinity): void {
  const { id, ...body } = input;
  if (evidence(body).id !== id) throw new Error("evidence_hash_mismatch");
  if (input.receivedAt > now || input.observedAt > now) throw new Error("future_evidence");
  if (now - input.observedAt > maxAgeMs) throw new Error("stale_evidence");
}
export function validatePlan(plan: TradePlan): void {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(plan.symbol) || plan.side !== "buy") throw new Error("only_long_us_equity_plans_supported");
  if (![plan.entry, plan.stop, plan.target, plan.holdingUntil].every(n => Number.isFinite(n) && n > 0)) throw new Error("invalid_plan_numbers");
  if (!(plan.stop < plan.entry && plan.entry < plan.target)) throw new Error("invalid_bracket");
  if (!Number.isInteger(plan.quantity) || plan.quantity <= 0) throw new Error("whole_share_quantity_required");
  if (![plan.entry, plan.stop, plan.target].every(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6)) throw new Error("whole_cent_price_required");
  if (!plan.thesis.trim() || !plan.strategyId.trim() || !/^[a-f0-9]{64}$/.test(plan.parametersHash)) throw new Error("plan_identity_required");
  if (!Array.isArray(plan.evidenceIds) || !plan.evidenceIds.length || plan.evidenceIds.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error("plan_evidence_required");
}
export function validateRules(rules: DeskRules): void {
  for (const value of Object.values(rules)) if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_desk_rules");
  if (rules.maxRiskFraction > .01 || rules.maxDailyLossFraction > .02 || rules.maxPositions > 5 ||
      !Number.isInteger(rules.maxPositions) || rules.maxGrossExposureFraction > 1 || rules.maxCorrelatedRiskFraction > .01 ||
      rules.correlationThreshold > 1 || rules.maxPriceDeviationFraction > .005 || rules.maxLossStreak > 3 ||
      rules.maxQuoteAgeMs > 60_000 || rules.maxRiskAgeMs > 60_000 || rules.approvalTtlMs > 900_000 || rules.minPrice < 5) {
    throw new Error("desk_rules_may_only_be_tightened");
  }
}
