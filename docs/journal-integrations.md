# Google Sheets and Notion Trade Journals

`src/integrations/journal-export.ts` implements remote creation and append for both services. Each destination has the article's fourteen columns, in order:

`TIME, BOT, TICKER, IDEA, SOURCE, SCORE, ENTRY, STOP, TARGET, SIZE, RISK CHECK, STATUS, RESULT, LESSON`.

Two additional metadata columns, `_EXPORT_ID` and `_PAYLOAD_HASH`, support recovery after an ambiguous request. Do not delete or edit these fields. The local SQLite journal remains the source of audit events; a remote document is a readable replica, not order authorization.

## Configure and call

Both exporters accept `{accessToken, store, allowWrites, fetch?, timeoutMs?}`. `store` implements atomic `claim`, plus `load` and `save`; an existing `DeskJournal` supplies all three. `fetch` is injectable for a proxy or deterministic tests. HTTP requests use only the official service host, refuse redirects, and have a bounded deadline. Tokens are never included in stored operation records or error text.

The constructor performs no request. Writes require `allowWrites: true`, which is disabled by default. OAuth acquisition and refresh are external responsibilities: obtain a token with appropriate access, share the target Notion parent with the connection, and keep tokens in environment variables or a secret store. No OAuth authorization, hosted document creation, or authenticated remote append was performed during implementation.

```ts
import { DeskJournal } from "../src/desk/journal";
import { GoogleSheetsJournalExporter, NotionJournalExporter } from "../src/integrations/journal-export";

const journal = new DeskJournal("data/desk.sqlite");
const sheets = new GoogleSheetsJournalExporter({
  accessToken: process.env.GOOGLE_SHEETS_ACCESS_TOKEN!,
  store: journal,
  allowWrites: true,
});
const created = await sheets.create("desk-main-sheet-v1", {
  title: "Trade Journal", sheetName: "Trade Journal",
});
if (created.status !== "CONFIRMED") throw new Error(created.reason);

// Reuse each immutable local event key; do not generate a new ID on every retry.
for (const event of journal.events().filter(event => event.kind === "row")) {
  const result = await sheets.append(`event-${event.seq}`, created.value,
    event.payload as import("../src/desk/types").JournalRow);
  if (result.status !== "CONFIRMED") break;
}

// Alternative destination; the same API creates a database and its first data source.
const notion = new NotionJournalExporter({
  accessToken: process.env.NOTION_ACCESS_TOKEN!, store: journal, allowWrites: true,
});
// Execute only when this destination has been explicitly configured:
// const result = await notion.create("desk-main-notion-v1", {
//   parentPageId: process.env.NOTION_PARENT_PAGE_ID!, title: "Trade Journal",
// });
journal.close();
```

Operation IDs must be stable, bounded strings. Each ID is bound to the exact destination and row payload. Reusing an ID for a different row fails with `journal_export_idempotency_conflict`. All processes writing this desk must use the same durable store. A new empty store cannot remember past writes.

## Service details

Google Sheets uses `POST /v4/spreadsheets` with the header row included in the creation request. Before append, it verifies the destination's complete header. `spreadsheets.values.append` uses `valueInputOption=RAW`; strings beginning with `=`, `+`, `-`, or `@` remain literal values rather than spreadsheet formulas. The returned row must match all sixteen sent values before the operation becomes confirmed. This is independent of the existing CSV export's formula-neutralization rules.

Notion is pinned to `Notion-Version: 2025-09-03`. Database creation sends `initial_data_source.properties`; subsequent pages use a `data_source_id` parent. `IDEA` is the required title property, `TIME` is a timezone-aware date, the five score/price/size fields are numbers, and the other fields are rich text. Empty numeric fields map to null. Invalid numeric strings are rejected rather than silently changed. Long text is split into bounded rich-text segments without splitting a surrogate pair; no journal text is truncated. The complete data-source schema is checked before page creation.

## Ambiguous requests and recovery

Before a mutation is sent, the store atomically records `PENDING`. A verified response changes it to `CONFIRMED`. Known input/access rejections become `FAILED`. A timeout, connection loss, server error, or malformed success becomes `UNKNOWN`, because the server may already have committed the write. Recalling `append` with the same ID does **not** send another mutation.

Use `reconcile(operationId, destination, originalRow)` to inspect the remote destination. This works with writes disabled. Sheets recovery reads values; Notion recovery uses its read-only query operation, which happens to use HTTP POST. Confirmation requires exactly one matching operation ID and an exact match of the visible fields and payload hash. Missing, duplicated, archived, moved, or edited data remains unknown. An empty read does not prove that an earlier in-flight request failed, so recovery never automatically resubmits.

Ambiguous **creation** remains a manual reconciliation boundary: the API cannot safely infer which same-title document was created. Locate and inspect the document, retain its explicit spreadsheet/data-source ID, and investigate the pending operation before issuing a new create ID. No exactly-once guarantee is claimed across an external API and a local database.

The adapters append immutable events; they do not modify existing rows, delete documents, or send messages to collaborators. Large recovery responses fail closed. Remote edits and synchronization conflicts must be reviewed against the local event history.

## Verification and primary references

`bun test tests/journal-export.test.ts` runs the real request/response serialization with injected transports and an actual SQLite `DeskJournal`. It covers opt-in gating, creation schemas, RAW formula safety, long Unicode text, changed payloads, schema mismatch, concurrent duplicate calls, failure classification, and ambiguous-write recovery. It sends no external requests.

- [Google Sheets spreadsheet creation](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create)
- [Google Sheets value append](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append)
- [Google Sheets RAW value interpretation](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption)
- [Notion database creation](https://developers.notion.com/reference/create-database)
- [Notion 2025-09-03 migration: data-source parents](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)
- [Notion retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source)
- [Notion query a data source](https://developers.notion.com/reference/query-a-data-source)
