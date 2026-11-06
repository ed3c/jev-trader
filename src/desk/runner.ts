import { reviewDeskWeek } from "./review";
import { evidence } from "./evidence";
import { DeskJournal } from "./journal";
import { DeskWorkflow, rankScoutCases } from "./workflow";
import type { ClaimedDeskJob } from "./scheduler";
import { finishDeskJob } from "./scheduler";
import type { DeskCase, Evidence, Quote, RiskSnapshot } from "./types";
import { executeDeskBacktest, verifyDeskBacktestBinding } from "./backtest";
import type { DeskBacktestJob } from "./backtest";
import { LocalPaperBroker } from "../integrations/paper-broker";

export interface DeskInputBundle {
  cases: DeskCase[];
  backtests?: DeskBacktestJob[];
  portfolio?: { risk: Evidence<RiskSnapshot>; quotes: Evidence<Quote>[] };
  updates?: { caseId: string; quote: Evidence<Quote>; risk: Evidence<RiskSnapshot> }[];
}
export interface DeskEvidenceProvider { read(): Promise<DeskInputBundle> }
/** JSON file is a concrete ingest boundary for audited provider data, not an invented news feed. */
export class JsonDeskProvider implements DeskEvidenceProvider {
  constructor(private readonly path: string) {}
  async read(): Promise<DeskInputBundle> {
    if (!await Bun.file(this.path).exists()) throw new Error(`evidence_provider_file_missing:${this.path}`);
    const value = await Bun.file(this.path).json();
    const bundle = Array.isArray(value) ? { cases: value } : value?.cases ? value : { cases: [value] };
    if (!Array.isArray(bundle.cases) || bundle.cases.some((item: DeskCase) => !item?.id || !item.plan)) throw new Error("invalid_evidence_provider_bundle");
    return bundle as DeskInputBundle;
  }
}
export async function runDeskRoutine(job: ClaimedDeskJob, journal: DeskJournal, desk: DeskWorkflow, provider: DeskEvidenceProvider, now: number, paper?: LocalPaperBroker): Promise<unknown> {
  try {
    let result: unknown;
    if (job.role === "chief") {
      result = desk.chiefBrief(now);
      if (job.task === "weekly_review") result = { brief: result, strategyReview: reviewDeskWeek(journal, now) };
    } else {
      const bundle = await provider.read(), results: unknown[] = [];
      if (job.role === "trader" || job.role === "risk") {
        const quoteMap = new Map<string, Evidence<Quote>>();
        for (const input of bundle.cases) quoteMap.set(input.symbol, input.quote);
        for (const update of bundle.updates ?? []) quoteMap.set(update.quote.payload.symbol, update.quote);
        for (const quote of bundle.portfolio?.quotes ?? []) quoteMap.set(quote.payload.symbol, quote);
        for (const quote of quoteMap.values()) if (paper) paper.mark(quote);
        const guard = await desk.monitorPortfolio(bundle.portfolio?.risk ?? bundle.updates?.[0]?.risk ?? bundle.cases[0]?.risk ?? null, [...quoteMap.values()], now);
        results.push({ portfolioGuard: guard });
        if (guard.reasons.length) { finishDeskJob(job, journal, { status: "failed", detail: guard.reasons.join(";") }, now); return guard; }
      }
      if (job.role === "scout") {
        const ranked = rankScoutCases(bundle.cases);
        for (const input of ranked) {
          const state = desk.register(input, now);
          if (state.stage === "NEW") results.push(desk.scout(input.id, now));
        }
        result = { status: ranked.length ? "ranked" : "no signal", ranked: ranked.map(item => item.symbol), transitions: results };
      } else {
        for (const input of bundle.cases) {
          let state = desk.state(input.id); if (!state) continue;
          const update = bundle.updates?.find(item => item.caseId === input.id) ?? { quote: input.quote, risk: input.risk };
          if (job.role === "chart" && state.stage === "SCOUTED") results.push(desk.chart(input.id, now));
          if (job.role === "strategist" && state.stage === "CHARTED") {
            const raw = bundle.backtests?.find(item => item.caseId === input.id);
            if (!raw) { results.push({ caseId: input.id, status: "NOT_RUN", reasons: ["raw_bar_backtest_job_missing"] }); continue; }
            const computed = executeDeskBacktest(raw, now);
            journal.append("nightly_backtest", computed, `backtest:${job.id}:${input.id}`, now);
            if (computed.status !== "COMPLETED") { results.push(computed); continue; }
            verifyDeskBacktestBinding(computed, input);
            results.push(desk.strategize(input.id, now));
          }
          if (job.role === "risk") {
            if (update.risk.payload.positions.some(position => position.stop === null || position.marketPrice <= position.stop)) desk.latchKill("position_review_missing_or_crossed_stop", now);
            journal.append("position_review", { caseId: input.id, riskEvidenceId: update.risk.id, positions: update.risk.payload.positions }, `positions:${job.id}:${input.id}`, now);
          }
          if (job.role === "trader") {
            if (["UNKNOWN", "SUBMITTED", "FILLED"].includes(state.stage)) {
              if (paper) paper.mark(update.quote);
              results.push(await desk.reconcile(input.id, now)); continue;
            }
            if (journal.load("desk:accounting-pause")) { results.push({ caseId: input.id, status: "PAUSED", reason: "realized_outcome_costs_unreconciled" }); continue; }
            let risk = update.risk;
            if (paper) {
              paper.mark(update.quote);
              risk = evidence({ source: `${update.risk.source} + local://paper-account`, observedAt: update.risk.observedAt, receivedAt: now, provenance: update.risk.provenance,
                payload: { ...update.risk.payload, ...paper.snapshot() } });
            }
            if (state.stage === "STRATEGIZED") state = desk.approve(input.id, now, "risk", risk, update.quote);
            if (state.stage === "APPROVED") results.push(await desk.execute(input.id, update.quote, risk, now));
          }
        }
        result = { transitions: results };
      }
    }
    if (journal.load("desk:kill")) await desk.emergency(now);
    journal.append("routine_result", { job, result }, `routine-result:${job.id}`, now);
    finishDeskJob(job, journal, { status: "completed", detail: "Audited routine result stored" }, now);
    return result;
  } catch (error) {
    const detail = String(error);
    if (job.role === "trader" || job.role === "risk") { desk.latchKill(`routine_data_unavailable:${detail}`, now); await desk.emergency(now); }
    journal.append("routine_failed", { job, detail }, `routine-failed:${job.id}`, now);
    finishDeskJob(job, journal, { status: "failed", detail }, now);
    return { status: "failed", detail };
  }
}
