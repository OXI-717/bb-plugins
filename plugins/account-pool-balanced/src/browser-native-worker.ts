/** Interactive native launcher: no DevTools connection or automation switches. */
export const NATIVE_BROWSER_WORKER = String.raw`
const {createServer}=require('node:http'),net=require('node:net'),fs=require('node:fs');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url'),path=require('node:path'),os=require('node:os');
let input='',primary,proxy,control,socketPath,documents,closing=false,active=0;
const sockets=new Set(),children=new Set(),files=new Map(),receipts=new Map();
function close(){
 if(closing)return;closing=true;
 if(primary&&primary.exitCode===null)primary.kill();
 for(const child of children)if(child.exitCode===null)child.kill();
 for(const s of sockets)s.destroy();
 if(proxy)proxy.close();if(control)control.close();
 if(socketPath)try{fs.unlinkSync(socketPath);}catch{}
 if(documents)try{fs.rmSync(documents,{recursive:true,force:true});}catch{}
 process.exit(0);
}
process.on('SIGTERM',close);process.on('SIGINT',close);process.on('uncaughtException',close);
function track(s){if(sockets.size>=512){s.destroy();return;}sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));s.setTimeout(300000,()=>s.destroy());}
function listen(server,address){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,()=>{server.off('error',reject);resolve();});});}
function documentURL(url,initial){
 if(url==='about:blank'&&!initial)return {url,ready:Promise.resolve()};
 let parsed;try{parsed=new URL(url);}catch{throw new Error('Invalid browser URL.');}
 if((url!=='about:blank'&&parsed.protocol!=='https:')||parsed.username||parsed.password||url.length>12000)throw new Error('Invalid browser URL.');
 if(files.size>=32)throw new Error('Browser navigation is busy. Try again later.');
 const file=path.join(documents,randomUUID()+'.html');
 const nonce=randomUUID();let confirm;const ready=new Promise(resolve=>{confirm=resolve;});
 const encoded=JSON.stringify(url).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 const fd=fs.openSync(file,'wx',0o600);
 const discard=()=>{try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')return false;}clearTimeout(files.get(file));files.delete(file);receipts.delete(nonce);return true;};
 const expire=()=>{if(!discard()){const retry=setTimeout(expire,60000);retry.unref();files.set(file,retry);}};
 const timer=setTimeout(expire,300000);timer.unref();files.set(file,timer);
 try{fs.writeFileSync(fd,'<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; connect-src http://pool-ready.invalid"><title>Opening account</title><script>const ready="http://pool-ready.invalid/'+nonce+'";fetch(ready,{mode:"no-cors",credentials:"omit",cache:"no-store"}).then(()=>location.replace('+encoded+'))</script>',{encoding:'utf8'});fs.closeSync(fd);}catch{try{fs.closeSync(fd);}catch{}discard();throw new Error('Could not prepare browser navigation.');}
 receipts.set(nonce,confirm);
 return {url:pathToFileURL(file).href,ready};
}
async function boot(cfg){
 const profiles=new Set(cfg.profileDirectories);
 if(!profiles.size||[...profiles].some(p=>!/^Profile [1-9]\d{0,6}$/.test(p))||!profiles.has(cfg.profileDirectory))throw new Error('Invalid browser profiles.');
 socketPath=cfg.socketPath;
 documents=fs.mkdtempSync(path.join(os.tmpdir(),'pool-browser-links-'));fs.chmodSync(documents,0o700);
 proxy=createServer({maxHeaderSize:16384,requestTimeout:4000,headersTimeout:4000},(q,r)=>{const prefix='http://pool-ready.invalid/';const nonce=q.url?.startsWith(prefix)?q.url.slice(prefix.length):'';const confirm=q.method==='GET'?receipts.get(nonce):undefined;if(!confirm){r.writeHead(405);r.end();return;}receipts.delete(nonce);r.writeHead(204,{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});r.end();confirm();});
 proxy.on('connection',track);
 proxy.on('connect',(req,client,head)=>{
  const m=/^([^\s/:\[\]@?#]+):(\d{1,5})$/.exec(req.url||'');
  if(!m||+m[2]<1||+m[2]>65535){client.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
  const upstream=net.connect({host:m[1],port:+m[2],family:4});track(upstream);
  const timer=setTimeout(()=>{upstream.destroy();client.destroy();},4000);
  upstream.once('connect',()=>{clearTimeout(timer);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  upstream.on('error',()=>client.destroy());upstream.on('close',()=>{clearTimeout(timer);client.destroy();});client.on('close',()=>upstream.destroy());
 });
 await listen(proxy,{port:0,host:'127.0.0.1'});
 const env={};for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','DBUS_SESSION_BUS_ADDRESS','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ'])if(process.env[key]!==undefined)env[key]=process.env[key];
 const args=profile=>['--user-data-dir='+cfg.root,'--profile-directory='+profile,'--no-first-run','--no-default-browser-check',
 '--proxy-server=http://127.0.0.1:'+proxy.address().port,'--proxy-bypass-list=<-loopback>','--disable-quic',
 '--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
 async function launch(url,profile,initial=false){
  if(!profiles.has(profile))throw new Error('Unknown account browser profile; close Helium once to refresh its profile list.');
  if(active>=8)throw new Error('Browser navigation is busy.');active++;
  try{
   const target=documentURL(url,initial);
   await new Promise((resolve,reject)=>{
    const child=spawn(cfg.executable,[...args(profile),target.url],{stdio:'ignore',env});children.add(child);
    let settled=false,timer;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(new Error('Browser profile launch failed.')):resolve();};
    child.once('error',()=>{children.delete(child);finish(true);});
    child.once('exit',code=>{children.delete(child);if(initial){finish(true);close();}else finish(code!==0);});
    if(initial){primary=child;child.once('spawn',()=>{timer=setTimeout(()=>finish(child.exitCode!==null),Math.min(2000,Math.max(100,cfg.settleMs||800)));});}
    else timer=setTimeout(()=>{child.kill();finish(true);},4000);
   });
   let timer;try{await Promise.race([target.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser did not confirm opening the local navigation document.')),initial?10000:5000);})]);}finally{clearTimeout(timer);}
  }finally{active--;}
 }
 await launch(cfg.url,cfg.profileDirectory,true);
 control=net.createServer(s=>{
  track(s);s.setTimeout(12000,()=>s.destroy());let data='',negotiated=false;
  s.on('data',chunk=>{
   data+=chunk;if(data.length>16384){s.destroy();return;}if(!data.includes('\n'))return;
   const message=data;data='';
   Promise.resolve().then(async()=>{
    const cmd=JSON.parse(message);
    if(!negotiated&&cmd.type==='hello'){negotiated=true;s.write(JSON.stringify({protocol:4,navigation:'native-file',profiles:'native'})+'\n');return;}
    s.removeAllListeners('data');
    if(!negotiated||cmd.protocol!==4)throw new Error('Close this account browser and reopen it after updating Pooler.');
    if(cmd.timezone!==cfg.timezone||cmd.executable!==cfg.executable||!primary||primary.exitCode!==null)throw new Error('Close this account browser window before changing its exit timezone or executable.');
    if(typeof cmd.url!=='string')throw new Error('Invalid browser URL.');
    await launch(cmd.url,cmd.profileDirectory);s.end(JSON.stringify({ok:true})+'\n');
   }).catch(e=>s.end(JSON.stringify({error:e.message})+'\n'));
  });
 });
 await listen(control,socketPath);fs.chmodSync(socketPath,0o600);
 process.stdout.end(JSON.stringify({ok:true,port:proxy.address().port})+'\n');
}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>32768)close();});
process.stdin.on('end',()=>{boot(JSON.parse(input)).catch(close);});
`;
