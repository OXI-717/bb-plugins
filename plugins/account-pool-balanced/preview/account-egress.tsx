/** Render real account-card controls with synthetic metadata for visual review. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProxyControl,EgressControl} from '../account-egress-form';
import {accountSettingsCss} from '../account-settings-style';
const accountId='11111111-1111-4111-8111-111111111111';
const state={schema:1 as const,profiles:[{id:'exit-one',version:1,label:'Prepared exit',node:'node-one',hostIds:['server-one'],transport:'ssh-connect' as const,endpoint:'http://127.0.0.1:19081',dns:'remote' as const,ipv4:true as const,ipv6:false as const,failure:'closed' as const,expectedExit:['192.0.2.1'],assurance:'proxy-enforced' as const}],bindings:{[accountId]:{id:'exit-one',version:1}},pins:{}};
const content=<><h1>Выходной профиль аккаунта</h1><div className="pool-settings">
  <h2>Центральный маршрут</h2><EgressControl accountId={accountId} provider="claude" state={state} pending={false} error="" save={()=>{}}/>
  <ProxyControl pending={false} save={async()=>{}}/><h2>Официальный native клиент</h2><EgressControl accountId={accountId} provider="agy" state={{...state,bindings:{}}} pending={false} error="" save={()=>{}}/>
  <h2>Нет данных</h2><EgressControl accountId={accountId} provider="codex" state={null} pending={false} error="Не удалось получить профили выхода." save={()=>{}}/>
</div></>;
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account egress preview</title><style>'+accountSettingsCss+'body{font-family:system-ui;margin:24px auto;padding:0 16px;max-width:560px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}</style>'+renderToStaticMarkup(content)+'</html>');
