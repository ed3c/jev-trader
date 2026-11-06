import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Values in evidence may contain external text. Never persist credentials in the audit trail. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /private.?key|api.?key|authorization|password|secret|access.?token/i.test(k) ? "[REDACTED]" : redact(v)]));
  return value;
}

export interface JournalRecord { sequence: number; ts: number; kind: string; key: string; payload: unknown }

/** SQLite transactions bind order intent, state and event identity before any external write. */
export class Journal {
  readonly db: Database;
  failed = false;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL,
        event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,ts);
    `);
  }
  append(kind: string, payload: unknown, key: string = crypto.randomUUID(), ts = Date.now()): boolean {
    if(this.failed)throw new Error("Journal is unavailable; trading must stop");
    try {
    const data = JSON.stringify(redact(payload));
    const old = this.db.query("SELECT payload,kind FROM events WHERE event_key=?").get(key) as {payload:string;kind:string}|null;
    if (old) {
      if (old.payload !== data || old.kind !== kind) throw new Error(`Conflicting journal identity: ${key}`);
      return false;
    }
    this.db.query("INSERT INTO events(ts,kind,event_key,payload) VALUES(?,?,?,?)").run(ts, kind, key, data);
    return true;
    } catch(error) { this.failed=true;throw error; }
  }
  save(name: string, payload: unknown) {
    if(this.failed)throw new Error("Journal is unavailable; trading must stop");
    try {
    this.db.query("INSERT INTO state(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload")
      .run(name, JSON.stringify(payload));
    } catch(error) {this.failed=true;throw error;}
  }
  load<T>(name: string): T | null {
    const row = this.db.query("SELECT payload FROM state WHERE name=?").get(name) as {payload:string}|null;
    return row ? JSON.parse(row.payload) as T : null;
  }
  atomic<T>(work: () => T): T { if(this.failed)throw new Error("Journal unavailable");try{return this.db.transaction(work)();}catch(error){this.failed=true;throw error;} }
  records(limit = 1000): JournalRecord[] {
    const rows = this.db.query("SELECT sequence,ts,kind,event_key AS key,payload FROM events ORDER BY sequence DESC LIMIT ?").all(limit) as Array<Omit<JournalRecord,"payload"> & {payload:string}>;
    return rows.reverse().map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  close() { this.db.close(); }
}
