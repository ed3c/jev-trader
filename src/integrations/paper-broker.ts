import { hash, immutable, validatePlan, verifyEvidence } from "../desk/evidence";
import { DeskJournal } from "../desk/journal";
import type { BracketRequest, BrokerOrder, DeskBroker, DeskPosition, EmergencyResult, Evidence, Quote, RiskSnapshot } from "../desk/types";

interface LocalAccount {
  initialEquity: number; dayStartEquity: number; day: string; cash: number; realizedPnl: number; lossStreak: number;
  positions: (DeskPosition & { entry: number; target: number; clientOrderId: string })[];
}
/** A deterministic simulator: fills occur only against supplied, timestamped quotes. */
export class LocalPaperBroker implements DeskBroker {
  readonly mode = "local-paper" as const;
  private quotes = new Map<string, Evidence<Quote>>();
  constructor(private readonly journal: DeskJournal, capital = 10_000, private readonly clock: () => number = Date.now) {
    if (!Number.isFinite(capital) || capital <= 0) throw new Error("invalid_paper_capital");
    if (!journal.load("paper:account")) journal.save("paper:account", { initialEquity: capital, dayStartEquity: capital, day: this.day(), cash: capital, realizedPnl: 0, lossStreak: 0, positions: [] } satisfies LocalAccount);
  }
  private day(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(this.clock()); }
  private account(): LocalAccount {
    let account = this.journal.load<LocalAccount>("paper:account")!;
    if (account.day !== this.day()) { account = { ...account, day: this.day(), dayStartEquity: account.cash + account.positions.reduce((sum, item) => sum + item.marketPrice * item.quantity, 0) }; this.journal.save("paper:account", account); }
    return account;
  }
  private orders(): string[] { return this.journal.load<string[]>("paper:order-ids") ?? []; }
  async submitBracket(request: BracketRequest): Promise<BrokerOrder> {
    validatePlan(request.plan);
    if (request.approval.expiresAt <= this.clock() || request.approval.approvedAt > this.clock()) throw new Error("paper_approval_expired");
    if (request.planHash !== hash(request.plan) || request.approval.planHash !== request.planHash || request.approval.mode !== "paper") throw new Error("paper_plan_approval_mismatch");
    const prior = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${request.clientOrderId}`);
    if (prior) { if (hash(prior.request) !== hash(request)) throw new Error("paper_client_id_conflict"); return prior.order; }
    const quote = this.quotes.get(request.plan.symbol), account = this.account();
    const reserved = this.orders().reduce((sum, id) => { const item = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${id}`)!; return sum + (item.order.status === "accepted" ? item.request.plan.entry * item.request.plan.quantity : 0); }, 0);
    if (account.cash - reserved < request.plan.entry * request.plan.quantity) throw new Error("paper_insufficient_cash");
    if (quote) verifyEvidence(quote, this.clock(), 60_000);
    const fill = quote && quote.payload.ask <= request.plan.entry && quote.payload.ask > request.plan.stop;
    const order: BrokerOrder = { id: `paper-${request.clientOrderId}`, clientOrderId: request.clientOrderId, planHash: request.planHash, symbol: request.plan.symbol,
      status: fill ? "filled" : "accepted", filledQuantity: fill ? request.plan.quantity : 0, filledPrice: fill ? quote.payload.ask : null, bracketProtected: true };
    this.journal.atomic(() => {
      if (!this.journal.claim(`paper:order:${request.clientOrderId}`, { request, order })) throw new Error("paper_concurrent_order_conflict");
      this.journal.save("paper:order-ids", [...this.orders(), request.clientOrderId]);
      if (fill) {
        this.journal.save("paper:account", { ...account, cash: account.cash - quote.payload.ask * request.plan.quantity,
          positions: [...account.positions, { symbol: request.plan.symbol, quantity: request.plan.quantity, marketPrice: quote.payload.bid,
            entry: quote.payload.ask, stop: request.plan.stop, target: request.plan.target, clientOrderId: request.clientOrderId, correlationGroup: "demo-unclassified" }] });
      }
      this.journal.append("paper_order", { request, order, simulation: true }, `paper:${request.clientOrderId}:submitted`, quote?.observedAt ?? request.approval.approvedAt);
    });
    return immutable(order);
  }
  async findOrder(clientOrderId: string): Promise<BrokerOrder | null> { return this.journal.load<{ order: BrokerOrder }>(`paper:order:${clientOrderId}`)?.order ?? null; }
  /** Processes entry limits and protective OCO exits; a gap through a stop fills at the available bid. */
  mark(quote: Evidence<Quote>): void {
    verifyEvidence(quote, this.clock(), 60_000);
    if (!Number.isFinite(quote.payload.bid) || quote.payload.bid <= 0 || quote.payload.ask < quote.payload.bid) throw new Error("invalid_paper_quote");
    const previous = this.journal.load<number>(`paper:quote-watermark:${quote.payload.symbol}`);
    if (previous !== null && quote.observedAt < previous) throw new Error("out_of_order_paper_quote");
    this.quotes.set(quote.payload.symbol, immutable(quote));
    this.journal.atomic(() => {
      this.journal.save(`paper:quote-watermark:${quote.payload.symbol}`, quote.observedAt);
      let account = this.account();
      if (account.day !== this.day()) account = { ...account, day: this.day(), dayStartEquity: account.cash + account.positions.reduce((sum, item) => sum + item.marketPrice * item.quantity, 0) };
      for (const id of this.orders()) {
        const stored = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${id}`)!;
        const { request, order } = stored, plan = request.plan;
        if (order.symbol !== quote.payload.symbol) continue;
        if (order.status === "accepted" && quote.observedAt >= request.approval.expiresAt) {
          this.journal.save(`paper:order:${id}`, { request, order: { ...order, status: "cancelled", reason: "entry_approval_expired" } }); continue;
        }
        if (order.status === "accepted" && quote.payload.ask <= plan.entry) {
          // An unfilled entry expires with its original approval. A gap below the stop cancels it.
          if (quote.observedAt >= request.approval.expiresAt || quote.payload.ask <= plan.stop) {
            const cancelled: BrokerOrder = { ...order, status: "cancelled", reason: "entry_expired_or_gapped_through_stop" };
            this.journal.save(`paper:order:${id}`, { request, order: cancelled }); continue;
          }
          if (account.cash < quote.payload.ask * plan.quantity) throw new Error("paper_cash_changed");
          account = { ...account, cash: account.cash - quote.payload.ask * plan.quantity,
            positions: [...account.positions, { symbol: plan.symbol, quantity: plan.quantity, marketPrice: quote.payload.bid, stop: plan.stop,
              entry: quote.payload.ask, target: plan.target, clientOrderId: id, correlationGroup: "demo-unclassified" }] };
          this.journal.save(`paper:order:${id}`, { request, order: { ...order, status: "filled", filledQuantity: plan.quantity, filledPrice: quote.payload.ask } });
          this.journal.append("paper_fill", { clientOrderId: id, price: quote.payload.ask, quantity: plan.quantity }, `${id}:entry-fill`, quote.observedAt);
        }
      }
      const remaining: LocalAccount["positions"] = [];
      for (const position of account.positions) {
        if (position.symbol !== quote.payload.symbol) { remaining.push(position); continue; }
        if (quote.payload.bid <= position.stop! || quote.payload.bid >= position.target) {
          const price = quote.payload.bid, pnl = (price - position.entry) * position.quantity;
          account = { ...account, cash: account.cash + price * position.quantity, realizedPnl: account.realizedPnl + pnl, lossStreak: pnl < 0 ? account.lossStreak + 1 : 0 };
          const stored = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${position.clientOrderId}`)!;
          this.journal.save(`paper:order:${position.clientOrderId}`, { ...stored, order: { ...stored.order, status: "closed", reason: quote.payload.bid <= position.stop! ? "protective_stop" : "profit_target" } });
          this.journal.append("paper_exit", { clientOrderId: position.clientOrderId, price, quantity: position.quantity, pnl, simulation: true }, `${position.clientOrderId}:exit`, quote.observedAt);
        } else remaining.push({ ...position, marketPrice: quote.payload.bid });
      }
      this.journal.save("paper:account", { ...account, positions: remaining });
    });
  }
  snapshot(): Pick<RiskSnapshot, "equity" | "cash" | "dayStartEquity" | "lossStreak" | "positions" | "openOrders"> {
    const account = this.account();
    return { equity: account.cash + account.positions.reduce((sum, item) => sum + item.marketPrice * item.quantity, 0), cash: account.cash,
      dayStartEquity: account.dayStartEquity, lossStreak: account.lossStreak, positions: account.positions,
      openOrders: this.orders().flatMap(id => { const stored = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${id}`)!;
        return stored.order.status === "accepted" ? [{ symbol: stored.request.plan.symbol, quantity: stored.request.plan.quantity, entry: stored.request.plan.entry, stop: stored.request.plan.stop, correlationGroup: "demo-unclassified" }] : []; }) };
  }
  async readAccountRisk() { return this.snapshot(); }
  async emergencyFlatten(): Promise<EmergencyResult> {
    let account = this.account();
    const unresolved: LocalAccount["positions"] = [];
    this.journal.atomic(() => {
      for (const id of this.orders()) {
        const stored = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${id}`)!;
        if (stored.order.status === "accepted") this.journal.save(`paper:order:${id}`, { ...stored, order: { ...stored.order, status: "cancelled", reason: "kill_switch" } });
      }
      for (const position of account.positions) {
        const quote = this.quotes.get(position.symbol);
        if (!quote || this.clock() - quote.observedAt > 60_000 || quote.observedAt > this.clock()) { unresolved.push(position); continue; }
        const pnl = (quote.payload.bid - position.entry) * position.quantity;
        account = { ...account, cash: account.cash + quote.payload.bid * position.quantity, realizedPnl: account.realizedPnl + pnl, lossStreak: pnl < 0 ? account.lossStreak + 1 : 0 };
        const stored = this.journal.load<{ request: BracketRequest; order: BrokerOrder }>(`paper:order:${position.clientOrderId}`)!;
        this.journal.save(`paper:order:${position.clientOrderId}`, { ...stored, order: { ...stored.order, status: "closed", reason: "kill_switch" } });
        this.journal.append("paper_emergency_exit", { clientOrderId: position.clientOrderId, price: quote.payload.bid, pnl }, `${position.clientOrderId}:emergency-exit`, quote.observedAt);
      }
      this.journal.save("paper:account", { ...account, positions: unresolved });
    });
    return { confirmed: unresolved.length === 0, openOrders: 0, openPositions: unresolved.length, ...(unresolved.length ? { reason: "missing_quote_cannot_assume_flat" } : {}) };
  }
}
