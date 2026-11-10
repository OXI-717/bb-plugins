/** Render the native subscription project controls with synthetic metadata. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AccountProjectsForm} from '../account-projects-form';
import {accountSettingsCss} from '../account-settings-style';
(globalThis as typeof globalThis & {React: typeof React}).React=React;
const loadProjects=async()=>[{id:'project-one',name:'Example project'}];
const content=<><h1>Google · Antigravity</h1><div className="pool-settings">
<AccountProjectsForm account={{role:'primary',projects:{onlySelected:false,rules:[]}}} showRoles={false} loadProjects={loadProjects} save={async()=>{}}/>
<h2>Только выбранные проекты</h2>
<AccountProjectsForm account={{role:'primary',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]}}} showRoles={false} loadProjects={loadProjects} save={async()=>{}}/>
</div></>;
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native subscription projects</title><style>'+accountSettingsCss+'body{font-family:system-ui;margin:24px auto;padding:0 16px;max-width:560px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}</style>'+renderToStaticMarkup(content)+'</html>');
