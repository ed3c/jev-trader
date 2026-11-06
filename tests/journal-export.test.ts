import { describe, expect, test } from "bun:test";
import { DeskJournal } from "../src/desk/journal";
import type { JournalRow } from "../src/desk/types";
import { EXPORT_COLUMNS, GoogleSheetsJournalExporter, NOTION_API_VERSION, NotionJournalExporter, notionJournalSchema } from "../src/integrations/journal-export";

const row: JournalRow = { TIME: "2026-11-06T15:00:00.000Z", BOT: "scout", TICKER: "TEST", IDEA: '=IMPORTDATA("https://untrusted.invalid")', SOURCE: "test://fixture",
  SCORE: 8, ENTRY: 100, STOP: 98, TARGET: 106, SIZE: 1, "RISK CHECK": "APPROVED_PAPER", STATUS: "SCOUTED", RESULT: "", LESSON: "@untrusted" };
const sheet = { spreadsheetId: "fixture_sheet_123", sheetName: "Desk's Journal" };
const dataSourceId = "11111111111141118111111111111111", pageId = "22222222222242228222222222222222", databaseId = "33333333333343338333333333333333";
const notion = { dataSourceId };
type Call = { url: string; init: RequestInit; body: any };
function harness(handle: (call: Call, index: number) => unknown | Promise<unknown>) {
  const calls: Call[] = [], store = new DeskJournal(":memory:");
  const fetch = async (url: string, init: RequestInit = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : null }; calls.push(call);
    const value = await handle(call, calls.length - 1);
    return value instanceof Response ? value : Response.json(value);
  };
  return { store, calls, options: { accessToken: "fixture-secret-token", store, fetch, allowWrites: true } };
}
function notionSchema() { return { object: "data_source", id: dataSourceId, properties: Object.fromEntries(Object.entries(notionJournalSchema()).map(([key, value]) => [key, { ...value, type: Object.keys(value)[0] }])) }; }
function notionPage(properties: any) { return { object: "page", id: pageId, archived: false, in_trash: false, parent: { type: "data_source_id", data_source_id: dataSourceId }, properties: Object.fromEntries(Object.entries(properties).map(([key, value]: [string, any]) => [key, { ...value, type: Object.keys(value)[0] }])) }; }
function sheetsResponse(values: unknown) { return { spreadsheetId: sheet.spreadsheetId, updates: { updatedRows: 1, updatedColumns: 16, updatedRange: "'Desk''s Journal'!A2:P2", updatedData: { values } } }; }

describe("opt-in remote journal adapters", () => {
  test("writes are disabled by default and credentials never enter durable state", async () => {
    const h = harness(() => { throw new Error("unexpected request"); });
    try {
      const client = new GoogleSheetsJournalExporter({ ...h.options, allowWrites: false });
      await expect(client.create("new-journal")).rejects.toThrow("writes_disabled");
      await expect(client.append("event-1", sheet, row)).rejects.toThrow("writes_disabled");
      const n = new NotionJournalExporter({ ...h.options, allowWrites: false });
      await expect(n.create("new-journal", { parentPageId: pageId })).rejects.toThrow("writes_disabled");
      expect(h.calls).toHaveLength(0);
    } finally { h.store.close(); }
  });
  test("Sheets creation atomically includes requested columns and replay returns same destination", async () => {
    const h = harness(() => ({ spreadsheetId: sheet.spreadsheetId }));
    try {
      const c = new GoogleSheetsJournalExporter(h.options);
      const result = await c.create("create-1", { sheetName: sheet.sheetName });
      expect(result).toEqual({ status: "CONFIRMED", value: sheet });
      expect(h.calls[0]!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets");
      expect(h.calls[0]!.body.sheets[0].data[0].rowData[0].values.map((v: any) => v.userEnteredValue.stringValue)).toEqual(EXPORT_COLUMNS);
      expect(await c.create("create-1", { sheetName: sheet.sheetName })).toEqual(result);
      expect(h.calls).toHaveLength(1);
      expect(JSON.stringify(h.store.load("journal_export:google_sheets:create:create-1"))).not.toContain("fixture-secret-token");
    } finally { h.store.close(); }
  });
  test("Sheets append uses RAW, escapes sheet names, verifies schema, and binds operation to payload", async () => {
    const h = harness(call => call.init.method === "GET" ? { values: [[...EXPORT_COLUMNS]] } : sheetsResponse(call.body.values));
    try {
      const c = new GoogleSheetsJournalExporter(h.options), first = await c.append("event-1", sheet, row);
      expect(first.status).toBe("CONFIRMED");
      expect(h.calls).toHaveLength(2);
      expect(decodeURIComponent(h.calls[1]!.url)).toContain("'Desk''s Journal'!A:P:append?valueInputOption=RAW");
      expect(h.calls[1]!.body.values[0][3]).toBe(row.IDEA);
      expect(h.calls[1]!.body.values[0]).toHaveLength(16);
      expect(h.calls[1]!.init.redirect).toBe("error");
      expect(await c.append("event-1", sheet, row)).toEqual(first);
      await expect(c.append("event-1", sheet, { ...row, SIZE: 9 })).rejects.toThrow("idempotency_conflict");
      expect(h.calls).toHaveLength(2);
    } finally { h.store.close(); }
  });
  test("Sheets ambiguous commit is reconciled read-only, never resubmitted", async () => {
    let committed: any;
    const h = harness(call => {
      if (call.init.method === "POST") { committed = call.body.values; throw new Error("socket closed after remote commit"); }
      return call.url.includes("A1%3AP1") ? { values: [[...EXPORT_COLUMNS]] } : { values: committed };
    });
    try {
      const c = new GoogleSheetsJournalExporter(h.options);
      expect((await c.append("ambiguous-1", sheet, row)).status).toBe("UNKNOWN");
      expect((await c.append("ambiguous-1", sheet, row)).status).toBe("UNKNOWN");
      expect(h.calls).toHaveLength(2);
      const restart = new GoogleSheetsJournalExporter({ ...h.options, allowWrites: false });
      expect((await restart.reconcile("ambiguous-1", sheet, row)).status).toBe("CONFIRMED");
      expect(h.calls.filter(c => c.init.method === "POST")).toHaveLength(1);
    } finally { h.store.close(); }
  });
  test("missing, duplicate, or changed Sheets entries cannot clear an unknown write", async () => {
    let committed: any, mode = "missing";
    const h = harness(call => {
      if (call.init.method === "POST") { committed = call.body.values; return new Response("unavailable", { status: 503 }); }
      if (call.url.includes("A1%3AP1")) return { values: [[...EXPORT_COLUMNS]] };
      return { values: mode === "missing" ? [] : mode === "duplicate" ? [...committed, ...committed] : [[...committed[0].slice(0, 9), 99, ...committed[0].slice(10)]] };
    });
    try {
      const c = new GoogleSheetsJournalExporter(h.options);
      expect((await c.append("ambiguous-2", sheet, row)).status).toBe("UNKNOWN");
      for (const m of ["missing", "duplicate", "changed"]) { mode = m; expect((await c.reconcile("ambiguous-2", sheet, row)).status).toBe("UNKNOWN"); }
      expect(h.calls.filter(c => c.init.method === "POST")).toHaveLength(1);
    } finally { h.store.close(); }
  });
  test("schemas and invalid identifiers fail before any mutation", async () => {
    const h = harness(() => ({ values: [["WRONG"]] }));
    try {
      const c = new GoogleSheetsJournalExporter(h.options);
      await expect(c.append("schema", sheet, row)).rejects.toThrow("schema_mismatch");
      await expect(c.append("bad", { ...sheet, spreadsheetId: "https://other.invalid" }, row)).rejects.toThrow("invalid_google_id");
      await expect(c.append("bad", sheet, { ...row, SIZE: NaN })).rejects.toThrow("invalid_journal_cell");
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.init.method).toBe("GET");
    } finally { h.store.close(); }
  });
  test("Notion creates a first data source with all columns under the configured page", async () => {
    const h = harness(() => ({ object: "database", id: databaseId, data_sources: [{ id: dataSourceId }] }));
    try {
      const c = new NotionJournalExporter(h.options);
      expect(await c.create("create-notion", { parentPageId: pageId })).toEqual({ status: "CONFIRMED", value: { databaseId, dataSourceId } });
      const request = h.calls[0]!;
      expect(request.url).toBe("https://api.notion.com/v1/databases");
      expect(request.body.parent).toEqual({ type: "page_id", page_id: pageId });
      expect(Object.keys(request.body.initial_data_source.properties)).toEqual([...EXPORT_COLUMNS]);
      expect(request.body.initial_data_source.properties.IDEA).toEqual({ title: {} });
      expect(new Headers(request.init.headers).get("Notion-Version")).toBe(NOTION_API_VERSION);
    } finally { h.store.close(); }
  });
  test("Notion uses typed pages and preserves long Unicode journal text", async () => {
    const h = harness(call => call.init.method === "GET" ? notionSchema() : notionPage(call.body.properties));
    try {
      const c = new NotionJournalExporter(h.options), longRow = { ...row, LESSON: "a".repeat(1899) + "🙂" + "b".repeat(2200) };
      expect((await c.append("notion-1", notion, longRow)).status).toBe("CONFIRMED");
      const p = h.calls[1]!.body.properties;
      expect(h.calls[1]!.body.parent).toEqual({ type: "data_source_id", data_source_id: dataSourceId });
      expect(p.SIZE).toEqual({ number: 1 }); expect(p.TIME).toEqual({ date: { start: row.TIME } });
      expect(p.LESSON.rich_text.map((v: any) => v.text.content).join("")).toBe(longRow.LESSON);
      expect(p.LESSON.rich_text.every((v: any) => v.text.content.length <= 1900)).toBeTrue();
      expect((await c.append("notion-1", notion, longRow)).status).toBe("CONFIRMED");
      expect(h.calls).toHaveLength(2);
    } finally { h.store.close(); }
  });
  test("Notion recovery requires one exact unarchived page and matching data source", async () => {
    let page: any, duplicate = true;
    const h = harness(call => {
      if (call.init.method === "GET") return notionSchema();
      if (call.url.endsWith("/pages")) { page = notionPage(call.body.properties); throw new Error("ambiguous timeout"); }
      expect(call.body.filter).toEqual({ property: "_EXPORT_ID", rich_text: { equals: "notion-unknown" } });
      return { results: duplicate ? [page, page] : [page], has_more: false };
    });
    try {
      const c = new NotionJournalExporter(h.options);
      expect((await c.append("notion-unknown", notion, row)).status).toBe("UNKNOWN");
      expect((await c.reconcile("notion-unknown", notion, row)).status).toBe("UNKNOWN");
      duplicate = false; page.in_trash = true;
      expect((await c.reconcile("notion-unknown", notion, row)).status).toBe("UNKNOWN");
      page.in_trash = false;
      expect((await c.reconcile("notion-unknown", notion, row)).status).toBe("CONFIRMED");
      expect(h.calls.filter(c => c.url.endsWith("/pages"))).toHaveLength(1);
    } finally { h.store.close(); }
  });
  test("Notion rejects malformed schema, numbers, and local timestamps before append", async () => {
    const h = harness(() => ({ object: "data_source", id: dataSourceId, properties: {} }));
    try {
      const c = new NotionJournalExporter(h.options);
      await expect(c.append("bad-number", notion, { ...row, SIZE: "N/A" })).rejects.toThrow("invalid_journal_number");
      await expect(c.append("bad-time", notion, { ...row, TIME: "2026-11-06 15:00" })).rejects.toThrow("iso8601_timezone");
      await expect(c.append("bad-schema", notion, row)).rejects.toThrow("schema_mismatch");
      expect(h.calls).toHaveLength(1);
    } finally { h.store.close(); }
  });
  test("concurrent duplicate calls share one atomic mutation claim", async () => {
    const h = harness(call => call.init.method === "GET" ? { values: [[...EXPORT_COLUMNS]] } : sheetsResponse(call.body.values));
    try {
      const a = new GoogleSheetsJournalExporter(h.options), b = new GoogleSheetsJournalExporter(h.options);
      const results = await Promise.all([a.append("concurrent", sheet, row), b.append("concurrent", sheet, row)]);
      expect(results.some(r => r.status === "CONFIRMED")).toBeTrue();
      expect(h.calls.filter(c => c.init.method === "POST")).toHaveLength(1);
      expect((await b.append("concurrent", sheet, row)).status).toBe("CONFIRMED");
    } finally { h.store.close(); }
  });
  test("known credential rejection is FAILED and malformed success remains UNKNOWN without retry", async () => {
    for (const status of [403, 200]) {
      const h = harness(() => new Response(status === 403 ? "token secret not echoed" : "{}", { status }));
      try {
        const c = new GoogleSheetsJournalExporter(h.options), first = await c.create(`rejected-${status}`);
        expect(first.status).toBe(status === 403 ? "FAILED" : "UNKNOWN");
        expect(JSON.stringify(first)).not.toContain("secret");
        expect(await c.create(`rejected-${status}`)).toEqual(first);
        expect(h.calls).toHaveLength(1);
      } finally { h.store.close(); }
    }
  });
});
