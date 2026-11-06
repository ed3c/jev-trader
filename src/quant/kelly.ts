import { applyPlatt, calibrationMetrics, evaluatePlatt, validateCalibrationSamples } from "../evaluation/calibration";
import type { CalibrationSample, PlattCalibration } from "../evaluation/calibration";
import { finite, positive, probability } from "./math";

export interface KellyEvidence {
  modelId: string;
  /** Kelly's probability must label a profitable trade after costs, not simply price-up. */
  outcomeDefinition: "TRADE_NET_PROFIT_POSITIVE";
  trainingEnd: number;
  validation: readonly CalibrationSample[];
  calibration?: PlattCalibration;
  minimumSamples?: number;
  maximumEce?: number;
}

/** General binary-payoff fractional Kelly; fail closed until venue/trade calibration exists. */
export function fractionalKelly(input: {
  winProbability: number;
  /** Estimated net average win / absolute net average loss, both after costs. */
  netWinLossRatio: number;
  modelId: string;
  fraction?: number;
  maxBankrollFraction?: number;
  evidence?: KellyEvidence;
}) {
  probability(input.winProbability, "winProbability");
  positive(input.netWinLossRatio, "netWinLossRatio");
  const fraction = input.fraction ?? 0.25;
  const cap = input.maxBankrollFraction ?? 0.25;
  probability(fraction, "fraction"); probability(cap, "maxBankrollFraction");
  const blocked = (reason: string) => ({ status: "UNVERIFIED" as const, fraction: 0, rawKelly: null, calibratedProbability: null, reason });
  const evidence = input.evidence;
  if (!evidence) return blocked("No held-out trade-outcome calibration evidence");
  if (evidence.modelId !== input.modelId || evidence.outcomeDefinition !== "TRADE_NET_PROFIT_POSITIVE") return blocked("Model or outcome definition does not match sizing");
  finite(evidence.trainingEnd, "trainingEnd");
  validateCalibrationSamples(evidence.validation);
  if (evidence.validation.some(sample => sample.predictionAt <= evidence.trainingEnd || sample.modelId !== input.modelId)) return blocked("Validation overlaps training or uses another model version");
  const minimumSamples = evidence.minimumSamples ?? 200;
  const maximumEce = evidence.maximumEce ?? 0.05;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 30) throw new RangeError("Kelly requires at least thirty held-out samples");
  probability(maximumEce, "maximumEce");
  if (evidence.validation.length < minimumSamples) return blocked("Insufficient held-out trade outcomes");
  if (!evidence.validation.some(sample => sample.outcome === 0) || !evidence.validation.some(sample => sample.outcome === 1)) return blocked("Held-out sample must include wins and losses");
  let p = input.winProbability;
  let metrics;
  if (evidence.calibration) {
    if (evidence.calibration.trainingEnd !== evidence.trainingEnd || evidence.calibration.modelId !== input.modelId) return blocked("Calibration cutoff or model version mismatch");
    metrics = evaluatePlatt(evidence.calibration, evidence.validation).calibrated;
    p = applyPlatt(p, evidence.calibration);
  } else metrics = calibrationMetrics(evidence.validation);
  if (metrics.ece > maximumEce) return blocked("Held-out expected calibration error exceeds configured limit");
  const relevant = metrics.reliability[Math.min(metrics.reliability.length - 1, Math.floor(p * metrics.reliability.length))]!;
  if (relevant.count < 30 || relevant.predicted === null || relevant.observed === null ||
      Math.abs(relevant.predicted - relevant.observed) > maximumEce) return blocked("The requested probability range lacks locally calibrated support");
  const rawKelly = (input.netWinLossRatio * p - (1 - p)) / input.netWinLossRatio;
  return {
    status: "CALIBRATED_RESEARCH_SIZING" as const,
    fraction: Math.min(cap, Math.max(0, rawKelly) * fraction), rawKelly, calibratedProbability: p,
    reason: "Independent position, leverage, stop and loss limits still apply",
  };
}
