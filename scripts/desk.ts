import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hash } from "../src/desk/evidence";
import { TradingViewReadClient, TradingViewSetupClient } from "../src/integrations/tradingview";
import type { TradingViewSetupOperation, TradingViewSetupApproval } from "../src/integrations/tradingview";
import { GoogleSheetsJournalExporter, NotionJournalExporter } from "../src/integrations/journal-export";
import type { SheetsDestination, NotionDestination } from "../src/integrations/journal-export";
import { DeskJournal } from "../src/desk/journal";
import { DeskWorkflow } from "../src/desk/workflow";
import { syntheticDeskCase } from "../src/desk/fixtures";
import { LocalPaperBroker } from "../src/integrations/paper-broker";
import { AlpacaLiveBroker, AlpacaPaperBroker } from "../src/integrations/alpaca";
import { claimDueDeskJobs, dueDeskJobs, nyseCalendar2026, validateSessionCalendar } from "../src/desk/scheduler";
import type { SessionCalendar } from "../src/desk/scheduler";
import { JsonDeskProvider, runDeskRoutine } from "../src/desk/runner";
import { executeDeskBacktest } from "../src/desk/backtest";
import type { DeskBacktestJob } from "../src/desk/backtest";
import type { DeskCase, DeskRules } from "../src/desk/types";

const args = process.argv.slice(2), command = args[0] ?? "help";
function option(name: string, fallback?: string): string | undefined { const index = args.indexOf(`--${name}`); if (index < 0) return fallback; const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`); return value; }
const flag = (name: string) => args.includes(`--${name}`);
async function output(path: string, body: string): Promise<void> { mkdirSync(dirname(resolve(path)), { recursive: true }); await Bun.write(path, body); }
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function broker(journal: DeskJournal, now: () => number, mode = "local-paper", capital = 10_000) {
  if (mode === "local-paper") return new LocalPaperBroker(journal, capital, now);
  if (mode === "alpaca-live") {
    if (!flag("allow-live-orders") || process.env.ALPACA_PAPER_TRADE !== "False") throw new Error("explicit_live_opt_in_required");
    return new AlpacaLiveBroker({ journal, apiKey: process.env.ALPACA_LIVE_API_KEY ?? "", secretKey: process.env.ALPACA_LIVE_SECRET_KEY ?? "", allowLiveOrders: true,
      expectedAccountId: option("account-id") ?? "", readinessReportFile: option("paper-readiness") ?? "", orderAuthorizationFile: option("live-authorization") ?? "", now });
  }
  if (mode !== "alpaca-paper") throw new Error("unknown_desk_broker");
  return new AlpacaPaperBroker({ journal, apiKey: process.env.ALPACA_API_KEY ?? "", secretKey: process.env.ALPACA_SECRET_KEY ?? "", paper: true,
    allowPaperOrders: flag("allow-paper-orders") && process.env.ALPACA_PAPER_TRADE === "True", now });
}
async function calendar(path: string): Promise<SessionCalendar> {
  const value = path === "nyse-2026" ? nyseCalendar2026() : await Bun.file(path).json() as SessionCalendar;
  validateSessionCalendar(value); return value;
}

try {
  if (command === "demo") {
    const now = Date.now(), journalPath = option("journal", `data/desk-demo-${now}.sqlite`)!;
    const journal = new DeskJournal(journalPath);
    try {
      const paper = new LocalPaperBroker(journal, 10_000, () => now), input = syntheticDeskCase(now), desk = new DeskWorkflow(journal, paper, { allowSyntheticDemo: true, now: () => now });
      paper.mark(input.quote); const state = await desk.run(input, now);
      const report = { provenance: "SYNTHETIC_SOFTWARE_DEMONSTRATION", externalOrdersSent: false, historicalStrategyAccepted: false, state, account: paper.snapshot(), brief: desk.chiefBrief(now), journal: resolve(journalPath) };
      if (option("out")) await output(option("out")!, JSON.stringify(report, null, 2) + "\n");
      if (option("input-out")) await output(option("input-out")!, JSON.stringify({ cases: [input] }, null, 2) + "\n");
      if (option("csv")) await output(option("csv")!, journal.exportCsv());
      print(report);
    } finally { journal.close(); }
  } else if (command === "backtest" || command === "prepare") {
    const path = option("input"); if (!path) throw new Error("--input is required");
    const value = await Bun.file(path).json(), now = Date.now();
    if (command === "backtest") {
      const jobs: DeskBacktestJob[] = Array.isArray(value) ? value : [value];
      const results = jobs.map(job => executeDeskBacktest(job, now));
      if (option("out")) await output(option("out")!, JSON.stringify(results, null, 2) + "\n");
      print(results);
    } else {
      if (!Array.isArray(value.cases) || !Array.isArray(value.backtests)) throw new Error("prepare requires cases and raw backtests");
      const cases: DeskCase[] = [], skipped: unknown[] = [];
      for (const seed of value.cases as Omit<DeskCase, "plan" | "backtest">[]) {
        const job = (value.backtests as DeskBacktestJob[]).find(item => item.caseId === seed.id);
        if (!job) { skipped.push({ id: seed.id, reason: "raw_bar_backtest_job_missing" }); continue; }
        const result = executeDeskBacktest(job, now);
        if (result.status !== "COMPLETED" || !result.plan) { skipped.push({ id: seed.id, result }); continue; }
        cases.push({ ...seed, backtest: result.evidence, plan: { ...result.plan, evidenceIds: [seed.scout.id, seed.chart.id, result.evidence.id] } });
      }
      const prepared = { cases, backtests: value.backtests, ...(value.updates ? { updates: value.updates } : {}), skipped };
      await output(option("out", "data/desk-input.json")!, JSON.stringify(prepared, null, 2) + "\n");
      print({ prepared: cases.length, skipped, out: resolve(option("out", "data/desk-input.json")!) });
    }
  } else if (command === "run-once" || command === "replay") {
    const inputPath = option("input"); if (!inputPath) throw new Error("--input is required");
    const bundle = await new JsonDeskProvider(inputPath).read();
    let now = command === "replay" ? Number(option("at", String(bundle.cases[0]?.quote.receivedAt))) : Date.now();
    if (!Number.isFinite(now)) throw new Error("valid replay --at Unix milliseconds required");
    const journal = new DeskJournal(option("journal", command === "replay" ? ":memory:" : "data/desk.sqlite")!);
    try {
      if (command === "replay" && option("broker", "local-paper") !== "local-paper") throw new Error("replay_cannot_reach_external_broker");
      const clock = command === "replay" ? () => now : Date.now;
      const venue = broker(journal, clock, option("broker", "local-paper"));
      const desk = new DeskWorkflow(journal, venue, { allowSyntheticDemo: flag("synthetic-demo"), now: clock });
      const states = [];
      for (const input of bundle.cases) {
        now = command === "replay" ? Math.max(now, input.quote.receivedAt) : clock();
        if (venue instanceof LocalPaperBroker) venue.mark(input.quote);
        states.push(await desk.run(input, now));
      }
      if (option("csv")) await output(option("csv")!, journal.exportCsv());
      print({ command, states, brief: desk.chiefBrief(now), simulation: venue.mode === "local-paper" });
    } finally { journal.close(); }
  } else if (command === "service") {
    const configPath = option("config", "config/desk.example.json")!, config = await Bun.file(configPath).json() as { mode: string; journal: string; input: string; calendar: string; pollIntervalMs: number; allowSyntheticDemo: boolean; rules?: Partial<DeskRules> };
    const marketCalendar = await calendar(config.calendar), journal = new DeskJournal(config.journal), clock = Date.now;
    const venue = broker(journal, clock, config.mode, config.rules?.paperCapital), desk = new DeskWorkflow(journal, venue, { now: clock, rules: config.rules, allowSyntheticDemo: config.allowSyntheticDemo });
    const provider = new JsonDeskProvider(config.input);
    if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1000 || config.pollIntervalMs > 60_000) throw new Error("pollIntervalMs must be between 1000 and 60000");
    let stopped = false;
    process.on("SIGINT", () => { stopped = true; }); process.on("SIGTERM", () => { stopped = true; });
    try {
      do {
        const now = clock(), jobs = claimDueDeskJobs(now, marketCalendar, journal, { lookbackMs: 60_000 });
        for (const job of jobs) print({ job: job.id, result: await runDeskRoutine(job, journal, desk, provider, clock(), venue instanceof LocalPaperBroker ? venue : undefined) });
        if (flag("once")) { print({ status: "service_tick_completed", dueJobs: jobs.length, calendar: marketCalendar.id }); break; }
        if (!stopped) await Bun.sleep(config.pollIntervalMs);
      } while (!stopped);
    } finally { journal.close(); }
  } else if (command === "schedule") {
    const at = option("at"), now = at ? Date.parse(at) : Date.now();
    print(dueDeskJobs(now, await calendar(option("calendar", "nyse-2026")!), { lookbackMs: Number(option("lookback-ms", "60000")) }));
  } else if (command === "export") {
    const path = option("journal", "data/desk.sqlite")!, out = option("out", "data/trade-journal.csv")!;
    const journal = new DeskJournal(path);
    try { await output(out, journal.exportCsv()); print({ rows: journal.rows().length, out: resolve(out), remoteSync: "NOT_CONFIGURED" }); } finally { journal.close(); }
  } else if (command === "account") {
    const journal = new DeskJournal(option("journal", "data/desk.sqlite")!);
    try { const venue = broker(journal, Date.now, "alpaca-paper") as AlpacaPaperBroker; print({ account: await venue.account(), positions: await venue.positions(), orders: await venue.openOrders(), ordersSent: 0 }); } finally { journal.close(); }
  } else if (["tradingview-discover", "tradingview-read", "tradingview-preview", "tradingview-setup"].includes(command)) {
    const config = await Bun.file(option("config", "config/desk.example.json")!).json();
    if (typeof config.tradingview?.endpoint !== "string" || !config.tradingview.endpoint) throw new Error("verified_tradingview_endpoint_required");
    const settings = { endpoint: config.tradingview.endpoint, accessToken: process.env[config.tradingview.accessTokenEnv ?? "TRADINGVIEW_OAUTH_ACCESS_TOKEN"] ?? "", allowedReadTools: config.tradingview.allowedReadTools ?? [] };
    if (command === "tradingview-discover" || command === "tradingview-read") {
      const client = new TradingViewReadClient(settings), discovery = await client.discover();
      if (command === "tradingview-discover") print(discovery);
      else { const name = option("name"), path = option("args"); if (!name || !path) throw new Error("--name and --args required"); print(await client.read("chart", name, await Bun.file(path).json())); }
    } else {
      if (command === "tradingview-setup" && !flag("allow-setup-writes")) throw new Error("explicit_setup_write_opt_in_required");
      const journal = new DeskJournal(option("journal", config.journal ?? "data/desk.sqlite")!);
      try {
        const client = new TradingViewSetupClient({ ...settings, enableSetupWrites: true, setupTools: config.tradingview.setupTools ?? {}, store: journal });
        await client.discover(); const operation = option("operation") as TradingViewSetupOperation, path = option("args");
        if (!operation || !path) throw new Error("--operation and --args required"); const value = await Bun.file(path).json();
        if (command === "tradingview-preview") print(client.preview(operation, value));
        else { const approvalPath = option("approval"); if (!approvalPath) throw new Error("--approval file required"); const approval = await Bun.file(approvalPath).json() as TradingViewSetupApproval;
          if (approval.operation !== operation) throw new Error("setup_operation_approval_mismatch"); print(await client.executeSetup(approval, value)); }
      } finally { journal.close(); }
    }
  } else if (["journal-create", "journal-sync", "journal-reconcile"].includes(command)) {
    const provider = option("provider"), journalPath = option("journal", "data/desk.sqlite")!;
    if (provider !== "sheets" && provider !== "notion") throw new Error("--provider sheets|notion required");
    if (command !== "journal-reconcile" && !flag("allow-journal-writes")) throw new Error("explicit_journal_write_opt_in_required");
    const journal = new DeskJournal(journalPath);
    try {
      const settings = { store: journal, allowWrites: flag("allow-journal-writes"), accessToken: provider === "sheets" ? process.env.SHEETS_OAUTH_ACCESS_TOKEN ?? "" : process.env.NOTION_ACCESS_TOKEN ?? "" };
      const sheets = provider === "sheets" ? new GoogleSheetsJournalExporter(settings) : null, notion = provider === "notion" ? new NotionJournalExporter(settings) : null;
      if (command === "journal-create") {
        const operationId = option("operation-id"); if (!operationId) throw new Error("stable --operation-id required");
        const result = sheets ? await sheets.create(operationId, { title: option("title", "Trade Journal"), sheetName: option("sheet-name", "Trade Journal") }) :
          await notion!.create(operationId, { parentPageId: option("parent-page-id") ?? "", title: option("title", "Trade Journal") });
        if (result.status === "CONFIRMED" && option("destination-out")) await output(option("destination-out")!, JSON.stringify(result.value, null, 2) + "\n");
        print(result); if (result.status !== "CONFIRMED") process.exitCode = 1;
      } else {
        const destinationPath = option("destination"); if (!destinationPath) throw new Error("--destination JSON file required");
        const destination = await Bun.file(destinationPath).json(), results = [];
        for (const event of journal.events().filter(event => event.kind === "row")) {
          const operationId = `desk-${hash({ journal: resolve(journalPath), event: event.event_hash }).slice(0, 48)}`;
          try {
            const row = event.payload as import("../src/desk/types").JournalRow;
            const result = sheets ? command === "journal-sync" ? await sheets.append(operationId, destination as SheetsDestination, row) : await sheets.reconcile(operationId, destination as SheetsDestination, row) :
              command === "journal-sync" ? await notion!.append(operationId, destination as NotionDestination, row) : await notion!.reconcile(operationId, destination as NotionDestination, row);
            results.push({ operationId, ...result }); if (result.status !== "CONFIRMED") process.exitCode = 1;
          } catch (error) { results.push({ operationId, status: "FAILED", reason: String(error) }); process.exitCode = 1; }
        }
        print({ provider, results });
      }
    } finally { journal.close(); }
  } else if (command === "capture-paper") {
    const journal = new DeskJournal(option("journal", "data/desk.sqlite")!);
    try {
      const venue = broker(journal, Date.now, "alpaca-paper") as AlpacaPaperBroker;
      const after = option("after"), until = option("until"); if (!after || !until) throw new Error("--after and --until ISO timestamps required");
      const account = await venue.readAccountRisk(), activities = await venue.captureActivities(after, until);
      const out = option("out", "data/alpaca-paper-events.json")!;
      await output(out, JSON.stringify(journal.events(), null, 2) + "\n");
      print({ account, activities, out: resolve(out), ordersSent: 0 });
    } finally { journal.close(); }
  } else if (command === "templates") {
    const out = option("out", "data/grok-desk-templates.md")!;
    await output(out, await Bun.file(new URL("../docs/grok-desk-templates.md", import.meta.url)).text());
    print({ out: resolve(out), hostedBotsProvisioned: false });
  } else {
    console.log(`Research desk commands:
  bun run desk demo [--journal path] [--csv path] [--out report.json] [--input-out input.json]
  bun run desk backtest --input raw-backtest-job.json [--out report.json]
  bun run desk prepare --input research-seeds.json --out data/desk-input.json
  bun run desk run-once --input input.json [--journal path] [--synthetic-demo]
  bun run desk replay --input input.json [--at UNIX_MS] [--synthetic-demo]
  bun run desk service --config config/desk.example.json [--once]
  bun run desk schedule --at 2026-11-06T14:30:00Z [--lookback-ms 60000]
  bun run desk export --journal data/desk.sqlite --out trade-journal.csv
  bun run desk account
  bun run desk capture-paper --after ISO --until ISO [--out paper-events.json]
  bun run desk templates [--out templates.md]
  bun run desk tradingview-discover --config config/desk.example.json
  bun run desk tradingview-read --name EXACT_DISCOVERED_NAME --args query.json
  bun run desk tradingview-preview --operation alert.create --args alert.json
  bun run desk tradingview-setup --operation alert.create --args alert.json --approval approval.json --allow-setup-writes
  bun run desk journal-create --provider sheets|notion --operation-id ID --allow-journal-writes [--destination-out destination.json]
  bun run desk journal-sync --provider sheets|notion --destination destination.json --allow-journal-writes
  bun run desk journal-reconcile --provider sheets|notion --destination destination.json

Default execution is local simulation. Alpaca paper requires --broker alpaca-paper,
--allow-paper-orders, ALPACA_PAPER_TRADE=True and paper credentials. Replay cannot
reach external brokers. Live requires the distinct alpaca-live broker, --allow-live-orders,
--account-id, --paper-readiness, --live-authorization, separate ALPACA_LIVE_API_KEY /
ALPACA_LIVE_SECRET_KEY and ALPACA_PAPER_TRADE=False. No credentials are printed.`);
    if (command !== "help" && command !== "--help") process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({ status: "FAILED_CLOSED", error: String(error) })); process.exitCode = 1; }
