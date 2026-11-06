import { createHash } from "node:crypto";
import { finite, logit, probability, sigmoid } from "../quant/math";

export interface CalibrationSample {
  id: string;
  modelId: string;
  predictionAt: number;
  /** Timestamp when the future outcome was actually observable. */
  outcomeAt: number;
  probability: number;
  outcome: 0 | 1;
}

export function validateCalibrationSamples(samples: readonly CalibrationSample[]): void {
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const sample of samples) {
    if (!sample.id || ids.has(sample.id) || !sample.modelId) throw new RangeError("calibration samples require unique IDs and a model version");
    ids.add(sample.id);
    finite(sample.predictionAt, "predictionAt"); finite(sample.outcomeAt, "outcomeAt");
    if (sample.predictionAt < previous || sample.outcomeAt <= sample.predictionAt) throw new RangeError("calibration samples must be chronological with strictly future outcomes");
    previous = sample.predictionAt;
    probability(sample.probability);
    if (sample.outcome !== 0 && sample.outcome !== 1) throw new RangeError("calibration outcome must be binary");
  }
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  predicted: number | null;
  observed: number | null;
}

export function calibrationMetrics(samples: readonly CalibrationSample[], bins = 10) {
  validateCalibrationSamples(samples);
  if (!samples.length) throw new RangeError("calibration metrics require observations");
  if (!Number.isInteger(bins) || bins < 2 || bins > 100) throw new RangeError("bins must be in 2..100");
  const groups = Array.from({ length: bins }, () => ({ count: 0, probability: 0, outcomes: 0 }));
  let brier = 0, logLoss = 0;
  const epsilon = 1e-15;
  for (const sample of samples) {
    const group = groups[Math.min(bins - 1, Math.floor(sample.probability * bins))]!;
    group.count++; group.probability += sample.probability; group.outcomes += sample.outcome;
    brier += (sample.probability - sample.outcome) ** 2;
    const clipped = Math.max(epsilon, Math.min(1 - epsilon, sample.probability));
    logLoss -= sample.outcome * Math.log(clipped) + (1 - sample.outcome) * Math.log(1 - clipped);
  }
  let ece = 0;
  const reliability: ReliabilityBin[] = groups.map((group, i) => {
    const predicted = group.count ? group.probability / group.count : null;
    const observed = group.count ? group.outcomes / group.count : null;
    if (predicted !== null && observed !== null) ece += group.count / samples.length * Math.abs(predicted - observed);
    return { lower: i / bins, upper: (i + 1) / bins, count: group.count, predicted, observed };
  });
  return { samples: samples.length, brier: brier / samples.length, logLoss: logLoss / samples.length, ece, reliability, logLossClippingEpsilon: epsilon };
}

export function chronologicalCalibrationSplit(samples: readonly CalibrationSample[], trainingEnd: number) {
  validateCalibrationSamples(samples); finite(trainingEnd, "trainingEnd");
  const training = samples.filter(sample => sample.outcomeAt <= trainingEnd);
  const validation = samples.filter(sample => sample.predictionAt > trainingEnd);
  const purged = samples.filter(sample => sample.predictionAt <= trainingEnd && sample.outcomeAt > trainingEnd);
  return { training, validation, purged };
}

export interface PlattCalibration {
  modelId: string;
  slope: number;
  intercept: number;
  trainingStart: number;
  /** Explicit cutoff, including outcome maturity, not just final feature time. */
  trainingEnd: number;
  samples: number;
  sampleHash: string;
  method: "REGULARIZED_LOGISTIC_ON_LOGIT_PROBABILITIES";
}

/** Fit a two-parameter sigmoid using training outcomes that matured before cutoff. */
export function fitPlatt(samples: readonly CalibrationSample[], trainingEnd: number, options: { minimumSamples?: number; l2?: number; iterations?: number } = {}): PlattCalibration {
  validateCalibrationSamples(samples); finite(trainingEnd, "trainingEnd");
  const minimumSamples = options.minimumSamples ?? 30;
  const l2 = options.l2 ?? 1e-3;
  const iterations = options.iterations ?? 100;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 10 || !Number.isFinite(l2) || l2 <= 0 ||
      !Number.isInteger(iterations) || iterations < 1 || iterations > 1_000) throw new RangeError("invalid calibration optimization settings");
  if (samples.some(sample => sample.outcomeAt > trainingEnd)) throw new RangeError("training includes outcomes unavailable at the cutoff");
  if (samples.length < minimumSamples) throw new RangeError("insufficient Platt training observations");
  const modelId = samples[0]!.modelId;
  if (samples.some(sample => sample.modelId !== modelId)) throw new RangeError("calibration cannot mix model versions");
  const positives = samples.reduce((sum, sample) => sum + sample.outcome, 0);
  if (positives === 0 || positives === samples.length) throw new RangeError("calibration needs both outcome classes");
  const inputs = samples.map(sample => logit(sample.probability));
  const n = samples.length;
  const loss = (slope: number, intercept: number) => {
    let value = l2 * (slope * slope + intercept * intercept) / 2;
    for (let i = 0; i < n; i++) {
      const z = slope * inputs[i]! + intercept;
      // Stable softplus(z) - y*z.
      value += (Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z))) - samples[i]!.outcome * z) / n;
    }
    return value;
  };
  let slope = 1, intercept = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let gA = l2 * slope, gB = l2 * intercept, hAA = l2, hAB = 0, hBB = l2;
    for (let i = 0; i < n; i++) {
      const x = inputs[i]!, predicted = sigmoid(slope * x + intercept);
      const error = (predicted - samples[i]!.outcome) / n;
      const weight = predicted * (1 - predicted) / n;
      gA += error * x; gB += error; hAA += weight * x * x; hAB += weight * x; hBB += weight;
    }
    if (Math.hypot(gA, gB) < 1e-9) break;
    const determinant = hAA * hBB - hAB * hAB;
    if (!(determinant > 0)) throw new RangeError("singular calibration Hessian");
    const dA = (hBB * gA - hAB * gB) / determinant;
    const dB = (hAA * gB - hAB * gA) / determinant;
    const previousLoss = loss(slope, intercept);
    let step = 1;
    while (step > 1e-8 && loss(slope - step * dA, intercept - step * dB) > previousLoss) step /= 2;
    slope -= step * dA; intercept -= step * dB;
    if (step * Math.hypot(dA, dB) < 1e-8) break;
  }
  return {
    modelId, slope: finite(slope, "Platt slope"), intercept: finite(intercept, "Platt intercept"),
    trainingStart: samples[0]!.predictionAt, trainingEnd, samples: n,
    sampleHash: createHash("sha256").update(JSON.stringify(samples)).digest("hex"),
    method: "REGULARIZED_LOGISTIC_ON_LOGIT_PROBABILITIES",
  };
}

export function applyPlatt(value: number, calibration: PlattCalibration): number {
  return sigmoid(finite(calibration.slope, "Platt slope") * logit(value) + finite(calibration.intercept, "Platt intercept"));
}

export function evaluatePlatt(calibration: PlattCalibration, validation: readonly CalibrationSample[], bins = 10) {
  validateCalibrationSamples(validation);
  if (validation.some(sample => sample.predictionAt <= calibration.trainingEnd)) throw new RangeError("validation overlaps calibration training period");
  if (validation.some(sample => sample.modelId !== calibration.modelId)) throw new RangeError("calibration model version mismatch");
  const calibrated = validation.map(sample => ({ ...sample, probability: applyPlatt(sample.probability, calibration) }));
  return { raw: calibrationMetrics(validation, bins), calibrated: calibrationMetrics(calibrated, bins), samples: calibrated };
}
