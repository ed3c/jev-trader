import { compareBaselines, syntheticReplayDataset } from "../src/evaluation/replay";
import type { ReplayConfig, ReplayDataset } from "../src/evaluation/replay";
import { chronologicalCalibrationSplit, evaluatePlatt, fitPlatt } from "../src/evaluation/calibration";
import type { CalibrationSample } from "../src/evaluation/calibration";
import { assessStrategyEvidence, backtestPairs } from "../src/evaluation/strategy";
import type { PairBar, StrategyEvidence } from "../src/evaluation/strategy";

const args = Bun.argv.slice(2);
const value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const help = `Offline evaluation, never live trading or automatic paid API calls.

bun run scripts/evaluate.ts --synthetic [--frames 240] [--output report.json]
bun run scripts/evaluate.ts --data dataset.json [--config config.json] [--output report.json]
bun run scripts/evaluate.ts --calibration samples.json --training-end TIMESTAMP
bun run scripts/evaluate.ts --strategy evidence.json
bun run scripts/evaluate.ts --pairs pairs.json

Replay datasets require point-in-time L2 frames and later trade prints. LLM/Jev
baselines require exact-state provider recordings; absent recordings are NOT_RUN.
Calibration input is CalibrationSample[]. Pair input is {bars, config}. See
docs/quant-models.md for schemas, cost assumptions and source references.
`;

try {
  if (args.includes("--help")) { console.log(help); process.exit(0); }
  const sources = ["--data", "--calibration", "--strategy", "--pairs", "--synthetic"].filter(flag => args.includes(flag));
  if (sources.length > 1) throw new Error("Choose exactly one input mode");
  let result: unknown;
  if (args.includes("--calibration")) {
    const path = value("--calibration"), cutoff = Number(value("--training-end"));
    if (!path || !Number.isFinite(cutoff)) throw new Error("Provide --calibration FILE --training-end TIMESTAMP");
    const samples = await Bun.file(path).json() as CalibrationSample[];
    const split = chronologicalCalibrationSplit(samples, cutoff);
    const fitted = fitPlatt(split.training, cutoff);
    result = { fitted, validation: evaluatePlatt(fitted, split.validation), purgedCount: split.purged.length, liveApproved: false };
  } else if (args.includes("--strategy")) {
    const path = value("--strategy"); if (!path) throw new Error("Provide a strategy evidence file");
    result = assessStrategyEvidence(await Bun.file(path).json() as StrategyEvidence);
  } else if (args.includes("--pairs")) {
    const path = value("--pairs"); if (!path) throw new Error("Provide a pair research input file");
    const input = await Bun.file(path).json() as { bars: PairBar[]; config: Parameters<typeof backtestPairs>[1] };
    result = backtestPairs(input.bars, input.config);
  } else {
    const path = value("--data"), configPath = value("--config");
    if (args.includes("--data") && !path) throw new Error("Provide --data FILE");
    const dataset = path ? await Bun.file(path).json() as ReplayDataset : syntheticReplayDataset(Number(value("--frames") ?? 240));
    const config = configPath ? await Bun.file(configPath).json() as Partial<ReplayConfig> : {};
    result = await compareBaselines(dataset, config);
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = value("--output");
  if (output) { await Bun.write(output, serialized); console.log(`Wrote ${output}`); }
  else console.log(serialized);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
}
