import { readFileSync } from "node:fs";
import type { Config } from "../config";
import { digest } from "./journal";
import { createHash } from "node:crypto";

/** All exposure-changing configuration is covered by the explicit live session authorization. */
export function strategyHash(c:Config):string {
  return digest({version:1,market:c.market,chainId:c.chainId,model:c.model,modelId:c.jevModelId,
    tradeSize:c.tradeSizeMon,maxPosition:c.maxPositionMon,dailyLoss:c.maxDailyLossUsd,
    drawdown:c.maxDrawdownFraction,leverage:c.maxLeverage,maxAge:c.maxInventoryAgeMs,
    deadline:c.decisionDeadlineMs,stale:c.maxDataAgeMs,gamma:c.gamma,kappa:c.kappa,
    minSpread:c.minSpreadBps,horizon:c.quoteHorizonSeconds,fallback:c.deterministicFallback,
    fillProbability:c.expectedFillProbability,fees:c.makerFeeBps,slippage:c.slippageBps,
    adverse:c.adverseSelectionBps,minLife:c.minQuoteLifeMs,maxLife:c.maxQuoteLifeMs,
    reprice:c.repriceBps,minEdge:c.minNetEdgeUsd,gasBudget:c.maxGasUsdPerHour,
    horizonBlocks:c.horizonBlocks,maxApiErrors:c.maxApiErrors,minVolSamples:c.minVolSamples,
    gasLimit:c.gasLimit??c.gasLimitFallback,maxFeeGwei:c.maxFeeGwei,priorityFeeGwei:c.priorityFeeGwei,
    modelInputCost:c.jevUsdPerMTok,blockMs:c.blockMs,initialInventory:c.marginMon,bankrollUsd:c.bankrollUsd});
}
export interface LiveAuthorization {
  version:1;approved:true;sessionId:string;wallet:string;market:string;strategyHash:string;
  issuedAtMs:number;expiresAtMs:number;maxNotionalUsd:number;
  paperEvidenceReportPath:string;
  paperSessionId:string;
  paperEvidence:{startedAtMs:number;endedAtMs:number;observedDays:number;source:"real-market-paper";
    orders:number;fills:number;unresolvedOperations:number;ruleViolations:number;matchesBacktest:boolean;reportSha256:string};
}

/** An operator grants a bounded session, not arbitrary authority to a model or an alert. */
export function checkLiveAuthorization(c:Config,sessionId:string,wallet:string|null,now:number,notionalUsd:number):LiveAuthorization|null {
  if(!Number.isFinite(now)||now<0||!Number.isFinite(notionalUsd)||notionalUsd<0)throw new Error("Invalid authorization time/notional");
  if(c.dryRun)return null;
  if(!c.liveAuthorizationFile||!wallet)throw new Error("Missing live authorization");
  const a=JSON.parse(readFileSync(c.liveAuthorizationFile,"utf8")) as LiveAuthorization;
  const e=a.paperEvidence;
  if(typeof a.paperEvidenceReportPath!=="string"||!a.paperEvidenceReportPath)throw new Error("Paper evidence artifact required");
  const bytes=readFileSync(a.paperEvidenceReportPath);
  if(createHash("sha256").update(bytes).digest("hex")!==e?.reportSha256)throw new Error("Paper evidence artifact hash mismatch");
  const report=JSON.parse(bytes.toString("utf8")) as {version?:number;eligible?:boolean;strategyHash?:string;sessionId?:string;generatedAtMs?:number;paperEvidence?:Record<string,unknown>};
  if(report.version!==1||report.eligible!==true||report.strategyHash!==strategyHash(c)||report.strategyHash!==a.strategyHash||
     typeof a.paperSessionId!=="string"||report.sessionId!==a.paperSessionId||
     !Number.isFinite(report.generatedAtMs)||report.generatedAtMs!>a.issuedAtMs||
     !report.paperEvidence||Object.entries(e??{}).some(([key,val])=>key!=="reportSha256"&&report.paperEvidence![key]!==val))
    throw new Error("Paper evidence summary does not match the verified artifact");
  if(a.version!==1||a.approved!==true||a.sessionId!==sessionId||a.wallet?.toLowerCase()!==wallet.toLowerCase()||
     a.market?.toLowerCase()!==c.market.toLowerCase()||a.strategyHash!==strategyHash(c)||
     !Number.isFinite(a.issuedAtMs)||!Number.isFinite(a.expiresAtMs)||a.issuedAtMs>now||a.expiresAtMs<=now||
     a.expiresAtMs-a.issuedAtMs>24*3600_000||!Number.isFinite(a.maxNotionalUsd)||a.maxNotionalUsd<=0||notionalUsd>a.maxNotionalUsd)
    throw new Error("Live session authorization is missing, expired or does not match this strategy/account");
  if(!e||e.source!=="real-market-paper"||!Number.isFinite(e.startedAtMs)||!Number.isFinite(e.endedAtMs)||e.endedAtMs>a.issuedAtMs||
     e.endedAtMs-e.startedAtMs<14*86400_000||!Number.isInteger(e.observedDays)||e.observedDays<14||
     !Number.isFinite(e.orders)||e.orders<30||!Number.isFinite(e.fills)||e.fills<30||
     e.unresolvedOperations!==0||e.ruleViolations!==0||e.matchesBacktest!==true||!/^[a-f0-9]{64}$/.test(e.reportSha256))
    throw new Error("Live readiness requires at least 14 observed paper days, 30 fills, clean operations and backtest comparison");
  return a;
}
