export interface QuoteEconomics {
  bid: number; ask: number; size: number; mid: number;
  fillProbability: number; makerFeeBps: number; slippageBps: number;
  adverseSelectionBps: number; gasUsd: number; decisionUsd: number;
}

/** A conservative round-trip estimate. Input assumptions are not measured profitability. */
export function quoteEconomics(p: QuoteEconomics) {
  if (Object.values(p).some(v => !Number.isFinite(v)) || p.bid <= 0 || p.ask <= p.bid || p.size <= 0 || p.mid <= 0 ||
      p.fillProbability < 0 || p.fillProbability > 1 || p.gasUsd < 0 || p.decisionUsd < 0 ||
      p.makerFeeBps < 0 || p.slippageBps < 0 || p.adverseSelectionBps < 0) throw new Error("Invalid cost assumptions");
  const grossCaptureUsd = (p.ask - p.bid) * p.size * p.fillProbability;
  const variableCostUsd = p.size * p.mid * p.fillProbability *
    (2 * p.makerFeeBps + p.slippageBps + p.adverseSelectionBps) / 10_000;
  const totalCostUsd = variableCostUsd + p.gasUsd + p.decisionUsd;
  return { grossCaptureUsd, totalCostUsd, netEdgeUsd: grossCaptureUsd - totalCostUsd,
    breakEvenFillProbability: (p.ask - p.bid) * p.size > variableCostUsd / Math.max(p.fillProbability, 1e-12)
      ? (p.gasUsd + p.decisionUsd) / ((p.ask - p.bid) * p.size - variableCostUsd / Math.max(p.fillProbability, 1e-12)) : null,
    assumptions: p, measured: false as const };
}

export function replacementReason(old: {bid:number;ask:number;at:number}|null, next: {bid:number;ask:number},
  now:number, minLifeMs:number, maxLifeMs:number, thresholdBps:number): string | null {
  if (!old) return "no_resting_quotes";
  if (now - old.at >= maxLifeMs) return "quote_lifetime";
  if (now - old.at < minLifeMs) return null;
  const moved = Math.max(Math.abs(next.bid / old.bid - 1), Math.abs(next.ask / old.ask - 1)) * 10_000;
  return moved >= thresholdBps ? "material_price_change" : null;
}
