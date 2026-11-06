import { describe,test,expect } from "bun:test";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config";
import { checkLiveAuthorization,strategyHash,type LiveAuthorization } from "../src/engine/authorization";
import { Journal } from "../src/engine/journal";
import { quoteEconomics,replacementReason } from "../src/engine/economics";
import { startServer } from "../src/server";

test("a key alone cannot enable live trading, and malformed numeric budgets fail before wallet construction",()=>{
  expect(loadConfig({PRIVATE_KEY:"never-used"}).dryRun).toBe(true);
  expect(()=>loadConfig({MODE:"live",PRIVATE_KEY:"never-used"})).toThrow();
  for(const config of [{MAX_POSITION_MON:"NaN"},{MAX_API_ERRORS:"1.5"},{PORT:"Infinity"},{DECISION_DEADLINE_MS:"300"}])expect(()=>loadConfig(config)).toThrow();
});
test("gas is charged on zero fills and replacement lifetime prevents needless churn",()=>{
  const cost=quoteEconomics({bid:99,ask:101,mid:100,size:1,fillProbability:0,makerFeeBps:1,slippageBps:1,adverseSelectionBps:1,gasUsd:0.25,decisionUsd:0.01});
  expect(cost.netEdgeUsd).toBe(-0.26);
  expect(replacementReason({bid:99,ask:101,at:1000},{bid:98,ask:102},1100,500,3000,1)).toBeNull();
  expect(replacementReason({bid:99,ask:101,at:1000},{bid:99,ask:101},4000,500,3000,1)).toBe("quote_lifetime");
});
test("journal conflicting identities and atomic failures fail-stop instead of silently overwriting history",()=>{
  const j=new Journal(":memory:");j.append("fill",{size:2},"same");
  expect(j.append("fill",{size:2},"same")).toBe(false);
  expect(()=>j.append("fill",{size:3},"same")).toThrow();expect(j.failed).toBe(true);
  expect(()=>j.save("engine",{})).toThrow();j.close();
  const k=new Journal(":memory:");k.save("v",{n:1});
  expect(()=>k.atomic(()=>{k.save("v",{n:2});throw new Error("disk failure simulation");})).toThrow();
  expect(k.load<{n:number}>("v")).toEqual({n:1});expect(k.failed).toBe(true);k.close();
});
test("a live grant binds the actual paper artifact, strategy, account, session, expiry and notional",()=>{
  const dir=mkdtempSync(join(tmpdir(),"jev-auth-")),now=2_000_000_000_000;
  try{
    const c=loadConfig({MODE:"live",LIVE_TRADING_ENABLED:"true",PRIVATE_KEY:"not-a-key",LIVE_AUTHORIZATION_FILE:join(dir,"grant.json")});
    const evidence={startedAtMs:now-20*86400_000,endedAtMs:now-86400_000,observedDays:19,source:"real-market-paper" as const,
      orders:50,fills:40,unresolvedOperations:0,ruleViolations:0,matchesBacktest:true};
    const report={version:1,eligible:true,sessionId:"paper",strategyHash:strategyHash(c),generatedAtMs:now-10000,paperEvidence:evidence};
    const bytes=JSON.stringify(report);writeFileSync(join(dir,"report.json"),bytes);
    const grant:LiveAuthorization={version:1,approved:true,sessionId:"live",wallet:"0xabc",market:c.market,strategyHash:strategyHash(c),issuedAtMs:now-1000,
      expiresAtMs:now+60000,maxNotionalUsd:100,paperSessionId:"paper",paperEvidenceReportPath:join(dir,"report.json"),
      paperEvidence:{...evidence,reportSha256:createHash("sha256").update(bytes).digest("hex")}};
    const save=()=>writeFileSync(c.liveAuthorizationFile!,JSON.stringify(grant));save();
    expect(checkLiveAuthorization(c,"live","0xabc",now,50)?.approved).toBe(true);
    expect(()=>checkLiveAuthorization(c,"other","0xabc",now,50)).toThrow();
    expect(()=>checkLiveAuthorization(c,"live","0xdef",now,50)).toThrow();
    expect(()=>checkLiveAuthorization(c,"live","0xabc",now,101)).toThrow();
    expect(()=>checkLiveAuthorization(c,"live","0xabc",now,NaN)).toThrow();
    expect(()=>checkLiveAuthorization({...c,horizonBlocks:c.horizonBlocks+1},"live","0xabc",now,50)).toThrow();
    writeFileSync(join(dir,"report.json"),JSON.stringify({...report,strategyHash:"wrong"}));
    grant.paperEvidence.reportSha256=createHash("sha256").update(JSON.stringify({...report,strategyHash:"wrong"})).digest("hex");save();
    expect(()=>checkLiveAuthorization(c,"live","0xabc",now,50)).toThrow();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("HTTP control is authenticated and reports unresolved recovery rather than a false flat result",async()=>{
  const c=loadConfig({PORT:"0",CONTROL_TOKEN:"test-control-token"});let killed=false;
  const server=startServer({model:"mock",wallet:null,dryRun:true,market:"test",startedAt:Date.now()},()=>[],{
    status:()=>({state:killed?"kill_recovery_pending":"ready",reason:killed?"kill":null,position:10,pending:[],totals:{pnlUsd:0}}),
    kill:async()=>{killed=true;},audit:()=>[]},c);
  try{
    const url=server.url;
    expect((await fetch(new URL("/control/kill",url),{method:"POST"})).status).toBe(401);expect(killed).toBe(false);
    const accepted=await fetch(new URL("/control/kill",url),{method:"POST",headers:{authorization:"Bearer test-control-token"}});
    expect(accepted.status).toBe(200);expect((await accepted.json() as any).status.state).toBe("kill_recovery_pending");
    expect((await fetch(new URL("/healthz",url))).status).toBe(503);
    expect((await fetch(new URL("/audit",url))).status).toBe(401);
  }finally{server.stop();}
});
