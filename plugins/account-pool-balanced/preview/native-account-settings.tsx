/** Visual acceptance of the real native account controls, with synthetic state. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeAccountCard,NativeAccountSettings} from '../native-account-settings';
import {accountSettingsCss} from '../account-settings-style';
(globalThis as typeof globalThis&{React:typeof React}).React=React;
const account={accountId:'example-subscription',label:'person@example.com',role:'primary' as const,priority:1,
  projects:{onlySelected:false,rules:[{projectId:'example-project',role:'primary' as const}]},projectsRevision:'a'.repeat(64),mixedProjects:false,
  executors:[{id:'example-server',hostId:'example-host',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0};
const loadProjects=async()=>[{id:'example-project',name:'Example project'}];
const content=<><h1>Antigravity</h1><NativeAccountCard account={account} open={()=>{}} loadProjects={loadProjects}/><div className="pool-settings"><h2>Настройки · {account.label}</h2><NativeAccountSettings account={account} revision={'b'.repeat(64)} save={async()=>{}} probe={async input=>({...input,status:'runtime-unavailable',verified:false,observedAt:Date.now(),catalog:[]})} loadProjects={loadProjects}/></div></>;
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account settings preview</title><style>'+accountSettingsCss+'fieldset{border:0;margin:0;padding:0;min-width:0}button{cursor:pointer}body{font-family:system-ui;margin:24px auto;padding:0 16px;max-width:680px;color:#222;background:#fff}h1{font-size:22px}h2{font-size:18px;margin-top:28px}button,input,select{font:inherit}button{padding:6px 12px;border:1px solid #aaa;border-radius:6px;background:#fff}.flex{display:flex}.flex-wrap{flex-wrap:wrap}.justify-between{justify-content:space-between}.items-center{align-items:center}.gap-2{gap:8px}.space-y-2>*+*{margin-top:8px}.text-xs{font-size:13px}.text-muted-foreground{color:#666}.py-3{padding-block:12px}</style>'+renderToStaticMarkup(content)+'</html>');
