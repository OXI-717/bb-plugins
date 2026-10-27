import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createFederation} from '../federation-core.mjs';
import {createEnv, CONFIG, PRIMARY_BOOTSTRAP} from './fake-env.mjs';
import {mountImageUrls} from '../image-presentation.mjs';
import {IMAGE_MAX_BYTES, IMAGE_MAX_BASE64, validateImage, imageFilename} from '../image-format.ts';
import {registerImageRoutes, readBoundedJson} from '../image-routes.ts';
import {uploadImage} from '../image-upload.ts';
import {PrimaryCollisionError} from '../ownership.ts';
import {imageUploadSchema} from '../contract.ts';

// Synthetic 1x1 PNG, never a screenshot or production artifact.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKZkAAAAASUVORK5CYII=','base64');
const upload={serverId:'alpha',projectId:'proj_remote01',filename:'pixel.png',mimeType:'image/png',bytesBase64:png.toString('base64')};
const stored={type:'localImage',sourceProjectId:'proj_remote01',path:'pixel-123-abc.png',name:'pixel.png',mimeType:'image/png',sizeBytes:png.length};
const bridge='/api/v1/plugins/federation-pilot/http';
const attachment='/api/v1/projects/proj_remote01/attachments';
const form=()=>{const f=new FormData();f.set('file',new Blob([png],{type:'image/png'}),'pixel.png');return f;};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function client(config=CONFIG) {
 const e=createEnv({primary:{'GET /api/v1/sidebar-bootstrap':PRIMARY_BOOTSTRAP}}), calls=[];
 const original=e.win.fetch;
 e.win.fetch=async(input,init)=>{
  if(String(input).startsWith(`${bridge}/image-`)){
   calls.push({url:String(input),init});if(e.win.remoteBridgeDown)throw Error('offline');
   return String(input).includes('image-upload')?Response.json(stored,{status:201}):new Response(png,{headers:{'content-type':'image/png'}});
  }return original(input,init);
 };
 const f=createFederation({win:e.win,config,pluginId:'federation-pilot'});
 return {e,f,calls};
}
test('native multipart image becomes a bounded explicit envelope; stored path and bytes survive',async()=>{
 const {e,f,calls}=client();try{
  const r=await e.win.fetch(attachment,{method:'POST',body:form()});assert.equal(r.status,201);assert.deepEqual(await r.json(),stored);
  const sent=JSON.parse(calls[0].init.body);assert.deepEqual(sent,{...upload,serverId:'default'});assert.deepEqual(Buffer.from(sent.bytesBase64,'base64'),png);
  assert.equal(e.primaryCalls().length,0);
  const request=new Request(`http://primary.invalid${attachment}`,{method:'POST',body:form()});
  assert.equal((await e.win.fetch(request)).status,201);assert.equal(calls.length,2);
 }finally{f.dispose();}
});
test('local multipart unchanged, unsupported remote binary unchanged, remote failures never fall back',async()=>{
 const {e,f,calls}=client();try{
  const local=form();await e.win.fetch('/api/v1/projects/proj_local01/attachments',{method:'POST',body:local});assert.equal(e.primaryCalls()[0].body,local);
  assert.equal((await e.win.fetch('/api/v1/threads/thr_unknown',{method:'POST',body:'{}'})).status,200);
  assert.equal((await e.win.fetch('/api/v1/projects/proj_remote01/other',{method:'POST',body:new Blob(['x'])})).status,415);
  e.calls.length=0;e.win.remoteBridgeDown=true;
  const r=await e.win.fetch(attachment,{method:'POST',body:form()});assert.equal(r.status,503);assert.equal(calls.length,1);assert.equal(e.primaryCalls().length,0);
 }finally{f.dispose();}
});
test('read-only, oversize, SVG, MIME spoofing and extra multipart fields fail before transmission',async()=>{
 const read=client({...CONFIG,allowWrites:false});try{assert.equal((await read.e.win.fetch(attachment,{method:'POST',body:form()})).status,403);assert.equal(read.calls.length,0);}finally{read.f.dispose();}
 const {e,f,calls}=client();try{
  for(const [blob,status] of [[new Blob([new Uint8Array(IMAGE_MAX_BYTES+1)],{type:'image/png'}),413],[new Blob(['<svg/>'],{type:'image/svg+xml'}),415],[new Blob(['<html/>'],{type:'image/png'}),415]]){
   const data=new FormData();data.set('file',blob,'test.png');assert.equal((await e.win.fetch(attachment,{method:'POST',body:data})).status,status);
  }
  const extra=form();extra.set('path','/private/file');assert.equal((await e.win.fetch(attachment,{method:'POST',body:extra})).status,400);assert.equal(calls.length,0);
 }finally{f.dispose();}
});
test('maximum-size envelope parses without regexp stack overflow; malformed padding fails',()=>{
 const bytes=Buffer.alloc(IMAGE_MAX_BYTES);png.copy(bytes);
 const {serverId,...input}=upload;
 assert.equal(imageUploadSchema.safeParse({...input,bytesBase64:bytes.toString('base64')}).success,true);
 for(const bytesBase64 of ['abc','ab=c','====','abcd==='])assert.equal(imageUploadSchema.safeParse({...input,bytesBase64}).success,false);
});
test('disabling or restoring primary ownership while reading a selected file sends no bytes',async()=>{
 for(const disable of [true,false]){
  const {e,f,calls}=client();let resume;const data=form();
  data.get('file').arrayBuffer=()=>new Promise(resolve=>{resume=resolve;});
  try {
   const pending=e.win.fetch(attachment,{method:'POST',body:data});await flush();
   if(disable)f.dispose();
   else {
    PRIMARY_BOOTSTRAP.projects.push({id:'proj_remote01',name:'Primary',threads:[]});
    try{await e.win.fetch('/api/v1/sidebar-bootstrap');}finally{PRIMARY_BOOTSTRAP.projects.pop();}
   }
   resume(png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength));
   assert.equal((await pending).status,disable?503:409);assert.equal(calls.length,0);
  }finally{f.dispose();}
 }
});
test('ownership restored to primary, image GETs, conflict and disposal retain fail-closed routing',async()=>{
 const {e,f,calls}=client();try{
  const r=await e.win.fetch(`${attachment}/content?path=${stored.path}`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);assert.match(calls[0].url,/serverId=default/);
  assert.equal((await e.win.fetch(`${attachment}/content?path=..%2Fsecret.png`)).status,400);
  e.win.fetch; // Primary claims the same project on its next bootstrap.
  PRIMARY_BOOTSTRAP.projects.push({id:'proj_remote01',name:'Primary now',threads:[]});
  try {await e.win.fetch('/api/v1/sidebar-bootstrap');}finally{PRIMARY_BOOTSTRAP.projects.pop();}
  calls.length=0;await e.win.fetch(attachment,{method:'POST',body:form()});assert.equal(calls.length,0);
 }finally{f.dispose();}
});
test('DOM property/attribute/parser images and links use explicit remote URL, restore only our changes',async()=>{
 const dom=new JSDOM('<body><img id="old" src="/remote.png"><a href="/remote.png">file</a><img id="local" src="/local.png"></body>',{url:'http://primary.invalid'}),w=dom.window;
 let enabled=true;const rewrite=s=>enabled&&s==='/remote.png'?'/bridge.png':null;
 const native=w.Element.prototype.setAttribute,view=mountImageUrls(w,rewrite);
 try {
  assert.equal(w.document.querySelector('#old').getAttribute('src'),'/bridge.png');
  assert.equal(w.document.querySelector('#local').getAttribute('src'),'/local.png');
  const img=new w.Image();img.src='/remote.png';w.document.body.append(img);assert.equal(img.getAttribute('src'),'/bridge.png');
  img.setAttribute('src','/remote.png');assert.equal(img.getAttribute('src'),'/bridge.png');
  const wrap=w.document.createElement('div');wrap.innerHTML='<img src="/remote.png">';w.document.body.append(wrap);await flush();assert.equal(wrap.firstChild.getAttribute('src'),'/bridge.png');
  enabled=false;view.refresh();assert.equal(img.getAttribute('src'),'/remote.png');
  enabled=true;view.refresh();img.src='/someone-else.png';view.dispose();assert.equal(img.getAttribute('src'),'/someone-else.png');assert.equal(w.Element.prototype.setAttribute,native);assert.equal(w.document.querySelector('#old').getAttribute('src'),'/remote.png');
 }finally{view.dispose();w.close();}
});
test('real federation DOM resolver touches only same-origin raster attachment URLs and isolates peers',()=>{
 const dom=new JSDOM('<body></body>',{url:'http://primary.invalid'}),e=createEnv();
 Object.assign(e.win,{document:dom.window.document,Element:dom.window.Element,MutationObserver:dom.window.MutationObserver,HTMLImageElement:dom.window.HTMLImageElement,HTMLAnchorElement:dom.window.HTMLAnchorElement});
 const f=createFederation({win:e.win,config:{servers:[{serverId:'alpha',projectId:'proj_alpha'},{serverId:'beta',projectId:'proj_beta'}]},pluginId:'federation-pilot'});
 try{
  for(const [value,expected] of [['/api/v1/projects/proj_alpha/attachments/content?path=x.png','serverId=alpha'],['/api/v1/projects/proj_beta/attachments/content?path=x.png','serverId=beta'],['/api/v1/projects/proj_local/attachments/content?path=x.png','proj_local'],['https://other.invalid/api/v1/projects/proj_alpha/attachments/content?path=x.png','https://other.invalid/'],['/api/v1/projects/proj_alpha/attachments/content?path=evil.html','about:blank']]){
   const img=dom.window.document.createElement('img');img.src=value;assert.ok(img.getAttribute('src').includes(expected));
  }
 }finally{f.dispose();dom.window.close();}
});

function routes() {
 const handlers=new Map(),calls=[];let c={serverId:'alpha',projectId:'proj_remote01',allowWrites:true},collision=false,afterUpload=null,metadata=stored,reply={status:200,contentType:'image/png',bodyBase64:png.toString('base64')};
 const bb={http:{route:(m,p,fn)=>handlers.set(`${m} ${p}`,fn)}};
 registerImageRoutes(bb,{selected:async id=>{if(id!=='alpha'||!c)throw Error('disabled');return {...c};},exclusive:async(config,ids)=>{calls.push({check:ids});if(collision)throw new PrimaryCollisionError(ids[0]);},upload:async(config,input)=>{calls.push({upload:input});afterUpload?.();return {status:201,contentType:'application/json',bodyBase64:Buffer.from(JSON.stringify(metadata)).toString('base64')};},get:async(config,path)=>{calls.push({get:path});return reply;}});
 async function request(method,path,body){const url=`http://primary.invalid${path}`;const req=new Request(url,{method,...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{})});return handlers.get(`${method} ${path.split('?')[0]}`)({req:{raw:req,url}});}
 return {request,calls,set config(x){c=x;},get config(){return c;},set collision(v){collision=v;},set afterUpload(v){afterUpload=v;},set reply(v){reply=v;},set metadata(v){metadata=v;}};
}
test('native sourceProjectId is preserved, legacy omission normalized and foreign project refused',async()=>{
 const h=routes();assert.deepEqual(await(await h.request('POST','/image-upload',upload)).json(),stored);
 const {sourceProjectId,...legacy}=stored;h.metadata=legacy;
 assert.deepEqual(await(await h.request('POST','/image-upload',upload)).json(),stored);
 h.metadata={...stored,sourceProjectId:'proj_primary'};
 assert.equal((await h.request('POST','/image-upload',upload)).status,502);
 h.metadata={...stored,path:'../private.png'};assert.equal((await h.request('POST','/image-upload',upload)).status,502);
});
test('image route checks scoped project, writes and primary ownership before sending bytes',async()=>{
 const h=routes();
 assert.equal((await h.request('POST','/image-upload',upload)).status,201);assert.equal(h.calls.filter(c=>c.upload).length,1);
 h.calls.length=0;h.collision=true;let r=await h.request('POST','/image-upload',upload);assert.equal(r.status,409);assert.equal(r.headers.get('x-bb-federation-primary'),'proj_remote01');assert.ok(!h.calls.some(c=>c.upload));
 h.collision=false;h.config={...h.config,allowWrites:false};r=await h.request('POST','/image-upload',upload);assert.equal(r.status,403);
 r=await h.request('POST','/image-upload',{...upload,projectId:'proj_other'});assert.equal(r.status,403);assert.ok(!h.calls.some(c=>c.upload));
});
test('image route rejects malformed/active bodies and revoked or retargeted connections',async()=>{
 const h=routes();
 for(const body of [{...upload,path:'/send'},{...upload,bytesBase64:'!!!!'},{...upload,bytesBase64:Buffer.from('<script>bad</script>').toString('base64')},{...upload,mimeType:'image/svg+xml'}])assert.ok((await h.request('POST','/image-upload',body)).status>=400);
 assert.equal(h.calls.length,0);
 h.afterUpload=()=>{h.config={...h.config,allowWrites:false};};assert.equal((await h.request('POST','/image-upload',upload)).status,409);assert.equal(h.calls.filter(c=>c.upload).length,1);
});
test('saved content is validated raster, read-only works, active/redirect/traversal and extra query refused',async()=>{
 const h=routes();h.config={...h.config,allowWrites:false};const path='/image-content?serverId=alpha&projectId=proj_remote01&path=pixel.png';
 const r=await h.request('GET',path);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('content-security-policy'),"default-src 'none'; sandbox");assert.equal(r.headers.get('cache-control'),'no-store');
 for(const suffix of ['&hostId=host_primary','&path=other.png'])assert.equal((await h.request('GET',path+suffix)).status,400);
 assert.equal((await h.request('GET',path.replace('pixel.png','..%2Fprivate.png'))).status,400);
 h.reply={status:302,contentType:'text/html',bodyBase64:''};assert.equal((await h.request('GET',path)).status,502);
 h.reply={status:200,contentType:'text/html',bodyBase64:png.toString('base64')};assert.equal((await h.request('GET',path)).status,415);
 h.reply={status:200,contentType:'image/png',bodyBase64:Buffer.from('<html>active</html>').toString('base64')};assert.equal((await h.request('GET',path)).status,415);
 h.collision=true;assert.equal((await h.request('GET',path)).status,409);
});
test('upload request streaming has a hard bound even without content-length',async()=>{
 const big=new Uint8Array(IMAGE_MAX_BASE64+4097);
 const req=new Request('http://primary.invalid/upload',{method:'POST',body:new ReadableStream({start(c){c.enqueue(big);c.close();}}),duplex:'half'});
 await assert.rejects(readBoundedJson(req),e=>e.status===413);
 assert.equal(imageFilename('../../bad.html','image/png'),'bad.png');assert.throws(()=>validateImage(png,'image/jpeg'),e=>e.status===415);
});
test('host upload uses real multipart on a fixed loopback API, exact bytes, safe extension and no forwarded credentials',async()=>{
 let received;const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const r=new Request('http://loopback.invalid',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)});const data=await r.formData();const file=data.get('file');received={url:req.url,headers:req.headers,fields:[...data.keys()],name:file.name,type:file.type,bytes:Buffer.from(await file.arrayBuffer())};res.setHeader('content-type','application/json');res.end(JSON.stringify(stored));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const result=await uploadImage(server.address().port,{...upload,filename:'../../pixel.html'},AbortSignal.timeout(5000));assert.equal(result.status,200);assert.equal(received.url,'/api/v1/projects/proj_remote01/attachments');assert.deepEqual(received.fields,['file']);assert.equal(received.name,'pixel.png');assert.deepEqual(received.bytes,png);for(const k of ['authorization','cookie','origin'])assert.equal(received.headers[k],undefined);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
