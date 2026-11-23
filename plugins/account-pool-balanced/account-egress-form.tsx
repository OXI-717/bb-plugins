import {Button} from './ui/components/ui/button';
import React,{useEffect,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {z} from 'zod';
import type {egressDisplayStateSchema} from './src/account-egress.js';
import type {PoolProvider} from './src/contracts.js';
import type {accountPoolRpcContract} from './src/rpc.js';
type Snapshot=z.output<typeof egressDisplayStateSchema>;

export function EgressControl({accountId,provider,state,pending,error,save}:{
 accountId:string;provider:PoolProvider;state:Snapshot|null;pending:boolean;error:string;
 save:(ref:{id:string;version:number}|null)=>void;
}){
 const ref=state?.bindings[accountId];
 const supported=provider==='claude'||provider==='codex';
 const selected=state?.profiles.find(p=>p.id===ref?.id&&p.version===ref?.version);
 const latestProfiles = new Map<string, Snapshot['profiles'][number]>();
 for (const profile of state?.profiles ?? []) {
   const latest = latestProfiles.get(profile.id);
   if (!latest || profile.version > latest.version) latestProfiles.set(profile.id, profile);
 }
 const latestSelected = ref && latestProfiles.get(ref.id);
 return <section className="pool-settings-section">
   <label className="pool-settings-field"><span>Выходной профиль</span>
     <select className="pool-settings-control pool-settings-wide" aria-label="Выходной профиль" disabled={!state||pending||!supported}
       value={latestSelected?.id ?? ''} onChange={event=>{
         const {value} = event.currentTarget;
         if (value === '') {
           save(null);
           return;
         }
         const profile = latestProfiles.get(value);
         if (profile) save({id:profile.id,version:profile.version});
       }}>
       <option value="">Текущий маршрут Pooler</option>
       {Array.from(latestProfiles.values(), profile=>
         <option key={profile.id} value={profile.id}>
           {state?.displayNames?.[`${profile.id}:${profile.version}`] ?? profile.label}
         </option>
       )}
     </select>
   </label>
   <p className="pool-settings-help">{supported?'Изменение применяется к новым разговорам. Начатые продолжают по прежнему маршруту.':'Для официального клиента этого провайдера поддержка транспорта ещё не подтверждена.'}</p>
   {supported && selected && latestSelected && selected.version < latestSelected.version &&
     <Button size="sm" type="button" disabled={pending}
       onClick={()=>save({id:latestSelected.id,version:latestSelected.version})}>Применить актуальную конфигурацию</Button>}
   {selected?.transport==='http-connect'&&<p className="pool-settings-help">Прокси: {selected.endpoint}</p>}
   {selected&&<p className="pool-settings-help">Поддерживаемые хосты: {selected.hostIds.join(', ')}. При отказе запрос завершается. Фактический адрес и ответ провайдера не проверены.</p>}
   {error&&<p role="alert">{error}</p>}
 </section>;
}
export function ProxyControl({pending,save}:{pending:boolean;save:(url:string)=>Promise<void>}){
 const [url,setUrl]=useState('');
 return <form className="pool-settings-section" onSubmit={async event=>{event.preventDefault();try{await save(url);}finally{setUrl('');}}}>
   <label className="pool-settings-field"><span>HTTP/HTTPS-прокси аккаунта</span>
     <input className="pool-settings-control" style={{width:'100%'}} maxLength={4096} type="password" autoComplete="new-password" aria-label="Прокси аккаунта"
       placeholder="http://user:password@proxy.example:8080" value={url} disabled={pending} onChange={event=>setUrl(event.target.value)}/>
   </label>
   <p className="pool-settings-help">Адрес и пароль сохраняются на сервере. Модельные запросы, квоты и обновление входа идут через этот прокси. При отказе прямого обхода нет. SOCKS не поддерживается. Для новых разговоров; начатые сохраняют прежний маршрут.</p>
   <Button size="sm" type="submit" disabled={pending||!url.trim()}>Сохранить прокси</Button>
 </form>;
}
export function AccountEgressForm({accountId,provider}:{accountId:string;provider:PoolProvider}){
 const rpc=useRpc<typeof accountPoolRpcContract>();
 const [state,setState]=useState<Snapshot|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;rpc.call('egress.status',null).then(value=>{if(active)setState(value);}).catch(()=>{if(active)setError('Не удалось получить профили выхода.');});return()=>{active=false;};},[accountId]);
 return <><EgressControl accountId={accountId} provider={provider} state={state} pending={pending} error={error}
   save={async ref=>{setPending(true);setError('');try{await rpc.call('egress.bind',{accountId,ref});setState(await rpc.call('egress.status',null));}catch{setError('Не удалось сохранить профиль выхода.');}finally{setPending(false);}}}/>
   {(provider==='claude'||provider==='codex')&&<ProxyControl key={accountId} pending={pending||state===null} save={async url=>{
     setPending(true);setError('');try{await rpc.call('egress.proxy',{accountId,url});setState(await rpc.call('egress.status',null));}
     catch{setError('Не удалось сохранить прокси. Проверьте адрес HTTP/HTTPS.');}finally{setPending(false);}
   }}/>}</>;
}
