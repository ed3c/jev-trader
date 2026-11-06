import { buildSnapshot } from "../src/engine/state";
import { DeterministicDecisionProvider,JevDecisionProvider } from "../src/engine/decisions";
const live=process.argv.includes("--live");
if(process.argv.includes("--help")){console.log("bun run decision:smoke [--live]. Default: deterministic, offline. --live explicitly calls Jev with your environment key.");process.exit(0);}
const now=performance.timeOrigin+performance.now(),bookTs=now-10;
const snapshot=buildSnapshot({sessionId:"decision-smoke",symbol:"MON-USDC",block:1,decisionTs:now,
  book:{block:1,ts:bookTs,bid:0.01999,ask:0.02001,bids:[[0.01999,1000],[0.01998,2000],[0.01997,3000]],asks:[[0.02001,1000],[0.02002,2000],[0.02003,3000]]},
  mids:Array.from({length:30},(_,i)=>({ts:bookTs-(30-i)*300,mid:0.02+Math.sin(i/4)*0.000001})),trades:[],flowWindowStartMs:bookTs-9000,
  account:{inventory:0,equityUsd:10000,peakEquityUsd:10000,dayStartEquityUsd:10000,realizedPnlUsd:0,unrealizedPnlUsd:0,positionOpenedAtMs:null},
  health:{apiErrors:0,fillRatio:null,rejectRate:null,slippageBps:null,latenciesMs:[]}},{minVolSamples:20});
const provider=live?new JevDecisionProvider({modelId:process.env.JEV_MODEL_ID??"jev-1.14.0",timeoutMs:1000}):new DeterministicDecisionProvider();
console.log(JSON.stringify({source:live?"real-provider-on-synthetic-state":"offline-synthetic",decision:await provider.decide(snapshot)},null,2));
