import { finite, nonnegative, positive } from "./math";

export interface AvellanedaStoikovInput {
  mid: number;
  /** Base-asset units, signed. Gamma must be calibrated for these units. */
  inventory: number;
  gamma: number;
  /** Absolute price standard deviation per square root of the chosen time unit. */
  sigma: number;
  /** Remaining horizon in the same time unit used by sigma. */
  timeRemaining: number;
  /** Exponential fill-intensity decay, in inverse price units. */
  kappa: number;
  tickSize: number;
  bestBid?: number;
  bestAsk?: number;
  minHalfSpread?: number;
}

export interface AvellanedaStoikovQuote {
  reservationPrice: number;
  /** Analytical half spread, before tick rounding or book constraints. */
  halfSpread: number;
  fullSpread: number;
  bid: number;
  ask: number;
}

function tickRound(price: number, tick: number, side: "bid" | "ask"): number {
  const ticks = price / tick;
  if (!Number.isFinite(ticks) || Math.abs(ticks) > Number.MAX_SAFE_INTEGER - 2) {
    throw new RangeError("price/tick exceeds safe numeric precision");
  }
  // Directional rounding is deliberately conservative; no epsilon can round through a touch.
  return (side === "bid" ? Math.floor(ticks) : Math.ceil(ticks)) * tick;
}

/**
 * Finite-horizon A-S approximation, equations (29)-(30) in the 2008 paper.
 * The supplied article incorrectly labels the FULL spread as a half spread.
 * This function uses half = gamma*sigma^2*tau/2 + log1p(gamma/kappa)/gamma.
 * Pricing is a deterministic proposal. Execution still needs independent risk approval.
 */
export function avellanedaStoikov(input: AvellanedaStoikovInput): AvellanedaStoikovQuote {
  const { mid, inventory, gamma, sigma, timeRemaining, kappa, tickSize } = input;
  positive(mid, "mid");
  finite(inventory, "inventory");
  nonnegative(gamma, "gamma");
  nonnegative(sigma, "sigma");
  nonnegative(timeRemaining, "timeRemaining");
  positive(kappa, "kappa");
  positive(tickSize, "tickSize");
  const minimum = nonnegative(input.minHalfSpread ?? 0, "minHalfSpread");
  if ((input.bestBid === undefined) !== (input.bestAsk === undefined)) {
    throw new RangeError("bestBid and bestAsk must be supplied together");
  }
  if (input.bestBid !== undefined && input.bestAsk !== undefined) {
    positive(input.bestBid, "bestBid");
    positive(input.bestAsk, "bestAsk");
    if (input.bestBid >= input.bestAsk) throw new RangeError("book must be uncrossed");
  }
  const varianceRisk = finite(gamma * sigma * sigma * timeRemaining, "variance risk");
  const reservationPrice = finite(mid - inventory * varianceRisk, "reservation price");
  const arrivalTerm = gamma === 0 ? 1 / kappa : Math.log1p(gamma / kappa) / gamma;
  const halfSpread = positive(Math.max(minimum, varianceRisk / 2 + arrivalTerm), "half spread");
  let bid = tickRound(reservationPrice - halfSpread, tickSize, "bid");
  let ask = tickRound(reservationPrice + halfSpread, tickSize, "ask");
  if (input.bestBid !== undefined && input.bestAsk !== undefined) {
    // Largest lattice bid strictly below ask; smallest lattice ask strictly above bid.
    const maxBid = (Math.ceil(input.bestAsk / tickSize) - 1) * tickSize;
    const minAsk = (Math.floor(input.bestBid / tickSize) + 1) * tickSize;
    bid = Math.min(bid, maxBid);
    ask = Math.max(ask, minAsk);
    if (bid >= input.bestAsk || ask <= input.bestBid) {
      throw new RangeError("numeric precision cannot guarantee post-only prices");
    }
  }
  positive(bid, "bid");
  positive(ask, "ask");
  if (bid >= ask) throw new RangeError("quote must have positive spread");
  return { reservationPrice, halfSpread, fullSpread: finite(2 * halfSpread, "full spread"), bid, ask };
}

export interface QuoteEconomicsInput {
  notional: number;
  /** Expected gross return for an entire completed buy/sell round trip. */
  expectedCaptureBps: number;
  makerFeeBpsPerLeg: number;
  slippageBpsPerLeg: number;
  adverseSelectionBps: number;
  gasUsdPerCycle: number;
  expectedCompletedRoundTrips: number;
}

/** Gas is paid even when no trade fills. Negative maker fees allow explicit rebates. */
export function quoteEconomics(input: QuoteEconomicsInput) {
  positive(input.notional, "notional");
  nonnegative(input.expectedCaptureBps, "expectedCaptureBps");
  finite(input.makerFeeBpsPerLeg, "makerFeeBpsPerLeg");
  nonnegative(input.slippageBpsPerLeg, "slippageBpsPerLeg");
  nonnegative(input.adverseSelectionBps, "adverseSelectionBps");
  nonnegative(input.gasUsdPerCycle, "gasUsdPerCycle");
  nonnegative(input.expectedCompletedRoundTrips, "expectedCompletedRoundTrips");
  const costBps = 2 * (input.makerFeeBpsPerLeg + input.slippageBpsPerLeg) + input.adverseSelectionBps;
  const contributionUsd = input.notional * (input.expectedCaptureBps - costBps) / 10_000;
  const expectedNetUsd = contributionUsd * input.expectedCompletedRoundTrips - input.gasUsdPerCycle;
  return {
    expectedNetUsd: finite(expectedNetUsd, "expected net"),
    canQuote: expectedNetUsd > 0,
    breakEvenRoundTrips: contributionUsd > 0 ? input.gasUsdPerCycle / contributionUsd : null,
    assumptions: "Expected fills and adverse selection must come from measured venue data.",
  };
}
