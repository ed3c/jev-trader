import type { Book } from "../market";
import type { TradeSide } from "../engine/types";

export interface OrderSpec { side: TradeSide; price: number; size: number }
export interface RestingOrder extends OrderSpec {
  id: string; operationId: string; createdAtMs: number; block: number; queueAhead: number;
}
export interface ExecutionFill {
  id: string; orderId: string; side: TradeSide; price: number; size: number;
  block: number; ts: number;
  /** Signed economic fee in quote units: a rebate is negative. */
  feeUsd: number;
  /** Native token fee/rebate transfer, separate from gross size used for order matching. */
  baseAdjustment?: number;
  simulated: boolean; txHash: string | null;
}
export interface MarketPrint { id: string; block: number; ts: number; side: TradeSide; price: number; size: number }
export interface VenueFrame { book: Book; observedAtMs: number; prints: MarketPrint[]; fills: ExecutionFill[]; gap: boolean }
export interface ExecutionIntent {
  operationId: string; sessionId: string; snapshotId: string; block: number;
  createdAtMs: number; deadlineMs: number; orders: OrderSpec[]; cancelIds: string[];
  postOnly: boolean; reduceOnly: boolean;
}
export type ExecutionStatus = "prepared" | "sent" | "confirmed" | "reverted" | "unknown";
export interface ExecutionUpdate {
  operationId: string; block: number; status: ExecutionStatus; txHash: string | null;
  orders: RestingOrder[]; canceledIds: string[]; gasMon: number; gasUsd: number;
  /** Retain the original intent on uncertain outcomes to reserve worst-case exposure. */
  intent: ExecutionIntent; reason?: string;
  fills?: ExecutionFill[];
}
export interface ExecutionHooks {
  /** Called before a signed transaction can leave this process. Must durably commit, or throw. */
  beforeBroadcast(update: ExecutionUpdate): void;
  /** Checked after any asynchronous signing and immediately before the external write. */
  stillValid(): boolean;
}
export interface ExecutionVenue {
  readonly name: string; readonly dryRun: boolean; readonly address: string | null;
  readonly tickSize: number; readonly minSize: number; readonly sizeStep: number;
  read(block: number): Promise<VenueFrame>;
  submit(intent: ExecutionIntent, book: Book, hooks: ExecutionHooks): Promise<ExecutionUpdate>;
  poll(block: number): Promise<ExecutionUpdate[]>;
  estimateGasMon(orderCount: number): number;
  restore(pending: ExecutionUpdate[], orders: RestingOrder[], checkpoint?: unknown): void;
  checkpoint?(): unknown;
  reconcile?(): Promise<{ openOrders: RestingOrder[]; accountBase: number; accountQuote: number; block: number; fills?: ExecutionFill[] }>;
  close?(): void;
}
