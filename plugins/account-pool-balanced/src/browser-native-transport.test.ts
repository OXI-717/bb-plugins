import {mkdtemp,writeFile,readFile,rm,stat,access,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createServer,createConnection} from 'node:net';
import {afterEach,describe,it,expect} from 'vitest';
import {startBrowserTransport,handoffBrowser,type TransportLaunch} from './browser-transport.js';
const cleanup:Array<()=>Promise<void>>=[];const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'native-login-')),executable=path.join(root,'browser');
 await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs'),{fileURLToPath}=require('node:url'),args=process.argv.slice(2),root=args.find(a=>a.startsWith('--user-data-dir=')).slice(16);
let first=false;try{fs.writeFileSync(root+'/pid',String(process.pid),{flag:'wx'});first=true;}catch{}
const url=args.at(-1),doc=url.startsWith('file:')?fs.readFileSync(fileURLToPath(url),'utf8'):null;
if(doc){const ready=doc.match(/const ready="([^"]+)"/)[1],proxy=new URL(args.find(a=>a.startsWith('--proxy-server=')).slice(15));require('node:http').get({hostname:proxy.hostname,port:proxy.port,path:ready},r=>r.resume()).on('error',()=>{});}
fs.appendFileSync(root+'/calls',JSON.stringify({args,doc,tz:process.env.TZ,secret:process.env.SYNTHETIC_SECRET})+'\\n');
if(!first){setTimeout(()=>process.exit(fs.existsSync(root+'/fail')?3:0),30);}else setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000);
`,{mode:0o700});
 const o:TransportLaunch={root,executable,socketPath:path.join(root,'control.sock'),profileDirectory:'Profile 1',profileDirectories:['Profile 1','Profile 2'],timezone:'UTC',url:'about:blank',settleMs:150,env:{PATH:process.env.PATH,SYNTHETIC_SECRET:'synthetic'}};
 cleanup.push(async()=>{try{process.kill(Number(await readFile(root+'/pid','utf8')),'SIGTERM');}catch{}for(let i=0;i<100;i++){try{await access(o.socketPath);await delay(20);}catch{break;}}await rm(root,{recursive:true,force:true});});return o;
}
async function calls(o:TransportLaunch){for(let i=0;i<50;i++){try{return(await readFile(o.root+'/calls','utf8')).trim().split('\n').map(s=>JSON.parse(s));}catch{await delay(20);}}throw new Error('Missing browser capture');}
describe('interactive native browser transport',()=>{
 it('uses native profile startup without opening a blank or temporary startup tab',async()=>{
  const o=await fixture();
  const history=path.join(o.root,'History'),session=path.join(o.root,'Session');
  await writeFile(history,'synthetic-history');await writeFile(session,'synthetic-session');
  await startBrowserTransport(o);await calls(o);await handoffBrowser({...o,profileDirectory:'Profile 2'});
  const rows=await calls(o);expect(rows).toHaveLength(2);
  for(const row of rows){
   expect(row.args).not.toContain('--restore-last-session');
   expect(row.args.some((arg:string)=>arg==='about:blank'||arg.startsWith('file:'))).toBe(false);
   expect(row.doc).toBeNull();
  }
  expect(rows[1].args).toContain('--profile-directory=Profile 2');
  expect(await readFile(history,'utf8')).toBe('synthetic-history');
  expect(await readFile(session,'utf8')).toBe('synthetic-session');
 });
 it('rejects the old blank-start protocol before handing off a URL',async()=>{
  const o=await fixture();let received='';
  const server=createServer(s=>s.on('data',b=>{received+=b;s.write(JSON.stringify({protocol:4,navigation:'native-file',profiles:'native'})+'\n');}));
  await new Promise<void>(r=>server.listen(o.socketPath,r));await chmod(o.socketPath,0o600);
  cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
  await expect(handoffBrowser({...o,url:'https://example.test/private'})).rejects.toThrow(/reopen/);
  expect(received).not.toContain('private');
 });
 it('omits automation while preserving proxy, timezone and exact profile',async()=>{
  const o=await fixture();await startBrowserTransport(o);await calls(o);await handoffBrowser({...o,profileDirectory:'Profile 2'});const rows=await calls(o);expect(rows).toHaveLength(2);
  expect(rows[0].args).toContain('--profile-directory=Profile 1');expect(rows[1].args).toContain('--profile-directory=Profile 2');
  for(const row of rows){expect(row.args.join(' ')).not.toMatch(/remote-debugging|enable-automation|disable-blink-features/);expect(row.tz).toBe('UTC');expect(row.secret).toBeUndefined();}
  expect(rows[0].args).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');expect(rows[0].args.some((a:string)=>a.startsWith('--proxy-server=http://127.0.0.1:'))).toBe(true);
 });
 it('keeps links in private temporary files and cleans them on owned browser exit',async()=>{
  const o=await fixture();o.url='https://example.test/auth?state=synthetic-secret&next=</script>';await startBrowserTransport(o);await handoffBrowser({...o,profileDirectory:'Profile 2',url:'https://example.test/second'});
  const rows=await calls(o),files=rows.map(r=>fileURLToPath(r.args.at(-1)));
  for(const row of rows)expect(row.args).not.toContain('--restore-last-session');
  for(let i=0;i<rows.length;i++){expect(rows[i].args.join(' ')).not.toContain('https://');expect((await stat(files[i])).mode&0o777).toBe(0o600);expect((await stat(path.dirname(files[i]))).mode&0o777).toBe(0o700);expect(rows[i].doc).toContain('location.replace(');}
  expect(rows[0].doc).toContain('synthetic-secret');const expression=rows[0].doc.match(/location.replace\((.*)\)\)<\/script>/)[1];expect(JSON.parse(expression)).toBe(o.url);expect(rows[0].doc.match(/<\/script>/g)).toHaveLength(1);expect(rows[1].doc).toContain('example.test/second');process.kill(Number(await readFile(o.root+'/pid','utf8')),'SIGTERM');await delay(400);for(const file of files)await expect(access(file)).rejects.toThrow();
 });
 it('refuses unknown profiles and redacts failed launch diagnostics',async()=>{
  const o=await fixture();await startBrowserTransport(o);await expect(handoffBrowser({...o,profileDirectory:'Profile 99'})).rejects.toThrow(/profile/i);expect(await calls(o)).toHaveLength(1);
  await writeFile(o.root+'/fail','1');await expect(handoffBrowser({...o,url:'https://example.test/private'})).rejects.toThrow('Browser profile launch failed.');
 });
 it('retains IPv4 CONNECT transport and rejects IPv6 literal destinations',async()=>{
  const o=await fixture();await startBrowserTransport(o);const row=(await calls(o))[0];const port=Number(new URL(row.args.find((a:string)=>a.startsWith('--proxy-server=')).slice(15)).port);
  const upstream=createServer(s=>s.once('data',()=>s.end('synthetic-response')));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
  const send=(target:string)=>new Promise<string>((resolve,reject)=>{const s=createConnection({host:'127.0.0.1',port});let data='';const timer=setTimeout(()=>{s.destroy();reject(new Error('Proxy timeout'));},2500);s.on('connect',()=>s.write('CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\n\r\npayload'));s.on('data',b=>{data+=b;if(data.includes('synthetic-response')||data.includes('400'))s.destroy();});s.on('error',reject);s.on('close',()=>{clearTimeout(timer);resolve(data);});});
  expect(await send('127.0.0.1:'+(upstream.address() as any).port)).toContain('synthetic-response');expect(await send('[::1]:443')).toContain('400');
 });
 it('bounds outstanding private URL documents without affecting blank opens',async()=>{
  const o=await fixture();o.url='https://example.test/first';await startBrowserTransport(o);
  for(let i=1;i<32;i++)await handoffBrowser({...o,url:'https://example.test/'+i});
  await expect(handoffBrowser({...o,url:'https://example.test/overflow'})).rejects.toThrow(/busy/);
  await expect(handoffBrowser({...o,url:'about:blank'})).resolves.toBe(true);
 },20000);
 it('rejects protocol3 before sending a URL',async()=>{
  const o=await fixture();let received='';const server=createServer(s=>s.on('data',b=>{received+=b;s.write(JSON.stringify({protocol:3,navigation:'pipe',profiles:'native'})+'\n');}));await new Promise<void>(r=>server.listen(o.socketPath,r));await chmod(o.socketPath,0o600);cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
  await expect(handoffBrowser({...o,url:'https://example.test/private'})).rejects.toThrow(/reopen/);expect(received).not.toContain('private');
 });
 it('cleans a partially written owned document and keeps later navigation available',async()=>{
  const o=await fixture(),preload=o.root+'/partial-write.cjs';
  o.url='https://example.test/initial';
  await writeFile(preload,`const fs=require('node:fs'),open=fs.openSync,write=fs.writeFileSync,paths=new Map();let injected=false;fs.openSync=(file,...args)=>{const fd=open(file,...args);paths.set(fd,String(file));return fd;};fs.writeFileSync=(file,data,...args)=>{const name=typeof file==='number'?paths.get(file):String(file);if(name?.includes('/pool-browser-links-')&&String(data).includes('partial-marker')&&!injected){injected=true;write(file,String(data).slice(0,-8),...args);throw Object.assign(new Error('synthetic partial write'),{code:'ENOSPC'});}return write(file,data,...args);};`);
  o.env.NODE_OPTIONS='--require='+preload;await startBrowserTransport(o);const dir=path.dirname(fileURLToPath((await calls(o))[0].args.at(-1)));
  await expect(handoffBrowser({...o,url:'https://example.test/?state=partial-marker'})).rejects.toThrow();
  const names=await(await import('node:fs/promises')).readdir(dir);expect(names).toHaveLength(1);expect(await readFile(path.join(dir,names[0]),'utf8')).not.toContain('partial-marker');
  expect(await handoffBrowser({...o,url:'https://example.test/retry'})).toBe(true);
 });
 it('does not unlink a file whose exclusive creation failed',async()=>{
  const o=await fixture(),preload=o.root+'/collision.cjs';
  o.url='https://example.test/initial';
  await writeFile(preload,`const fs=require('node:fs'),open=fs.openSync,write=fs.writeFileSync;let count=0;fs.openSync=(file,...args)=>{if(String(file).includes('/pool-browser-links-')&&++count===2){const fd=open(file,...args);write(fd,'synthetic-existing-file');fs.closeSync(fd);throw Object.assign(new Error('synthetic collision'),{code:'EEXIST'});}return open(file,...args);};`);
  o.env.NODE_OPTIONS='--require='+preload;await startBrowserTransport(o);const dir=path.dirname(fileURLToPath((await calls(o))[0].args.at(-1)));
  await expect(handoffBrowser({...o,url:'https://example.test/collision'})).rejects.toThrow();
  const names=await(await import('node:fs/promises')).readdir(dir);expect(names).toHaveLength(2);expect(await Promise.all(names.map(n=>readFile(path.join(dir,n),'utf8')))).toContain('synthetic-existing-file');
 });
 it('retains the file-cap slot when partial-write cleanup is denied',async()=>{
  const o=await fixture(),preload=o.root+'/denied-cleanup.cjs';
  o.url='https://example.test/initial';
  await writeFile(preload,`const fs=require('node:fs'),open=fs.openSync,write=fs.writeFileSync,unlink=fs.unlinkSync,paths=new Map();let blocked;fs.openSync=(file,...args)=>{const fd=open(file,...args);paths.set(fd,String(file));return fd;};fs.writeFileSync=(file,data,...args)=>{const name=typeof file==='number'?paths.get(file):String(file);if(name?.includes('/pool-browser-links-')&&String(data).includes('partial-marker')){blocked=name;write(file,String(data).slice(0,-8),...args);throw Object.assign(new Error('synthetic partial write'),{code:'ENOSPC'});}return write(file,data,...args);};fs.unlinkSync=file=>{if(String(file)===blocked)throw Object.assign(new Error('synthetic cleanup denied'),{code:'EACCES'});return unlink(file);};`);
  o.env.NODE_OPTIONS='--require='+preload;await startBrowserTransport(o);
  await expect(handoffBrowser({...o,url:'https://example.test/?state=partial-marker'})).rejects.toThrow('Could not prepare browser navigation.');
  for(let i=0;i<30;i++)await handoffBrowser({...o,url:'https://example.test/'+i});
  await expect(handoffBrowser({...o,url:'https://example.test/overflow'})).rejects.toThrow(/busy/);
  expect(await handoffBrowser({...o,url:'about:blank'})).toBe(true);
 },20000);
});
