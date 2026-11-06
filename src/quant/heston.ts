import { finite, mean, nonnegative, normalRandom, positive, sampleVariance } from "./math";

export interface HestonParameters {
  spot: number;
  initialVariance: number;
  kappa: number;
  theta: number;
  volOfVariance: number;
  rho: number;
  rate: number;
  dividendYield?: number;
}
export interface EuropeanOption { kind: "call" | "put"; strike: number; maturity: number }
export interface HestonSimulation { paths: number; steps: number; seed: number }

export function validateHeston(parameters: HestonParameters): boolean {
  positive(parameters.spot, "spot");
  nonnegative(parameters.initialVariance, "initialVariance");
  positive(parameters.kappa, "kappa"); nonnegative(parameters.theta, "theta");
  nonnegative(parameters.volOfVariance, "volOfVariance");
  finite(parameters.rho, "rho");
  if (Math.abs(parameters.rho) > 1) throw new RangeError("rho must be in [-1,1]");
  finite(parameters.rate, "risk-neutral rate"); finite(parameters.dividendYield ?? 0, "dividend yield");
  return 2 * parameters.kappa * parameters.theta >= parameters.volOfVariance ** 2;
}

function validateSimulation(config: HestonSimulation) {
  if (!Number.isInteger(config.paths) || config.paths < 2 || config.paths > 1_000_000 ||
      !Number.isInteger(config.steps) || config.steps < 1 || config.steps > 100_000 ||
      config.paths * config.steps > 50_000_000) throw new RangeError("simulation exceeds bounded path/step budget");
  if (!Number.isSafeInteger(config.seed)) throw new RangeError("seed must be a safe integer");
}

function validateOption(option: EuropeanOption) {
  if (option.kind !== "call" && option.kind !== "put") throw new RangeError("unsupported option kind");
  positive(option.strike, "strike"); nonnegative(option.maturity, "maturity in years");
}

function stepHeston(spot: number, rawVariance: number, parameters: HestonParameters, dt: number, random: () => number) {
  const variance = Math.max(0, rawVariance);
  const zVariance = random();
  const zSpot = parameters.rho * zVariance + Math.sqrt(Math.max(0, 1 - parameters.rho ** 2)) * random();
  const diffusion = Math.sqrt(variance * dt);
  const nextSpot = spot * Math.exp((parameters.rate - (parameters.dividendYield ?? 0) - variance / 2) * dt + diffusion * zSpot);
  // Retain the untruncated latent update; truncate only coefficients and reported variance.
  // Clamping the state itself each step would be a different (partial truncation) scheme.
  const nextRawVariance = rawVariance + parameters.kappa * (parameters.theta - variance) * dt + parameters.volOfVariance * diffusion * zVariance;
  return { spot: positive(nextSpot, "simulated spot"), rawVariance: finite(nextRawVariance, "simulated variance") };
}

export function simulateHestonPath(parameters: HestonParameters, input: { horizon: number; steps: number; seed: number }) {
  validateHeston(parameters);
  nonnegative(input.horizon, "horizon");
  validateSimulation({ paths: 2, steps: input.steps, seed: input.seed });
  const random = normalRandom(input.seed);
  const dt = input.horizon / input.steps;
  let state = { spot: parameters.spot, rawVariance: parameters.initialVariance };
  const path = [{ time: 0, spot: state.spot, variance: Math.max(0, state.rawVariance), rawVariance: state.rawVariance }];
  for (let i = 1; i <= input.steps; i++) {
    state = stepHeston(state.spot, state.rawVariance, parameters, dt, random);
    path.push({ time: i * dt, spot: state.spot, variance: Math.max(0, state.rawVariance), rawVariance: state.rawVariance });
  }
  return path;
}

export interface HestonPrice {
  price: number;
  standardError: number;
  confidence95: [number, number];
  paths: number;
  steps: number;
  seed: number;
  fellerConditionSatisfied: boolean;
  method: "RISK_NEUTRAL_FULL_TRUNCATION_LOG_EULER";
  uncertainty: "MONTE_CARLO_SAMPLING_ONLY_EXCLUDES_DISCRETIZATION_AND_MODEL_ERROR";
}

/** European risk-neutral price. No physical-return forecast or executable trade is implied. */
export function priceHestonEuropean(parameters: HestonParameters, option: EuropeanOption, config: HestonSimulation): HestonPrice {
  const fellerConditionSatisfied = validateHeston(parameters);
  validateOption(option); validateSimulation(config);
  const random = normalRandom(config.seed);
  const dt = option.maturity / config.steps;
  const discount = Math.exp(-parameters.rate * option.maturity);
  const payoffs: number[] = [];
  for (let path = 0; path < config.paths; path++) {
    let state = { spot: parameters.spot, rawVariance: parameters.initialVariance };
    for (let step = 0; step < config.steps; step++) state = stepHeston(state.spot, state.rawVariance, parameters, dt, random);
    const intrinsic = option.kind === "call" ? state.spot - option.strike : option.strike - state.spot;
    payoffs.push(finite(discount * Math.max(0, intrinsic), "discounted payoff"));
  }
  const price = mean(payoffs);
  const standardError = finite(Math.sqrt(sampleVariance(payoffs) / config.paths), "Monte Carlo standard error");
  return {
    price, standardError, confidence95: [Math.max(0, price - 1.96 * standardError), finite(price + 1.96 * standardError, "confidence upper bound")],
    ...config, fellerConditionSatisfied, method: "RISK_NEUTRAL_FULL_TRUNCATION_LOG_EULER",
    uncertainty: "MONTE_CARLO_SAMPLING_ONLY_EXCLUDES_DISCRETIZATION_AND_MODEL_ERROR",
  };
}

export interface ObservedOption extends EuropeanOption { id: string; asOf: number; spot: number; marketPrice: number }

/**
 * Bounded candidate search using common random numbers. Fit uses only quotes <= trainingEnd.
 * This is a reproducible research path, not a full market-surface calibration service.
 */
export function calibrateHestonGrid(quotes: readonly ObservedOption[], candidates: readonly HestonParameters[], input: {
  trainingEnd: number; simulation: HestonSimulation;
}) {
  finite(input.trainingEnd, "trainingEnd"); validateSimulation(input.simulation);
  if (!candidates.length || candidates.length > 200) throw new RangeError("provide 1..200 Heston candidates");
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const quote of quotes) {
    validateOption(quote); finite(quote.asOf, "option asOf"); positive(quote.spot, "option spot");
    nonnegative(quote.marketPrice, "market price");
    if (!quote.id || ids.has(quote.id)) throw new RangeError("option observations require unique IDs");
    if (quote.asOf < previous) throw new RangeError("option observations must be chronological");
    previous = quote.asOf; ids.add(quote.id);
  }
  const training = quotes.filter(quote => quote.asOf <= input.trainingEnd);
  const validation = quotes.filter(quote => quote.asOf > input.trainingEnd);
  if (training.length < 3) throw new RangeError("Heston grid fit needs at least three training quotes");
  if (quotes.length * candidates.length * input.simulation.paths * input.simulation.steps > 100_000_000) {
    throw new RangeError("Heston calibration exceeds bounded simulation budget");
  }
  const rmse = (candidate: HestonParameters, observations: readonly ObservedOption[]) => {
    if (!observations.length) return null;
    const errors = observations.map(quote => {
      const price = priceHestonEuropean({ ...candidate, spot: quote.spot }, quote, input.simulation).price;
      return (price - quote.marketPrice) ** 2;
    });
    return Math.sqrt(mean(errors));
  };
  const scored = candidates.map(candidate => ({ parameters: { ...candidate }, trainingRmse: rmse(candidate, training)! }));
  scored.sort((a, b) => a.trainingRmse - b.trainingRmse);
  const selected = scored[0]!;
  return {
    ...selected, validationRmse: rmse(selected.parameters, validation), trainingEnd: input.trainingEnd,
    trainingCount: training.length, validationCount: validation.length,
    method: "FINITE_CANDIDATE_GRID_WITH_COMMON_RANDOM_NUMBERS" as const,
    warnings: ["No global optimum claim.", "Monte Carlo and time-discretization error remain.",
      "Parameters must be revalidated against real option quotes before any volatility trade."],
  };
}
