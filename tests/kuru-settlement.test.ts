import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { settleKuruFills, type KuruSettlementInput, type KuruSettlementParams } from "../src/execution/kuru-settlement";

const params: KuruSettlementParams = { sizePrecision: 1_000_000, pricePrecision: 100_000, baseAssetDecimals: 18, quoteAssetDecimals: 6, makerFeeBps: 5, takerFeeBps: 10 };
function fill(input: Partial<KuruSettlementInput> = {}): KuruSettlementInput {
  return { id: "0xabc:0x1", orderId: "42", side: "sell", price: 2, size: 10, block: 100, ts: 100_000, txHash: "0xabc", liquidity: "maker", nativeOrderId: "42", ...input };
}
describe("Kuru token-currency fee settlement", () => {
  test("maker sell rebate returns base inventory and reports negative fee value", () => {
    const [result] = settleKuruFills([fill()], params);
    expect(result!.size).toBe(10); expect(result!.baseAdjustment).toBe(.005);
    expect(result!.feeUsd).toBe(-.01); expect(result!.side).toBe("sell"); expect(result!.id).toBe("0xabc:0x1");
  });
  test("maker buy rebate is quote; it does not add base inventory", () => {
    const [result] = settleKuruFills([fill({ side: "buy" })], params);
    expect(result!.feeUsd).toBe(-.01); expect(result!.baseAdjustment).toBeUndefined();
    expect(result!.size).toBe(10);
  });
  test("taker buy fee is base and its gross fill size remains unchanged", () => {
    const [result] = settleKuruFills([fill({ side: "buy", liquidity: "taker", orderId: "taker:0xabc:0x1" })], params);
    expect(result!.baseAdjustment).toBe(-.01); expect(result!.feeUsd).toBe(.02);
    expect(result!.size).toBe(10); expect(result!.id).toBe("0xabc:0x1:taker"); expect(result!.orderId).toBe("taker:0xabc:0x1");
  });
  test("taker sell charges quote once on aggregate and never adjusts base beyond gross size", () => {
    const rows = [fill({ id: "0xabc:0x2:taker", liquidity: "taker", size: 4 }), fill({ id: "0xabc:0x1:taker", liquidity: "taker", size: 6 })];
    const result = settleKuruFills(rows, params);
    expect(result.map(r => r.id)).toEqual(rows.map(r => r.id));
    expect(result[0]!.feeUsd).toBe(.008); expect(result[1]!.feeUsd).toBe(.012);
    expect(result.every(r => r.baseAdjustment === undefined)).toBeTrue();
    const reversed = settleKuruFills([...rows].reverse(), params);
    expect([...result].sort((a, b) => a.id.localeCompare(b.id))).toEqual(reversed.sort((a, b) => a.id.localeCompare(b.id)));
  });
  test("taker fee rounds up once, maker rebate down; small amounts are not guessed zero", () => {
    const tinyParams = { ...params, baseAssetDecimals: 6, makerFeeBps: 1, takerFeeBps: 1 };
    const tiny = fill({ size: .000001, price: 1 });
    expect(settleKuruFills([tiny], tinyParams)[0]!.baseAdjustment).toBe(0);
    const takers = [fill({ ...tiny, id: "a", liquidity: "taker", side: "buy" }), fill({ ...tiny, id: "b", liquidity: "taker", side: "buy" })];
    const settled = settleKuruFills(takers, tinyParams);
    expect(settled[0]!.baseAdjustment).toBe(-.000001);
    expect(settled[1]!.baseAdjustment).toBeUndefined();
    expect(settled.reduce((sum, item) => sum + item.feeUsd, 0)).toBe(.000001);
  });
  test("taker sell sums book fills at each price before integer division", () => {
    const p = { ...params, pricePrecision: 100, quoteAssetDecimals: 2, makerFeeBps: 0, takerFeeBps: 4000 };
    const small = [fill({ id: "a", liquidity: "taker", size: .0001, price: 50 }), fill({ id: "b", liquidity: "taker", size: .0001, price: 50 }), fill({ id: "c", liquidity: "taker", size: .0004, price: 50 })];
    // The first two fills are half a cent each, the third two cents. The price-point
    // credit is three cents; 40% rounds up to two. Rounding each fill prematurely
    // would incorrectly give a one-cent fee. Only the largest fill can hold it.
    const result = settleKuruFills(small, p);
    expect(result.reduce((sum, item) => sum + item.feeUsd, 0)).toBe(.02);
    expect(result.map(item => item.feeUsd)).toEqual([0, 0, .02]);
  });
  test("vault and book taker sell credits use their distinct precision conversions", () => {
    const vault = fill({ liquidity: "taker", nativeOrderId: "0", price: 1.2345678912345678, rawPrice: "1234567891234567800", size: 2, rawSize: "2000000" });
    const book = fill({ id: "0xabc:0x2", liquidity: "taker", size: 3, price: 2 });
    const result = settleKuruFills([vault, book], params);
    // floor(vault credit)=2.469135; book credit=6; ceil(8.469135*.001,6dp).
    expect(result.reduce((sum, item) => sum + item.feeUsd, 0)).toBeCloseTo(.00847, 12);
    expect(result[0]!.feeUsd).toBe(.002469); expect(result[1]!.feeUsd).toBe(.006001);
  });
  test("same event can have distinct maker and taker roles without double-suffixing", () => {
    const result = settleKuruFills([fill(), fill({ id: "0xabc:0x1:taker", side: "buy", liquidity: "taker", orderId: "taker:0xabc:0x1" })], params);
    expect(result.map(f => f.id)).toEqual(["0xabc:0x1", "0xabc:0x1:taker"]);
    expect(result.reduce((sum, f) => sum + (f.side === "buy" ? f.size : -f.size) + (f.baseAdjustment ?? 0), 0)).toBeCloseTo(-.005, 12);
  });
  test("raw integers bind displayed values and BigNumber-like market params are accepted", () => {
    const toString = () => "1000000";
    expect(settleKuruFills([fill({ rawSize: "10000000", rawPrice: "2000000000000000000" })], { ...params, sizePrecision: { toString } })[0]!.feeUsd).toBe(-.01);
    expect(() => settleKuruFills([fill({ rawSize: "10000001" })], params)).toThrow("raw_display_mismatch");
    expect(() => settleKuruFills([fill({ size: .0000001 })], params)).toThrow("raw_integer_required");
  });
  test("receipt and feed float decoders settle the same vault event to an identical fill", () => {
    const rawPrice = "20000000000000010";
    const receiptPrice = Number(ethers.utils.formatUnits(rawPrice, 18));
    const feedPrice = Number(rawPrice) / 1e18;
    expect(receiptPrice).not.toBe(feedPrice);
    for (const side of ["buy", "sell"] as const) {
      const event = fill({ liquidity: "taker", side, nativeOrderId: "0", rawPrice, rawSize: "10000000" });
      const receipt = settleKuruFills([{ ...event, price: receiptPrice }], params);
      const feed = settleKuruFills([{ ...event, price: feedPrice }], params);
      expect(receipt).toEqual(feed);
      expect(JSON.stringify(receipt)).toBe(JSON.stringify(feed));
      expect(receipt[0]!.price).toBe(receiptPrice);
      if (side === "buy") expect(receipt[0]!.feeUsd).toBe(.01 * receiptPrice);
    }
  });
  test("raw size normalizes one-ULP decoder drift before inventory and fee calculations", () => {
    const rawSize = "20000000000000010", receiptSize = Number(ethers.utils.formatUnits(rawSize, 18)), feedSize = Number(rawSize) / 1e18;
    const p = { ...params, sizePrecision: "1000000000000000000" };
    expect(receiptSize).not.toBe(feedSize);
    for (const liquidity of ["maker", "taker"] as const) {
      const event = fill({ side: liquidity === "maker" ? "sell" : "buy", liquidity, rawSize, rawPrice: "2000000000000000000" });
      const receipt = settleKuruFills([{ ...event, size: receiptSize }], p);
      const feed = settleKuruFills([{ ...event, size: feedSize }], p);
      expect(receipt).toEqual(feed);
      expect(receipt[0]!.size).toBe(receiptSize);
      expect(receipt[0]!.baseAdjustment).toBe(feed[0]!.baseAdjustment);
      expect(receipt[0]!.feeUsd).toBe(feed[0]!.feeUsd);
    }
  });
  test("unknown nonzero fee cases fail closed and empty batches need no metadata", () => {
    expect(settleKuruFills([], {} as KuruSettlementParams)).toEqual([]);
    expect(() => settleKuruFills([fill({ liquidity: "taker", nativeOrderId: undefined })], params)).toThrow("native_order_id");
    expect(() => settleKuruFills([fill({ side: "buy", price: 1.234567 })], params)).toThrow("non_grid_book_price");
    expect(() => settleKuruFills([fill({ nativeOrderId: "0" })], params)).toThrow("vault_maker_rebate");
    expect(() => settleKuruFills([fill(), fill()], params)).toThrow("duplicate");
    expect(() => settleKuruFills([fill()], { ...params, takerFeeBps: 0 })).toThrow("invalid_kuru_fee_schedule");
  });
  test("proportional fees do not overwhelm a tiny first fill; impossible token allocations reject", () => {
    const rows = [fill({ id: "a", side: "buy", liquidity: "taker", size: .000001 }), fill({ id: "z", side: "buy", liquidity: "taker", size: 100 })];
    const result = settleKuruFills(rows, params);
    for (const item of result) expect(Math.abs(item.baseAdjustment ?? 0)).toBeLessThanOrEqual(item.size);
    expect(result.reduce((sum, item) => sum + (item.baseAdjustment ?? 0), 0)).toBeCloseTo(-.100000001, 15);
    const halfCent = [fill({ id: "a", liquidity: "taker", size: .0001, price: 50 }), fill({ id: "b", liquidity: "taker", size: .0001, price: 50 })];
    expect(() => settleKuruFills(halfCent, { ...params, pricePrecision: 100, quoteAssetDecimals: 2, makerFeeBps: 0, takerFeeBps: 1 })).toThrow("allocation_capacity");
  });
});
