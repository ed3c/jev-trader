import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, hash, immutable } from "./evidence";
import type { Evidence, JournalRow } from "./types";

export const JOURNAL_COLUMNS = ["TIME", "BOT", "TICKER", "IDEA", "SOURCE", "SCORE", "ENTRY", "STOP", "TARGET", "SIZE", "RISK CHECK", "STATUS", "RESULT", "LESSON"] as const;
/** Neutralize spreadsheet formulas even after whitespace or control characters. */
export function csvCell(value: unknown): string {
  let cell = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}
export class DeskJournal {
  private db: Database;
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS desk_events(seq INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_evidence(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_state(name TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS desk_events_no_update BEFORE UPDATE ON desk_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
      CREATE TRIGGER IF NOT EXISTS desk_events_no_delete BEFORE DELETE ON desk_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
      CREATE TRIGGER IF NOT EXISTS desk_evidence_no_update BEFORE UPDATE ON desk_evidence BEGIN SELECT RAISE(ABORT,'immutable_evidence'); END;
      CREATE TRIGGER IF NOT EXISTS desk_evidence_no_delete BEFORE DELETE ON desk_evidence BEGIN SELECT RAISE(ABORT,'immutable_evidence'); END;`);
    this.verify();
  }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  append(kind: string, payload: unknown, eventKey: string, ts = Date.now()): void {
    const encoded = canonical(payload);
    this.atomic(() => {
      const old = this.db.query<{ payload: string; kind: string }, [string]>("SELECT kind,payload FROM desk_events WHERE event_key=?").get(eventKey);
      if (old) { if (old.kind !== kind || old.payload !== encoded) throw new Error("journal_idempotency_conflict"); return; }
      const previous = this.db.query<{ event_hash: string }, []>("SELECT event_hash FROM desk_events ORDER BY seq DESC LIMIT 1").get()?.event_hash ?? "GENESIS";
      const eventHash = hash({ eventKey, ts, kind, payload, previous });
      this.db.query("INSERT INTO desk_events(event_key,ts,kind,payload,previous_hash,event_hash) VALUES(?,?,?,?,?,?)").run(eventKey, ts, kind, encoded, previous, eventHash);
    });
  }
  putEvidence(value: Evidence<unknown>): void {
    const encoded = canonical(value);
    const existing = this.db.query<{ payload: string }, [string]>("SELECT payload FROM desk_evidence WHERE id=?").get(value.id);
    if (existing && existing.payload !== encoded) throw new Error("immutable_evidence_conflict");
    this.db.query("INSERT OR IGNORE INTO desk_evidence(id,payload) VALUES(?,?)").run(value.id, encoded);
  }
  claim(key: string, value: unknown): boolean { return this.db.query("INSERT OR IGNORE INTO desk_state(name,payload) VALUES(?,?)").run(key, canonical(value)).changes === 1; }
  release(key: string): void { this.db.query("DELETE FROM desk_state WHERE name=?").run(key); }
  getEvidence<T>(id: string): Evidence<T> | null { const row = this.db.query<{ payload: string }, [string]>("SELECT payload FROM desk_evidence WHERE id=?").get(id); return row ? immutable(JSON.parse(row.payload) as Evidence<T>) : null; }
  save(key: string, value: unknown): void { this.db.query("INSERT INTO desk_state(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload").run(key, canonical(value)); }
  load<T>(key: string): T | null { const row = this.db.query<{ payload: string }, [string]>("SELECT payload FROM desk_state WHERE name=?").get(key); return row ? immutable(JSON.parse(row.payload) as T) : null; }
  events(): { seq: number; event_key: string; ts: number; kind: string; payload: unknown; previous_hash: string; event_hash: string }[] {
    return this.db.query<{ seq: number; event_key: string; ts: number; kind: string; payload: string; previous_hash: string; event_hash: string }, []>("SELECT seq,event_key,ts,kind,payload,previous_hash,event_hash FROM desk_events ORDER BY seq").all().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  rows(): JournalRow[] { return this.events().filter(event => event.kind === "row").map(event => event.payload as JournalRow); }
  exportCsv(): string { return [JOURNAL_COLUMNS.join(","), ...this.rows().map(row => JOURNAL_COLUMNS.map(column => csvCell(row[column])).join(","))].join("\r\n") + "\r\n"; }
  verify(): void {
    let previous = "GENESIS";
    for (const row of this.db.query<{ event_key: string; ts: number; kind: string; payload: string; previous_hash: string; event_hash: string }, []>("SELECT event_key,ts,kind,payload,previous_hash,event_hash FROM desk_events ORDER BY seq").all()) {
      if (row.previous_hash !== previous || row.event_hash !== hash({ eventKey: row.event_key, ts: row.ts, kind: row.kind, payload: JSON.parse(row.payload), previous })) throw new Error("journal_integrity_failure");
      previous = row.event_hash;
    }
  }
  close(): void { this.db.close(); }
}
