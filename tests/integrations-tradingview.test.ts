import { afterEach, expect, test } from "bun:test";
import { DeskJournal } from "../src/desk/journal";
import { hash } from "../src/desk/evidence";
import { TradingViewReadClient, TradingViewSetupClient } from "../src/integrations/tradingview";

const journals: DeskJournal[] = [];
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });
function mock(failWrite = false) {
  const calls: { method: string; params: any }[] = [];
  const transport = (async (_url: any, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    expect(init?.redirect).toBe("error");
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }, { headers: { "Mcp-Session-Id": "test-session" } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    expect(new Headers(init?.headers).get("Mcp-Session-Id")).toBe("test-session");
    if (request.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "test_chart_read", description: "Test-only chart read name supplied by fake discovery", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "test_alert_create", description: "Create an alert in the fake provider", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "test_no_annotation", inputSchema: { type: "object" } },
      { name: "test_order_submit", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ] } });
    if (failWrite && request.params.name === "test_alert_create") throw new Error("timeout after write");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "test-result" }], isError: false } });
  }) as typeof fetch;
  return { calls, transport };
}

test("read-only MCP discovers exact names and permits only explicit annotated read capabilities", async () => {
  const fake = mock(), client = new TradingViewReadClient({ endpoint: "https://test.invalid/mcp", accessToken: "test-token", allowedReadTools: ["test_chart_read", "test_no_annotation"], fetch: fake.transport });
  await expect(client.read("chart", "test_chart_read", {})).rejects.toThrow("not_discovered");
  const discovered = await client.discover(); expect(discovered.allowed.map(tool => tool.name)).toEqual(["test_chart_read"]);
  await client.read("chart", "test_chart_read", { symbol: "DEMO" });
  await expect(client.read("chart", "test_alert_create", {})).rejects.toThrow("not_discovered");
  await expect(client.read("chart", "test_no_annotation", {})).rejects.toThrow("not_discovered");
  await expect(client.read("chief", "test_chart_read", {})).rejects.toThrow("no_market_read");
  expect(fake.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
});

test("MCP credentials are never accepted over HTTP or followed through redirect; write-like read allowlist rejected", () => {
  expect(() => new TradingViewReadClient({ endpoint: "http://test.invalid", accessToken: "secret", allowedReadTools: [] })).toThrow("https_oauth");
  expect(() => new TradingViewReadClient({ endpoint: "https://test.invalid", accessToken: "secret", allowedReadTools: ["test_order_submit"] })).toThrow("read_tool_allowlist");
});

test("separate setup adapter uses a discovered mapped alert capability with exact bounded approval and durable idempotence", async () => {
  const fake = mock(), store = new DeskJournal(":memory:"); journals.push(store);
  const client = new TradingViewSetupClient({ endpoint: "https://test.invalid/mcp", accessToken: "test-token", allowedReadTools: [], fetch: fake.transport,
    enableSetupWrites: true, setupTools: { "alert.create": "test_alert_create" }, store, now: () => 1000 });
  await client.discover(); const args = { symbol: "DEMO", condition: "Desk Signal BUY" }, preview = client.preview("alert.create", args);
  const approval = { id: "reviewed-alert", approved: true as const, approvedBy: "operator", operation: "alert.create" as const, toolName: preview.toolName, argumentsHash: preview.argumentsHash, issuedAt: 999, expiresAt: 2000 };
  await expect(client.executeSetup({ ...approval, argumentsHash: hash({ changed: true }) }, args)).rejects.toThrow("exact_current");
  await client.executeSetup(approval, args); await client.executeSetup(approval, args);
  expect(fake.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
});

test("uncertain setup write cannot be automatically replayed", async () => {
  const fake = mock(true), store = new DeskJournal(":memory:"); journals.push(store);
  const client = new TradingViewSetupClient({ endpoint: "https://test.invalid/mcp", accessToken: "test-token", allowedReadTools: [], fetch: fake.transport,
    enableSetupWrites: true, setupTools: { "alert.create": "test_alert_create" }, store, now: () => 1000 });
  await client.discover(); const args = { symbol: "DEMO" };
  const approval = { id: "uncertain-alert", approved: true as const, approvedBy: "operator", operation: "alert.create" as const, toolName: "test_alert_create", argumentsHash: hash(args), issuedAt: 999, expiresAt: 2000 };
  await expect(client.executeSetup(approval, args)).rejects.toThrow("unknown"); await expect(client.executeSetup(approval, args)).rejects.toThrow("unknown");
  expect(fake.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
});
