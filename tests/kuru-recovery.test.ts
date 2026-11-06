import { afterEach, describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { loadConfig } from "../src/config";
import { KuruSource, KuruVenue } from "../src/execution/kuru";
import type { ExecutionIntent, ExecutionUpdate, RestingOrder } from "../src/execution/types";
import type { Book, Market } from "../src/market";

const iface = new ethers.utils.Interface(OrderBookAbi.abi);
const OWNER = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const TX = `0x${"a".repeat(64)}`, BLOCK = 2;
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
interface RawLog { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string; removed?: boolean }
function book(): Book {
  return { block: BLOCK, bid: .02, ask: .02002, mid: .02001, spreadBps: 10, imbalance: 0,
    levels: { bids: [[.02, 2000]], asks: [[.02002, 2000]] }, depthBps: { "10": { bid: 2000, ask: 2000 } } };
}
function fixture(changes: Partial<ExecutionIntent> = {}) {
  const cfg = loadConfig({ RECONCILE_FROM_BLOCK: "1", MAX_RECONCILE_BLOCKS: "1000" });
  const market = { wallet: {}, address: OWNER, params: {
    pricePrecision: ethers.BigNumber.from(1_000_000), sizePrecision: ethers.BigNumber.from(1000),
    tickSize: ethers.BigNumber.from(1), minSize: ethers.BigNumber.from(200_000),
    baseAssetDecimals: ethers.BigNumber.from(18), quoteAssetDecimals: ethers.BigNumber.from(6),
    makerFeeBps: ethers.BigNumber.from(0), takerFeeBps: ethers.BigNumber.from(0),
  }, margin: { mon: 1000, usdc: 100 }, refresh: async () => {}, readBook: async () => book() } as unknown as Market;
  const source = new KuruSource(market, cfg), venue = new KuruVenue(source, cfg);
  const intent: ExecutionIntent = { operationId: "recovery-test", sessionId: "test-session", snapshotId: "test-snapshot", block: 1,
    createdAtMs: Date.now() - 100, deadlineMs: Date.now() + 1000, orders: [{ side: "sell", price: .0199, size: 400 }], cancelIds: [],
    postOnly: false, reduceOnly: true, ...changes };
  const pending: ExecutionUpdate = { operationId: intent.operationId, block: 1, status: "unknown", txHash: TX, orders: [], canceledIds: [], gasMon: 0, gasUsd: 0, intent };
  venue.restore([pending], []);
  return { cfg, source, venue, intent, pending };
}
type Fixture = ReturnType<typeof fixture>;
function log(f: Fixture, name: "Trade" | "OrderCreated" | "OrdersCanceled", args: any[], index: number): RawLog {
  return { address: f.cfg.market, ...iface.encodeEventLog(iface.getEvent(name), args), transactionHash: TX, blockNumber: "0x2", logIndex: `0x${index.toString(16)}` };
}
function trade(f: Fixture, size = 400, isBuy = false, index = 0, maker = OTHER, taker = OWNER, price = .02): RawLog {
  return log(f, "Trade", [900 + index, maker, isBuy, ethers.utils.parseUnits(String(price), 18), 0, taker, OWNER, Math.round(size * 1000)], index);
}
function created(f: Fixture, size = 200, side: "buy" | "sell" = "sell", index = 1): RawLog {
  return log(f, "OrderCreated", [777, OWNER, Math.round(size * 1000), 19_900, side === "buy"], index);
}
function rpcFixture(f: Fixture, logs: RawLog[], states: Record<string, { size: number; side?: "buy" | "sell"; owner?: string; price?: number }> = {}) {
  const calls: { method: string; params: any[] }[] = [];
  const response = (request: { id: number; method: string; params: any[] }) => {
    calls.push(request);
    let result: unknown;
    switch (request.method) {
      case "eth_getTransactionReceipt": result = { transactionHash: TX, status: "0x1", blockNumber: "0x2", effectiveGasPrice: "0x1", gasUsed: "0x10000", logs }; break;
      case "eth_call": {
        const transaction = iface.parseTransaction({ data: request.params[0].data });
        if (transaction.name !== "s_orders") throw new Error(`Unexpected test read: ${transaction.name}`);
        const id = transaction.args[0].toString(), state = states[id];
        if (!state) throw new Error(`Missing test order state: ${id}`);
        result = iface.encodeFunctionResult("s_orders", [state.owner ?? OWNER, Math.round(state.size * 1000), 0, 0, 0,
          Math.round((state.price ?? .0199) * 1_000_000), 0, state.side === "buy"]); break;
      }
      case "eth_getLogs": {
        const from = parseInt(request.params[0].fromBlock, 16), to = parseInt(request.params[0].toBlock, 16);
        result = logs.filter(item => parseInt(item.blockNumber, 16) >= from && parseInt(item.blockNumber, 16) <= to); break;
      }
      case "eth_getBlockByNumber": result = { number: request.params[0], timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${"b".repeat(64)}` }; break;
      case "eth_blockNumber": result = "0x2"; break;
      case "eth_getTransactionCount": result = "0x0"; break;
      default: throw new Error(`Forbidden test RPC, especially writes: ${request.method}`);
    }
    return { jsonrpc: "2.0", id: request.id, result };
  };
  globalThis.fetch = (async (_url: any, init: any) => {
    const request = JSON.parse(String(init?.body));
    return Response.json(Array.isArray(request) ? request.map(response) : response(request));
  }) as unknown as typeof fetch;
  return calls;
}

describe("Kuru aggressive recovery receipt reconciliation", () => {
  test("a fully filled taker exit confirms without an OrderCreated event or residual order", async () => {
    const f = fixture(), calls = rpcFixture(f, [trade(f)]);
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("confirmed"); expect(update?.orders).toEqual([]);
    expect(update?.fills).toHaveLength(1);
    expect(update?.fills?.[0]).toMatchObject({ id: `${TX}:0x0:taker`, side: "sell", size: 400, price: .02, feeUsd: 0, simulated: false });
    expect(await f.venue.poll(BLOCK + 1)).toEqual([]);
    expect(calls.every(call => call.method !== "eth_sendRawTransaction")).toBe(true);
  });

  test("a partial taker exit confirms only the exact filled size plus created residual", async () => {
    const f = fixture(); rpcFixture(f, [trade(f, 200), created(f, 200)], { "777": { size: 200 } });
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("confirmed");
    expect(update?.orders).toHaveLength(1); expect(update?.orders[0]).toMatchObject({ id: "777", side: "sell", size: 200, price: .0199 });
    expect(update?.fills?.[0]).toMatchObject({ side: "sell", size: 200 });
    expect((update?.orders[0]?.size ?? 0) + (update?.fills?.[0]?.size ?? 0)).toBe(f.intent.orders[0]!.size);
  });

  test("a buy recovery uses the taker direction and stays at or inside its limit", async () => {
    const f = fixture({ orders: [{ side: "buy", price: .0201, size: 400 }] }); rpcFixture(f, [trade(f, 400, true)]);
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("confirmed"); expect(update?.fills?.[0]).toMatchObject({ side: "buy", size: 400, price: .02 });
  });

  test("a cancellation raced by an existing order fill resolves only after zero on-chain size", async () => {
    const f = fixture({ orders: [], cancelIds: ["71"], postOnly: true, reduceOnly: false });
    const order: RestingOrder = { id: "71", operationId: "old", side: "sell", price: .0199, size: 200, createdAtMs: 1, block: 1, queueAhead: 0 };
    f.venue.restore([f.pending], [order]);
    const calls = rpcFixture(f, [log(f, "OrdersCanceled", [[0], OWNER], 0)], { "71": { size: 0, owner: ethers.constants.AddressZero } });
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("confirmed"); expect(update?.canceledIds).toEqual(["71"]);
    expect(calls.some(call => call.method === "eth_call")).toBe(true);
    expect(await f.venue.poll(BLOCK + 1)).toEqual([]);
  });

  test("a missing cancellation event cannot release a still-open order", async () => {
    const f = fixture({ orders: [], cancelIds: ["71"], postOnly: true, reduceOnly: false });
    rpcFixture(f, [], { "71": { size: 200 } });
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("unknown"); expect(update?.intent.cancelIds).toEqual(["71"]);
  });

  const invalid = [
    { name: "wrong taker side", logs: (f: Fixture) => [trade(f, 400, true)] },
    { name: "taker overfill", logs: (f: Fixture) => [trade(f, 401)] },
    { name: "oversized created residual", logs: (f: Fixture) => [trade(f, 200), created(f, 201)] },
    { name: "wrong residual side", logs: (f: Fixture) => [trade(f, 200), created(f, 200, "buy")] },
    { name: "fill beyond the approved limit", logs: (f: Fixture) => [trade(f, 400, false, 0, OTHER, OWNER, .0198)] },
    { name: "unexplained missing effects", logs: (_f: Fixture) => [] },
  ];
  for (const variant of invalid) test(`${variant.name} stays unknown and retains the original intent`, async () => {
    const f = fixture(); rpcFixture(f, variant.logs(f));
    const [update] = await f.venue.poll(BLOCK);
    expect(update?.status).toBe("unknown"); expect(update?.reason).toBe("receipt_effects_mismatch");
    expect(update?.intent).toEqual(f.intent);
    await expect(f.venue.submit({ ...f.intent, operationId: "no-second-broadcast" }, book(), { beforeBroadcast: () => { throw new Error("Unexpected broadcast"); }, stillValid: () => true })).rejects.toThrow("Unresolved transaction");
  });

  test("a restored aggressive order without reduceOnly authority cannot be confirmed", async () => {
    const f = fixture({ reduceOnly: false }); rpcFixture(f, [trade(f)]);
    expect((await f.venue.poll(BLOCK))[0]?.status).toBe("unknown");
  });

  test("receipt, first source poll and restart reconciliation preserve distinct maker and taker identities", async () => {
    const f = fixture();
    // A self-match has two account legs. It must neither collapse them nor double-book a role.
    const logs = [trade(f, 100, false, 0, OWNER, OWNER), trade(f, 300, false, 1)];
    rpcFixture(f, logs);
    const [receipt] = await f.venue.poll(BLOCK);
    expect(receipt?.status).toBe("confirmed");
    const expected = [`${TX}:0x0`, `${TX}:0x0:taker`, `${TX}:0x1:taker`].sort();
    expect(receipt?.fills?.map(fill => fill.id).sort()).toEqual(expected);
    const firstFrame = await f.source.read(BLOCK);
    expect(firstFrame.fills.map(fill => fill.id).sort()).toEqual(expected);
    expect(firstFrame.fills.filter(fill => fill.side === "buy")).toHaveLength(1);
    expect(firstFrame.fills.filter(fill => fill.side === "sell")).toHaveLength(2);
    expect((await f.source.read(BLOCK)).fills).toEqual([]);
    const restarted = new KuruVenue(f.source, f.cfg);
    const reconciled = await restarted.reconcile();
    expect(reconciled.fills?.map(fill => fill.id).sort()).toEqual(expected);
    expect(reconciled.openOrders).toEqual([]);
  });
});
