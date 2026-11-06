import { hash } from "../desk/evidence";
import { JOURNAL_COLUMNS } from "../desk/journal";
import type { JournalRow } from "../desk/types";

/** OAuth/token acquisition and destination sharing remain the operator's responsibility. */
export interface JournalExportStore {
  load<T>(key: string): T | null | undefined;
  save(key: string, value: unknown): void;
  /** Atomic insert-if-absent, shared by every writer to this journal. */
  claim(key: string, value: unknown): boolean;
}
export interface JournalExporterOptions {
  accessToken: string;
  store: JournalExportStore;
  allowWrites?: boolean;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
export type ExportResult<T> = { status: "CONFIRMED"; value: T } | { status: "UNKNOWN" | "FAILED"; reason: string };
interface Operation<T> { digest: string; status: "PENDING" | "CONFIRMED" | "UNKNOWN" | "FAILED"; value?: T; reason?: string }
export interface SheetsDestination { spreadsheetId: string; sheetName: string }
export interface NotionDestination { dataSourceId: string }
export interface JournalReceipt { remoteId: string; url: string }
export const EXPORT_COLUMNS = [...JOURNAL_COLUMNS, "_EXPORT_ID", "_PAYLOAD_HASH"] as const;
export const NOTION_API_VERSION = "2025-09-03";
const NUMERIC_COLUMNS = new Set<string>(["SCORE", "ENTRY", "STOP", "TARGET", "SIZE"]);
type Json = Record<string, any>;

function identifier(value: string, kind: "google" | "notion" | "operation"): string {
  const valid = kind === "notion" ? /^[a-f\d]{8}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{12}$/i : /^[a-z\d][a-z\d_.:-]{0,199}$/i;
  if (typeof value !== "string" || !valid.test(value)) throw new Error(`invalid_${kind}_id`);
  return kind === "notion" ? value.toLowerCase().replaceAll("-", "") : value;
}
function sheetName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\[\]:*?/\\\u0000-\u001f]/.test(value)) throw new Error("invalid_sheet_name");
  return value;
}
function title(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("invalid_journal_title");
  return value;
}
function rowValues(row: JournalRow): (string | number)[] {
  return JOURNAL_COLUMNS.map(column => {
    const value = row[column];
    if (typeof value !== "string" && typeof value !== "number" || typeof value === "number" && !Number.isFinite(value)) throw new Error(`invalid_journal_cell:${column}`);
    if (!NUMERIC_COLUMNS.has(column) && typeof value !== "string") throw new Error(`invalid_journal_text:${column}`);
    if (String(value).length > 45_000) throw new Error(`journal_cell_too_large:${column}`);
    return value;
  });
}
function sameCells(actual: unknown, expected: (string | number)[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}
class HttpFailure extends Error { constructor(readonly status: number) { super(`journal_http_${status}`); } }

/** PENDING is durable before POST. Timeouts, malformed success, and server errors are never blindly retried. */
abstract class JournalExporter {
  protected readonly transport: (url: string, init?: RequestInit) => Promise<Response>;
  constructor(protected readonly options: JournalExporterOptions, private readonly provider: string) {
    if (!options.accessToken || /[\r\n]/.test(options.accessToken)) throw new Error("journal_token_required");
    if (!Number.isInteger(options.timeoutMs ?? 10_000) || (options.timeoutMs ?? 10_000) < 1 || (options.timeoutMs ?? 10_000) > 60_000) throw new Error("invalid_journal_timeout");
    this.transport = options.fetch ?? fetch;
  }
  protected writable(): void { if (this.options.allowWrites !== true) throw new Error("journal_remote_writes_disabled"); }
  protected key(action: string, operationId: string): string { return `journal_export:${this.provider}:${action}:${identifier(operationId, "operation")}`; }
  protected prior<T>(key: string, digest: string): ExportResult<T> | null {
    const old = this.options.store.load<Operation<T>>(key);
    if (!old) return null;
    if (old.digest !== digest) throw new Error("journal_export_idempotency_conflict");
    if (old.status === "CONFIRMED") return { status: "CONFIRMED", value: old.value! };
    return { status: old.status === "FAILED" ? "FAILED" : "UNKNOWN", reason: old.reason ?? "pending_request_requires_reconciliation" };
  }
  protected async mutate<T>(key: string, digest: string, send: () => Promise<T>): Promise<ExportResult<T>> {
    this.writable();
    const old = this.prior<T>(key, digest);
    if (old) return old;
    if (!this.options.store.claim(key, { digest, status: "PENDING" })) return this.prior<T>(key, digest)!;
    try {
      const value = await send();
      this.options.store.save(key, { digest, status: "CONFIRMED", value });
      return { status: "CONFIRMED", value };
    } catch (error) {
      const definite = error instanceof HttpFailure && [400, 401, 403, 404, 422].includes(error.status);
      const result: ExportResult<T> = { status: definite ? "FAILED" : "UNKNOWN", reason: error instanceof HttpFailure ? error.message : "request_outcome_unknown" };
      this.options.store.save(key, { digest, ...result });
      return result;
    }
  }
  protected async request(url: string, method = "GET", body?: unknown): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json" };
      if (this.provider === "notion") headers["Notion-Version"] = NOTION_API_VERSION;
      const response = await this.transport(url, { method, headers, redirect: "error", signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new HttpFailure(response.status);
      const text = await response.text();
      if (text.length > 8_000_000) throw new Error("journal_response_too_large");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_journal_response");
      return parsed as Json;
    } finally { clearTimeout(timer); }
  }
  protected confirm<T>(key: string, digest: string, value: T): ExportResult<T> {
    this.options.store.save(key, { digest, status: "CONFIRMED", value });
    return { status: "CONFIRMED", value };
  }
}

export class GoogleSheetsJournalExporter extends JournalExporter {
  constructor(options: JournalExporterOptions) { super(options, "google_sheets"); }
  private destination(input: SheetsDestination): SheetsDestination { return { spreadsheetId: identifier(input.spreadsheetId, "google"), sheetName: sheetName(input.sheetName) }; }
  private range(destination: SheetsDestination, cells: string): string { return `'${destination.sheetName.replaceAll("'", "''")}'!${cells}`; }
  private valuesUrl(destination: SheetsDestination, cells: string): string { return `https://sheets.googleapis.com/v4/spreadsheets/${destination.spreadsheetId}/values/${encodeURIComponent(this.range(destination, cells))}`; }
  async create(operationId: string, input: { title?: string; sheetName?: string } = {}): Promise<ExportResult<SheetsDestination>> {
    this.writable();
    const journalTitle = title(input.title ?? "Trade Journal"), name = sheetName(input.sheetName ?? "Trade Journal");
    const key = this.key("create", operationId), digest = hash({ title: journalTitle, sheetName: name });
    return this.mutate(key, digest, async () => {
      const data = await this.request("https://sheets.googleapis.com/v4/spreadsheets", "POST", {
        properties: { title: journalTitle }, sheets: [{ properties: { title: name, gridProperties: { rowCount: 1000, columnCount: 16, frozenRowCount: 1 } },
          data: [{ startRow: 0, startColumn: 0, rowData: [{ values: EXPORT_COLUMNS.map(header => ({ userEnteredValue: { stringValue: header } })) }] }] }],
      });
      return this.destination({ spreadsheetId: data.spreadsheetId, sheetName: name });
    });
  }
  async append(operationId: string, input: SheetsDestination, row: JournalRow): Promise<ExportResult<JournalReceipt>> {
    this.writable(); identifier(operationId, "operation");
    const destination = this.destination(input), cells = rowValues(row), digest = hash({ destination, cells });
    const key = this.key("append", operationId), old = this.prior<JournalReceipt>(key, digest);
    if (old) return old;
    const header = await this.request(this.valuesUrl(destination, "A1:P1"));
    if (!sameCells(header.values?.[0], [...EXPORT_COLUMNS])) throw new Error("journal_sheet_schema_mismatch");
    const values = [...cells, operationId, digest];
    return this.mutate(key, digest, async () => {
      const data = await this.request(`${this.valuesUrl(destination, "A:P")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE`, "POST", {
        range: this.range(destination, "A:P"), majorDimension: "ROWS", values: [values],
      });
      if (data.spreadsheetId !== destination.spreadsheetId || data.updates?.updatedRows !== 1 || !sameCells(data.updates?.updatedData?.values?.[0], values) || typeof data.updates?.updatedRange !== "string") throw new Error("journal_append_unconfirmed");
      return { remoteId: data.updates.updatedRange, url: `https://docs.google.com/spreadsheets/d/${destination.spreadsheetId}/edit` };
    });
  }
  /** Read-only recovery. Zero matches or duplicate/edited rows remain UNKNOWN; no POST is repeated. */
  async reconcile(operationId: string, input: SheetsDestination, row: JournalRow): Promise<ExportResult<JournalReceipt>> {
    const destination = this.destination(input), cells = rowValues(row), digest = hash({ destination, cells }), key = this.key("append", operationId);
    const old = this.prior<JournalReceipt>(key, digest);
    if (!old) throw new Error("journal_export_operation_not_found");
    if (old.status !== "UNKNOWN") return old;
    const data = await this.request(`${this.valuesUrl(destination, "A2:P")}?valueRenderOption=UNFORMATTED_VALUE`);
    if (data.values !== undefined && !Array.isArray(data.values)) throw new Error("invalid_journal_rows");
    const rows = data.values ?? [];
    if (rows.length > 50_000) return { status: "UNKNOWN", reason: "reconciliation_row_limit" };
    const matches = rows.map((values: unknown, index: number) => ({ values, index })).filter(({ values }: { values: any }) => Array.isArray(values) && values[14] === operationId);
    if (matches.length !== 1 || !sameCells(matches[0].values, [...cells, operationId, digest])) return { status: "UNKNOWN", reason: "remote_row_missing_duplicated_or_changed" };
    return this.confirm(key, digest, { remoteId: this.range(destination, `A${matches[0].index + 2}:P${matches[0].index + 2}`), url: `https://docs.google.com/spreadsheets/d/${destination.spreadsheetId}/edit` });
  }
}

function richText(value: string): Json[] {
  const parts: Json[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 1900, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    parts.push({ type: "text", text: { content: value.slice(offset, end) } }); offset = end;
  }
  return parts;
}
function notionType(column: string): "title" | "date" | "number" | "rich_text" { return column === "IDEA" ? "title" : column === "TIME" ? "date" : NUMERIC_COLUMNS.has(column) ? "number" : "rich_text"; }
export function notionJournalSchema(): Json { return Object.fromEntries(EXPORT_COLUMNS.map(column => [column, { [notionType(column)]: {} }])); }
function notionProperties(row: JournalRow, operationId: string, digest: string): Json {
  rowValues(row);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(row.TIME) || !Number.isFinite(Date.parse(row.TIME))) throw new Error("journal_time_requires_iso8601_timezone");
  return Object.fromEntries(EXPORT_COLUMNS.map(column => {
    const value = column === "_EXPORT_ID" ? operationId : column === "_PAYLOAD_HASH" ? digest : row[column];
    const type = notionType(column);
    if (type === "date") return [column, { date: { start: new Date(row.TIME).toISOString() } }];
    if (type === "number") {
      const number = value === "" ? null : typeof value === "number" ? value : /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value)) ? Number(value) : NaN;
      if (number !== null && !Number.isFinite(number)) throw new Error(`invalid_journal_number:${column}`);
      return [column, { number }];
    }
    return [column, { [type]: richText(String(value)) }];
  }));
}
function matchesNotionProperties(actual: Json, expected: Json): boolean {
  if (!actual || typeof actual !== "object") return false;
  return EXPORT_COLUMNS.every(column => {
    const type = notionType(column), a = actual[column], e = expected[column];
    if (!a || a.type !== type) return false;
    if (type === "number") return a.number === e.number;
    if (type === "date") return a.date?.end == null && Date.parse(a.date?.start) === Date.parse(e.date.start);
    if (!Array.isArray(a[type])) return false;
    return a[type].map((v: Json) => v.plain_text ?? v.text?.content ?? "").join("") === e[type].map((v: Json) => v.text.content).join("");
  });
}

export class NotionJournalExporter extends JournalExporter {
  constructor(options: JournalExporterOptions) { super(options, "notion"); }
  private destination(input: NotionDestination): NotionDestination { return { dataSourceId: identifier(input.dataSourceId, "notion") }; }
  async create(operationId: string, input: { parentPageId: string; title?: string }): Promise<ExportResult<NotionDestination & { databaseId: string }>> {
    this.writable();
    const parentPageId = identifier(input.parentPageId, "notion"), journalTitle = title(input.title ?? "Trade Journal");
    return this.mutate(this.key("create", operationId), hash({ parentPageId, title: journalTitle }), async () => {
      const data = await this.request("https://api.notion.com/v1/databases", "POST", { parent: { type: "page_id", page_id: parentPageId },
        title: richText(journalTitle), initial_data_source: { properties: notionJournalSchema() } });
      const databaseId = identifier(data.id, "notion");
      if (data.object !== "database" || !Array.isArray(data.data_sources) || data.data_sources.length !== 1) throw new Error("notion_data_source_not_confirmed");
      return { databaseId, ...this.destination({ dataSourceId: data.data_sources[0].id }) };
    });
  }
  async append(operationId: string, input: NotionDestination, row: JournalRow): Promise<ExportResult<JournalReceipt>> {
    this.writable(); identifier(operationId, "operation");
    const destination = this.destination(input), cells = rowValues(row), digest = hash({ destination, cells }), properties = notionProperties(row, operationId, digest);
    const key = this.key("append", operationId), old = this.prior<JournalReceipt>(key, digest);
    if (old) return old;
    const schema = await this.request(`https://api.notion.com/v1/data_sources/${destination.dataSourceId}`);
    if (schema.object !== "data_source" || identifier(schema.id, "notion") !== destination.dataSourceId || EXPORT_COLUMNS.some(column => schema.properties?.[column]?.type !== notionType(column))) throw new Error("notion_journal_schema_mismatch");
    return this.mutate(key, digest, async () => {
      const data = await this.request("https://api.notion.com/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: destination.dataSourceId }, properties });
      const remoteId = identifier(data.id, "notion");
      if (data.object !== "page" || data.parent?.type !== "data_source_id" || identifier(data.parent.data_source_id, "notion") !== destination.dataSourceId || !matchesNotionProperties(data.properties, properties)) throw new Error("notion_page_not_confirmed");
      return { remoteId, url: `https://www.notion.so/${remoteId}` };
    });
  }
  async reconcile(operationId: string, input: NotionDestination, row: JournalRow): Promise<ExportResult<JournalReceipt>> {
    const destination = this.destination(input), cells = rowValues(row), digest = hash({ destination, cells }), properties = notionProperties(row, operationId, digest), key = this.key("append", operationId);
    const old = this.prior<JournalReceipt>(key, digest);
    if (!old) throw new Error("journal_export_operation_not_found");
    if (old.status !== "UNKNOWN") return old;
    const data = await this.request(`https://api.notion.com/v1/data_sources/${destination.dataSourceId}/query`, "POST", { filter: { property: "_EXPORT_ID", rich_text: { equals: operationId } }, page_size: 2 });
    if (!Array.isArray(data.results) || data.results.length !== 1 || data.has_more !== false || data.request_status?.type === "incomplete") return { status: "UNKNOWN", reason: "remote_page_missing_or_duplicated" };
    const page = data.results[0];
    if (page.object !== "page" || page.archived === true || page.in_trash === true || page.parent?.type !== "data_source_id" || identifier(page.parent.data_source_id, "notion") !== destination.dataSourceId || !matchesNotionProperties(page.properties, properties)) return { status: "UNKNOWN", reason: "remote_page_changed_or_mismatched" };
    const remoteId = identifier(page.id, "notion");
    return this.confirm(key, digest, { remoteId, url: `https://www.notion.so/${remoteId}` });
  }
}
