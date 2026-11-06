/** Scheduled research work never replaces the synchronous risk check before an order. */
export type ScheduledDeskRole = "chief" | "scout" | "chart" | "strategist" | "risk" | "trader";
export type DeskRoutine = "premarket_sweep" | "watchlist_scan" | "watchlist_monitor" | "screener_scan" |
  "nightly_backtest" | "position_review" | "approved_alert_check" | "morning_brief" | "close_report" | "weekly_review";

export interface ExchangeSession { open: string; close: string }
export interface SessionCalendar {
  id: string;
  timeZone: "America/New_York";
  validFrom: string;
  validThrough: string;
  source: string;
  verifiedAt: string;
  /** A missing day inside the explicit coverage is a closed session, not an unknown weekday. */
  sessions: Record<string, ExchangeSession>;
}
export interface DeskJob {
  id: string;
  role: ScheduledDeskRole;
  task: DeskRoutine;
  scheduledAtMs: number;
  localDate: string;
  localTime: string;
  timeZone: "America/New_York";
  calendarId: string;
}
export interface ClaimedDeskJob extends DeskJob { claimToken: string }
export interface SchedulerOptions {
  deskId?: string;
  /** Exclusive lower bound: only jobs in (now-lookback, now] are returned. Maximum one day. */
  lookbackMs?: number;
  /** Read-only watchlist monitoring is a polling fallback; the default is five minutes. */
  monitorEveryMinutes?: number;
}
export interface SchedulerStore {
  load<T>(key: string): T | null | undefined;
  save(key: string, value: unknown): void;
  /** Atomic insert-if-absent. Implement with a unique key/transaction in a durable store. */
  claim(key: string, value: unknown): boolean;
}
export interface StoredRoutine {
  job: DeskJob;
  claimToken: string;
  status: "claimed" | "completed" | "failed";
  claimedAtMs: number;
  finishedAtMs?: number;
  detail?: string;
}

const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
function validDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("calendar date must be YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new RangeError("invalid calendar date");
}
function minuteOfDay(time: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("session time must be HH:MM");
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}
export function newYorkTime(nowMs: number) {
  finite(nowMs, "timestamp");
  const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time, minuteOfDay: minuteOfDay(time), weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

export function validateSessionCalendar(calendar: SessionCalendar): void {
  if (!calendar?.id || calendar.timeZone !== "America/New_York" || !calendar.source || !calendar.verifiedAt ||
      !calendar.sessions || typeof calendar.sessions !== "object" || Array.isArray(calendar.sessions)) throw new RangeError("explicit exchange calendar and source are required");
  validDate(calendar.validFrom); validDate(calendar.validThrough);
  if (calendar.validFrom > calendar.validThrough) throw new RangeError("invalid calendar coverage");
  for (const [date, session] of Object.entries(calendar.sessions)) {
    validDate(date);
    if (date < calendar.validFrom || date > calendar.validThrough) throw new RangeError("session outside calendar coverage");
    const open = minuteOfDay(session.open), close = minuteOfDay(session.close);
    if (open >= close || close + 30 >= 24 * 60) throw new RangeError("invalid same-day exchange session");
  }
}

/**
 * Pure UTC-minute enumeration handles DST gaps and folds without inventing local times.
 * Repeated 01:30 monitoring slots have distinct UTC IDs; nonexistent spring slots do not run.
 */
export function dueDeskJobs(nowMs: number, calendar: SessionCalendar, options: SchedulerOptions = {}): DeskJob[] {
  finite(nowMs, "nowMs"); validateSessionCalendar(calendar);
  const lookbackMs = options.lookbackMs ?? 60_000;
  const monitorEvery = options.monitorEveryMinutes ?? 5;
  const deskId = options.deskId ?? "trading-desk";
  if (!Number.isFinite(lookbackMs) || lookbackMs <= 0 || lookbackMs > 86_400_000 ||
      !Number.isInteger(monitorEvery) || monitorEvery < 1 || monitorEvery > 60 || 60 % monitorEvery !== 0 || !deskId.trim()) {
    throw new RangeError("invalid scheduler window, monitor cadence or desk identity");
  }
  const jobs: DeskJob[] = [];
  const firstMinute = Math.floor((nowMs - lookbackMs) / 60_000) * 60_000 + 60_000;
  for (let at = firstMinute; at <= nowMs; at += 60_000) {
    const local = newYorkTime(at);
    if (local.date < calendar.validFrom || local.date > calendar.validThrough) throw new RangeError(`calendar coverage unavailable for ${local.date}; load a verified calendar`);
    const add = (role: ScheduledDeskRole, task: DeskRoutine) => jobs.push({
      id: `${deskId}:${role}:${task}:${at}`, role, task, scheduledAtMs: at, localDate: local.date,
      localTime: local.time, timeZone: "America/New_York", calendarId: calendar.id,
    });
    // Read-only monitoring and research continue on weekends and exchange holidays.
    if (local.minuteOfDay % monitorEvery === 0) add("scout", "watchlist_monitor");
    if (local.minuteOfDay === 21 * 60) add("strategist", "nightly_backtest");
    if (local.weekday === 0 && local.minuteOfDay === 18 * 60) add("chief", "weekly_review");
    const session = calendar.sessions[local.date];
    if (!session) continue;
    const open = minuteOfDay(session.open), close = minuteOfDay(session.close), minute = local.minuteOfDay;
    if (minute === 6 * 60 + 30) add("scout", "premarket_sweep");
    if (minute > 6 * 60 + 30 && minute < close && (minute - (6 * 60 + 30)) % 30 === 0) add("scout", "watchlist_scan");
    if (minute >= 8 * 60 + 30 && minute < close && (minute - (8 * 60 + 30)) % 60 === 0) add("chart", "screener_scan");
    if (minute >= open && minute < close && (minute - open) % 15 === 0) add("trader", "approved_alert_check");
    if (minute === 7 * 60 + 30) add("chief", "morning_brief");
    // Normal 16:15/16:30 become 13:15/13:30 on a confirmed 13:00 early close.
    if (minute === close + 15) add("risk", "position_review");
    if (minute === close + 30) add("chief", "close_report");
  }
  return jobs.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs || a.id.localeCompare(b.id));
}

export function claimDueDeskJobs(nowMs: number, calendar: SessionCalendar, store: SchedulerStore, options: SchedulerOptions = {}): ClaimedDeskJob[] {
  if (typeof store.claim !== "function") throw new TypeError("scheduler requires an atomic durable claim operation");
  const claimed: ClaimedDeskJob[] = [];
  for (const job of dueDeskJobs(nowMs, calendar, options)) {
    const claimToken = crypto.randomUUID();
    const record: StoredRoutine = { job, claimToken, status: "claimed", claimedAtMs: nowMs };
    if (store.claim(`routine:${job.id}`, record)) claimed.push({ ...job, claimToken });
  }
  return claimed;
}

/** No silent retry of a crashed/failed claimed job: inspect its effects before a new attempt. */
export function finishDeskJob(job: ClaimedDeskJob, store: SchedulerStore, result: { status: "completed" | "failed"; detail?: string }, nowMs = Date.now()): void {
  finite(nowMs, "completion time");
  const key = `routine:${job.id}`;
  const stored = store.load<StoredRoutine>(key);
  if (!stored || stored.status !== "claimed" || stored.claimToken !== job.claimToken || stored.job.id !== job.id ||
      stored.job.role !== job.role || stored.job.task !== job.task || stored.job.scheduledAtMs !== job.scheduledAtMs) throw new Error("routine completion does not match its active claim");
  if (nowMs < stored.claimedAtMs || !["completed", "failed"].includes(result.status) ||
      (result.detail !== undefined && typeof result.detail !== "string")) throw new RangeError("invalid routine completion");
  store.save(key, { ...stored, status: result.status, finishedAtMs: nowMs,
    ...(result.detail === undefined ? {} : { detail: result.detail }) } satisfies StoredRoutine);
}

/**
 * Verified scheduled NYSE equity sessions only. Emergency closures require an updated calendar.
 * Sources verified 2026-11-06: https://www.nyse.com/trade/hours-calendars
 * and https://nasdaqtrader.com/Trader.aspx?id=Calendar . No inferred sessions beyond 2026.
 */
export function nyseCalendar2026(): SessionCalendar {
  const holidays = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
  const early = new Set(["2026-11-27", "2026-12-24"]);
  const sessions: Record<string, ExchangeSession> = {};
  for (let ts = Date.UTC(2026, 0, 1); ts < Date.UTC(2027, 0, 1); ts += 86_400_000) {
    const date = new Date(ts), day = date.getUTCDay(), key = date.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(key)) sessions[key] = { open: "09:30", close: early.has(key) ? "13:00" : "16:00" };
  }
  return { id: "nyse-equities-2026-verified-2026-11-06", timeZone: "America/New_York", validFrom: "2026-01-01", validThrough: "2026-12-31",
    source: "https://www.nyse.com/trade/hours-calendars", verifiedAt: "2026-11-06", sessions };
}
