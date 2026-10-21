import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { startBrowserTransport, handoffBrowser, type TransportLaunch } from './browser-transport.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fixture(mode = '') {
 const root = await mkdtemp(path.join(tmpdir(), 'pool-shared-transport-')), executable = path.join(root, 'browser');
 await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),net=require('node:net'),args=process.argv.slice(2),root=args.find(a=>a.startsWith('--user-data-dir=')).slice(16);
if(!args.includes('--remote-debugging-pipe')) {
 fs.appendFileSync(root+'/selectors.jsonl',JSON.stringify(args)+'\\n');
 if(${JSON.stringify(mode)}==='no-target') process.exit(0);
 fs.appendFileSync(root+'/requests.jsonl',JSON.stringify({url:args.at(-1),profile:args.find(a=>a.startsWith('--profile-directory=')).slice(20)})+'\\n');process.exit(0);
}
fs.writeFileSync(root+'/pid',String(process.pid));fs.writeFileSync(root+'/capture',JSON.stringify({args,tz:process.env.TZ}));
const targets=new Map(),sessions=new Map();let input='',seq=0,seen=0;
const send=m=>fs.writeSync(4,JSON.stringify(m)+'\\0');
const pipe=new net.Socket({fd:3,readable:true,writable:false});pipe.on('end',()=>process.exit(0));
setInterval(()=>{let lines=[];try{lines=fs.readFileSync(root+'/requests.jsonl','utf8').trim().split('\\n');}catch{}
 for(const line of lines.slice(seen)){seen++;const r=JSON.parse(line),t={targetId:'t'+(++seq),type:'page',url:r.url,browserContextId:r.profile};targets.set(t.targetId,t);send({method:'Target.targetCreated',params:{targetInfo:t}});}
 if(fs.existsSync(root+'/close-pages')){fs.unlinkSync(root+'/close-pages');for(const targetId of targets.keys())send({method:'Target.targetDestroyed',params:{targetId}});targets.clear();}
},10);
pipe.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\0'))>=0){const m=JSON.parse(input.slice(0,end));input=input.slice(end+1);fs.appendFileSync(root+'/commands.jsonl',JSON.stringify(m)+'\\n');
 let result={};
 if(m.method==='Target.getTargets') result={targetInfos:[...targets.values()]};
 if(m.method==='Target.createTarget'){const t={targetId:'t'+(++seq),type:'page',url:m.params.url,browserContextId:'WRONG_DEFAULT'};targets.set(t.targetId,t);result={targetId:t.targetId};}
 if(m.method==='Target.attachToTarget'){sessions.set('s'+m.params.targetId,m.params.targetId);result={sessionId:'s'+m.params.targetId};}
 if(m.method==='Page.navigate'){const t=targets.get(sessions.get(m.sessionId));fs.appendFileSync(root+'/navigations.jsonl',JSON.stringify({profile:t?.browserContextId,url:m.params.url})+'\\n');if(t)t.url=m.params.url;result={frameId:'frame'};}
 if(m.method==='Browser.close')fs.writeFileSync(root+'/closed','yes');
 send({id:m.id,result,...(m.sessionId?{sessionId:m.sessionId}:{})});
}});setTimeout(()=>process.exit(0),15000);
`, { mode: 0o700 });
 const options: TransportLaunch & { profileDirectories: string[] } = { root, executable, socketPath:path.join(root,'control.sock'), profileDirectory:'Profile 1',profileDirectories:['Profile 1','Profile 2'],timezone:'UTC',url:'about:blank',settleMs:20,env:{PATH:process.env.PATH} };
 cleanup.push(async()=>{try{process.kill(Number(await readFile(root+'/pid','utf8')),'SIGTERM');}catch{}await delay(200);await rm(root,{recursive:true,force:true});});return options;
}
describe('shared profile transport',()=>{
 it('routes each secret URL to the selected native profile, not the current default',async()=>{
  const o=await fixture();await startBrowserTransport(o);
  await handoffBrowser({...o,profileDirectory:'Profile 2',url:'https://example.test/?state=synthetic-second'});
  await handoffBrowser({...o,url:'https://example.test/?state=synthetic-first'});
  const navigations=(await readFile(o.root+'/navigations.jsonl','utf8')).trim().split('\n').map(s=>JSON.parse(s));
  expect(navigations.map(n=>n.profile)).toEqual(['Profile 1','Profile 2','Profile 1']);
  expect(navigations[1].url).toContain('synthetic-second');
  expect(await readFile(o.root+'/selectors.jsonl','utf8')).not.toContain('state=');
  expect(await readFile(o.root+'/capture','utf8')).not.toContain('state=');
 });
 it('rejects unregistered profiles before spawning or sending navigation',async()=>{
  const o=await fixture();await startBrowserTransport(o);
  await expect(handoffBrowser({...o,profileDirectory:'Profile 99'})).rejects.toThrow(/profile/i);
  const selectors=(await readFile(o.root+'/selectors.jsonl','utf8')).trim().split('\n');expect(selectors).toHaveLength(1);
 });
 it('does not navigate the default account when the requested profile never appears',async()=>{
  const o=await fixture('no-target');await expect(startBrowserTransport(o)).rejects.toThrow();
  let lines='';try{lines=await readFile(o.root+'/navigations.jsonl','utf8');}catch{}expect(lines).toBe('');
 });
});
