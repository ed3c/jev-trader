import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { Market, type Book } from "../market";
import { log10, toFloat } from "../book";
import { config, type Config } from "../config";
import { rpc,rpcBatch } from "../chain";
import { TradeFeed, type TradePrint, type MakerFill } from "../trades";
import { validateOrders } from "./paper";
import { settleKuruFills, type KuruSettlementInput } from "./kuru-settlement";
import type { ExecutionFill,ExecutionHooks,ExecutionIntent,ExecutionUpdate,ExecutionVenue,RestingOrder,VenueFrame } from "./types";

/** Shared, read-only market source for both paper and live execution. */
export class KuruSource {
  readonly feed:TradeFeed;
  private blockTimes=new Map<number,number>();
  private bufferedPrints:TradePrint[]=[];
  private bufferedFills:MakerFill[]=[];
  private lastRefreshBlock=0;
  constructor(readonly market:Market,private settings:Config=config) {
    this.feed=new TradeFeed({market:settings.market,url:settings.readRpcUrl,
      sizeDec:log10(market.params.sizePrecision),maker:market.address});
  }
  get tickSize(){return Number(this.market.params.tickSize.toString())/Number(this.market.params.pricePrecision.toString());}
  get minSize(){return Number(this.market.params.minSize.toString())/Number(this.market.params.sizePrecision.toString());}
  get sizeStep(){return 1/Number(this.market.params.sizePrecision.toString());}
  async read(block:number):Promise<VenueFrame> {
    if(block-this.lastRefreshBlock>=this.settings.refreshBlocks){
      await this.market.refresh();this.lastRefreshBlock=block;
    }
    const [book,,header]=await Promise.all([this.market.readBook(block),this.feed.poll(block),
      rpc<{number:string;timestamp:string;hash:string}>("eth_getBlockByNumber",["0x"+block.toString(16),false],this.settings.readRpcUrl)]);
    if (!header || parseInt(header.number,16)!==block || book.block!==block) throw new Error("Pinned block identity mismatch");
    this.bufferedPrints.push(...this.feed.drainPrints());this.bufferedFills.push(...this.feed.drainFills());
    const rawPrints=this.bufferedPrints,rawFills=this.bufferedFills;
    this.blockTimes.set(block,parseInt(header.timestamp,16)*1000);
    const missing=[...new Set([...rawPrints,...rawFills].map(p=>p.block))].filter(b=>!this.blockTimes.has(b));
    for(let at=0;at<missing.length;at+=50){
      const batch=missing.slice(at,at+50);
      const headers=await rpcBatch<{number:string;timestamp:string}>(batch.map(b=>({method:"eth_getBlockByNumber",params:["0x"+b.toString(16),false]})),this.settings.readRpcUrl);
      headers.forEach((h,i)=>{if(!h||parseInt(h.number,16)!==batch[i])throw new Error("Trade source block mismatch");
        this.blockTimes.set(batch[i]!,parseInt(h.timestamp,16)*1000);});
    }
    const observedAtMs=Date.now();
    if([...this.blockTimes.values()].some(ts=>!Number.isFinite(ts)||ts<0||ts>observedAtMs))throw new Error("Invalid source block timestamp");
    // Ethereum timestamps have second precision. Allow that quantization, never mask a stalled head.
    const stale=observedAtMs-parseInt(header.timestamp,16)*1000>this.settings.maxDataAgeMs+1000;
    const prints=rawPrints.map(t=>({...t,ts:this.blockTimes.get(t.block)!}));
    const fills=settleKuruFills(rawFills.map(f=>({id:f.id,
      orderId:f.liquidity==="taker"?`taker:${f.txHash}:${f.id.split(":")[1]}`:String(f.orderId),
      side:f.side,price:f.price,size:f.size,block:f.block,ts:this.blockTimes.get(f.block)!,
      txHash:f.txHash,liquidity:f.liquidity,rawSize:f.rawSize,rawPrice:f.rawPrice,nativeOrderId:String(f.orderId)})),this.market.params);
    if(this.blockTimes.size>10000)this.blockTimes=new Map([...this.blockTimes].slice(-5000));
    this.bufferedPrints=[];this.bufferedFills=[];
    return {book,observedAtMs,prints,fills,gap:stale||this.feed.gap||this.feed.lastBlock<block||this.feed.lastError!==null};
  }
}

/** Real Kuru transport. Signed hashes are journaled before broadcast and remain reserved on timeout. */
export class KuruVenue implements ExecutionVenue {
  readonly name="kuru-monad";readonly dryRun=false;
  private iface=new ethers.utils.Interface(OrderBookAbi.abi);
  private pending=new Map<string,ExecutionUpdate>();
  private knownOrders=new Map<string,RestingOrder>();
  private unknownReported=new Set<string>();
  private nonce:number|null=null;
  private cursor=0;
  private lastMid=0;
  constructor(readonly source:KuruSource,private settings:Config=config) {
    if (!source.market.wallet) throw new Error("Kuru live venue requires explicitly enabled wallet");
  }
  get address(){return this.source.market.address;}
  get tickSize(){return this.source.tickSize;}
  get minSize(){return this.source.minSize;}
  get sizeStep(){return this.source.sizeStep;}
  async read(block:number){const frame=await this.source.read(block);this.lastMid=frame.book.mid;return frame;}
  estimateGasMon(_orders:number){return (this.settings.gasLimit??this.settings.gasLimitFallback)*this.settings.maxFeeGwei/1e9;}
  restore(pending:ExecutionUpdate[],orders:RestingOrder[]){
    this.pending=new Map(pending.filter(p=>p.txHash).map(p=>[p.txHash!,p]));
    this.knownOrders=new Map(orders.map(o=>[o.id,o]));
  }
  async submit(intent:ExecutionIntent,book:Book,hooks:ExecutionHooks):Promise<ExecutionUpdate>{
    const existing=[...this.pending.values()].find(p=>p.operationId===intent.operationId);
    if(existing)return existing;
    validateOrders(intent,book,this.tickSize,this.minSize,this.sizeStep);
    if(!intent.postOnly&&intent.orders.length&&(intent.orders.length!==1||!intent.reduceOnly))
      throw new Error("Aggressive Kuru execution is limited to one reducing order");
    if(this.pending.size)throw new Error("Unresolved transaction: reconcile before another write");
    if(this.nonce===null)this.nonce=parseInt(await rpc<string>("eth_getTransactionCount",[this.address,"pending"]),16);
    const precision=Number(this.source.market.params.pricePrecision.toString());
    const sizeDecimals=log10(this.source.market.params.sizePrecision);
    const buy=intent.orders.filter(o=>o.side==="buy"),sell=intent.orders.filter(o=>o.side==="sell");
    const prices=(orders:typeof buy)=>orders.map(o=>Math.round(o.price*precision));
    const sizes=(orders:typeof buy)=>orders.map(o=>ethers.utils.parseUnits(o.size.toFixed(sizeDecimals),sizeDecimals));
    const data=this.iface.encodeFunctionData("batchUpdate",[prices(buy),sizes(buy),prices(sell),sizes(sell),intent.cancelIds,intent.postOnly]);
    const signed=await this.source.market.wallet!.signTransaction({type:2,chainId:this.settings.chainId,to:this.settings.market,
      nonce:this.nonce,gasLimit:this.settings.gasLimit??this.settings.gasLimitFallback,
      maxFeePerGas:ethers.utils.parseUnits(String(this.settings.maxFeeGwei),"gwei"),
      maxPriorityFeePerGas:ethers.utils.parseUnits(String(this.settings.priorityFeeGwei),"gwei"),data,value:0});
    if(!hooks.stillValid())throw new Error("Execution invalidated during signing");
    const hash=ethers.utils.keccak256(signed);
    const update:ExecutionUpdate={operationId:intent.operationId,block:intent.block,status:"prepared",txHash:hash,
      orders:[],canceledIds:[],gasMon:0,gasUsd:0,intent};
    hooks.beforeBroadcast(update); // failure here prevents the external write
    this.pending.set(hash,update);this.nonce++;
    try{
      const returned=await rpc<string>("eth_sendRawTransaction",[signed]);
      if(returned.toLowerCase()!==hash.toLowerCase())throw new Error("RPC returned an unexpected transaction identity");
      update.status="sent";
    }catch{update.status="unknown";update.reason="broadcast_outcome_unknown";}
    return {...update};
  }
  private tradeFills(logs:any[],ts:number):KuruSettlementInput[]{
    const fills:KuruSettlementInput[]=[];
    for(const log of logs){
      if(log.removed)throw new Error("Removed execution log requires reconciliation");
      if(log.address?.toLowerCase()!==this.settings.market.toLowerCase())continue;
      let ev;try{ev=this.iface.parseLog(log);}catch{continue;}
      if(ev.name!=="Trade")continue;
      const price=Number(ethers.utils.formatUnits(ev.args.price,18));
      const size=toFloat(BigInt(ev.args.filledSize.toString()),log10(this.source.market.params.sizePrecision));
      const txHash=log.transactionHash,identity=`${txHash}:${log.logIndex}`;
      const block=parseInt(log.blockNumber,16);
      if(String(ev.args.makerAddress).toLowerCase()===this.address!.toLowerCase())
        fills.push({id:identity,orderId:ev.args.orderId.toString(),side:ev.args.isBuy?"sell":"buy",price,size,block,ts,txHash,liquidity:"maker",rawSize:ev.args.filledSize.toString(),rawPrice:ev.args.price.toString(),nativeOrderId:ev.args.orderId.toString()});
      if(String(ev.args.takerAddress).toLowerCase()===this.address!.toLowerCase())
        fills.push({id:`${identity}:taker`,orderId:`taker:${identity}`,side:ev.args.isBuy?"buy":"sell",price,size,block,ts,txHash,liquidity:"taker",rawSize:ev.args.filledSize.toString(),rawPrice:ev.args.price.toString(),nativeOrderId:ev.args.orderId.toString()});
    }
    return fills;
  }
  async poll(block:number):Promise<ExecutionUpdate[]>{
    const updates:ExecutionUpdate[]=[];
    for(const [hash,p] of this.pending){
      const receipt=await rpc<any>("eth_getTransactionReceipt",[hash]);
      if(!receipt){
        const key=`${hash}:timeout`;
        if(block-p.block>=this.settings.pendingBlocks&&!this.unknownReported.has(key)){
          this.unknownReported.add(key);updates.push({...p,status:"unknown",reason:"receipt_not_confirmed"});
        }
        continue;
      }
      if(receipt.transactionHash?.toLowerCase()!==hash.toLowerCase())throw new Error("Receipt identity mismatch");
      if(receipt.status!=="0x0"&&receipt.status!=="0x1")throw new Error("Receipt has no final status");
      const gasMon=(this.settings.gasLimit??this.settings.gasLimitFallback)*Number(BigInt(receipt.effectiveGasPrice))/1e18;
      const update:ExecutionUpdate={...p,status:receipt.status==="0x0"?"reverted":"confirmed",orders:[],canceledIds:[],gasMon,gasUsd:gasMon*(this.lastMid||0)};
      if(update.status==="confirmed"){
        const logs=(receipt.logs??[]).map((log:any)=>({...log,transactionHash:log.transactionHash??hash,blockNumber:log.blockNumber??receipt.blockNumber}));
        const grossFills=this.tradeFills(logs,Date.now());
        for(const log of logs){
          if(log.address?.toLowerCase()!==this.settings.market.toLowerCase())continue;
          let ev;try{ev=this.iface.parseLog(log);}catch{continue;}
          if(ev.name==="OrderCreated"&&String(ev.args.owner).toLowerCase()===this.address!.toLowerCase()){
            update.orders.push({id:ev.args.orderId.toString(),operationId:p.operationId,side:ev.args.isBuy?"buy":"sell",
              price:Number(ev.args.price)/Number(this.source.market.params.pricePrecision.toString()),
              size:Number(ev.args.size)/Number(this.source.market.params.sizePrecision.toString()),
              createdAtMs:p.intent.createdAtMs,block:parseInt(receipt.blockNumber,16),queueAhead:0});
          }
          if(ev.name==="OrdersCanceled"&&String(ev.args.owner).toLowerCase()===this.address!.toLowerCase())
            for(const id of ev.args.orderId)if(id.toString()!=="0")update.canceledIds.push(id.toString());
        }
        // A cancellation may race with a fill. The contract emits zero for that slot; a
        // separately verified zero remaining size also establishes no working exposure.
        for(const id of p.intent.cancelIds)if(!update.canceledIds.includes(id)){
          if((await this.orderState(id)).size===0)update.canceledIds.push(id);
        }
        let complete=p.intent.cancelIds.every(id=>update.canceledIds.includes(id));
        const taker=grossFills.filter(f=>f.liquidity==="taker");
        if(p.intent.postOnly||!p.intent.orders.length){
          const signature=(o:{side:string;price:number;size:number})=>`${o.side}:${Math.round(o.price/this.tickSize)}:${Math.round(o.size/this.sizeStep)}`;
          complete=complete&&!taker.length&&JSON.stringify(p.intent.orders.map(signature).sort())===JSON.stringify(update.orders.map(signature).sort());
        }else{
          const wanted=p.intent.orders[0];
          complete=complete&&p.intent.reduceOnly&&p.intent.orders.length===1&&!!wanted&&
            update.orders.length<=1&&update.orders.every(o=>o.side===wanted.side&&Math.abs(o.price-wanted.price)<this.tickSize/2)&&
            taker.every(f=>f.side===wanted.side&&(f.side==="buy"?f.price<=wanted.price+this.tickSize/2:f.price>=wanted.price-this.tickSize/2))&&
            Math.abs(update.orders.reduce((n,o)=>n+o.size,0)+taker.reduce((n,f)=>n+f.size,0)-wanted.size)<=this.sizeStep/2;
        }
        if(!complete){
          const key=`${hash}:effects`;
          if(!this.unknownReported.has(key)){this.unknownReported.add(key);updates.push({...p,status:"unknown",reason:"receipt_effects_mismatch",gasMon,gasUsd:gasMon*(this.lastMid||0)});}
          continue;
        }
        for(const o of update.orders)await this.orderState(o.id);
        update.fills=settleKuruFills(grossFills,this.source.market.params);
        for(const id of update.canceledIds)this.knownOrders.delete(id);
        for(const order of update.orders)this.knownOrders.set(order.id,order);
      }
      this.pending.delete(hash);updates.push(update);
    }
    return updates;
  }
  private async orderState(id:string){
    const data=this.iface.encodeFunctionData("s_orders",[id]);
    const raw=await rpc<string>("eth_call",[{to:this.settings.market,data},"latest"],this.settings.readRpcUrl);
    const result=this.iface.decodeFunctionResult("s_orders",raw);
    const size=Number(result.size)/Number(this.source.market.params.sizePrecision.toString());
    if(size>0&&String(result.ownerAddress).toLowerCase()!==this.address!.toLowerCase())throw new Error("Order ownership mismatch");
    return {size,side:result.isBuy?"buy" as const:"sell" as const,price:Number(result.price)/Number(this.source.market.params.pricePrecision.toString())};
  }
  async reconcile(){
    const head=parseInt(await rpc<string>("eth_blockNumber",[],this.settings.readRpcUrl),16);
    const from=this.cursor?this.cursor+1:this.settings.reconcileFromBlock;
    if(!from||from>head||head-from+1>this.settings.maxReconcileBlocks)throw new Error("Set a complete bounded RECONCILE_FROM_BLOCK range before live startup");
    if(!this.cursor){
      const earlier=await rpc<string>("eth_getTransactionCount",[this.address,"0x"+(from-1).toString(16)],this.settings.readRpcUrl);
      if(BigInt(earlier)!==0n)throw new Error("Reconciliation range omits earlier wallet transactions");
    }
    const ids=new Set(this.knownOrders.keys());
    const topic=this.iface.getEventTopic("OrderCreated"),tradeTopic=this.iface.getEventTopic("Trade");
    const grossFills:KuruSettlementInput[]=[];
    for(let lo=from;lo<=head;lo+=100){
      const logs=await rpc<any[]>("eth_getLogs",[{address:this.settings.market,topics:[[topic,tradeTopic]],
        fromBlock:"0x"+lo.toString(16),toBlock:"0x"+Math.min(head,lo+99).toString(16)}],this.settings.readRpcUrl);
      for(const log of logs){if(log.removed)throw new Error("Reorg during reconciliation");const ev=this.iface.parseLog(log);
        if(ev.name==="OrderCreated"&&String(ev.args.owner).toLowerCase()===this.address!.toLowerCase())ids.add(ev.args.orderId.toString());
        if(ev.name==="Trade"&&(String(ev.args.makerAddress).toLowerCase()===this.address!.toLowerCase()||String(ev.args.takerAddress).toLowerCase()===this.address!.toLowerCase())){
          const header=await rpc<{timestamp:string}>("eth_getBlockByNumber",[log.blockNumber,false],this.settings.readRpcUrl);
          grossFills.push(...this.tradeFills([log],parseInt(header.timestamp,16)*1000));
        }
      }
    }
    const fills=settleKuruFills(grossFills,this.source.market.params);
    const openOrders:RestingOrder[]=[];
    for(const id of ids){const state=await this.orderState(id);if(state.size>0)openOrders.push({...state,id,
      operationId:this.knownOrders.get(id)?.operationId??"reconciled-external",createdAtMs:this.knownOrders.get(id)?.createdAtMs??0,block:head,queueAhead:0});}
    await this.source.market.refresh();
    this.knownOrders=new Map(openOrders.map(o=>[o.id,o]));this.cursor=head;
    return {openOrders,accountBase:this.source.market.margin.mon+openOrders.filter(o=>o.side==="sell").reduce((s,o)=>s+o.size,0),
      accountQuote:this.source.market.margin.usdc+openOrders.filter(o=>o.side==="buy").reduce((s,o)=>s+o.size*o.price,0),block:head,fills};
  }
}
