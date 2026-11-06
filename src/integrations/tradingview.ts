import { hash, immutable } from "../desk/evidence";
import type { DeskRole } from "../desk/types";

export interface TradingViewOAuthConfig {
  endpoint: string;
  /** An OAuth access token acquired through the provider's actual consent flow. Never a password. */
  accessToken: string;
  /** Copy exact names from discovery after reviewing the provider's tool descriptions. */
  allowedReadTools: string[];
  fetch?: typeof fetch;
}
export interface McpTool { name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; }
const WRITE_WORDS = /(^|[_\-.])(create|update|delete|remove|write|submit|place|cancel|trade|buy|sell|transfer|execute|modify)([_\-.]|$)/i;
/** Generic read-only MCP client. No provider tool names or successful OAuth session are invented. */
export class TradingViewReadClient {
  private readonly transport: typeof fetch;
  protected readonly tools = new Map<string, McpTool>();
  private session: string | undefined;
  private nextId = 0;
  private initialized = false;
  constructor(protected readonly config: TradingViewOAuthConfig) {
    const url = new URL(config.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !config.accessToken) throw new Error("https_oauth_mcp_configuration_required");
    if (!Array.isArray(config.allowedReadTools) || new Set(config.allowedReadTools).size !== config.allowedReadTools.length || config.allowedReadTools.some(name => !/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || WRITE_WORDS.test(name))) throw new Error("explicit_read_tool_allowlist_required");
    this.transport = config.fetch ?? fetch;
  }
  protected async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : ++this.nextId;
    const response = await this.transport(this.config.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26", ...(this.session ? { "Mcp-Session-Id": this.session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });
    if (!response.ok) throw new Error(`mcp_http_error:${response.status}`);
    const session = response.headers.get("Mcp-Session-Id"); if (session) this.session = session;
    if (notification && response.status === 202) return null;
    const body = await response.text(); if (notification && !body) return null;
    let messages: Record<string, unknown>[];
    if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
      messages = body.split(/\r?\n\r?\n/).flatMap(event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        return data ? [JSON.parse(data) as Record<string, unknown>] : [];
      });
    } else messages = [JSON.parse(body) as Record<string, unknown>];
    const message = messages.find(item => item.id === id && item.jsonrpc === "2.0");
    if (!message || message.error || !("result" in message)) throw new Error("mcp_invalid_or_error_response");
    return message.result;
  }
  async discover(): Promise<{ available: McpTool[]; allowed: McpTool[]; schemaHash: string }> {
    if (!this.initialized) {
      const result = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jev-research-desk-read-only", version: "1.0.0" } }) as Record<string, unknown>;
      if (result.protocolVersion !== "2025-03-26") throw new Error("unsupported_mcp_protocol_version");
      await this.rpc("notifications/initialized", {}, true); this.initialized = true;
    }
    this.tools.clear(); let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
      if (!Array.isArray(result.tools)) throw new Error("mcp_tool_discovery_failed");
      for (const tool of result.tools) {
        if (!tool || typeof tool.name !== "string" || this.tools.has(tool.name)) throw new Error("mcp_duplicate_or_invalid_tool");
        this.tools.set(tool.name, immutable(tool));
      }
      if (!result.nextCursor) break;
      if (seen.has(result.nextCursor) || page === 19) throw new Error("mcp_discovery_pagination_limit");
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    const available = [...this.tools.values()], allowed = available.filter(tool => this.isAllowed(tool));
    return { available, allowed, schemaHash: hash(available) };
  }
  private isAllowed(tool: McpTool): boolean {
    return this.config.allowedReadTools.includes(tool.name) && tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true && !WRITE_WORDS.test(tool.name);
  }
  async read(role: DeskRole, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!["scout", "chart", "strategist", "risk", "trader"].includes(role)) throw new Error("role_has_no_market_read_permission");
    const tool = this.tools.get(name);
    if (!this.initialized || !tool || !this.isAllowed(tool)) throw new Error("mcp_tool_not_discovered_or_not_explicitly_read_allowed");
    return this.rpc("tools/call", { name, arguments: immutable(args) });
  }
}

export type TradingViewSetupOperation = "watchlist.create" | "watchlist.update" | "alert.create" | "alert.update" | "alert.delete";
export interface TradingViewSetupConfig extends TradingViewOAuthConfig {
  enableSetupWrites: boolean;
  /** Operator-reviewed mapping from an allowed purpose to an actually discovered provider tool. */
  setupTools: Partial<Record<TradingViewSetupOperation, string>>;
  store: { load<T>(key: string): T | null | undefined; save(key: string, value: unknown): void; claim(key: string, value: unknown): boolean };
  now?: () => number;
}
export interface TradingViewSetupApproval {
  id: string; approved: true; approvedBy: string; operation: TradingViewSetupOperation;
  toolName: string; argumentsHash: string; issuedAt: number; expiresAt: number;
}
/** Separate setup capability; ordinary research role clients never receive this object. */
export class TradingViewSetupClient extends TradingViewReadClient {
  private readonly clock: () => number;
  constructor(private readonly setup: TradingViewSetupConfig) {
    super(setup); this.clock = setup.now ?? Date.now;
    if (!setup.enableSetupWrites) throw new Error("tradingview_setup_writes_not_enabled");
    for (const [operation, name] of Object.entries(setup.setupTools)) {
      if (!["watchlist.create", "watchlist.update", "alert.create", "alert.update", "alert.delete"].includes(operation) ||
          typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || /(^|[_\-.])(orders?|trade|broker|positions?|transfer|withdraw|buy|sell|execute)([_\-.]|$)/i.test(name)) throw new Error("setup_tool_must_be_watchlist_or_alert_capability");
    }
  }
  preview(operation: TradingViewSetupOperation, args: Record<string, unknown>) {
    const name = this.setup.setupTools[operation], tool = name ? this.tools.get(name) : undefined;
    if (!name || !tool) throw new Error("setup_tool_not_configured_and_discovered");
    if (tool.annotations?.readOnlyHint === true) throw new Error("setup_mapping_points_to_read_only_tool");
    return immutable({ operation, toolName: name, description: tool.description ?? "", arguments: args, argumentsHash: hash(args) });
  }
  async executeSetup(approval: TradingViewSetupApproval, args: Record<string, unknown>): Promise<unknown> {
    const preview = this.preview(approval.operation, args), now = this.clock();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(approval.id) || approval.approved !== true || !approval.approvedBy?.trim() ||
        approval.toolName !== preview.toolName || approval.argumentsHash !== preview.argumentsHash ||
        !Number.isFinite(approval.issuedAt) || !Number.isFinite(approval.expiresAt) || approval.issuedAt > now || approval.expiresAt <= now ||
        approval.expiresAt - approval.issuedAt > 15 * 60_000) throw new Error("exact_current_setup_approval_required");
    const key = `tradingview-setup:${approval.id}`, previous = this.setup.store.load<{ fingerprint: string; status: string; result?: unknown }>(key), fingerprint = hash({ approval, preview });
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("setup_approval_id_conflict");
      if (previous.status === "confirmed") return previous.result;
      throw new Error("setup_outcome_unknown_inspect_provider_do_not_replay");
    }
    if (!this.setup.store.claim(key, { fingerprint, status: "reserved", approval, preview })) throw new Error("setup_already_reserved");
    try {
      const result = await this.rpc("tools/call", { name: preview.toolName, arguments: preview.arguments });
      if (!result || typeof result !== "object" || (result as { isError?: boolean }).isError) throw new Error("setup_provider_reported_failure");
      this.setup.store.save(key, { fingerprint, status: "confirmed", result }); return result;
    } catch {
      this.setup.store.save(key, { fingerprint, status: "unknown" }); throw new Error("setup_outcome_unknown_inspect_provider_do_not_replay");
    }
  }
}
