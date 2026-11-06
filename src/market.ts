import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";
import { config } from "./config";
import { rpc } from "./chain";
import { readBook as fetchBook, readVaultParams, vaultActive, log10 } from "./book";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative MON depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

export type Side = "buy" | "sell";

/**
 * This block's order: a post-only limit order resting on Kuru's book, replacing last block's.
 * `sent` until the receipt lands, then `placed` (with its orderId) or `reverted` (the book moved
 * through the price, or a cancelled id had already filled). `lost` if no receipt ever came.
 */
export interface Quote {
  side: Side;
  price: number; // USDC per MON, tick aligned
  size: number; // MON
  txHash: string | null;
  gasMon: number; // gasLimit x gas price: Monad charges the limit, not gasUsed
  cancel: number[]; // resting order ids this tx cancels
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: number | null;
  /** The position cap or margin funds picked this side; the model's probabilities still show its call. */
  capped: boolean;
}

/** A maker fill: someone hit one of our resting orders. Arrives via the Trade log feed, not our own receipts. */
export interface Fill {
  side: Side;
  size: number; // MON
  price: number; // USDC per MON: our order's price
  txHash: string | null; // the taker's transaction
  orderId: number;
  simulated: boolean;
}

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const BN = ethers.BigNumber;
const ZERO_ADDRESS = ethers.constants.AddressZero;

/** Read-only Kuru metadata, balances and book access. External writes belong to KuruVenue. */
export class Market {
  readonly provider = new ethers.providers.StaticJsonRpcProvider({ url: config.rpcUrl, timeout: config.rpcTimeoutMs }, config.chainId);
  /** null in a dry run (no key, or DRY_RUN=true): nothing is signed, nothing is sent. */
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  params!: Kuru.MarketParams; // public so scripts can build txs without init()
  /** Margin account balances, refreshed every `config.refreshBlocks`. Limit orders draw from here. */
  margin = { mon: 0, usdc: 0 };
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private marginIface = new ethers.utils.Interface(MarginAccountAbi.abi);
  private gasLimit = BN.from(config.gasLimit ?? config.gasLimitFallback);
  private useVault = false;

  get address() { return this.wallet?.address ?? null; }
  private get priceDec() { return log10(this.params.pricePrecision); }
  private get sizeDec() { return log10(this.params.sizePrecision); }
  private get tickUnits() { return Number(this.params.tickSize.toString()); }

  async init() {
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    await this.refresh();
  }

  /** Refresh margin balances and whether the Kuru AMM vault is active. */
  async refresh() {
    const [vault, mon, usdc] = await Promise.all([
      readVaultParams(config.readRpcUrl, config.market, "latest", config.rpcTimeoutMs),
      this.wallet ? this.marginBalance(ZERO_ADDRESS) : Promise.resolve(null),
      this.wallet ? this.marginBalance(this.params.quoteAssetAddress) : Promise.resolve(null),
    ]);
    // Publish the refreshed snapshot only after every required read succeeds.
    this.useVault = vaultActive(vault);
    if (mon) this.margin.mon = Number(ethers.utils.formatUnits(mon, this.params.baseAssetDecimals.toNumber()));
    if (usdc) this.margin.usdc = Number(ethers.utils.formatUnits(usdc, this.params.quoteAssetDecimals.toNumber()));
  }

  /** One eth_call (two batched into one HTTP request once the vault is live). */
  readBook(block?: number): Promise<Book> {
    return fetchBook(config.readRpcUrl, config.market, this.params, { vault: this.useVault,
      blockTag: block === undefined ? "latest" : "0x" + block.toString(16), timeoutMs: config.rpcTimeoutMs });
  }

  /**
   * Where this block's order rests: `quoteInsideTicks` inside the touch on our side, never crossing.
   * If the spread is too tight to step inside, join the touch. Integer tick math, so the price is
   * exactly representable on-chain.
   */
  quotePrice(side: Side, book: Book): number {
    const scale = 10 ** this.priceDec, tick = this.tickUnits;
    const bidU = Math.round(book.bid * scale), askU = Math.round(book.ask * scale);
    const step = config.quoteInsideTicks * tick;
    let p = side === "buy" ? bidU + step : askU - step;
    if (side === "buy" && p >= askU) p = bidU;
    if (side === "sell" && p <= bidU) p = askU;
    return p / scale;
  }

  /** Offline encoding helper for diagnostics. This class cannot broadcast a transaction. */
  buildTx(side: Side, sizeMon: number, price: number, cancel: number[]): ethers.providers.TransactionRequest {
    return {
      type: 2, chainId: config.chainId, to: config.market, nonce: 0, gasLimit: this.gasLimit,
      maxFeePerGas: gwei(config.maxFeeGwei), maxPriorityFeePerGas: gwei(config.priorityFeeGwei),
      data: this.encode(side, sizeMon, price, cancel), value: BN.from(0),
    };
  }

  /** batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly). Funds come from the margin account, so value is 0. */
  encode(side: Side, sizeMon: number, price: number, cancel: number[]): string {
    const priceU = BN.from(Math.round(price * 10 ** this.priceDec));
    const sizeU = ethers.utils.parseUnits(sizeMon.toFixed(this.sizeDec), this.sizeDec);
    const [bp, bs, sp, ss] = side === "buy" ? [[priceU], [sizeU], [], []] : [[], [], [priceU], [sizeU]];
    return this.iface.encodeFunctionData("batchUpdate", [bp, bs, sp, ss, cancel.map((id) => BN.from(id)), true]);
  }

  private async marginBalance(token: string): Promise<ethers.BigNumber> {
    const data = this.marginIface.encodeFunctionData("getBalance", [this.wallet!.address, token]);
    const res = await rpc<string>("eth_call", [{ to: config.marginAccount, data }, "latest"], config.readRpcUrl);
    return BN.from(res);
  }

}
