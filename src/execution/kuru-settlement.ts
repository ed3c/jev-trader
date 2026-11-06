import type { ExecutionFill } from "./types";

type IntegerLike = string | number | bigint | { toString(): string };
export interface KuruSettlementParams {
  sizePrecision: IntegerLike;
  pricePrecision: IntegerLike;
  baseAssetDecimals: IntegerLike;
  quoteAssetDecimals: IntegerLike;
  /** On-chain nonnegative rates. Maker rates are rebates, not fees charged to the maker. */
  makerFeeBps: IntegerLike;
  takerFeeBps: IntegerLike;
}
export interface KuruSettlementInput {
  id: string; orderId: string; side: "buy" | "sell"; price: number; size: number;
  block: number; ts: number; txHash: string; liquidity: "maker" | "taker";
  /** Preserve exact Trade integers; decimal-number reconstruction is only a fallback. */
  rawSize?: string;
  rawPrice?: string;
  /** Original Trade.orderId. Zero identifies the AMM vault, even when orderId is synthetic. */
  nativeOrderId?: string;
}
const TRADE_PRICE_PRECISION = 10n ** 18n;
const BPS = 10_000n;

function uint(input: IntegerLike, name: string, positive = false): bigint {
  if (typeof input === "number" && !Number.isSafeInteger(input)) throw new Error(`invalid_kuru_integer:${name}`);
  const value = input?.toString();
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`invalid_kuru_integer:${name}`);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) throw new Error(`invalid_kuru_integer:${name}`);
  return parsed;
}
function decimals(input: IntegerLike, name: string): bigint {
  const value = uint(input, name);
  if (value > 36n) throw new Error(`unsupported_kuru_decimals:${name}`);
  return 10n ** value;
}
function ceilDiv(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function fromNumber(value: number, precision: bigint, name: string): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_kuru_fill:${name}`);
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e"), exponent = Number(exponentText ?? 0);
  const [whole, fractional = ""] = mantissa!.split(".");
  let numerator = BigInt(whole! + fractional) * precision, denominator = 1n;
  const shift = fractional.length - exponent;
  if (shift >= 0) denominator = 10n ** BigInt(shift); else numerator *= 10n ** BigInt(-shift);
  if (numerator % denominator !== 0n) throw new Error(`kuru_raw_integer_required:${name}`);
  return numerator / denominator;
}
function units(value: bigint, scale: bigint): number {
  // Convert the exact rational through its terminating decimal representation.
  // Number(raw) / Number(scale) rounds twice and can disagree with formatUnits,
  // even though both decoders read the same event. Supported token/size scales
  // divide 10^36, so at most 36 digits are needed before the one Number parse.
  let remainder = value % scale, fraction = "";
  for (let i = 0; remainder !== 0n && i < 36; i++) {
    remainder *= 10n; fraction += (remainder / scale).toString(); remainder %= scale;
  }
  if (remainder !== 0n) throw new Error("unsupported_kuru_nondecimal_scale");
  const result = Number(`${value / scale}${fraction ? `.${fraction}` : ""}`);
  if (!Number.isFinite(result)) throw new Error("kuru_settlement_number_overflow");
  return result;
}
function exactInput(raw: string | undefined, displayed: number, scale: bigint, name: string): bigint {
  const integer = raw === undefined ? fromNumber(displayed, scale, name) : uint(raw, name, true);
  const reconstructed = units(integer, scale);
  // Only binary-double representation error is tolerated; never a token-sized discrepancy.
  if (Math.abs(reconstructed - displayed) > Math.max(Number.EPSILON * Math.abs(displayed) * 4, 1e-300)) throw new Error(`kuru_raw_display_mismatch:${name}`);
  return integer;
}
function bookPrice(rawPrice: bigint, precision: bigint): bigint {
  const scaled = rawPrice * precision;
  if (scaled % TRADE_PRICE_PRECISION !== 0n) throw new Error("unsupported_non_grid_book_price");
  const price = scaled / TRADE_PRICE_PRECISION;
  if (price <= 0n || price >= 2n ** 32n) throw new Error("invalid_kuru_book_price");
  return price;
}
function allocate<T>(total: bigint, rows: T[], weight: (row: T) => bigint, capacity: (row: T) => bigint, identity: (row: T) => string): Map<T, bigint> {
  const weights = rows.reduce((sum, row) => sum + weight(row), 0n), allocations = new Map<T, bigint>();
  let remainder = total;
  for (const row of rows) {
    const proportional = total * weight(row) / weights, cap = capacity(row);
    const amount = proportional < cap ? proportional : cap;
    allocations.set(row, amount); remainder -= amount;
  }
  const sorted = [...rows].sort((a, b) => weight(a) > weight(b) ? -1 : weight(a) < weight(b) ? 1 : identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
  for (const row of sorted) {
    if (remainder === 0n) break;
    const available = capacity(row) - allocations.get(row)!, extra = remainder < available ? remainder : available;
    allocations.set(row, allocations.get(row)! + extra); remainder -= extra;
  }
  // A token quantum can exceed every tiny individual fill's notional even when
  // the whole transaction can pay it. Such a group cannot satisfy the ledger's
  // per-fill bound; fail rather than invent a fractional token or cross inventory.
  if (remainder > 0n) throw new Error("kuru_fee_quantum_exceeds_fill_allocation_capacity");
  return allocations;
}

/**
 * Contract source: Kuru-Labs/Kuru-contracts-dex-public, OrderBook.sol
 * _creditMakerRebate / _matchAggressiveBuyWithCap / _matchAggressiveSell,
 * and AbstractAMM.sol _fillVaultForSell.
 *
 * Caller MUST supply every wallet Trade for a transaction together and guarantee
 * at most one aggressive order per transaction/side. The supported recovery path
 * submits one such order. Trade logs alone cannot distinguish repeated calls.
 * Taker fees are allocated proportionally in integer token units; the remainder
 * goes to the largest eligible fill (canonical ID breaks ties). Receipt/feed
 * and restart replays produce exactly the same event identity and cashflow.
 *
 * Fees are rounded in integer token units, exactly where the contract rounds.
 * Output price, size, and all price-based economic values are normalized from
 * raw event integers before use, independent of the caller's float decoder.
 * feeUsd is a reporting conversion; baseAdjustment changes actual inventory.
 * Gross size stays unchanged for order-fill accounting. Price-times-size still
 * uses JS numbers outside this helper; principal quote rounding is bounded by
 * one market quote quantum per book level plus one quote token quantum per
 * conversion, and must not be mistaken for a fee or a fill. Reconcile balances
 * with a declared tolerance for that principal dust; non-grid/unknown fee paths
 * fail closed instead of returning an invented zero.
 */
export function settleKuruFills(inputs: readonly KuruSettlementInput[], params: KuruSettlementParams): ExecutionFill[] {
  if (!inputs.length) return [];
  const sizePrecision = uint(params.sizePrecision, "sizePrecision", true), pricePrecision = uint(params.pricePrecision, "pricePrecision", true);
  const baseMultiplier = decimals(params.baseAssetDecimals, "baseAssetDecimals"), quoteMultiplier = decimals(params.quoteAssetDecimals, "quoteAssetDecimals");
  const makerRate = uint(params.makerFeeBps, "makerFeeBps"), takerRate = uint(params.takerFeeBps, "takerFeeBps");
  if (makerRate > takerRate || takerRate >= BPS) throw new Error("invalid_kuru_fee_schedule");
  if (baseMultiplier % sizePrecision !== 0n) throw new Error("unsupported_kuru_base_size_precision");
  const rows = inputs.map(input => {
    if (!input.id || !input.orderId || !input.txHash || !["buy", "sell"].includes(input.side) || !["maker", "taker"].includes(input.liquidity) ||
        !Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.size) || input.size <= 0 ||
        !Number.isSafeInteger(input.block) || input.block < 0 || !Number.isFinite(input.ts) || input.ts < 0) throw new Error("invalid_kuru_fill_identity_or_value");
    const rawSize = exactInput(input.rawSize, input.size, sizePrecision, "size"), rawPrice = exactInput(input.rawPrice, input.price, TRADE_PRICE_PRECISION, "price");
    if (rawSize >= 2n ** 96n) throw new Error("invalid_kuru_fill_size");
    const price = units(rawPrice, TRADE_PRICE_PRECISION), size = units(rawSize, sizePrecision);
    const normalizedInput = { ...input, price, size };
    const id = input.liquidity === "taker" && !input.id.endsWith(":taker") ? `${input.id}:taker` : input.id;
    const fill: ExecutionFill = { id, orderId: input.orderId, side: input.side, price, size,
      block: input.block, ts: input.ts, feeUsd: 0, simulated: false, txHash: input.txHash };
    return { input: normalizedInput, rawSize, rawPrice, fill };
  });
  if (new Set(rows.map(row => row.fill.id)).size !== rows.length) throw new Error("duplicate_kuru_settlement_event");
  for (const row of rows.filter(row => row.input.liquidity === "maker")) {
    if (makerRate === 0n) continue;
    if (row.input.nativeOrderId !== undefined && uint(row.input.nativeOrderId, "nativeOrderId") === 0n) throw new Error("unsupported_wallet_vault_maker_rebate");
    if (row.input.side === "sell") {
      const rebate = (row.rawSize * baseMultiplier / sizePrecision) * makerRate / BPS;
      const baseAdjustment = units(rebate, baseMultiplier);
      row.fill.baseAdjustment = baseAdjustment;
      row.fill.feeUsd = -baseAdjustment * row.input.price;
    } else {
      const price = bookPrice(row.rawPrice, pricePrecision);
      const quote = (price * row.rawSize / sizePrecision) * quoteMultiplier / pricePrecision;
      row.fill.feeUsd = -units(quote * makerRate / BPS, quoteMultiplier);
    }
  }
  const groups = new Map<string, typeof rows>();
  for (const row of rows.filter(row => row.input.liquidity === "taker")) {
    const key = `${row.input.txHash.toLowerCase()}:${row.input.side}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (takerRate === 0n) continue;
    group.sort((a, b) => a.fill.id < b.fill.id ? -1 : a.fill.id > b.fill.id ? 1 : 0);
    const first = group[0]!;
    if (group.some(row => row.input.block !== first.input.block || row.input.ts !== first.input.ts)) throw new Error("inconsistent_kuru_transaction_context");
    if (first.input.side === "buy") {
      const grossBase = group.reduce((sum, row) => sum + row.rawSize, 0n) * baseMultiplier / sizePrecision;
      const fee = ceilDiv(grossBase * takerRate, BPS);
      const gross = (row: typeof first) => row.rawSize * baseMultiplier / sizePrecision;
      const allocation = allocate(fee, group, gross, gross, row => row.fill.id);
      for (const row of group) {
        const charge = units(allocation.get(row)!, baseMultiplier);
        if (charge > 0) row.fill.baseAdjustment = -charge;
        row.fill.feeUsd = charge * row.input.price;
      }
    } else {
      const bookLevels = new Map<bigint, bigint>(); let vaultQuote = 0n;
      for (const row of group) {
        if (row.input.nativeOrderId === undefined) throw new Error("kuru_taker_sell_requires_native_order_id");
        if (uint(row.input.nativeOrderId, "nativeOrderId") === 0n) vaultQuote += row.rawPrice * row.rawSize / sizePrecision;
        else {
          const price = bookPrice(row.rawPrice, pricePrecision);
          bookLevels.set(price, (bookLevels.get(price) ?? 0n) + row.rawSize);
        }
      }
      const bookQuote = [...bookLevels].reduce((sum, [price, size]) => sum + price * size / sizePrecision, 0n);
      const quoteCredit = bookQuote * quoteMultiplier / pricePrecision + vaultQuote * quoteMultiplier / TRADE_PRICE_PRECISION;
      const fee = ceilDiv(quoteCredit * takerRate, BPS);
      const weight = (row: typeof first) => row.rawPrice * row.rawSize;
      const capacity = (row: typeof first) => weight(row) * quoteMultiplier / (sizePrecision * TRADE_PRICE_PRECISION);
      const allocation = allocate(fee, group, weight, capacity, row => row.fill.id);
      for (const row of group) row.fill.feeUsd = units(allocation.get(row)!, quoteMultiplier);
    }
  }
  if (rows.some(({ fill }) => !Number.isFinite(fill.feeUsd) || !Number.isFinite(fill.baseAdjustment ?? 0))) throw new Error("kuru_settlement_number_overflow");
  return rows.map(row => row.fill);
}
