import { describe, expect, test } from "bun:test";
import { claimDueDeskJobs, dueDeskJobs, finishDeskJob, newYorkTime, nyseCalendar2026 } from "../src/desk/scheduler";
import type { SchedulerStore, StoredRoutine } from "../src/desk/scheduler";
import { DeskJournal } from "../src/desk/journal";

class SharedStore implements SchedulerStore {
  constructor(private readonly values = new Map<string, unknown>()) {}
  load<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  save(key: string, value: unknown): void { this.values.set(key, structuredClone(value)); }
  claim(key: string, value: unknown): boolean {
    if (this.values.has(key)) return false;
    this.save(key, value); return true;
  }
}
const calendar = nyseCalendar2026();
const at = (iso: string) => Date.parse(iso);

describe("New York desk routines", () => {
  test("market-open checks follow both spring and autumn DST offsets", () => {
    for (const iso of ["2026-03-06T14:30:00Z", "2026-03-09T13:30:00Z", "2026-10-30T13:30:00Z", "2026-11-02T14:30:00Z"]) {
      const jobs = dueDeskJobs(at(iso), calendar);
      expect(jobs.some(job => job.task === "approved_alert_check" && job.localTime === "09:30")).toBe(true);
    }
    expect(newYorkTime(at("2026-03-09T14:30:00Z")).time).toBe("10:30");
  });
  test("NYSE holidays suppress trading routines while read-only monitoring continues", () => {
    const jobs = dueDeskJobs(at("2026-11-26T14:30:00Z"), calendar);
    expect(jobs.map(job => job.task)).toEqual(["watchlist_monitor"]);
    expect(calendar.sessions["2026-07-03"]).toBeUndefined();
    expect(calendar.sessions["2026-04-03"]).toBeUndefined();
  });
  test("early closes stop order checks and move post-close reviews", () => {
    expect(dueDeskJobs(at("2026-11-27T17:45:00Z"), calendar).some(job => job.task === "approved_alert_check")).toBe(true);
    expect(dueDeskJobs(at("2026-11-27T18:00:00Z"), calendar).some(job => job.task === "approved_alert_check")).toBe(false);
    expect(dueDeskJobs(at("2026-11-27T18:15:00Z"), calendar).some(job => job.task === "position_review")).toBe(true);
    expect(dueDeskJobs(at("2026-11-27T18:30:00Z"), calendar).some(job => job.task === "close_report")).toBe(true);
    expect(dueDeskJobs(at("2026-12-24T18:30:00Z"), calendar).some(job => job.task === "close_report")).toBe(true);
  });
  test("retains all normal-day article routine times", () => {
    const expected = [
      ["2026-11-06T11:30:00Z", "premarket_sweep"], ["2026-11-06T12:00:00Z", "watchlist_scan"],
      ["2026-11-06T12:30:00Z", "morning_brief"], ["2026-11-06T13:30:00Z", "screener_scan"],
      ["2026-11-06T21:15:00Z", "position_review"], ["2026-11-06T21:30:00Z", "close_report"],
      ["2026-11-07T02:00:00Z", "nightly_backtest"], ["2026-11-08T23:00:00Z", "weekly_review"],
    ] as const;
    for (const [iso, task] of expected) expect(dueDeskJobs(at(iso), calendar).some(job => job.task === task)).toBe(true);
  });
  test("DST fold has distinct UTC monitoring IDs and spring gap creates no nonexistent job", () => {
    const fall = dueDeskJobs(at("2026-11-01T07:00:00Z"), calendar, { lookbackMs: 2 * 3_600_000 });
    const repeated = fall.filter(job => job.localTime === "01:30" && job.task === "watchlist_monitor");
    expect(repeated.length).toBe(2); expect(repeated[0]!.id).not.toBe(repeated[1]!.id);
    const spring = dueDeskJobs(at("2026-03-08T08:00:00Z"), calendar, { lookbackMs: 2 * 3_600_000 });
    expect(spring.some(job => job.localTime.startsWith("02:"))).toBe(false);
  });
  test("unknown future calendar coverage fails closed and a window excludes its lower boundary", () => {
    expect(() => dueDeskJobs(at("2027-01-04T14:30:00Z"), calendar)).toThrow("calendar coverage unavailable");
    const jobs = dueDeskJobs(at("2026-11-06T12:35:00Z"), calendar, { lookbackMs: 5 * 60_000 });
    expect(jobs.some(job => job.localTime === "07:30")).toBe(false);
    expect(jobs.every(job => job.scheduledAtMs > at("2026-11-06T12:30:00Z"))).toBe(true);
  });
});

describe("durable routine claim contract", () => {
  test("real SQLite journal accepts a completion with no optional detail", () => {
    const journal = new DeskJournal(":memory:");
    try {
      const now = at("2026-11-06T12:30:00Z");
      const job = claimDueDeskJobs(now, calendar, journal)[0]!;
      finishDeskJob(job, journal, { status: "completed" }, now + 1);
      const stored = journal.load<StoredRoutine>(`routine:${job.id}`)!;
      expect(stored.status).toBe("completed");
      expect("detail" in stored).toBe(false);
      expect(claimDueDeskJobs(now, calendar, journal).length).toBe(0);
    } finally { journal.close(); }
  });

  test("two workers sharing an atomic store cannot both receive the same job", () => {
    const values = new Map<string, unknown>();
    const first = new SharedStore(values), second = new SharedStore(values);
    const now = at("2026-11-06T12:30:00Z");
    const jobs = claimDueDeskJobs(now, calendar, first);
    expect(jobs.length).toBeGreaterThan(0);
    expect(claimDueDeskJobs(now, calendar, second).length).toBe(0);
    finishDeskJob(jobs[0]!, first, { status: "completed" }, now + 1);
    expect(second.load<StoredRoutine>(`routine:${jobs[0]!.id}`)!.status).toBe("completed");
    expect(claimDueDeskJobs(now, calendar, second).length).toBe(0);
  });
  test("a crash or failure cannot silently replay a financial routine", () => {
    const store = new SharedStore();
    const now = at("2026-11-06T14:30:00Z");
    const jobs = claimDueDeskJobs(now, calendar, store);
    const job = jobs.find(item => item.task === "approved_alert_check")!;
    expect(() => finishDeskJob({ ...job, claimToken: "other-worker" }, store, { status: "completed" }, now + 1)).toThrow("claim");
    finishDeskJob(job, store, { status: "failed", detail: "Inspect broker state before retry" }, now + 1);
    expect(claimDueDeskJobs(now, calendar, store).length).toBe(0);
    expect(() => finishDeskJob(job, store, { status: "completed" }, now + 2)).toThrow("claim");
  });
});
