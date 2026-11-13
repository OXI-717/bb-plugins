/** Interactive visual preview; synthetic state only, no Pooler or provider calls. */
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NativeAccountCard,NativeAccountSettings} from '../native-account-settings';
import {accountSettingsCss} from '../account-settings-style';
import type {NativeAccounts} from '../src/native-accounts';
const projects=async()=>[{id:'example-project',name:'Пример проекта'}];
function Preview(){
  const [account,setAccount]=useState<NativeAccounts['accounts'][number]>({accountId:'example-subscription',label:'person@example.com',role:'reserve',priority:10,projects:{onlySelected:true,rules:[{projectId:'example-project',role:'reserve'}]},projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[{id:'example-server',hostId:'example-host',enabled:false,autopilotAllowed:false}],active:0,queued:0,uncertain:0});
  return <><style>{accountSettingsCss}</style><p>Предпросмотр · вымышленные данные · без запросов Google</p><h1>Antigravity</h1><NativeAccountCard account={account} open={()=>document.getElementById('settings')?.scrollIntoView()} loadProjects={projects}/><main id="settings" className="pool-settings"><h2>Настройки аккаунта</h2><NativeAccountSettings account={account} revision={'b'.repeat(64)} loadProjects={projects} save={async({accountId,expectedRevision,executor,...patch})=>setAccount(current=>({...current,...patch,executors:current.executors.map(e=>e.id===executor?.id?{...e,...executor}:e)}))} probe={async input=>({...input,status:'runtime-unavailable',verified:false,observedAt:Date.now(),catalog:[]})}/></main></>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
