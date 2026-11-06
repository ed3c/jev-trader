import { config } from "./config";

let requestId = 0;
/** Read calls can be retried by their caller. Transaction writes are never blindly retried. */
export async function rpc<T = unknown>(method: string, params: unknown[] = [], url = config.rpcUrl): Promise<T> {
  const id = ++requestId;
  const res = await fetch(url, {method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.timeout(config.rpcTimeoutMs)});
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json() as {id?:number;result?:T;error?:{code:number;message:string}};
  if (body.id !== id) throw new Error(`${method}: RPC response identity mismatch`);
  if (body.error) throw new Error(`${method}: RPC error ${body.error.code}`);
  if (!("result" in body)) throw new Error(`${method}: missing RPC result`);
  return body.result as T;
}

/** Bounded read-only batching, with one response identity for each request. */
export async function rpcBatch<T>(requests:{method:string;params:unknown[]}[],url=config.readRpcUrl):Promise<T[]>{
  if(!requests.length)return [];
  if(requests.length>100||requests.some(r=>!/^eth_(getBlockByNumber|getLogs|call)$/.test(r.method)))throw new Error("Invalid read-only RPC batch");
  const payload=requests.map(r=>({jsonrpc:"2.0",id:++requestId,...r}));
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(config.rpcTimeoutMs)});
  if(!response.ok)throw new Error(`RPC batch HTTP ${response.status}`);
  const values=await response.json() as {id:number;result?:T;error?:unknown}[];
  if(!Array.isArray(values)||values.length!==payload.length||new Set(values.map(v=>v.id)).size!==values.length)throw new Error("RPC batch response mismatch");
  const byId=new Map(values.map(v=>[v.id,v]));
  return payload.map(p=>{const v=byId.get(p.id);if(!v||v.error||!("result" in v))throw new Error("RPC batch missing result");return v.result as T;});
}

export interface FeedHealth { lastBlock:number; lastHeadAtMs:number; gaps:number; errors:number; connected:boolean }
/** Coalesced heads, single poll in flight, reconnect with backoff and explicit shutdown. */
export function startBlockFeed(onBlock:(block:number)=>void, pollMs=150,
  onHealth:(health:FeedHealth)=>void=()=>{}, options:{wsUrl?:string;readRpcUrl?:string}={}) {
  let last=0,newest=0,scheduled=false,stopped=false,polling=false,ws:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|null=null;
  const health:FeedHealth={lastBlock:0,lastHeadAtMs:0,gaps:0,errors:0,connected:false};
  const emit=(block:number)=>{
    if (!Number.isSafeInteger(block)||block<=0) throw new Error("Invalid block number");
    if (block<=last || stopped) return;
    if (last && block>last+1) health.gaps++;
    last=newest=block;health.lastBlock=block;health.lastHeadAtMs=Date.now();onHealth({...health});
    if (scheduled) return;scheduled=true;
    queueMicrotask(()=>{scheduled=false;if(!stopped)onBlock(newest);});
  };
  const poll=async()=>{
    if(polling||stopped)return;polling=true;
    try{emit(parseInt(await rpc<string>("eth_blockNumber",[],options.readRpcUrl??config.readRpcUrl),16));}
    catch{health.errors++;onHealth({...health});}finally{polling=false;}
  };
  const timer=setInterval(poll,pollMs);void poll();
  const wsUrl=options.wsUrl??config.wsUrl;
  const connect=(delay=0)=>{if(stopped||!wsUrl)return;reconnect=setTimeout(()=>{
    if(stopped)return;
    try {
      ws=new WebSocket(wsUrl);
      ws.onopen=()=>{health.connected=true;ws!.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_subscribe",params:["newHeads"]}));};
      ws.onmessage=e=>{try{const m=JSON.parse(String(e.data));if(m.method==="eth_subscription")emit(parseInt(m.params.result.number,16));}catch{health.errors++;}};
      ws.onclose=()=>{health.connected=false;onHealth({...health});connect(Math.min(delay+1000,10000));};
      ws.onerror=()=>ws?.close();
    } catch { health.errors++;connect(Math.min(delay+1000,10000)); }
  },delay);};
  connect();
  return {health:()=>({...health}),stop(){stopped=true;clearInterval(timer);if(reconnect)clearTimeout(reconnect);ws?.close();}};
}
