// Prove the hand-encoded batchUpdate calldata round-trips through the Kuru ABI and that quote prices
// are tick aligned and never cross, without sending anything. Builds + signs a bid and an ask with a
// random wallet and decodes the calldata back.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run scripts/dry-encode.ts [rpcUrl]
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";

// A disconnected throwaway wallet signs diagnostics locally; application live mode stays off.
const offlineWallet = ethers.Wallet.createRandom();
process.env.MODE = "paper";
process.env.DRY_RUN = "true";
const { config } = await import("../src/config");
const { Market } = await import("../src/market");

const RPC = process.argv[2] ?? config.readRpcUrl;
const provider = new ethers.providers.StaticJsonRpcProvider(RPC, config.chainId);
const iface = new ethers.utils.Interface(OrderBookAbi.abi);

const market = new Market();
market.params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
const book = await market.readBook();
const size = config.tradeSizeMon;
const priceDec = market.params.pricePrecision.toString().length - 1, sizeDec = market.params.sizePrecision.toString().length - 1;
const tick = Number(market.params.tickSize.toString());
console.log(`market ${config.market} · block ${book.block} · bid ${book.bid} ask ${book.ask} · tick ${tick / 10 ** priceDec} · size ${size} MON · ${config.quoteInsideTicks} tick inside`);
console.log(`wallet ${offlineWallet.address} (random, unfunded)\n`);

let failed = false;
const check = (label: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failed = true; };
for (const side of ["buy", "sell"] as const) {
  const price = market.quotePrice(side, book);
  const cancel = [123, 456];
  const tx = market.buildTx(side, size, price, cancel);
  const signed = await offlineWallet.signTransaction(tx);
  const parsed = ethers.utils.parseTransaction(signed);
  const d = iface.decodeFunctionData("batchUpdate", parsed.data);
  // ethers decodes uint32 as number and uint96/uint40 as BigNumber; normalise everything to BigNumber.
  const bn = (xs: unknown[]) => xs.map((x) => ethers.BigNumber.from(x as ethers.BigNumberish));
  const [bp, bs, sp, ss, ids] = [bn(d[0]), bn(d[1]), bn(d[2]), bn(d[3]), bn(d[4])];
  const postOnly = d[5] as boolean;
  const prices = side === "buy" ? bp : sp, sizes = side === "buy" ? bs : ss, otherPrices = side === "buy" ? sp : bp;
  console.log(`${side}: price ${price} → ${prices.map(String)} units · size ${sizes.map(String)} · cancel ${ids.map(String)} · postOnly ${postOnly}`);
  check(`${side} one order on our side, none on the other`, prices.length === 1 && otherPrices.length === 0);
  check(`${side} price is on a tick`, prices[0]!.mod(tick).isZero());
  check(`${side} price is ${price}`, prices[0]!.eq(Math.round(price * 10 ** priceDec)));
  check(`${side} does not cross`, side === "buy" ? price < book.ask : price > book.bid);
  check(`${side} is at or inside the touch`, side === "buy" ? price >= book.bid : price <= book.ask);
  check(`${side} size is ${size} MON`, sizes[0]!.eq(ethers.utils.parseUnits(String(size), sizeDec)));
  check(`${side} cancels ${cancel}`, ids.length === 2 && ids[0]!.eq(123) && ids[1]!.eq(456));
  check(`${side} post only`, postOnly === true);
  check(`${side} value is 0 (margin funded)`, parsed.value.isZero());
  check(`${side} type-2 to the market`, parsed.type === 2 && parsed.to?.toLowerCase() === config.market.toLowerCase());
  console.log();
}
console.log(failed ? "MISMATCH" : "all checks passed");
process.exit(failed ? 1 : 0);
