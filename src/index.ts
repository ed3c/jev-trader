import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { startServer } from "./server";
import { KuruSource,KuruVenue } from "./execution/kuru";
import { PaperVenue } from "./execution/paper";

const market=new Market();
await market.init();
const source=new KuruSource(market);
const venue=config.dryRun?new PaperVenue(b=>source.read(b),source.tickSize,source.minSize,source.sizeStep,config.makerFeeBps,
  (config.gasLimit??config.gasLimitFallback)*config.maxFeeGwei/1e9):new KuruVenue(source);
const model=createModel();
let server:ReturnType<typeof startServer>|undefined;
const trader=new Trader(venue,model,{onEvent:e=>server?.broadcast(e),onAlert:a=>console.error(JSON.stringify({event:"kill_alert",...a}))});
console.log(JSON.stringify({event:"session",sessionId:trader.sessionId,strategyHash:trader.status().strategyHash,mode:config.dryRun?"paper":"live"}));
await trader.initialize();
server=startServer({model:model.name,wallet:venue.address,dryRun:venue.dryRun,market:config.market,startedAt:Date.now()},()=>trader.history,
  {status:()=>trader.status(),kill:r=>trader.halt(r),audit:()=>trader.journal.records()});
const feed=startBlockFeed(block=>{void trader.onBlock(block).catch(()=>trader.halt("unhandled_loop_error"));});
const watchdog=setInterval(()=>{void trader.watchdog();},Math.min(250,config.maxDataAgeMs/2));
console.log(`Dashboard: ${server.url}dashboard`);
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;feed.stop();clearInterval(watchdog);await trader.close();server?.stop();}
process.on("SIGINT",()=>{void shutdown();});process.on("SIGTERM",()=>{void shutdown();});
