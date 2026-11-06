import { avellanedaStoikov, quoteEconomics } from "../src/quant/avellaneda-stoikov";
import { fitOU, ouZScore, simulateOU } from "../src/quant/ou";
import { fitHawkes, hawkesIntensity } from "../src/quant/hawkes";
import { priceHestonEuropean } from "../src/quant/heston";

const args = Bun.argv.slice(2);
const value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
try {
  if (args.includes("--help")) {
    console.log("bun run scripts/quant.ts [--model all|ou|as|hawkes|heston] [--output result.json]\nRuns labeled synthetic research examples. No network, API calls, account access or live orders.");
    process.exit(0);
  }
  const model = value("--model") ?? "all";
  if (!["all", "ou", "as", "hawkes", "heston"].includes(model)) throw new Error("Unknown model; use --help");
  const results: Record<string, unknown> = {};
  if (model === "all" || model === "ou") {
    const points = simulateOU({ mean: 0, theta: 0.2, sigma: 0.1, initial: 0, dt: 1, count: 1_000, seed: 42 });
    const fit = fitOU(points, 799);
    results.ou = { fit, heldOutZScore: ouZScore(points.at(-1)!.value, points.at(-1)!.time, fit),
      note: "Synthetic OU data; no historical cointegration or strategy acceptance claim." };
  }
  if (model === "all" || model === "as") {
    results.avellanedaStoikov = avellanedaStoikov({ mid: 100, inventory: 2, gamma: 0.01, sigma: 0.1, timeRemaining: 10, kappa: 100, tickSize: 0.01, bestBid: 99.99, bestAsk: 100.01 });
    results.quoteEconomics = quoteEconomics({ notional: 100, expectedCaptureBps: 3.5, makerFeeBpsPerLeg: 1, slippageBpsPerLeg: 1, adverseSelectionBps: 1, gasUsdPerCycle: 0.02, expectedCompletedRoundTrips: 1 });
  }
  if (model === "all" || model === "hawkes") {
    const events = Array.from({ length: 80 }, (_, i) => 0.1 + Math.floor(i / 4) * 3 + (i % 4) * 0.06);
    const fit = fitHawkes(events, 0, 60);
    results.hawkes = { fit, intensityAt61: hawkesIntensity(events, 61, fit.parameters), note: "Invented event clusters, not exchange order flow." };
  }
  if (model === "all" || model === "heston") {
    results.heston = priceHestonEuropean({ spot: 100, initialVariance: 0.04, kappa: 2, theta: 0.04, volOfVariance: 0.3, rho: -0.7, rate: 0.03 },
      { kind: "call", strike: 100, maturity: 1 }, { paths: 10_000, steps: 128, seed: 2026 });
  }
  const output = `${JSON.stringify({ provenance: "SYNTHETIC_ENGINEERING_FIXTURES", liveApproved: false, results }, null, 2)}\n`;
  const path = value("--output");
  if (path) { await Bun.write(path, output); console.log(`Wrote ${path}`); }
  else console.log(output);
} catch (error) { console.error(error instanceof Error ? error.message : "Quant research failed"); process.exitCode = 1; }
