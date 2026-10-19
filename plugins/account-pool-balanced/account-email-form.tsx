import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {Button} from './ui/components/ui/button';

export function AccountEmailForm({email,save,onUnsavedChange}:{email:string|null;save:(email:string|null,expectedEmail:string|null)=>Promise<void>;onUnsavedChange:(value:boolean)=>void}){
 const [draft,setDraft]=useState(email??'');const [baseline,setBaseline]=useState(email);
 const [pending,setPending]=useState(false);const [error,setError]=useState('');const live=useRef(true);
 useEffect(()=>{live.current=true;return ()=>{live.current=false;};},[]);
 const dirty=draft!==(baseline??'');
 useEffect(()=>{onUnsavedChange(dirty||pending);},[dirty,pending,onUnsavedChange]);
 useEffect(()=>{if(!dirty&&!pending){setBaseline(email);setDraft(email??'');}},[email]);
 const submit=async()=>{
  const parsed=z.string().trim().email().max(254).nullable().safeParse(draft.trim()||null);
  if(!parsed.success){setError('Укажите корректный email.');return;}
  setPending(true);setError('');
  try{await save(parsed.data,baseline);if(live.current){setBaseline(parsed.data);setDraft(parsed.data??'');}}
  catch{if(live.current)setError('Не удалось сохранить email. Проверьте актуальные данные и повторите.');}
  finally{if(live.current)setPending(false);}
 };
 return <section className="pool-settings-section" aria-label="Email аккаунта">
  <label className="pool-settings-field">Email аккаунта
   <input aria-label="Email аккаунта" className="pool-settings-control" type="email" value={draft} maxLength={254} disabled={pending} onChange={e=>setDraft(e.target.value)}/>
  </label>
  <p className="pool-settings-help">Для API-ключа адрес указывается вручную. Провайдер его не подтверждает.</p>
  <Button size="sm" variant="outline" disabled={!dirty||pending} onClick={()=>void submit()}>{pending?'Сохраняем…':'Сохранить email'}</Button>
  <Button size="sm" variant="ghost" disabled={pending||(!dirty&&baseline===email)} onClick={()=>{setBaseline(email);setDraft(email??'');setError('');}}>Сбросить</Button>
  {error&&<p role="alert" className="pool-settings-error">{error}</p>}
 </section>;
}
