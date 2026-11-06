import { loadConfig } from "../src/config";
import { PaperVenue } from "../src/execution/paper";
import { DeterministicDecisionProvider } from "../src/engine/decisions";
import { Journal } from "../src/engine/journal";
import { Trader } from "../src/trader";
import { startServer } from "../src/server";
import type { VenueFrame } from "../src/execution/types";

const args=process.argv.slice(2),serve=args.includes("--serve");
const get=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;};
const settings=loadConfig({MODE:"paper",MODEL:"mock",DATA_DIR:get("--data-dir","data/demo"),PORT:get("--port","3000"),
  TRADE_SIZE_MON:"800",MAX_POSITION_MON:"2000",MARGIN_MON:"1000",MIN_VOL_SAMPLES:"5",MIN_QUOTE_LIFE_MS:"900",
  MAX_QUOTE_LIFE_MS:"3000",REPRICE_BPS:"1",EXPECTED_FILL_PROBABILITY:"0.5",MIN_SPREAD_BPS:"20",MAX_GAS_USD_PER_HOUR:"20"});
let base=Date.now(),time=base,block=0;
const clock=()=>{time+=0.01;return time;};
const source=async(n:number):Promise<VenueFrame>=>{
  time=Math.max(time,base+n*300);const mid=0.02+Math.sin(n/12)*0.00003,bid=Math.floor((mid-0.00002)/0.000001)*0.000001,ask=Math.ceil((mid+0.00002)/0.000001)*0.000001;
  const tradeTime=clock(),observedAtMs=clock();
  return {book:{block:n,bid,ask,mid:(bid+ask)/2,spreadBps:(ask-bid)/((bid+ask)/2)*10000,imbalance:0,
    levels:{bids:[[bid,150],[bid-0.000001,300],[bid-0.000002,500]],asks:[[ask,150],[ask+0.000001,300],[ask+0.000002,500]]},depthBps:{}},
    observedAtMs,prints:[{id:`synthetic:${n}:buy`,block:n,ts:tradeTime,side:"buy",price:ask+0.00008,size:500},
      {id:`synthetic:${n}:sell`,block:n,ts:tradeTime,side:"sell",price:bid-0.00008,size:500}],fills:[],gap:false};
};
const journal=new Journal(`${settings.dataDir}/engine.sqlite`);
const saved=journal.load<{lastBlock:number;lastBookAt:number}>("engine");
if(saved){block=saved.lastBlock;base=Math.max(Date.now(),saved.lastBookAt+300)-block*300;time=base+block*300;}
const venue=new PaperVenue(source,0.000001,200,0.0000000001,0.5,0.001,"synthetic-paper");
const provider=new DeterministicDecisionProvider({clock});
let server:ReturnType<typeof startServer>|undefined;
const trader=new Trader(venue,provider,{config:settings,journal,clock,sourceLabel:"synthetic",onEvent:e=>server?.broadcast(e)});
await trader.initialize();
const count=Number(get("--blocks","200"));
if(!Number.isSafeInteger(count)||count<1||count>100_000)throw new Error("--blocks must be 1..100000");
if(serve){
  server=startServer({model:provider.name,wallet:null,dryRun:true,market:"synthetic MON-USDC",startedAt:Date.now()},()=>trader.history,
    {status:()=>trader.status(),kill:r=>trader.halt(r),audit:()=>journal.records()},settings);
  console.log(`SYNTHETIC PAPER ONLY: ${server.url}dashboard`);
  const timer=setInterval(()=>{time=Math.max(time,base+(block+1)*300);void trader.onBlock(++block);},300);
  const stop=async()=>{clearInterval(timer);await trader.close();server?.stop();};
  process.on("SIGINT",()=>{void stop();});process.on("SIGTERM",()=>{void stop();});
}else{
  for(let n=0;n<count;n++){time=Math.max(time,base+(block+1)*300);await trader.onBlock(++block);}
  const status=trader.status();
  console.log(JSON.stringify({financialPerformanceEvidence:false,...status,latestSnapshot:undefined},null,2));
  // A bounded simulation checkpoint can be resumed. No kill latch or invented real-market days.
  journal.close();
}
