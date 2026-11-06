import { finite, mean, nonnegative, normalRandom, positive } from "./math";

export interface TimedValue { time: number; value: number }
export interface OUFit {
  mean: number;
  theta: number;
  sigma: number;
  halfLife: number;
  phi: number;
  intercept: number;
  innovationVariance: number;
  stationaryStd: number;
  dt: number;
  samples: number;
  trainingStart: number;
  trainingEnd: number;
  stationarity: "AR1_DIAGNOSTIC_ONLY";
}

function ordered(points: readonly TimedValue[]): void {
  let previous = -Infinity;
  for (const point of points) {
    finite(point.time, "timestamp");
    finite(point.value, "value");
    if (point.time <= previous) throw new RangeError("timestamps must be strictly increasing");
    previous = point.time;
  }
}

function regression(x: readonly number[], y: readonly number[]) {
  if (x.length !== y.length || x.length < 3) throw new RangeError("regression needs three paired observations");
  const mx = mean(x), my = mean(y);
  const xx = x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
  if (xx <= Number.EPSILON * Math.max(1, x.length * mx * mx)) {
    throw new RangeError("degenerate regressor variance");
  }
  const beta = x.reduce((sum, value, i) => sum + (value - mx) * (y[i]! - my), 0) / xx;
  const intercept = my - beta * mx;
  const residuals = y.map((value, i) => value - intercept - beta * x[i]!);
  return { beta, intercept, residuals };
}

/** Fit an exact OU transition via AR(1) OLS on an explicitly bounded training prefix. */
export function fitOU(points: readonly TimedValue[], trainingEnd: number, minimumSamples = 30): OUFit {
  ordered(points);
  finite(trainingEnd, "trainingEnd");
  if (!Number.isInteger(minimumSamples) || minimumSamples < 4) throw new RangeError("minimumSamples must be >= 4");
  const training = points.filter(point => point.time <= trainingEnd);
  if (training.length < minimumSamples) throw new RangeError("insufficient OU training observations");
  const dt = positive(training[1]!.time - training[0]!.time, "sampling interval");
  for (let i = 2; i < training.length; i++) {
    const interval = training[i]!.time - training[i - 1]!.time;
    if (Math.abs(interval - dt) > Math.max(1e-9, dt * 1e-6)) {
      throw new RangeError("OU AR(1) calibration requires regularly sampled observations");
    }
  }
  const x = training.slice(0, -1).map(point => point.value);
  const y = training.slice(1).map(point => point.value);
  const fit = regression(x, y);
  const phi = fit.beta;
  if (!(phi > 0 && phi < 1)) throw new RangeError("spread does not fit a mean-reverting continuous OU process (0 < phi < 1)");
  const theta = positive(-Math.log(phi) / dt, "OU theta");
  // OLS residual variance with two estimated coefficients; small-sample uncertainty remains.
  const innovationVariance = fit.residuals.reduce((sum, value) => sum + value * value, 0) / (x.length - 2);
  positive(innovationVariance, "innovation variance");
  const denominator = -Math.expm1(-2 * theta * dt);
  const sigma = positive(Math.sqrt(innovationVariance * 2 * theta / denominator), "OU sigma");
  return {
    mean: finite(fit.intercept / (1 - phi), "OU mean"), theta, sigma,
    halfLife: positive(Math.LN2 / theta, "OU half life"), phi, intercept: fit.intercept,
    innovationVariance, stationaryStd: positive(Math.sqrt(innovationVariance / denominator), "OU stationary standard deviation"), dt,
    samples: training.length, trainingStart: training[0]!.time, trainingEnd: training.at(-1)!.time,
    stationarity: "AR1_DIAGNOSTIC_ONLY",
  };
}

export function ouZScore(value: number, observedAt: number, fit: OUFit): number {
  finite(value, "spread value");
  finite(observedAt, "observedAt");
  if (observedAt <= fit.trainingEnd) throw new RangeError("signal must follow the calibration period");
  return (value - finite(fit.mean, "fitted mean")) / positive(fit.stationaryStd, "stationary standard deviation");
}

export interface PairFit {
  intercept: number;
  hedgeRatio: number;
  logPrices: boolean;
  trainingEnd: number;
  ou: OUFit;
  cointegration: "NOT_TESTED";
}

/** Correlation or an OU fit is not a cointegration test; research output says so explicitly. */
export function fitPairs(a: readonly TimedValue[], b: readonly TimedValue[], trainingEnd: number, logPrices = true): PairFit {
  ordered(a); ordered(b);
  if (a.length !== b.length || a.some((point, i) => point.time !== b[i]!.time)) {
    throw new RangeError("pair series must have identical aligned timestamps");
  }
  const transform = (value: number) => logPrices ? Math.log(positive(value, "pair price")) : finite(value, "pair value");
  const trainA = a.filter(point => point.time <= trainingEnd);
  const trainB = b.filter(point => point.time <= trainingEnd);
  const fit = regression(trainB.map(point => transform(point.value)), trainA.map(point => transform(point.value)));
  const spread = a.map((point, i) => ({
    time: point.time,
    value: transform(point.value) - fit.intercept - fit.beta * transform(b[i]!.value),
  }));
  const ou = fitOU(spread, trainingEnd);
  return { intercept: fit.intercept, hedgeRatio: fit.beta, logPrices, trainingEnd: ou.trainingEnd, ou, cointegration: "NOT_TESTED" };
}

export function pairsZScore(a: number, b: number, observedAt: number, fit: PairFit): number {
  const transform = (value: number) => fit.logPrices ? Math.log(positive(value, "pair price")) : finite(value, "pair value");
  const spread = transform(a) - fit.intercept - fit.hedgeRatio * transform(b);
  return ouZScore(spread, observedAt, fit.ou);
}

export function meanReversionSignal(input: {
  zScore: number;
  position: "flat" | "long_spread" | "short_spread";
  halfLife: number;
  minHalfLife: number;
  maxHalfLife: number;
  entryZ?: number;
  exitZ?: number;
  stopZ?: number;
}): "long_spread" | "short_spread" | "close" | "hold" {
  const z = finite(input.zScore, "zScore");
  const entry = positive(input.entryZ ?? 2, "entryZ");
  const exit = nonnegative(input.exitZ ?? 0.5, "exitZ");
  const stop = positive(input.stopZ ?? 4, "stopZ");
  positive(input.halfLife, "halfLife");
  nonnegative(input.minHalfLife, "minHalfLife");
  positive(input.maxHalfLife, "maxHalfLife");
  if (!(exit < entry && entry < stop && input.minHalfLife < input.maxHalfLife)) throw new RangeError("invalid mean-reversion thresholds");
  const eligible = input.halfLife >= input.minHalfLife && input.halfLife <= input.maxHalfLife;
  if (input.position !== "flat") {
    if (!eligible || Math.abs(z) >= stop || Math.abs(z) <= exit ||
        (input.position === "long_spread" && z >= 0) || (input.position === "short_spread" && z <= 0)) return "close";
    return "hold";
  }
  if (!eligible || Math.abs(z) >= stop) return "hold";
  if (z >= entry) return "short_spread";
  if (z <= -entry) return "long_spread";
  return "hold";
}

/** Exact transitions for synthetic fixtures; this is not historical market data. */
export function simulateOU(input: { mean: number; theta: number; sigma: number; initial: number; dt: number; count: number; seed: number }): TimedValue[] {
  finite(input.mean, "mean"); finite(input.initial, "initial");
  positive(input.theta, "theta"); nonnegative(input.sigma, "sigma"); positive(input.dt, "dt");
  if (!Number.isInteger(input.count) || input.count < 2 || input.count > 1_000_000) throw new RangeError("invalid sample count");
  const random = normalRandom(input.seed);
  const phi = Math.exp(-input.theta * input.dt);
  const innovationStd = input.sigma * Math.sqrt(-Math.expm1(-2 * input.theta * input.dt) / (2 * input.theta));
  const points: TimedValue[] = [{ time: 0, value: input.initial }];
  for (let i = 1; i < input.count; i++) {
    const value = input.mean + (points[i - 1]!.value - input.mean) * phi + innovationStd * random();
    points.push({ time: i * input.dt, value: finite(value, "simulated OU value") });
  }
  return points;
}
