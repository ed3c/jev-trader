import type { Book } from "../market";
import type { ExecutionFill, ExecutionHooks, ExecutionIntent, ExecutionUpdate, ExecutionVenue, RestingOrder, VenueFrame, MarketPrint } from "./types";

/** Conservative queue-aware paper venue. One market print cannot fill multiple orders twice. */
export class PaperVenue implements ExecutionVenue {
  readonly name: string;
  readonly dryRun = true;
  readonly address = null;
  private orders = new Map<string, RestingOrder>();
  private seen = new Set<string>();
  private executed = new Map<string, ExecutionUpdate>();
  private seenThroughBlock=0;
  constructor(private source: (block:number)=>Promise<VenueFrame>,
    readonly tickSize = 0.000001, readonly minSize = 200, readonly sizeStep = 0.0000000001,
    private feeBps = 0, private gasMon = 0.0663, label = "paper-kuru") { this.name = label; }

  async read(block: number): Promise<VenueFrame> {
    const frame = await this.source(block);
    const fills: ExecutionFill[] = [];
    const freshPrints:MarketPrint[]=[];
    for (const print of frame.prints) {
      if(print.block<=this.seenThroughBlock)continue;
      if (this.seen.has(print.id)) continue;
      this.seen.add(print.id);
      freshPrints.push(print);
      let available = print.size;
      const eligible = [...this.orders.values()].filter(o => o.block < print.block && o.createdAtMs < print.ts &&
        (o.side === "buy" ? print.side === "sell" && print.price <= o.price : print.side === "buy" && print.price >= o.price))
        .sort((a,b) => a.side === "buy" ? b.price-a.price || a.createdAtMs-b.createdAtMs : a.price-b.price || a.createdAtMs-b.createdAtMs);
      for (const order of eligible) {
        const ahead = Math.min(available, order.queueAhead);
        order.queueAhead -= ahead; available -= ahead;
        const size = Math.min(order.size, available);
        if (size <= 0) continue;
        order.size -= size; available -= size;
        fills.push({id:`${print.id}:${order.id}`,orderId:order.id,side:order.side,price:order.price,size,
          block:print.block,ts:print.ts,feeUsd:size*order.price*this.feeBps/10_000,simulated:true,txHash:null});
        if (order.size < this.sizeStep/2) this.orders.delete(order.id);
      }
    }
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    // A complete VenueFrame covers prints through its pinned book block. Persist this cursor
    // with the account checkpoint so a restart cannot consume old prints a second time.
    if(!frame.gap)this.seenThroughBlock=Math.max(this.seenThroughBlock,frame.book.block);
    return {...frame,prints:freshPrints,fills};
  }

  async submit(intent: ExecutionIntent, book: Book, hooks: ExecutionHooks): Promise<ExecutionUpdate> {
    const old = this.executed.get(intent.operationId);
    if (old) {
      if (JSON.stringify(old.intent) !== JSON.stringify(intent)) throw new Error("Conflicting operation identity");
      return old;
    }
    validateOrders(intent, book, this.tickSize, this.minSize, this.sizeStep);
    if (!hooks.stillValid()) throw new Error("Execution invalidated before submission");
    const orders = intent.orders.map((o,i):RestingOrder => ({...o,id:`paper:${intent.operationId}:${i}`,
      operationId:intent.operationId,createdAtMs:intent.createdAtMs,block:intent.block,
      queueAhead:(o.side === "buy" ? book.levels.bids : book.levels.asks).filter(([price]) => Math.abs(price-o.price)<this.tickSize/2).reduce((n,[,size])=>n+size,0)}));
    const update:ExecutionUpdate = {operationId:intent.operationId,block:intent.block,status:"confirmed",txHash:null,
      orders,canceledIds:intent.cancelIds.filter(id=>this.orders.has(id)),gasMon:this.estimateGasMon(orders.length),
      gasUsd:this.estimateGasMon(orders.length)*book.mid,intent};
    if (!intent.postOnly) {
      update.fills=[];
      const depth={buy:book.levels.asks.map(l=>[...l] as [number,number]),sell:book.levels.bids.map(l=>[...l] as [number,number])};
      for(const order of orders){
        for(const level of depth[order.side]){
          const [price,available]=level;
          if(order.side==="buy"?price>order.price:price<order.price)break;
          const size=Math.min(order.size,available);if(size<=0)continue;
          level[1]-=size;order.size-=size;
          update.fills.push({id:`${order.id}:immediate:${price}`,orderId:order.id,side:order.side,price,size,
            block:intent.block,ts:intent.createdAtMs,feeUsd:size*price*this.feeBps/10_000,simulated:true,txHash:null});
        }
      }
      // The receipt describes original accepted quantities; the engine applies its fills exactly once.
      update.orders=orders.map((o,i)=>({...o,size:intent.orders[i]!.size}));
    }
    hooks.beforeBroadcast({...update,status:"prepared"});
    for (const id of update.canceledIds) this.orders.delete(id);
    for (const o of orders) if(o.size>=this.sizeStep/2)this.orders.set(o.id,{...o});
    this.executed.set(intent.operationId,update);
    return update;
  }
  async poll():Promise<ExecutionUpdate[]> { return []; }
  estimateGasMon(_orderCount:number) { return this.gasMon; }
  checkpoint(){return {version:1,seenThroughBlock:this.seenThroughBlock};}
  restore(pending:ExecutionUpdate[],orders:RestingOrder[],checkpoint?:unknown) {
    if(checkpoint){const c=checkpoint as {version:number;seenThroughBlock:number};
      if(c.version!==1||!Number.isSafeInteger(c.seenThroughBlock)||c.seenThroughBlock<0)throw new Error("Invalid paper replay cursor");
      this.seenThroughBlock=c.seenThroughBlock;}
    this.orders = new Map(orders.map(o=>[o.id,{...o}]));
    // A crashed paper write is deterministic and local. Resolve its persisted intent exactly once.
    for (const p of pending) {
      for (const id of p.canceledIds) this.orders.delete(id);
      for (const o of p.orders) {
        const filled=(p.fills??[]).filter(f=>f.orderId===o.id).reduce((n,f)=>n+f.size,0);
        if(o.size-filled>=this.sizeStep/2)this.orders.set(o.id,{...o,size:o.size-filled});
        else this.orders.delete(o.id);
      }
      this.executed.set(p.operationId,{...p,status:"confirmed"});
    }
  }
}

export function validateOrders(intent:ExecutionIntent,book:Book,tick:number,minSize:number,step:number) {
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(minSize) || minSize <= 0 || !Number.isFinite(step) || step <= 0 ||
      !Number.isFinite(book.bid) || !Number.isFinite(book.ask) || book.bid <= 0 || book.ask <= book.bid) throw new Error("Invalid venue market data");
  if (new Set(intent.cancelIds).size !== intent.cancelIds.length) throw new Error("Duplicate cancellation");
  for (const o of intent.orders) {
    if (![o.price,o.size].every(Number.isFinite) || o.price <= 0 || o.size < minSize ||
        Math.abs(o.price/tick-Math.round(o.price/tick))>1e-6 || Math.abs(o.size/step-Math.round(o.size/step))>1e-4) throw new Error("Invalid order precision or size");
    if (o.side !== "buy" && o.side !== "sell") throw new Error("Invalid order side");
    if (intent.postOnly && (o.side === "buy" ? o.price >= book.ask : o.price <= book.bid)) throw new Error("Post-only order would cross");
  }
  const buys=intent.orders.filter(o=>o.side==="buy"), sells=intent.orders.filter(o=>o.side==="sell");
  if (buys.some(b=>sells.some(s=>b.price>=s.price))) throw new Error("Self-crossing batch");
}
