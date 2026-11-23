import {Button} from './ui/components/ui/button';
import React,{useEffect,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {AccountEgress} from './src/account-egress.js';
import type {PoolProvider} from './src/contracts.js';
import type {accountPoolRpcContract} from './src/rpc.js';
type Snapshot=ReturnType<AccountEgress['snapshot']>;

export function EgressControl({accountId,provider,state,pending,error,save}:{
 accountId:string;provider:PoolProvider;state:Snapshot|null;pending:boolean;error:string;
 save:(ref:{id:string;version:number}|null)=>void;
}){
 const ref=state?.bindings[accountId];
 const supported=provider==='claude'||provider==='codex';
 const selected=state?.profiles.find(p=>p.id===ref?.id&&p.version===ref?.version);
 return <section className="pool-settings-section">
   <label className="pool-settings-field"><span>Egress profile</span>
     <select className="pool-settings-control pool-settings-wide" aria-label="Egress profile" disabled={!state||pending||!supported}
       value={ref?`${ref.id}:${ref.version}`:''} onChange={event=>{
         const profile=state?.profiles.find(p=>`${p.id}:${p.version}`===event.target.value);
         save(profile?{id:profile.id,version:profile.version}:null);
       }}>
       <option value="">Current Pooler route</option>
       {state?.profiles.map(p=><option key={`${p.id}:${p.version}`} value={`${p.id}:${p.version}`}>{p.label} · version {p.version}</option>)}
     </select>
   </label>
   <p className="pool-settings-help">{supported?"Changes apply to new conversations. Existing conversations retain their account and route version.":"Transport support for this provider's official client has not been verified yet."}</p>
   {selected?.transport==='http-connect'&&<p className="pool-settings-help">Proxy: {selected.endpoint}</p>}
   {selected&&<p className="pool-settings-help">Supported hosts: {selected.hostIds.join(', ')}. Requests fail closed. The actual exit address and provider response have not been verified.</p>}
   {error&&<p role="alert">{error}</p>}
 </section>;
}
export function ProxyControl({pending,save}:{pending:boolean;save:(url:string)=>Promise<void>}){
 const [url,setUrl]=useState('');
 return <form className="pool-settings-section" onSubmit={async event=>{event.preventDefault();try{await save(url);}finally{setUrl('');}}}>
   <label className="pool-settings-field"><span>Account HTTP/HTTPS proxy</span>
     <input className="pool-settings-control" style={{width:'100%'}} maxLength={4096} type="password" autoComplete="new-password" aria-label="Account proxy"
       placeholder="http://user:password@proxy.example:8080" value={url} disabled={pending} onChange={event=>setUrl(event.target.value)}/>
   </label>
   <p className="pool-settings-help">The address and password stay on the server. Model requests, quotas and token refreshes use this proxy. There is no direct fallback. SOCKS is unsupported. New conversations use the new route; existing ones retain their route.</p>
   <Button size="sm" type="submit" disabled={pending||!url.trim()}>Save proxy</Button>
 </form>;
}
export function AccountEgressForm({accountId,provider}:{accountId:string;provider:PoolProvider}){
 const rpc=useRpc<typeof accountPoolRpcContract>();
 const [state,setState]=useState<Snapshot|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;rpc.call('egress.status',null).then(value=>{if(active)setState(value);}).catch(()=>{if(active)setError("Could not load egress profiles.");});return()=>{active=false;};},[accountId]);
 return <><EgressControl accountId={accountId} provider={provider} state={state} pending={pending} error={error}
   save={async ref=>{setPending(true);setError('');try{await rpc.call('egress.bind',{accountId,ref});setState(await rpc.call('egress.status',null));}catch{setError("Could not save the egress profile.");}finally{setPending(false);}}}/>
   {(provider==='claude'||provider==='codex')&&<ProxyControl key={accountId} pending={pending||state===null} save={async url=>{
     setPending(true);setError('');try{await rpc.call('egress.proxy',{accountId,url});setState(await rpc.call('egress.status',null));}
     catch{setError("Could not save the proxy. Check the HTTP/HTTPS address.");}finally{setPending(false);}
   }}/>}</>;
}
