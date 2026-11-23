/** Render the actual update controls with synthetic operation states. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {PoolSelectedAccounts, PoolTechnicalDetails, PoolUpdateView} from '../pool-update-panel';
(globalThis as typeof globalThis & {React:typeof React}).React=React;
const base={operationId:'11111111-1111-4111-8111-111111111111',startedAt:1,hostId:'host-one',terminalId:'terminal-one'};
const content=<main data-bb-plugin="account-pool-balanced" className="space-y-6">
  <PoolUpdateView operation={null} busy={false} error={null} onStart={()=>{}}/>
  <PoolUpdateView operation={{...base,state:'running'}} busy={true} error={null} onStart={()=>{}}/>
  <PoolUpdateView operation={{...base,state:'succeeded'}} busy={false} error={null} onStart={()=>{}}/>
  <PoolUpdateView operation={{...base,state:'succeeded',alreadyCurrent:true}} busy={false} error={null} onStart={()=>{}}/>
  <PoolUpdateView operation={{...base,state:'unknown'}} busy={true} error={null} onStart={()=>{}}/>
  <PoolUpdateView operation={null} busy={true} statusUnavailable error="Could not check update status. Starting is unavailable for now." onStart={()=>{}}/>
  <PoolSelectedAccounts accounts={[
    {provider:'Codex',account:'long-account-address@example.com'},
    {provider:'Antigravity',account:"Selected for the session"},
    {provider:'Claude',account:"Not selected"},
  ]}/>
  <PoolTechnicalDetails>
    Hub accepting · 3 active · used by worker-1, worker-2, scheduler
  </PoolTechnicalDetails>
</main>;
const css=readFileSync(new URL('../dist/app.css',import.meta.url),'utf8');
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pool update controls</title><style>'+css+'body{font-family:system-ui;margin:24px auto;padding:0 16px;max-width:760px;background:#fff;color:#202124;--border:#d9dde3;--muted-foreground:#596575;--primary:#272a30;--primary-foreground:#fff;--foreground:#202124;--background:#fff;--radius:.5rem}</style>'+renderToStaticMarkup(content)+'</html>');
