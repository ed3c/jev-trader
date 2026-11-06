import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, evidence, hash, verifyEvidence } from "../src/desk/evidence";
import { csvCell, DeskJournal, JOURNAL_COLUMNS } from "../src/desk/journal";
import { claimDueDeskJobs, finishDeskJob, nyseCalendar2026 } from "../src/desk/scheduler";
import type { StoredRoutine } from "../src/desk/scheduler";
import type { JournalRow } from "../src/desk/types";

const directories: string[] = [], stores: DeskJournal[] = [], rawDatabases: Database[] = [];
afterEach(() => {
  for (const raw of rawDatabases.splice(0)) { try { raw.close(); } catch {} }
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryPath(): string { const directory = mkdtempSync(join(tmpdir(), "jev-desk-journal-")); directories.push(directory); return join(directory, "journal.sqlite"); }
function open(path = ":memory:"): DeskJournal { const store = new DeskJournal(path); stores.push(store); return store; }
function raw(path: string): Database { const db = new Database(path); rawDatabases.push(db); return db; }

describe("content-addressed desk evidence", () => {
  test("hashes canonical JSON and freezes a defensive copy", () => {
    expect(hash({ b: 2, a: { d: 4, c: 3 } })).toBe(hash({ a: { c: 3, d: 4 }, b: 2 }));
    const input = { source: "test://synthetic-observation", observedAt: 100, receivedAt: 101, provenance: "synthetic" as const, payload: { nested: [1, 2] } };
    const value = evidence(input);
    input.payload.nested[0] = 900;
    expect(value.payload.nested).toEqual([1, 2]);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.payload.nested)).toBe(true);
    expect(() => verifyEvidence(value, 102)).not.toThrow();
  });

  test("non-finite, undefined and non-JSON data cannot silently change audit hashes", () => {
    for (const value of [NaN, Infinity, -Infinity, undefined, { silentlyDropped: undefined }, new Date(), () => 1]) expect(() => canonical(value)).toThrow();
    expect(() => evidence({ source: " ", observedAt: 100, receivedAt: 101, provenance: "synthetic", payload: {} })).toThrow("provenance");
    expect(() => evidence({ source: "test://fixture", observedAt: 102, receivedAt: 101, provenance: "synthetic", payload: {} })).toThrow("provenance");
  });

  test("future, stale and altered observations are rejected independently", () => {
    const value = evidence({ source: "test://fixture", observedAt: 100, receivedAt: 101, provenance: "synthetic", payload: { price: 100 } });
    expect(() => verifyEvidence(value, 100)).toThrow("future");
    expect(() => verifyEvidence(value, 111, 10)).toThrow("stale");
    expect(() => verifyEvidence({ ...value, payload: { price: 200 } }, 102)).toThrow("hash_mismatch");
  });
});

describe("durable desk audit journal", () => {
  test("identical retries preserve the original event and conflicting retries fail", () => {
    const store = open();
    store.append("decision", { result: "hold" }, "event-1", 100);
    store.append("decision", { result: "hold" }, "event-1", 101);
    expect(store.events().length).toBe(1); expect(store.events()[0]!.ts).toBe(100);
    expect(() => store.append("decision", { result: "trade" }, "event-1", 102)).toThrow("idempotency_conflict");
    expect(() => store.append("another_kind", { result: "hold" }, "event-1", 102)).toThrow("idempotency_conflict");
    expect(() => store.verify()).not.toThrow();
  });

  test("SQLite rejects updates and deletions of journal events and evidence", () => {
    const path = temporaryPath(), store = open(path);
    store.append("decision", { result: "hold" }, "event-1", 100);
    const value = evidence({ source: "test://fixture", observedAt: 100, receivedAt: 100, provenance: "synthetic", payload: { price: 100 } });
    store.putEvidence(value); store.putEvidence(value);
    expect(() => store.putEvidence({ ...value, payload: { price: 999 } })).toThrow("immutable_evidence_conflict");
    const db = raw(path);
    expect(() => db.exec("UPDATE desk_events SET kind='forged'")).toThrow("append_only");
    expect(() => db.exec("DELETE FROM desk_events")).toThrow("append_only");
    expect(() => db.exec("UPDATE desk_evidence SET payload='{}'")).toThrow("immutable_evidence");
    expect(() => db.exec("DELETE FROM desk_evidence")).toThrow("immutable_evidence");
  });

  test("a failed transaction rolls back state, reservation and its nested audit event together", () => {
    const store = open();
    expect(() => store.atomic(() => {
      store.claim("execution-lock", { caseId: "case" });
      store.save("case", { stage: "UNKNOWN" });
      store.append("intent", { symbol: "TEST" }, "intent", 100);
      throw new Error("injected disk-operation failure");
    })).toThrow("injected disk-operation failure");
    expect(store.load("execution-lock")).toBeNull(); expect(store.load("case")).toBeNull(); expect(store.events()).toEqual([]);
  });

  test("independent SQLite connections cannot claim the same reservation, even after restart", () => {
    const path = temporaryPath(), first = open(path), second = open(path);
    expect(first.claim("lock", { owner: "first" })).toBe(true);
    expect(second.claim("lock", { owner: "second" })).toBe(false);
    first.close();
    const restarted = open(path);
    expect(restarted.load<{ owner: string }>("lock")).toEqual({ owner: "first" });
    expect(restarted.claim("lock", { owner: "restart" })).toBe(false);
  });

  test("reopening a modified hash chain fails before consuming its state", () => {
    const path = temporaryPath(), store = open(path);
    store.append("decision", { result: "hold" }, "event-1", 100);
    store.close();
    const db = raw(path);
    // Simulate an offline modification outside the protected application interface.
    db.exec("DROP TRIGGER desk_events_no_update");
    db.query("UPDATE desk_events SET payload=? WHERE event_key=?").run(JSON.stringify({ result: "forged" }), "event-1");
    db.close();
    expect(() => new DeskJournal(path)).toThrow("journal_integrity_failure");
  });

  test("spreadsheet export preserves columns while neutralizing formula injection", () => {
    const store = open();
    const row: JournalRow = { TIME: "2026-11-06T15:00:00.000Z", BOT: "scout", TICKER: "TEST", IDEA: "\t=IMPORTDATA(\"https://untrusted.invalid\")",
      SOURCE: "test://fixture", SCORE: 8, ENTRY: 100, STOP: 98, TARGET: 106, SIZE: 1, "RISK CHECK": "unknown", STATUS: "SCOUTED", RESULT: "line1\nline2", LESSON: "@untrusted" };
    store.append("row", row, "row-1", 100);
    const csv = store.exportCsv();
    expect(csv.split("\r\n")[0]).toBe(JOURNAL_COLUMNS.join(","));
    expect(csv).toContain('"\'\t=IMPORTDATA(""https://untrusted.invalid"")"');
    expect(csv).toContain('"\'@untrusted"'); expect(csv).toContain('"line1\nline2"');
    for (const input of ["=1+1", " +cmd", "\u0000-cmd", "\t@SUM(1)"]) expect(csvCell(input).startsWith('"\'')).toBe(true);
  });

  test("scheduler claims and completion work with the real journal when detail is omitted", () => {
    const store = open(), now = Date.parse("2026-11-06T12:30:00Z");
    const jobs = claimDueDeskJobs(now, nyseCalendar2026(), store);
    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    finishDeskJob(job, store, { status: "completed" }, now + 1);
    expect(store.load<StoredRoutine>(`routine:${job.id}`)?.status).toBe("completed");
    expect(claimDueDeskJobs(now, nyseCalendar2026(), store)).toEqual([]);
  });
});
