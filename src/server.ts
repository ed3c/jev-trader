import { timingSafeEqual } from "node:crypto";
import { config, type Config } from "./config";
import type { BlockEvent } from "./trader";
import { dashboardHtml } from "./dashboard";
interface Meta {model:string;wallet:string|null;dryRun:boolean;market:string;startedAt:number}
interface Controls {status:()=>any;kill:(reason:string)=>Promise<void>;audit:()=>unknown}
export function startServer(meta:Meta,history:()=>BlockEvent[],controls?:Controls,settings:Config=config){
  const clients=new Set<ReadableStreamDefaultController<Uint8Array>>(),enc=new TextEncoder();
  const readCors={"access-control-allow-origin":"*"};
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...readCors,"content-type":"application/json","cache-control":"no-store"}});
  const send=(c:ReadableStreamDefaultController<Uint8Array>,type:string,data:unknown)=>{
    try{if(c.desiredSize!==null&&c.desiredSize<=0){clients.delete(c);c.close();return;}c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));}
    catch{clients.delete(c);}
  };
  const authorized=(req:Request)=>{const expected=settings.controlToken;if(!expected)return false;
    const got=req.headers.get("authorization")??"",want=`Bearer ${expected}`;
    const a=Buffer.from(got),b=Buffer.from(want);return a.length===b.length&&timingSafeEqual(a,b);};
  const server=Bun.serve({hostname:settings.host,port:settings.port,async fetch(req){
    const path=new URL(req.url).pathname;
    if(req.method==="OPTIONS")return new Response(null,{headers:{...readCors,"access-control-allow-methods":"GET"}});
    if(path==="/control/kill"){
      if(req.method!=="POST")return json({error:"method not allowed"},405);
      if(!authorized(req))return json({error:"control token required"},401);
      if(!controls)return json({error:"control unavailable"},503);
      await controls.kill("operator_http_kill");return json({accepted:true,status:controls.status()});
    }
    if(req.method!=="GET")return json({error:"method not allowed"},405);
    if(path==="/")return json({...meta,latest:history().at(-1)??null,engine:controls?.status()??null});
    if(path==="/dashboard")return new Response(dashboardHtml,{headers:{"content-type":"text/html; charset=utf-8","content-security-policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"}});
    if(path==="/history")return json(history());
    if(path==="/healthz"){
      const s=controls?.status();return json({alive:true,ready:s?.state==="ready",state:s?.state??"starting",reason:s?.reason??null},s?.reason?503:200);
    }
    if(path==="/metrics"){
      const s=controls?.status(),t=s?.totals??{};
      const metrics=[...Object.entries(t).filter(([,v])=>typeof v==="number"&&Number.isFinite(v)).map(([k,v])=>`jev_trader_${k.replace(/[A-Z]/g,m=>"_"+m.toLowerCase())} ${v}`),
        `jev_trader_pending_operations ${s?.pending?.length??0}`,`jev_trader_killed ${s?.reason?1:0}`];
      return new Response(metrics.join("\n")+"\n",{headers:{"content-type":"text/plain; version=0.0.4"}});
    }
    if(path==="/audit")return authorized(req)?json(controls?.audit()??[]):json({error:"control token required"},401);
    if(path==="/events"){
      if(clients.size>=100)return json({error:"stream capacity"},503);
      let client:ReadableStreamDefaultController<Uint8Array>|undefined;
      const stream=new ReadableStream<Uint8Array>({start(c){client=c;clients.add(c);send(c,"snapshot",{...meta,history:history(),engine:controls?.status()});},
        cancel(){if(client)clients.delete(client);}});
      return new Response(stream,{headers:{...readCors,"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"}});
    }
    return json({error:"not found"},404);
  }});
  const ping=setInterval(()=>clients.forEach(c=>send(c,"ping",Date.now())),15000);
  return {port:server.port,url:server.url,broadcast:(e:BlockEvent)=>clients.forEach(c=>send(c,"block",e)),
    stop(){clearInterval(ping);for(const c of clients){try{c.close();}catch{}}clients.clear();server.stop(true);}};
}
