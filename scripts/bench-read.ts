// Compare src/book.ts readBook against Kuru.OrderBook.getFormattedL2OrderBook: exactness and latency.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run scripts/bench-read.ts [rpcUrl] [reads]
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { readBook, buildBook, abiBytesPayload, decodeVaultParams, readVaultParams, vaultActive, SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS } from "../src/book";
import type { Book } from "../src/market";

const RPC = process.argv[2] ?? "https://rpc.monad.xyz";
const N = Number(process.argv[3] ?? 10);
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 143);
const params = await Kuru.ParamFetcher.getMarketParams(provider, MARKET);

// Same reduction market.ts applies to the SDK book.
type ComparableBook = Pick<Book, "block" | "bid" | "ask" | "mid" | "spreadBps" | "imbalance">;
function sdkToBook(b: Awaited<ReturnType<typeof Kuru.OrderBook.getFormattedL2OrderBook>>): ComparableBook {
  const ask = b.asks.at(-1)![0]!, bid = b.bids[0]![0]!, mid = (bid + ask) / 2;
  const near = (levels: number[][]) => levels.filter((l) => Math.abs(l[0]! - mid) / mid < 0.01).reduce((s, l) => s + l[1]!, 0);
  const bd = near(b.bids), ad = near(b.asks);
  return { block: b.blockNumber, bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10_000, imbalance: bd + ad ? (bd - ad) / (bd + ad) : 0 };
}
const same = (a: ComparableBook, b: ComparableBook) => a.block === b.block && a.bid === b.bid && a.ask === b.ask && a.mid === b.mid && a.spreadBps === b.spreadBps && a.imbalance === b.imbalance;
const fmt = (b: ComparableBook) => `blk=${b.block} bid=${b.bid} ask=${b.ask} mid=${b.mid} spr=${b.spreadBps.toFixed(3)} imb=${b.imbalance.toFixed(6)}`;
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return `min=${s[0]!.toFixed(0)} p50=${s[s.length >> 1]!.toFixed(0)} mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)} max=${s.at(-1)!.toFixed(0)} ms`; };

const vp = await readVaultParams(provider, MARKET);
console.log("vault:", vp.kuruAmmVault, "bidSize", vp.vaultBidOrderSize, "askSize", vp.vaultAskOrderSize, "active:", vaultActive(vp));

// ---- 1. Live interleaved reads: latency, and equality when both land on the same block ----
console.log(`\n== live interleaved reads x${N} (mine -> sdk -> mine+vault batch)`);
await readBook(provider, MARKET, params); await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params); // warm-up (TLS/keepalive)
const tMine: number[] = [], tSdk: number[] = [], tBatch: number[] = [];
let sameBlock = 0, matched = 0;
for (let i = 0; i < N; i++) {
  let t = performance.now(); const mine = await readBook(provider, MARKET, params); tMine.push(performance.now() - t);
  t = performance.now(); const sdk = sdkToBook(await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params)); tSdk.push(performance.now() - t);
  t = performance.now(); const batch = await readBook(provider, MARKET, params, { vault: true }); tBatch.push(performance.now() - t);
  const cmp = mine.block === sdk.block ? (same(mine, sdk) ? "MATCH" : "DIFF!") : "(different block)";
  if (mine.block === sdk.block) { sameBlock++; if (same(mine, sdk)) matched++; }
  console.log(`#${i} mine ${tMine.at(-1)!.toFixed(0)}ms | sdk ${tSdk.at(-1)!.toFixed(0)}ms | batch ${tBatch.at(-1)!.toFixed(0)}ms  ${cmp}\n   mine ${fmt(mine)}\n   sdk  ${fmt(sdk)}`);
}
console.log(`same-block pairs: ${sameBlock}/${N}, exact matches among them: ${matched}`);
console.log(`latency mine (1 eth_call):        ${stats(tMine)}`);
console.log(`latency sdk  (2 sequential calls): ${stats(tSdk)}`);
console.log(`latency mine vault batch (1 http): ${stats(tBatch)}`);

// ---- 2. Deterministic: feed identical raw bytes to both decoders ----
console.log(`\n== deterministic: same raw getL2Book bytes -> SDK (l2Book+contractVaultParams injected, 0 RPC) vs buildBook`);
const post = async (data: string): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    const j = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MARKET, data }, "latest"] }) })).json()) as any;
    if (j?.result) return j.result;
    console.log(`   (rpc returned no result: ${JSON.stringify(j?.error ?? j).slice(0, 100)}; retry ${attempt + 1})`);
    if (attempt >= 5) throw new Error("rpc failed 6x");
    await new Promise((r) => setTimeout(r, 500)); // public RPC: 50 req/s limit (-32007)
  }
};
const iface = new ethers.utils.Interface((await import("@kuru-labs/kuru-sdk/abi/OrderBook.json")).abi);
let ok = 0;
for (let i = 0; i < N; i++) {
  await new Promise((r) => setTimeout(r, 150)); // pace: public RPC 50 req/s
  const l2Raw = await post(SEL_GET_L2_BOOK);
  const vRaw = await post(SEL_GET_VAULT_PARAMS);
  const vArr = iface.decodeFunctionResult("getVaultParams", vRaw);
  const sdk = sdkToBook(await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params, abiBytesPayload(l2Raw), vArr));
  const mine = buildBook(l2Raw, params, decodeVaultParams(vRaw));
  const mineNoVault = buildBook(l2Raw, params);
  const r = same(mine, sdk) && same(mineNoVault, sdk); if (r) ok++;
  console.log(`#${i} ${r ? "MATCH" : "DIFF!"} ${fmt(mine)}${r ? "" : "\n   sdk " + fmt(sdk)}`);
}
console.log(`deterministic exact matches: ${ok}/${N}`);

// ---- 3. Synthetic ACTIVE vault: does my AMM ladder merge match the SDK's? ----
console.log(`\n== synthetic active vault (sizes>0) merged into a real book`);
const l2Raw = await post(SEL_GET_L2_BOOK);
const base = buildBook(l2Raw, params);
const fake = [
  "0x838c2d3fD4DB5eB2F185cbE7697fbaAce52b34d7",
  ethers.utils.parseUnits((base.bid * 1.0002).toFixed(18), 18), // vault best bid slightly inside the book
  ethers.BigNumber.from(0),
  ethers.utils.parseUnits((base.ask * 0.9998).toFixed(18), 18),
  ethers.BigNumber.from("123456789"),
  ethers.BigNumber.from("5000000000000"), // vaultBidOrderSize (sizePrecision units)
  ethers.BigNumber.from("4800000000000"),
  ethers.BigNumber.from(30),
];
const fakeHex = iface.encodeFunctionResult("getVaultParams", fake);
const sdkV = sdkToBook(await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params, abiBytesPayload(l2Raw), fake));
const mineV = buildBook(l2Raw, params, decodeVaultParams(fakeHex));
console.log(same(mineV, sdkV) ? "MATCH" : "DIFF!", "\n   mine", fmt(mineV), "\n   sdk ", fmt(sdkV), "\n   (no vault)", fmt(base));
