import { config, type Config } from "./config";
import type { Book, Fill, Quote } from "./market";
import { buildSnapshot } from "./engine/state";
import { composePolicy } from "./engine/policy";
import { evaluateRisk } from "./engine/risk";
import { DeterministicDecisionProvider } from "./engine/decisions";
import { Journal, digest } from "./engine/journal";
import { checkLiveAuthorization, strategyHash } from "./engine/authorization";
import { quoteEconomics, replacementReason } from "./engine/economics";
import { avellanedaStoikov } from "./quant/avellaneda-stoikov";
import type { DecisionBattery, DecisionProvider, MarketSnapshot, MidObservation, PolicyDecision, RiskLimits, RiskVerdict, TradeObservation } from "./engine/types";
import type { ExecutionFill,ExecutionIntent,ExecutionUpdate,ExecutionVenue,OrderSpec,RestingOrder,VenueFrame } from "./execution/types";

export interface Totals {
  blocks:number;decisions:number;quotes:number;fills:number;reverted:number;lateBlocks:number;
  jevUsd:number;gasMon:number;gasUsd:number;feesUsd:number;realizedUsd:number;pnlUsd:number;pnlMon:number;pnlPct:number;
}
export interface BlockEvent {
  block:number;ts:number;mid:number;bestBid:number;bestAsk:number;spreadBps:number;
  decision:{action:"buy"|"sell"|"hold";probabilities:{buy:number;sell:number;hold:number};upIn10:number;latencyMs:number;late:boolean}|null;
  quote:Quote|null;quotes:Quote[];fill:Fill|null;resting:{bidMon:number;askMon:number};
  position:{side:"long"|"short"|"flat";size:number;entryPrice:number|null;unrealizedUsd:number;unrealizedMon:number};
  totals:Totals;policy:PolicyDecision|null;risk:RiskVerdict|null;
  evidence:{sessionId:string;snapshotId:string|null;modelId:string;source:string;calibration:string};
  health:{state:string;reason:string|null;pending:number;apiErrors:number;missing:string[]};
}
export interface Timing {readMs:number;loopMs:number}
interface Checkpoint {
  version:1;sessionId:string;strategyHash:string;identity:string;startedAtMs:number;
  initialized:boolean;position:number;costUsd:number;positionOpenedAtMs:number|null;openEntryFeesUsd:number;
  bankrollUsd:number;peakEquityUsd:number;dayStartEquityUsd:number;day:string;
  killed:string|null;killAt:number|null;lastBlock:number;lastBook:Book|null;lastBookAt:number;
  orders:RestingOrder[];pending:ExecutionUpdate[];filledSizes:Record<string,number>;
  totals:Totals;apiErrors:number;consecutiveLosses:number;mids:MidObservation[];
  lastQuote:{bid:number;ask:number;at:number}|null;gasHistory:{at:number;usd:number}[];
  observedDays:string[];
  baselineBlock:number;
  venueCheckpoint?:unknown;
}
export interface TraderOptions {
  config?:Config;journal?:Journal;clock?:()=>number;onEvent?:(event:BlockEvent,timing?:Timing)=>void;
  onAlert?:(alert:{at:number;reason:string;sessionId:string})=>void;sourceLabel?:"real-market-paper"|"synthetic"|"live";
}
const totalDefaults=():Totals=>({blocks:0,decisions:0,quotes:0,fills:0,reverted:0,lateBlocks:0,jevUsd:0,gasMon:0,gasUsd:0,feesUsd:0,realizedUsd:0,pnlUsd:0,pnlMon:0,pnlPct:0});
const dayOf=(ts:number)=>new Date(ts).toISOString().slice(0,10);

/** One decision generation, one durable account ledger, one absolute risk veto before every write. */
export class Trader {
  readonly history:BlockEvent[]=[];
  readonly journal:Journal;
  private settings:Config;private now:()=>number;private state:Checkpoint;
  private orders=new Map<string,RestingOrder>();private pending=new Map<string,ExecutionUpdate>();
  private busy=false;private recovering=false;private closed=false;private newestBlock=0;
  private controller:AbortController|null=null;private lastFrame:VenueFrame|null=null;
  private lastSnapshot:MarketSnapshot|null=null;private lastBattery:DecisionBattery|null=null;
  private lastPolicy:PolicyDecision|null=null;private lastRisk:RiskVerdict|null=null;
  private recentTrades:TradeObservation[]=[];private latencies:number[]=[];
  private fallback:DeterministicDecisionProvider;
  private bootstrap:{accountBase:number;accountQuote:number;block:number;openOrders:RestingOrder[]}|null=null;
  constructor(readonly venue:ExecutionVenue,readonly model:DecisionProvider,private options:TraderOptions={}) {
    this.settings=options.config??config;this.now=options.clock??(()=>performance.timeOrigin+performance.now());
    this.journal=options.journal??new Journal(`${this.settings.dataDir}/engine.sqlite`);
    this.fallback=new DeterministicDecisionProvider({clock:this.now,timeoutMs:this.settings.decisionDeadlineMs});
    const identity=`${venue.name}:${venue.dryRun}:${venue.address}:${this.settings.market}`;
    const saved=this.journal.load<Checkpoint>("engine");
    if(saved&&(saved.version!==1||saved.identity!==identity||saved.strategyHash!==strategyHash(this.settings)))
      throw new Error("Checkpoint account/strategy mismatch. Reconcile and migrate explicitly; never reuse another session ledger.");
    if(saved){
      if(saved.openEntryFeesUsd===undefined){
        if(saved.position!==0)throw new Error("Checkpoint entry fee carry is missing for open inventory. Reconcile and migrate explicitly before restarting.");
        saved.openEntryFeesUsd=0;
      }
      if(!Number.isFinite(saved.openEntryFeesUsd)||(saved.position===0&&saved.openEntryFeesUsd!==0))
        throw new Error("Invalid checkpoint entry fee carry. Reconcile and migrate explicitly before restarting.");
    }
    this.state=saved??{version:1,sessionId:crypto.randomUUID(),strategyHash:strategyHash(this.settings),identity,startedAtMs:this.now(),
      initialized:false,position:0,costUsd:0,positionOpenedAtMs:null,openEntryFeesUsd:0,bankrollUsd:this.settings.bankrollUsd,
      peakEquityUsd:this.settings.bankrollUsd,dayStartEquityUsd:this.settings.bankrollUsd,day:dayOf(this.now()),
      killed:null,killAt:null,lastBlock:0,lastBook:null,lastBookAt:0,orders:[],pending:[],filledSizes:{},totals:totalDefaults(),
      apiErrors:0,consecutiveLosses:0,mids:[],lastQuote:null,gasHistory:[],observedDays:[],baselineBlock:0};
    this.state.observedDays??=[];
    this.state.baselineBlock??=this.state.lastBlock;
    this.orders=new Map(this.state.orders.map(o=>[o.id,o]));this.pending=new Map(this.state.pending.map(p=>[p.operationId,p]));
    this.venue.restore(this.state.pending,this.state.orders,this.state.venueCheckpoint);
    this.newestBlock=this.state.lastBlock;
    if(this.venue.dryRun){for(const p of [...this.pending.values()])this.applyUpdate({...p,status:"confirmed"});}
    this.persist();
  }
  get sessionId(){return this.state.sessionId;}
  get killed(){return this.state.killed;}
  get limits():RiskLimits{return {maxPosition:this.settings.maxPositionMon,maxOrderSize:this.settings.tradeSizeMon,
    maxDailyLossUsd:this.settings.maxDailyLossUsd,maxDrawdownFraction:this.settings.maxDrawdownFraction,
    maxInventoryAgeMs:this.settings.maxInventoryAgeMs,maxDataAgeMs:this.settings.maxDataAgeMs,maxLeverage:this.settings.maxLeverage,
    maxApiErrors:this.settings.maxApiErrors,maxDecisionLatencyMs:this.settings.decisionDeadlineMs};}
  status(){return {sessionId:this.sessionId,strategyHash:this.state.strategyHash,source:this.options.sourceLabel??(this.venue.dryRun?"real-market-paper":"live"),
    state:this.journal.failed?"persistence_failure":this.state.killed?(this.state.position===0&&!this.orders.size&&!this.pending.size?"killed_flat":"kill_recovery_pending"):this.pending.size?"reconciling":this.lastSnapshot?.readiness.ready?"ready":"warming_up",
    reason:this.journal.failed?"journal_failure":this.state.killed,accountingVerified:!this.journal.failed,position:this.state.position,openOrders:[...this.orders.values()],pending:[...this.pending.values()],
    lastBlock:this.state.lastBlock,lastBookAt:this.state.lastBookAt,model:this.model.name,lastPolicy:this.lastPolicy,
    lastRisk:this.lastRisk,latestSnapshot:this.lastSnapshot,totals:this.mark(this.state.lastBook?.mid??1),
    initialized:this.state.initialized,paperReadiness:{minimumDays:14,elapsedDays:(this.now()-this.state.startedAtMs)/86400_000,
      observedDays:this.state.observedDays.length}};}
  async initialize(){
    if(!this.venue.dryRun){
      if(!this.venue.reconcile)throw new Error("Live venue has no reconciliation capability");
      this.bootstrap=await this.venue.reconcile();
      if(this.state.initialized){
        for(const fill of (this.bootstrap as typeof this.bootstrap & {fills?:ExecutionFill[]}).fills??[])
          if(fill.block>this.state.baselineBlock)this.applyFill(fill);
        // A mismatch is an unresolved accounting fact. Halt before accepting a new position.
        if(Math.abs(this.bootstrap.accountBase-this.state.position)>this.venue.sizeStep*2)
          this.latch("restart_inventory_mismatch");
        const expectedQuote=this.state.bankrollUsd-this.state.costUsd+this.state.totals.realizedUsd-this.state.totals.feesUsd;
        if(Math.abs(expectedQuote-this.bootstrap.accountQuote)>0.00001){
          this.journal.append("reconciliation_discrepancy",{kind:"quote_cash",expected:expectedQuote,observed:this.bootstrap.accountQuote,tolerance:0.00001},undefined,this.now());
          this.latch("restart_cash_mismatch");
        }
        const known=new Set(this.orders.keys());
        if(this.bootstrap.openOrders.some(o=>!known.has(o.id)))this.latch("untracked_live_order");
        this.orders=new Map(this.bootstrap.openOrders.map(o=>[o.id,o]));
      }else if(this.bootstrap.openOrders.length){this.latch("preexisting_live_orders");this.orders=new Map(this.bootstrap.openOrders.map(o=>[o.id,o]));}
      checkLiveAuthorization(this.settings,this.sessionId,this.venue.address,this.now(),0);
      this.persist();
    }
  }
  private persist(){
    this.state.orders=[...this.orders.values()];this.state.pending=[...this.pending.values()];
    this.state.venueCheckpoint=this.venue.checkpoint?.();
    this.journal.save("engine",this.state);
  }
  private unrealized(mid:number){return this.state.position?this.state.position*mid-this.state.costUsd:0;}
  private equity(mid:number){const t=this.state.totals;return this.state.bankrollUsd+t.realizedUsd+this.unrealized(mid)-t.gasUsd-t.feesUsd-t.jevUsd;}
  private mark(mid:number):Totals {
    const t=this.state.totals;t.pnlUsd=this.equity(mid)-this.state.bankrollUsd;t.pnlMon=t.pnlUsd/mid;
    t.pnlPct=t.pnlUsd/this.state.bankrollUsd*100;return {...t};
  }
  private latch(reason:string){
    if(this.state.killed)return;
    this.state.killed=reason;this.state.killAt=this.now();this.controller?.abort();
    if(this.journal.failed){this.options.onAlert?.({at:this.now(),reason:"journal_failure",sessionId:this.sessionId});return;}
    this.journal.atomic(()=>{this.journal.append("kill",{reason,sessionId:this.sessionId},`kill:${this.sessionId}`,this.now());this.persist();});
    this.options.onAlert?.({at:this.now(),reason,sessionId:this.sessionId});
  }
  async halt(reason="operator_kill"){this.latch(reason);if(!this.busy)await this.recover();}
  async watchdog(){
    if(this.state.lastBookAt&&this.now()-this.state.lastBookAt>=this.settings.maxDataAgeMs){
      this.latch("stale_feed_watchdog");if(!this.busy)await this.recover();
    }
  }
  async onBlock(block:number):Promise<void>{
    if(this.closed||this.journal.failed||!Number.isSafeInteger(block)||block<=this.newestBlock)return;
    this.newestBlock=block;
    if(this.busy){this.controller?.abort();this.state.totals.lateBlocks++;return;}
    this.busy=true;
    let current=block;
    try{
      do{await this.process(current);current=this.newestBlock;}while(current>this.state.lastBlock&&!this.closed);
    }finally{this.busy=false;if(this.state.killed)await this.recover();}
  }
  private async process(block:number){
    const started=this.now(),deadline=started+this.settings.decisionDeadlineMs;
    this.controller=new AbortController();
    this.state.totals.blocks++;this.state.lastBlock=block;
    if(!this.state.observedDays.includes(dayOf(started)))this.state.observedDays.push(dayOf(started));
    this.lastBattery=null;this.lastPolicy=null;this.lastRisk=null;this.lastSnapshot=null;this.lastFrame=null;
    let quoted:ExecutionUpdate|null=null;
    try{
      for(const update of await this.venue.poll(block))this.applyUpdate(update);
      const frame=await this.venue.read(block);this.lastFrame=frame;
      if(frame.book.block!==block||frame.observedAtMs>this.now()||![frame.book.mid,frame.book.bid,frame.book.ask].every(Number.isFinite))
        throw new Error("Invalid or future venue frame");
      this.state.lastBook=frame.book;this.state.lastBookAt=frame.observedAtMs;
      // A whole market frame and its replay cursor are one durable unit. A crash cannot
      // commit the cursor after only the first partial fill in this frame.
      this.journal.atomic(()=>{
      if(!this.state.initialized){
        this.state.position=this.bootstrap?.accountBase??this.settings.marginMon;
        this.state.costUsd=this.state.position*frame.book.mid;
        this.state.openEntryFeesUsd=0;
        this.state.positionOpenedAtMs=this.state.position?this.now():null;
        if(this.bootstrap)this.state.bankrollUsd=this.bootstrap.accountBase*frame.book.mid+this.bootstrap.accountQuote;
        if(this.state.bankrollUsd<=0||this.state.costUsd>this.state.bankrollUsd)throw new Error("Invalid initial spot funding");
        this.state.peakEquityUsd=this.state.dayStartEquityUsd=this.state.bankrollUsd;this.state.initialized=true;
        this.state.baselineBlock=this.bootstrap?.block??block;
        this.journal.append("account_baseline",{inventory:this.state.position,costBasis:"session_start_mark",equityUsd:this.state.bankrollUsd},`baseline:${this.sessionId}`,this.now());
      }
      for(const fill of frame.fills){
        // A live bootstrap is a pinned current balance. Replaying earlier fills would count twice.
        if(this.bootstrap&&fill.block<=this.state.baselineBlock)continue;
        this.applyFill(fill);
      }
      this.persist();
      });
      if(frame.gap){this.latch("market_data_gap");return;}
      this.state.mids.push({ts:frame.observedAtMs,mid:frame.book.mid});
      this.state.mids=this.state.mids.filter(p=>p.ts>=this.now()-31*60_000).slice(-10_000);
      this.recentTrades.push(...frame.prints.map(p=>({ts:p.ts,price:p.price,size:p.size,side:p.side})));
      this.recentTrades=this.recentTrades.filter(t=>t.ts>=this.now()-60_000);
      const ts=Math.max(this.now(),frame.observedAtMs+0.001);
      const equity=this.equity(frame.book.mid);
      this.state.peakEquityUsd=Math.max(this.state.peakEquityUsd,equity);
      if(dayOf(ts)!==this.state.day){this.state.day=dayOf(ts);this.state.dayStartEquityUsd=equity;}
      const snapshot=buildSnapshot({sessionId:this.sessionId,symbol:"MON-USDC",block,decisionTs:ts,horizonBlocks:this.settings.horizonBlocks,
        book:{block,ts:frame.observedAtMs,bid:frame.book.bid,ask:frame.book.ask,bids:frame.book.levels.bids,asks:frame.book.levels.asks},
        mids:this.state.mids,trades:this.recentTrades,flowWindowStartMs:Math.max(this.state.startedAtMs,ts-60_000),
        account:{inventory:this.state.position,equityUsd:equity,peakEquityUsd:this.state.peakEquityUsd,dayStartEquityUsd:this.state.dayStartEquityUsd,
          realizedPnlUsd:this.state.totals.realizedUsd,unrealizedPnlUsd:this.unrealized(frame.book.mid),positionOpenedAtMs:this.state.positionOpenedAtMs},
        health:{apiErrors:this.state.apiErrors,fillRatio:this.state.totals.quotes?Math.min(1,Object.keys(this.state.filledSizes).length/this.state.totals.quotes):null,
          rejectRate:this.state.totals.quotes?this.state.totals.reverted/this.state.totals.quotes:null,slippageBps:null,latenciesMs:this.latencies}},
        {maxDataAgeMs:this.settings.maxDataAgeMs,minVolSamples:this.settings.minVolSamples});
      this.lastSnapshot=snapshot;
      this.lastRisk=evaluateRisk({snapshot,orders:[],openOrders:this.exposure(),decisionLatencyMs:0,nowMs:Math.max(this.now(),ts),killed:!!this.state.killed},this.limits);
      if(this.lastRisk.kill){this.latch(this.lastRisk.reasons.join(","));return;}
      if(this.state.killed||this.pending.size||!snapshot.readiness.ready)return;
      if(this.newestBlock!==block||this.now()>=deadline)return this.expired();
      let battery:DecisionBattery;
      try{battery=await this.model.decide(snapshot,{deadlineMs:deadline,signal:this.controller.signal});}
      catch(error){
        this.state.apiErrors++;
        this.journal.append("provider_error",{block,model:this.model.name,message:error instanceof Error?error.name:"Error"},undefined,this.now());
        if(this.state.apiErrors>=this.settings.maxApiErrors){this.latch("max_provider_errors");return;}
        if(this.newestBlock!==block||this.now()>=deadline||this.controller.signal.aborted)return this.expired();
        if(!this.settings.deterministicFallback)return;
        battery=await this.fallback.decide(snapshot,{deadlineMs:deadline,signal:this.controller.signal});
      }
      this.lastBattery=battery;this.state.totals.decisions++;
      if(battery.source==="jev"||this.settings.model==="mock")this.state.apiErrors=0;
      if(battery.source==="jev")this.state.totals.jevUsd+=battery.inputTokens*this.settings.jevUsdPerMTok/1e6;
      this.latencies.push(battery.latencyMs);this.latencies=this.latencies.slice(-10);
      if(this.newestBlock!==block||this.now()>=deadline||this.controller.signal.aborted)return this.expired();
      const policy=composePolicy(snapshot,battery,{allowDeterministicFallback:this.settings.deterministicFallback,
        maxDecisionAgeMs:this.settings.decisionDeadlineMs,maxDataAgeMs:this.settings.maxDataAgeMs},Math.max(this.now(),battery.decidedAtMs));
      this.lastPolicy=policy;
      if(policy.action==="kill"){this.latch(policy.reasons.join(","));return;}
      if(policy.action==="pull_quotes"){
        if(this.orders.size)quoted=await this.submit([],snapshot,block,deadline,true,false);
        return;
      }
      if(policy.action==="hold"){
        if(this.state.lastQuote&&this.now()-this.state.lastQuote.at>=this.settings.maxQuoteLifeMs&&this.orders.size)
          quoted=await this.submit([],snapshot,block,deadline,true,false);
        return;
      }
      const base=avellanedaStoikov({mid:snapshot.price.mid,inventory:this.state.position-policy.skew*this.settings.tradeSizeMon/4,
        gamma:this.settings.gamma,sigma:(snapshot.vol.short??0)*snapshot.price.mid,timeRemaining:this.settings.quoteHorizonSeconds,
        kappa:this.settings.kappa,tickSize:this.venue.tickSize,bestBid:frame.book.bid,bestAsk:frame.book.ask,
        minHalfSpread:snapshot.price.mid*this.settings.minSpreadBps/20_000});
      const bid=Math.min(frame.book.ask-this.venue.tickSize,Math.floor((base.reservationPrice-base.halfSpread*policy.spreadMultiplier)/this.venue.tickSize)*this.venue.tickSize);
      const ask=Math.max(frame.book.bid+this.venue.tickSize,Math.ceil((base.reservationPrice+base.halfSpread*policy.spreadMultiplier)/this.venue.tickSize)*this.venue.tickSize);
      const size=Math.floor(this.settings.tradeSizeMon*policy.sizeMultiplier/this.venue.sizeStep)*this.venue.sizeStep;
      if(size<this.venue.minSize){this.lastPolicy={...policy,action:"hold",reasons:["reduced_size_below_venue_minimum"]};return;}
      let orders:OrderSpec[]=[{side:"buy",price:bid,size},{side:"sell",price:ask,size}];
      if(policy.action==="reduce_inventory")orders=orders.filter(o=>o.side===policy.reduceSide).map(o=>({...o,size:Math.min(o.size,Math.abs(this.state.position))}));
      // This venue is spot: no unbacked asks and no spend beyond the marked paper/live account.
      const freeQuote=this.equity(frame.book.mid)-this.state.position*frame.book.mid;
      orders=orders.filter(o=>o.side==="sell"?o.size<=Math.max(0,this.state.position):o.size*o.price<=freeQuote);
      if(!orders.length)return;
      const reason=replacementReason(this.orders.size?this.state.lastQuote:null,{bid,ask},this.now(),this.settings.minQuoteLifeMs,this.settings.maxQuoteLifeMs,this.settings.repriceBps);
      if(!reason)return;
      const economics=quoteEconomics({bid,ask,size,mid:snapshot.price.mid,fillProbability:this.settings.expectedFillProbability,
        makerFeeBps:this.settings.makerFeeBps,slippageBps:this.settings.slippageBps,adverseSelectionBps:this.settings.adverseSelectionBps,
        gasUsd:2*this.venue.estimateGasMon(orders.length)*snapshot.price.mid,
        decisionUsd:battery.source==="jev"?battery.inputTokens*this.settings.jevUsdPerMTok/1e6:0});
      this.journal.append("quote_economics",{snapshotId:snapshot.id,...economics},undefined,this.now());
      if(economics.netEdgeUsd<this.settings.minNetEdgeUsd){this.lastPolicy={...policy,action:"hold",reasons:["cost_exceeds_expected_capture"]};return;}
      this.state.gasHistory=this.state.gasHistory.filter(g=>g.at>this.now()-3600_000);
      if(this.state.gasHistory.reduce((s,g)=>s+g.usd,0)+economics.assumptions.gasUsd>this.settings.maxGasUsdPerHour){
        this.lastPolicy={...policy,action:"hold",reasons:["hourly_gas_budget"]};return;
      }
      this.lastRisk=evaluateRisk({snapshot,orders,openOrders:this.exposure(),decisionLatencyMs:battery.latencyMs,nowMs:this.now(),killed:!!this.state.killed},this.limits);
      if(this.lastRisk.kill){this.latch(this.lastRisk.reasons.join(","));return;}
      if(!this.lastRisk.ok){if(this.orders.size)quoted=await this.submit([],snapshot,block,deadline,true,false);return;}
      quoted=await this.submit(orders,snapshot,block,deadline,true,policy.action==="reduce_inventory");
      this.state.lastQuote={bid,ask,at:this.now()};
    }catch(error){
      this.state.apiErrors++;
      this.journal.append("loop_error",{block,error:error instanceof Error?error.message:"Unknown error"},undefined,this.now());
      if(this.state.apiErrors>=this.settings.maxApiErrors)this.latch("max_api_errors");
    }finally{
      if(this.state.lastBook)this.emit(block,quoted,{readMs:this.lastFrame?Math.max(0,this.lastFrame.observedAtMs-started):0,loopMs:this.now()-started});
      this.persist();
    }
  }
  private expired(){this.state.totals.lateBlocks++;if(this.lastPolicy)this.lastPolicy={...this.lastPolicy,action:"hold",reasons:["decision_deadline"]};}
  private exposure(){return [...this.orders.values(),...[...this.pending.values()].flatMap(p=>p.intent.orders)];}
  private async submit(orders:OrderSpec[],snapshot:MarketSnapshot,block:number,deadlineMs:number,postOnly:boolean,reduceOnly:boolean){
    if(this.pending.size)throw new Error("Pending execution must reconcile first");
    const cancelIds=[...this.orders.keys()];
    if(!orders.length&&!cancelIds.length)return null;
    const intent:ExecutionIntent={operationId:digest({session:this.sessionId,snapshot:snapshot.id,orders,cancelIds,postOnly,reduceOnly}),sessionId:this.sessionId,
      snapshotId:snapshot.id,block,createdAtMs:this.now(),deadlineMs,orders,cancelIds,postOnly,reduceOnly};
    if(orders.length)checkLiveAuthorization(this.settings,this.sessionId,this.venue.address,this.now(),orders.reduce((s,o)=>s+o.price*o.size,0));
    const update=await this.venue.submit(intent,this.state.lastBook!,{
      stillValid:()=>{
        if(this.journal.failed||this.newestBlock!==block||this.now()>=deadlineMs||this.state.killed)return false;
        if(!orders.length)return true;
        try{checkLiveAuthorization(this.settings,this.sessionId,this.venue.address,this.now(),orders.reduce((s,o)=>s+o.price*o.size,0));}catch{return false;}
        return evaluateRisk({snapshot,orders,openOrders:this.exposure(),decisionLatencyMs:this.lastBattery?.latencyMs??0,nowMs:this.now(),killed:false},this.limits).ok;
      },
      beforeBroadcast:p=>{this.journal.atomic(()=>{this.journal.append("execution_intent",p,`intent:${p.operationId}`,this.now());this.pending.set(p.operationId,p);this.persist();});},
    });
    this.applyUpdate(update);return update;
  }
  private applyUpdate(update:ExecutionUpdate){
    this.journal.atomic(()=>{
      const key=`execution:${update.operationId}:${update.status}:${digest({reason:update.reason,txHash:update.txHash,gasMon:update.gasMon,orders:update.orders,canceledIds:update.canceledIds})}`;
      if(!this.journal.append("execution_update",update,key,this.now()))return;
      if(!Number.isFinite(update.gasMon)||update.gasMon<0||!Number.isFinite(update.gasUsd)||update.gasUsd<0)
        throw new Error("Invalid execution cost");
      // A verified receipt can establish the fee while its order effects remain unresolved.
      // Charge that receipt once, even if a later reconciliation changes its execution status.
      if(update.gasMon>0){
        const name=`execution-cost:${update.operationId}`;
        const paid=this.journal.load<{txHash:string|null;gasMon:number;gasUsd:number}>(name);
        if(paid&&(paid.txHash!==update.txHash||Math.abs(paid.gasMon-update.gasMon)>1e-12))
          throw new Error("Conflicting execution cost identity");
        if(!paid){
          const gasUsd=update.gasUsd||update.gasMon*(this.state.lastBook?.mid??update.intent.orders[0]?.price??0);
          const cost={txHash:update.txHash,gasMon:update.gasMon,gasUsd};
          this.journal.append("execution_cost",cost,name,this.now());this.journal.save(name,cost);
          this.state.totals.gasMon+=update.gasMon;this.state.totals.gasUsd+=gasUsd;
          this.state.gasHistory.push({at:this.now(),usd:gasUsd});
        }
      }
      if(update.status==="confirmed"||update.status==="reverted"){
        this.pending.delete(update.operationId);
        if(update.status==="reverted")this.state.totals.reverted++;
        else{
          for(const id of update.canceledIds)this.orders.delete(id);
          for(const o of update.orders){const size=o.size-(this.state.filledSizes[o.id]??0);if(size>this.venue.sizeStep/2)this.orders.set(o.id,{...o,size});}
          this.state.totals.quotes+=update.intent.orders.length;
        }
      }else this.pending.set(update.operationId,update);
      // Receipt effects and their immediate executions are one recoverable transaction.
      for(const f of update.fills??[])this.applyFill(f);
      this.persist();
    });
    if(update.status==="unknown")this.latch("unknown_execution_outcome");
  }
  private applyFill(fill:ExecutionFill){
    if(!Number.isFinite(fill.size)||fill.size<=0||!Number.isFinite(fill.price)||fill.price<=0||!Number.isFinite(fill.feeUsd)||!Number.isFinite(fill.baseAdjustment??0)||Math.abs(fill.baseAdjustment??0)>fill.size||Math.abs(fill.feeUsd)>fill.size*fill.price)throw new Error("Invalid fill");
    this.journal.atomic(()=>{
      const {ts:observedAt,...identity}=fill;
      if(!this.journal.append("fill",identity,`fill:${fill.id}`,observedAt))return;
      const p=this.state.position,signed=fill.side==="buy"?fill.size:-fill.size;
      let realized=0,closedQuantity=0,closedFeesUsd=0;
      if(!p||Math.sign(p)===Math.sign(signed)){
        this.state.costUsd+=signed*fill.price;
        this.state.openEntryFeesUsd+=fill.feeUsd;
      }
      else{const close=Math.min(Math.abs(p),Math.abs(signed))*Math.sign(signed),entry=this.state.costUsd/p;
        closedQuantity=Math.abs(close);
        // Fee carry is only for classifying closes. Ledger fees remain charged once
        // below, including signed rebates and fees paid through base adjustments.
        const entryFees=this.state.openEntryFeesUsd*(closedQuantity/Math.abs(p));
        const exitFees=fill.feeUsd*(closedQuantity/fill.size);
        closedFeesUsd=entryFees+exitFees;
        this.state.openEntryFeesUsd=this.state.openEntryFeesUsd-entryFees+(fill.feeUsd-exitFees);
        realized=-close*(fill.price-entry);this.state.totals.realizedUsd+=realized;
        this.state.costUsd+=close*entry+(signed-close)*fill.price;}
      this.state.position+=signed;
      // Base-denominated fees/rebates change tokens held without consuming more of the
      // resting order. Their economic value is already included once in signed feeUsd.
      this.state.position+=fill.baseAdjustment??0;
      this.state.costUsd+=(fill.baseAdjustment??0)*fill.price;
      if(this.state.position===0){
        // A base fee can exactly consume a gross opening/reversal remainder.
        // Its fee obligation is realized here rather than lost when inventory is flat.
        closedFeesUsd+=this.state.openEntryFeesUsd;this.state.openEntryFeesUsd=0;
        this.state.position=0;this.state.costUsd=0;this.state.positionOpenedAtMs=null;
      }
      else if(!p||Math.sign(p)!==Math.sign(this.state.position))this.state.positionOpenedAtMs=fill.ts;
      const netClosedUsd=realized-closedFeesUsd;
      if(!Number.isFinite(this.state.openEntryFeesUsd)||!Number.isFinite(netClosedUsd))throw new Error("Invalid fill fee allocation");
      if(closedQuantity>0||this.state.position===0)
        this.state.consecutiveLosses=netClosedUsd<0?this.state.consecutiveLosses+1:0;
      this.state.filledSizes[fill.orderId]=(this.state.filledSizes[fill.orderId]??0)+fill.size;
      const order=this.orders.get(fill.orderId);if(order){order.size-=fill.size;if(order.size<this.venue.sizeStep/2)this.orders.delete(order.id);}
      this.state.totals.fills++;this.state.totals.feesUsd+=fill.feeUsd;this.persist();
    });
    if(this.state.consecutiveLosses>=3)this.latch("three_consecutive_losses");
  }
  private async recover(){
    if(this.journal.failed||this.recovering||this.pending.size||!this.state.killed||!this.state.lastBook)return;
    this.recovering=true;
    try{
      const book=this.state.lastBook,bookAt=this.state.lastBookAt,sourceBlock=book.block,now=this.now(),position=this.state.position;
      const cancelIds=[...this.orders.keys()];let orders:OrderSpec[]=[];
      const fresh=now-this.state.lastBookAt<this.settings.maxDataAgeMs;
      if(!cancelIds.length&&position!==0&&fresh){
        const size=Math.floor(Math.min(Math.abs(position),this.settings.tradeSizeMon)/this.venue.sizeStep)*this.venue.sizeStep;
        if(size>=this.venue.minSize){const side=position>0?"sell":"buy";
          const raw=side==="sell"?book.bid*(1-this.settings.slippageBps/10000):book.ask*(1+this.settings.slippageBps/10000);
          const price=(side==="sell"?Math.floor(raw/this.venue.tickSize):Math.ceil(raw/this.venue.tickSize))*this.venue.tickSize;
          orders=[{side,price,size}];}
      }
      if(!orders.length&&!cancelIds.length)return;
      const intent:ExecutionIntent={operationId:digest({session:this.sessionId,kill:this.state.killAt,block:this.newestBlock,cancelIds,orders}),
        sessionId:this.sessionId,snapshotId:this.lastSnapshot?.id??"recovery",block:this.newestBlock,createdAtMs:now,
        deadlineMs:now+this.settings.maxDataAgeMs,orders,cancelIds,postOnly:false,reduceOnly:true};
      // Recovery may only cancel known orders or reduce an independently tracked position.
      const update=await this.venue.submit(intent,book,{
        stillValid:()=>!this.journal.failed&&!!this.state.killed&&this.state.position===position&&(!orders.length||
          (this.state.lastBook?.block===sourceBlock&&this.now()-bookAt<this.settings.maxDataAgeMs&&orders[0]!.size<=Math.abs(this.state.position))),
        beforeBroadcast:p=>this.journal.atomic(()=>{this.journal.append("recovery_intent",p,`intent:${p.operationId}`,this.now());this.pending.set(p.operationId,p);this.persist();}),
      });
      this.applyUpdate(update);
    }catch(error){this.journal.append("recovery_unresolved",{error:error instanceof Error?error.message:"Unknown",position:this.state.position,pending:this.pending.size},undefined,this.now());}
    finally{this.recovering=false;this.persist();}
  }
  private emit(block:number,update:ExecutionUpdate|null,timing:Timing){
    const b=this.state.lastBook!,d=this.lastBattery,s=this.lastSnapshot;
    const q:Quote[]=update?.intent.orders.map((o,i)=>({...o,txHash:update.txHash,gasMon:i?0:update.gasMon,cancel:update.intent.cancelIds.map(Number).filter(Number.isFinite),
      status:this.venue.dryRun?"sim":update.status==="confirmed"?"placed":update.status==="reverted"?"reverted":update.status==="unknown"?"lost":"sent",
      orderId:update.orders[i]?Number(update.orders[i]!.id):null,capped:false}))??[];
    const late=this.newestBlock!==block||this.now()-this.state.lastBookAt>this.settings.decisionDeadlineMs||d!==null&&this.now()>=d.validUntilMs;
    const event:BlockEvent={block,ts:this.now(),mid:b.mid,bestBid:b.bid,bestAsk:b.ask,spreadBps:b.spreadBps,
      decision:d?{action:late?"hold":d.direction.choice==="up"?"buy":d.direction.choice==="down"?"sell":"hold",
        probabilities:{buy:d.direction.probabilities.up,sell:d.direction.probabilities.down,hold:d.direction.probabilities.neutral},
        upIn10:d.direction.probabilities.up,latencyMs:d.latencyMs,late}:null,
      quote:q[0]??null,quotes:q,fill:null,resting:{bidMon:this.exposure().filter(o=>o.side==="buy").reduce((n,o)=>n+o.size,0),askMon:this.exposure().filter(o=>o.side==="sell").reduce((n,o)=>n+o.size,0)},
      position:{side:this.state.position>0?"long":this.state.position<0?"short":"flat",size:Math.abs(this.state.position),
        entryPrice:this.state.position?this.state.costUsd/this.state.position:null,unrealizedUsd:this.unrealized(b.mid),unrealizedMon:this.unrealized(b.mid)/b.mid},
      totals:this.mark(b.mid),policy:this.lastPolicy,risk:this.lastRisk,
      evidence:{sessionId:this.sessionId,snapshotId:s?.id??null,modelId:d?.modelId??this.model.name,source:d?.source??"none",calibration:d?.calibration??"unverified"},
      health:{state:this.state.killed?"kill_recovery_pending":this.pending.size?"reconciling":s?.readiness.ready?"ready":"warming_up",
        reason:this.state.killed,pending:this.pending.size,apiErrors:this.state.apiErrors,missing:s?.readiness.missing??[]}};
    this.journal.append("decision_triple",{snapshot:s,decision:d,policy:this.lastPolicy,risk:this.lastRisk,event},`decision:${this.sessionId}:${block}`,event.ts);
    this.journal.append("block",{...event,source:this.options.sourceLabel??(this.venue.dryRun?"real-market-paper":"live")},`block:${this.sessionId}:${block}`,event.ts);
    this.history.push(event);if(this.history.length>this.settings.historySize)this.history.shift();this.options.onEvent?.(event,timing);
  }
  async close(){
    this.closed=true;this.latch("shutdown");
    const until=Date.now()+2*this.settings.rpcTimeoutMs+this.settings.decisionDeadlineMs+1000;
    while((this.busy||this.recovering)&&Date.now()<until)await Bun.sleep(10);
    if(this.busy||this.recovering)throw new Error("Shutdown waiting for unresolved I/O; checkpoint retained");
    await this.recover();this.venue.close?.();this.journal.close();
  }
}
