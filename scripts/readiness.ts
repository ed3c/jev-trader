import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
const args=process.argv.slice(2);
const arg=(name:string,fallback?:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
if(args.includes("--help")){console.log("bun run readiness --db data/engine.sqlite --backtest accepted-backtest.json [--out data/readiness.json]");process.exit(0);}
const path=arg("--db","data/engine.sqlite")!,out=arg("--out","data/readiness.json")!;
const db=new Database(path,{readonly:true});
const checkpoint=(db.query("SELECT payload FROM state WHERE name='engine'").get() as {payload:string}|null);
if(!checkpoint)throw new Error("No engine evidence");
const state=JSON.parse(checkpoint.payload);
const stats=db.query("SELECT MIN(ts) first,MAX(ts) last,COUNT(DISTINCT date(ts/1000,'unixepoch')) days,COUNT(*) count FROM events WHERE kind='block'").get() as any;
const sources=db.query("SELECT DISTINCT json_extract(payload,'$.source') source FROM events WHERE kind='block'").all() as {source:string}[];
const violations=db.query("SELECT COUNT(*) count FROM events WHERE kind IN ('kill','recovery_unresolved')").get() as {count:number};
const backtestPath=arg("--backtest");
let backtest:any=null,backtestSha256:string|null=null;
if(backtestPath){const bytes=await Bun.file(backtestPath).arrayBuffer();backtest=JSON.parse(new TextDecoder().decode(bytes));backtestSha256=createHash("sha256").update(new Uint8Array(bytes)).digest("hex");}
const range=backtest?.expectedPaperReturnRange;
const returnFraction=state.totals.pnlUsd/state.bankrollUsd;
const backtestValid=backtest?.version===1&&backtest?.source==="historical"&&backtest?.historyYears>=3&&backtest?.trades>=30&&
  backtest?.recentYearReturn>0&&backtest?.parameterStabilityPassed===true&&typeof backtest?.datasetSha256==="string"&&/^[a-f0-9]{64}$/.test(backtest.datasetSha256);
const matchesBacktest=!!(backtestValid&&range&&[range.min,range.max,range.days].every(Number.isFinite)&&range.min<=range.max&&
  range.days===stats.days&&returnFraction>=range.min&&returnFraction<=range.max);
const paperEvidence={startedAtMs:stats.first??0,endedAtMs:stats.last??0,observedDays:stats.days,
  source:sources.length===1&&sources[0]!.source==="real-market-paper"?"real-market-paper":"unverified",
  orders:state.totals.quotes,fills:state.totals.fills,unresolvedOperations:state.pending.length,ruleViolations:violations.count,matchesBacktest};
const checks={realMarket:paperEvidence.source==="real-market-paper",fourteenDays:stats.days>=14&&stats.last-stats.first>=14*86400_000,
  sufficientOrders:state.totals.quotes>=30,sufficientFills:state.totals.fills>=30,cleanOperations:state.pending.length===0&&violations.count===0,
  backtestValid,matchesBacktest};
const report={version:1,generatedAtMs:Date.now(),sessionId:state.sessionId,strategyHash:state.strategyHash,
  eligible:Object.values(checks).every(Boolean),checks,paperEvidence,returnFraction,backtestSha256,
  note:"Historical data provenance and the declared expectation range remain operator-reviewed research evidence. No report changes trading mode."};
await Bun.write(out,JSON.stringify(report,null,2)+"\n");
const bytes=await Bun.file(out).arrayBuffer();console.log(JSON.stringify({report:out,sha256:createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),...report},null,2));db.close();
