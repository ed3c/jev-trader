import { describe, expect, test } from "bun:test";
import { avellanedaStoikov, quoteEconomics } from "../src/quant/avellaneda-stoikov";
import { fitOU, fitPairs, meanReversionSignal, ouZScore, simulateOU } from "../src/quant/ou";
import { ExponentialHawkes, fitHawkes, hawkesIntensity, hawkesLogLikelihood, validateHawkes } from "../src/quant/hawkes";
import { calibrateHestonGrid, priceHestonEuropean, simulateHestonPath } from "../src/quant/heston";
import type { HestonParameters, ObservedOption } from "../src/quant/heston";
import { fractionalKelly } from "../src/quant/kelly";
import type { CalibrationSample } from "../src/evaluation/calibration";

describe("Avellaneda-Stoikov pricing", () => {
  const base = { mid: 100, inventory: 0, gamma: 0.1, sigma: 2, timeRemaining: 1, kappa: 1.5, tickSize: 0.01 };
  test("uses the full vs half spread correctly and shifts long inventory down", () => {
    const neutral = avellanedaStoikov(base);
    const long = avellanedaStoikov({ ...base, inventory: 3 });
    const full = 0.1 * 4 + 20 * Math.log1p(0.1 / 1.5);
    expect(neutral.fullSpread).toBeCloseTo(full, 12);
    expect(neutral.halfSpread * 2).toBeCloseTo(full, 12);
    expect(long.reservationPrice).toBeCloseTo(98.8, 12);
    expect(long.bid).toBeLessThan(neutral.bid);
    expect(long.ask).toBeLessThan(neutral.ask);
  });
  test("gamma zero has the correct finite risk-neutral limit", () => {
    const quote = avellanedaStoikov({ ...base, gamma: 0, inventory: 100 });
    expect(quote.reservationPrice).toBe(100);
    expect(quote.halfSpread).toBeCloseTo(1 / 1.5, 12);
    expect(avellanedaStoikov({ ...base, gamma: 1e-12 }).halfSpread).toBeCloseTo(quote.halfSpread, 9);
  });
  test("post-only lattice constraints survive an inventory skew through the touch", () => {
    const quote = avellanedaStoikov({ ...base, inventory: -10, bestBid: 99.99, bestAsk: 100.01 });
    expect(quote.bid).toBeLessThan(100.01);
    expect(quote.ask).toBeGreaterThan(99.99);
    expect(quote.bid / 0.01).toBeCloseTo(Math.round(quote.bid / 0.01), 8);
  });
  test("invalid parameters and impossible nonpositive quotes fail closed", () => {
    expect(() => avellanedaStoikov({ ...base, kappa: 0 })).toThrow();
    expect(() => avellanedaStoikov({ ...base, sigma: NaN })).toThrow();
    expect(() => avellanedaStoikov({ ...base, inventory: 1e9 })).toThrow();
    expect(() => avellanedaStoikov({ ...base, bestBid: 101, bestAsk: 100 })).toThrow();
    expect(() => avellanedaStoikov({ ...base, bestAsk: 100.01 })).toThrow();
  });
  test("gas is charged even for zero expected completed fills", () => {
    const costs = { notional: 100, expectedCaptureBps: 3.5, makerFeeBpsPerLeg: 1, slippageBpsPerLeg: 1, adverseSelectionBps: 1, gasUsdPerCycle: 0.01, expectedCompletedRoundTrips: 0 };
    expect(quoteEconomics(costs).expectedNetUsd).toBe(-0.01);
    expect(quoteEconomics({ ...costs, expectedCompletedRoundTrips: 100 }).canQuote).toBe(false);
  });
});

describe("OU and statistical arbitrage", () => {
  const points = simulateOU({ mean: 2, theta: 0.2, sigma: 0.3, initial: 2, dt: 1, count: 1_500, seed: 42 });
  test("fits a mean-reverting prefix and does not train on future observations", () => {
    const fit = fitOU(points, 999);
    const changedFuture = points.map(point => point.time > 999 ? { ...point, value: point.value * 10_000 } : point);
    expect(fitOU(changedFuture, 999)).toEqual(fit);
    expect(fit.theta).toBeGreaterThan(0.1);
    expect(fit.theta).toBeLessThan(0.4);
    expect(fit.halfLife).toBeCloseTo(Math.LN2 / fit.theta, 12);
    expect(fit.stationarity).toBe("AR1_DIAGNOSTIC_ONLY");
    expect(() => ouZScore(2, 999, fit)).toThrow("follow");
    expect(ouZScore(fit.mean + 2 * fit.stationaryStd, 1_000, fit)).toBeCloseTo(2, 12);
  });
  test("rejects non-mean-reversion, constant series, irregular timestamps and insufficient history", () => {
    expect(() => fitOU(Array.from({ length: 50 }, (_, i) => ({ time: i, value: 1.05 ** i })), 49)).toThrow();
    expect(() => fitOU(Array.from({ length: 50 }, (_, i) => ({ time: i, value: 2 })), 49)).toThrow();
    expect(() => fitOU(points.map((point, i) => i === 100 ? { ...point, time: point.time + 0.1 } : point), 999)).toThrow("regularly");
    expect(() => fitOU(points, 10)).toThrow("insufficient");
  });
  test("pair regression is trained on the prefix and does not assert cointegration", () => {
    const b = points.map(point => ({ time: point.time, value: Math.exp(4 + point.time / 10_000) }));
    const a = points.map((point, i) => ({ time: point.time, value: Math.exp(1 + 0.8 * Math.log(b[i]!.value) + 0.1 * point.value) }));
    const fit = fitPairs(a, b, 999);
    expect(fit.cointegration).toBe("NOT_TESTED");
    expect(fitPairs(a.map(point => point.time > 999 ? { ...point, value: point.value * 100 } : point), b, 999)).toEqual(fit);
  });
  test("signal exits on reversion, adverse excursion or an invalid half-life", () => {
    const limits = { halfLife: 5, minHalfLife: 1, maxHalfLife: 20 };
    expect(meanReversionSignal({ ...limits, zScore: -2.2, position: "flat" })).toBe("long_spread");
    expect(meanReversionSignal({ ...limits, zScore: -4.1, position: "flat" })).toBe("hold");
    expect(meanReversionSignal({ ...limits, zScore: -4.1, position: "long_spread" })).toBe("close");
    expect(meanReversionSignal({ ...limits, zScore: 0.2, position: "long_spread" })).toBe("close");
  });
});

describe("exponential Hawkes model", () => {
  const parameters = { baseline: 1, alpha: 0.5, beta: 2 };
  test("predictable intensity excludes the current and future events", () => {
    expect(hawkesIntensity([1, 2, 8], 2, parameters)).toBeCloseTo(1 + 0.5 * Math.exp(-2), 12);
    const stream = new ExponentialHawkes(parameters);
    expect(stream.observe(1)).toBe(1);
    expect(stream.observe(2)).toBeCloseTo(hawkesIntensity([1], 2, parameters), 12);
    expect(stream.intensity(3)).toBeCloseTo(hawkesIntensity([1, 2], 3, parameters), 12);
    expect(() => stream.observe(2)).toThrow();
  });
  test("likelihood equals an analytically integrated two-event example", () => {
    const expected = Math.log(1 + 0.5 * Math.exp(-2)) - 3 - 0.25 * (2 - Math.exp(-4) - Math.exp(-2));
    expect(hawkesLogLikelihood([1, 2], 0, 3, parameters)).toBeCloseTo(expected, 12);
    expect(hawkesLogLikelihood([1, 2], 0, 3, { baseline: 1, alpha: 0, beta: 2 })).toBe(-3);
  });
  test("rejects explosive kernels and fits no worse than its Poisson candidate", () => {
    expect(() => validateHawkes({ baseline: 1, alpha: 2, beta: 2 })).toThrow();
    expect(() => hawkesLogLikelihood([1, 1], 0, 3, parameters)).toThrow();
    const events = Array.from({ length: 80 }, (_, i) => 0.1 + Math.floor(i / 4) * 3 + (i % 4) * 0.06);
    const fit = fitHawkes(events, 0, 60);
    expect(fit.branchingRatio).toBeLessThan(1);
    expect(fit.logLikelihood).toBeGreaterThanOrEqual(fit.poissonLogLikelihood);
    expect(fitHawkes([...events, 90, 91, 92], 0, 60)).toEqual(fit);
  });
});

describe("Heston research pricing", () => {
  const params: HestonParameters = { spot: 100, initialVariance: 0.04, kappa: 2, theta: 0.04, volOfVariance: 0.3, rho: -0.7, rate: 0.03 };
  test("zero variance has an independently known discounted deterministic payoff", () => {
    const p = priceHestonEuropean({ ...params, initialVariance: 0, theta: 0, volOfVariance: 0 }, { kind: "call", strike: 100, maturity: 1 }, { paths: 100, steps: 20, seed: 7 });
    expect(p.price).toBeCloseTo(100 - 100 * Math.exp(-0.03), 8);
    expect(p.standardError).toBeLessThan(1e-10);
    expect(p.uncertainty).toContain("EXCLUDES_DISCRETIZATION");
  });
  test("full truncation keeps coefficients positive while retaining a negative latent variance", () => {
    const path = simulateHestonPath({ ...params, volOfVariance: 3 }, { horizon: 1, steps: 100, seed: 14 });
    expect(path.every(point => point.variance >= 0 && point.spot > 0 && Number.isFinite(point.spot))).toBe(true);
    expect(path.some(point => point.rawVariance < 0)).toBe(true);
    expect(simulateHestonPath(params, { horizon: 1, steps: 100, seed: 14 })).toEqual(simulateHestonPath(params, { horizon: 1, steps: 100, seed: 14 }));
  });
  test("a call and put use the same shocks and respect put-call parity within sampling error", () => {
    const config = { paths: 12_000, steps: 64, seed: 19 };
    const call = priceHestonEuropean(params, { kind: "call", strike: 100, maturity: 1 }, config);
    const put = priceHestonEuropean(params, { kind: "put", strike: 100, maturity: 1 }, config);
    const parity = params.spot - 100 * Math.exp(-params.rate);
    expect(Math.abs(call.price - put.price - parity)).toBeLessThan(4 * (call.standardError + put.standardError));
    expect(() => priceHestonEuropean({ ...params, rho: 1.01 }, { kind: "call", strike: 100, maturity: 1 }, config)).toThrow();
  });
  test("candidate selection never uses future option prices", () => {
    const config = { paths: 500, steps: 20, seed: 3 };
    const candidates = [params, { ...params, initialVariance: 0.15, theta: 0.15 }];
    const quotes: ObservedOption[] = [90, 100, 110, 105].map((strike, i) => ({
      id: String(i), asOf: i < 3 ? 100 : 200, spot: 100, kind: "call", strike, maturity: 1,
      marketPrice: priceHestonEuropean(params, { kind: "call", strike, maturity: 1 }, config).price,
    }));
    const first = calibrateHestonGrid(quotes, candidates, { trainingEnd: 100, simulation: config });
    const changed = calibrateHestonGrid(quotes.map(quote => quote.asOf > 100 ? { ...quote, marketPrice: 99 } : quote), candidates, { trainingEnd: 100, simulation: config });
    expect(first.parameters).toEqual(params);
    expect(changed.parameters).toEqual(first.parameters);
    expect(changed.validationRmse).not.toBe(first.validationRmse);
  });
});

describe("calibrated fractional Kelly", () => {
  const samples: CalibrationSample[] = Array.from({ length: 200 }, (_, i) => ({
    id: String(i), modelId: "model-v1", predictionAt: 1_001 + i * 2, outcomeAt: 1_002 + i * 2,
    probability: 0.6, outcome: i % 10 < 6 ? 1 : 0,
  }));
  const evidence = { modelId: "model-v1", outcomeDefinition: "TRADE_NET_PROFIT_POSITIVE" as const, trainingEnd: 1_000, validation: samples };
  test("uses payoff ratio instead of assuming even-money returns", () => {
    expect(fractionalKelly({ winProbability: 0.6, netWinLossRatio: 2, modelId: "model-v1", evidence }).fraction).toBeCloseTo(0.1, 12);
    expect(fractionalKelly({ winProbability: 0.6, netWinLossRatio: 1, modelId: "model-v1", evidence }).fraction).toBeCloseTo(0.05, 12);
  });
  test("refuses unverified, stale-version and uncalibrated probabilities", () => {
    expect(fractionalKelly({ winProbability: 0.9, netWinLossRatio: 2, modelId: "model-v1" }).fraction).toBe(0);
    expect(fractionalKelly({ winProbability: 0.9, netWinLossRatio: 2, modelId: "model-v1", evidence }).fraction).toBe(0);
    expect(fractionalKelly({ winProbability: 0.6, netWinLossRatio: 2, modelId: "different", evidence }).fraction).toBe(0);
    const wrong = { ...evidence, validation: samples.map(sample => ({ ...sample, probability: 0.99 })) };
    expect(fractionalKelly({ winProbability: 0.99, netWinLossRatio: 2, modelId: "model-v1", evidence: wrong }).fraction).toBe(0);
  });
});
