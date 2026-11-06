import { validateDecisionBattery } from "./decisions";
import { verifySnapshot } from "./state";
import type { DecisionBattery, MarketSnapshot, PolicyConfig, PolicyDecision } from "./types";

export const DEFAULT_POLICY_CONFIG: Readonly<PolicyConfig> = Object.freeze({
  toxicFlowThreshold: 0.6,
  liquidityStressThreshold: 0.7,
  minQuoteScore: 2,
  minQuoteConfidence: 0.8,
  minWideScore: 1,
  minWideConfidence: 0.5,
  inventoryReduceScore: 2.5,
  minInventoryConfidence: 0.8,
  minDirectionConfidence: 0.8,
  minDirectionProbability: 0.65,
  maxDecisionAgeMs: 300,
  maxDataAgeMs: 1000,
  wideSpreadMultiplier: 2,
  lowConfidenceSizeMultiplier: 0.25,
  allowDeterministicFallback: false,
});

function validConfig(config: PolicyConfig): boolean {
  const probabilities = [config.toxicFlowThreshold, config.liquidityStressThreshold, config.minQuoteConfidence, config.minWideConfidence, config.minInventoryConfidence, config.minDirectionConfidence, config.minDirectionProbability];
  const scores = [config.minQuoteScore, config.minWideScore, config.inventoryReduceScore];
  return probabilities.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    && scores.every((v) => Number.isFinite(v) && v >= 0 && v <= 3)
    && config.minQuoteScore >= config.minWideScore && config.minQuoteConfidence >= config.minWideConfidence
    && [config.maxDecisionAgeMs, config.maxDataAgeMs].every((v) => Number.isFinite(v) && v > 0)
    && Number.isFinite(config.wideSpreadMultiplier) && config.wideSpreadMultiplier >= 1
    && Number.isFinite(config.lowConfidenceSizeMultiplier) && config.lowConfidenceSizeMultiplier > 0 && config.lowConfidenceSizeMultiplier <= 1
    && typeof config.allowDeterministicFallback === "boolean";
}

/** Model outputs are judgments. This function alone composes them into an order policy. */
export function composePolicy(
  snapshot: MarketSnapshot,
  battery: DecisionBattery | null,
  config: Partial<PolicyConfig> = {},
  nowMs = performance.timeOrigin + performance.now(),
): PolicyDecision {
  const cfg = { ...DEFAULT_POLICY_CONFIG, ...config };
  const base: PolicyDecision = {
    action: "hold", reasons: [], snapshotId: snapshot.id, sizeMultiplier: 0,
    spreadMultiplier: 1, skew: 0, reduceSide: null, fallback: battery?.source === "deterministic",
  };
  const result = (action: PolicyDecision["action"], reason: string, extra: Partial<PolicyDecision> = {}): PolicyDecision => ({ ...base, action, reasons: [reason], ...extra });
  if (!validConfig(cfg)) return result("kill", "invalid_policy_config");
  try { if (!verifySnapshot(snapshot)) return result("kill", "snapshot_modified"); }
  catch { return result("kill", "invalid_snapshot"); }
  if (!Number.isFinite(nowMs) || nowMs < snapshot.decisionTs) return result("hold", "future_snapshot");
  if (nowMs - snapshot.bookTs >= cfg.maxDataAgeMs || !snapshot.readiness.fresh) return result("pull_quotes", "stale_book");
  if (!snapshot.readiness.ready) return result("hold", "snapshot_not_ready", { reasons: [...snapshot.readiness.reasons] });
  if (!battery) return result("hold", "decision_unavailable");
  try { validateDecisionBattery(battery); } catch { return result("pull_quotes", "invalid_decision"); }
  if (battery.snapshotId !== snapshot.id || battery.sessionId !== snapshot.sessionId) return result("pull_quotes", "decision_binding_mismatch");
  if (battery.requestedAtMs < snapshot.decisionTs || battery.decidedAtMs > nowMs) return result("hold", "decision_time_mismatch");
  if (nowMs >= battery.validUntilMs || nowMs - battery.requestedAtMs > cfg.maxDecisionAgeMs) return result("hold", "decision_expired");
  if (battery.toxicFlow >= cfg.toxicFlowThreshold) return result("pull_quotes", "toxic_flow");
  if (battery.regime.choice === "crisis") return result("pull_quotes", "crisis_regime");

  const reduceSide = snapshot.account.inventory > 0 ? "sell" : snapshot.account.inventory < 0 ? "buy" : null;
  if (battery.source === "deterministic") {
    if (!cfg.allowDeterministicFallback) return result("hold", "deterministic_fallback_disabled");
    if (battery.liquidityStressed >= cfg.liquidityStressThreshold || battery.quoteEnvironment.score < cfg.minWideScore) return result("pull_quotes", "fallback_unsafe_environment");
    if (reduceSide && battery.inventoryPressure.score >= cfg.inventoryReduceScore) {
      return result("reduce_inventory", "deterministic_inventory_reduction", { reduceSide, sizeMultiplier: cfg.lowConfidenceSizeMultiplier, spreadMultiplier: cfg.wideSpreadMultiplier });
    }
    return result("quote_wide", "deterministic_fallback", { sizeMultiplier: cfg.lowConfidenceSizeMultiplier, spreadMultiplier: cfg.wideSpreadMultiplier });
  }

  const q = battery.quoteEnvironment, pressure = battery.inventoryPressure;
  if (reduceSide && pressure.score >= cfg.inventoryReduceScore && pressure.confidence !== null && pressure.confidence >= cfg.minInventoryConfidence) {
    return result("reduce_inventory", "inventory_pressure", { reduceSide, sizeMultiplier: 1, spreadMultiplier: cfg.wideSpreadMultiplier });
  }
  if (q.confidence === null || q.confidence < cfg.minWideConfidence) return result("hold", "low_quote_confidence");
  if (q.score < cfg.minWideScore) return result("pull_quotes", "unfavorable_quote_environment");

  let skew = 0;
  if (pressure.confidence !== null && pressure.confidence >= cfg.minInventoryConfidence) skew -= Math.sign(snapshot.account.inventory) * pressure.score / 3;
  const direction = battery.direction;
  if (direction.confidence !== null && direction.confidence >= cfg.minDirectionConfidence && direction.probabilities[direction.choice] >= cfg.minDirectionProbability) {
    skew += (direction.probabilities.up - direction.probabilities.down) * 0.25;
  }
  skew = Math.max(-1, Math.min(1, skew));
  const stressed = battery.liquidityStressed >= cfg.liquidityStressThreshold;
  const volatile = battery.regime.choice === "high_vol";
  if (stressed || volatile) return result("quote_wide", stressed ? "liquidity_stress" : "high_volatility", { sizeMultiplier: cfg.lowConfidenceSizeMultiplier, spreadMultiplier: cfg.wideSpreadMultiplier, skew });
  if (q.score >= cfg.minQuoteScore && q.confidence >= cfg.minQuoteConfidence) return result("quote_both", "quote_conditions_met", { sizeMultiplier: 1, skew });
  return result("quote_wide", "marginal_quote_environment", { sizeMultiplier: cfg.lowConfidenceSizeMultiplier, spreadMultiplier: cfg.wideSpreadMultiplier, skew });
}
