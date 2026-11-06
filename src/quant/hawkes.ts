import { finite, nonnegative, positive } from "./math";

/** Kernel convention h(t)=alpha*exp(-beta*t), so branching ratio is alpha/beta. */
export interface HawkesParameters { baseline: number; alpha: number; beta: number }

export function validateHawkes(parameters: HawkesParameters): number {
  positive(parameters.baseline, "baseline intensity");
  nonnegative(parameters.alpha, "alpha");
  positive(parameters.beta, "beta");
  const branchingRatio = parameters.alpha / parameters.beta;
  if (branchingRatio >= 1) throw new RangeError("stationary Hawkes model requires alpha/beta < 1");
  return branchingRatio;
}

function validateEvents(events: readonly number[], start: number, end: number): void {
  finite(start, "observation start"); finite(end, "observation end");
  if (end <= start) throw new RangeError("observation interval must be positive");
  let previous = start;
  for (const event of events) {
    finite(event, "event time");
    if (event <= previous || event > end) throw new RangeError("events must be unique, ordered and inside (start,end]");
    previous = event;
  }
}

/** Predictable intensity: events at or after the query time cannot influence it. */
export function hawkesIntensity(events: readonly number[], at: number, parameters: HawkesParameters): number {
  validateHawkes(parameters);
  finite(at, "query time");
  let previous = -Infinity;
  let intensity = parameters.baseline;
  for (const event of events) {
    finite(event, "event time");
    if (event <= previous) throw new RangeError("events must be strictly increasing");
    previous = event;
    if (event < at) intensity += parameters.alpha * Math.exp(-parameters.beta * (at - event));
  }
  return finite(intensity, "Hawkes intensity");
}

/** Conditional log likelihood with empty prehistory at start; O(number of events). */
export function hawkesLogLikelihood(events: readonly number[], start: number, end: number, parameters: HawkesParameters): number {
  validateHawkes(parameters);
  validateEvents(events, start, end);
  let excitation = 0;
  let previous = start;
  let logEvents = 0;
  let integralExcitation = 0;
  for (const event of events) {
    excitation *= Math.exp(-parameters.beta * (event - previous));
    logEvents += Math.log(parameters.baseline + excitation);
    excitation += parameters.alpha;
    integralExcitation += parameters.alpha / parameters.beta * -Math.expm1(-parameters.beta * (end - event));
    previous = event;
  }
  return finite(logEvents - parameters.baseline * (end - start) - integralExcitation, "Hawkes log likelihood");
}

export interface HawkesFit {
  parameters: HawkesParameters;
  branchingRatio: number;
  logLikelihood: number;
  poissonLogLikelihood: number;
  trainingStart: number;
  trainingEnd: number;
  events: number;
  method: "BOUNDED_GRID_AND_COORDINATE_SEARCH";
  warning: string;
}

/** Constrained numerical MLE research fit; not a claim of a global optimum. */
export function fitHawkes(events: readonly number[], start: number, trainingEnd: number, minimumEvents = 20): HawkesFit {
  if (!Number.isInteger(minimumEvents) || minimumEvents < 3) throw new RangeError("minimumEvents must be >= 3");
  // Validate all timestamps, then fit only the chronological prefix.
  let previous = start;
  events.forEach(event => {
    finite(event, "event time");
    if (event <= previous) throw new RangeError("events must be strictly increasing after start");
    previous = event;
  });
  const training = events.filter(event => event <= trainingEnd);
  validateEvents(training, start, trainingEnd);
  if (training.length < minimumEvents) throw new RangeError("insufficient Hawkes training events");
  const rate = training.length / (trainingEnd - start);
  let best: HawkesParameters = { baseline: rate, alpha: 0, beta: rate };
  let score = hawkesLogLikelihood(training, start, trainingEnd, best);
  const poissonLogLikelihood = score;
  const consider = (baseline: number, beta: number, ratio: number) => {
    if (!Number.isFinite(baseline + beta) || baseline <= 0 || beta <= 0 || ratio < 0 || ratio >= 0.995) return false;
    const candidate = { baseline, alpha: ratio * beta, beta };
    const candidateScore = hawkesLogLikelihood(training, start, trainingEnd, candidate);
    if (candidateScore > score + 1e-10) {
      best = candidate; score = candidateScore; return true;
    }
    return false;
  };
  for (const ratio of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const betaScale of [0.1, 0.3, 1, 3, 10, 30]) {
      for (const baselineScale of [0.5, 1, 2]) consider(rate * (1 - ratio) * baselineScale, rate * betaScale, ratio);
    }
  }
  let step = 0.5;
  for (let iteration = 0; iteration < 120 && step > 1e-5; iteration++) {
    const current = { ...best };
    const ratio = current.alpha / current.beta;
    let improved = false;
    for (const direction of [-1, 1]) {
      improved = consider(current.baseline * Math.exp(direction * step), current.beta, ratio) || improved;
      improved = consider(current.baseline, current.beta * Math.exp(direction * step), ratio) || improved;
      improved = consider(current.baseline, current.beta, Math.max(0, Math.min(0.994, ratio + direction * step / 4))) || improved;
    }
    if (!improved) step /= 2;
  }
  return {
    parameters: best, branchingRatio: best.alpha / best.beta, logLikelihood: score,
    poissonLogLikelihood, trainingStart: start, trainingEnd, events: training.length,
    method: "BOUNDED_GRID_AND_COORDINATE_SEARCH",
    warning: "Empty prehistory and finite samples bias estimation. Branching ratio is not a directional prediction.",
  };
}

/** Streaming counterpart. Every timestamp is unique; units must match beta. */
export class ExponentialHawkes {
  private excitation = 0;
  private lastTime: number | null = null;
  private beforeLast = 0;
  readonly parameters: Readonly<HawkesParameters>;
  constructor(parameters: HawkesParameters) {
    validateHawkes(parameters);
    this.parameters = Object.freeze({ ...parameters });
  }
  intensity(at: number): number {
    finite(at, "query time");
    if (this.lastTime === null) return this.parameters.baseline;
    if (at < this.lastTime) throw new RangeError("cannot query before last observed event");
    if (at === this.lastTime) return this.beforeLast;
    return finite(this.parameters.baseline + this.excitation * Math.exp(-this.parameters.beta * (at - this.lastTime)), "streaming intensity");
  }
  observe(at: number): number {
    if (this.lastTime !== null && at <= this.lastTime) throw new RangeError("event timestamps must increase");
    const before = this.intensity(at);
    this.excitation = finite(before - this.parameters.baseline + this.parameters.alpha, "streaming excitation");
    this.beforeLast = before;
    this.lastTime = at;
    return before;
  }
}
