import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe,it,expect } from 'vitest';
import { HubTokenStore } from './store.js';
import { combinedTokens } from './external-clients.js';
it('binds opaque tokens to projects and preserves real host across restart/rotation/pruning',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pool-project-token-'));let now=1000;
 try {
  const store=new HubTokenStore(dir,()=>now);
  const a=await store.forProject('host-one','project-a');const b=await store.forProject('host-one','project-b');
  expect(a).not.toBe(b);expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await store.authenticate(a)).toBe('host-one');expect(await store.projectForToken(a)).toBe('project-a');
  expect(await store.projectForToken(await store.forHost('host-one'))).toBeNull();
  const restart=new HubTokenStore(dir,()=>now);
  expect(await restart.projectForToken(b)).toBe('project-b');
  await restart.prune(['host-one']);expect(await restart.authenticate(a)).toBe('host-one');
  await restart.rotate('host-one');expect(await restart.authenticate(a)).toBe('host-one');
  now+=600001;expect(await restart.authenticate(a)).toBeNull();
  const fresh=await restart.forProject('host-one','project-a');expect(fresh).not.toBe(a);
  await restart.remove('host-one');expect(await restart.authenticate(fresh)).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('combined authentication cannot assign a project to an invalid token',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pool-project-combined-'));
 try{const hosts=new HubTokenStore(path.join(dir,'hosts')), clients=new HubTokenStore(path.join(dir,'clients')); const store=combinedTokens(hosts,clients);const t=await clients.forProject('external_test','project-a');expect(await store.projectForToken(t)).toBe('project-a');expect(await store.projectForToken('invalid')).toBeNull();}finally{await rm(dir,{recursive:true,force:true});}
});
it('revokes a project token being minted concurrently with client removal',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pool-project-revoke-'));
 try {
  const store=new HubTokenStore(dir);await store.forHost('external_test');
  const [token]=await Promise.all([store.forProject('external_test','project-a'),store.remove('external_test')]);
  expect(await store.authenticate(token)).toBeNull();
  expect(await new HubTokenStore(dir).authenticate(token)).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('keeps thread identity isolated inside one host and project through rotation and restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pool-thread-token-'));let now=1000;
 try{
  const store=new HubTokenStore(dir,()=>now);
  const first=await store.forThread('host-one','project-a','thread-one');const second=await store.forThread('host-one','project-a','thread-two');
  expect(first).not.toBe(second);expect(await store.authenticateContext(first)).toEqual({hostId:'host-one',projectId:'project-a',threadId:'thread-one'});
  const restart=new HubTokenStore(dir,()=>now);expect(await restart.authenticateContext(second)).toMatchObject({threadId:'thread-two'});
  await restart.rotate('host-one');expect(await restart.authenticateContext(first)).toMatchObject({threadId:'thread-one'});
  now+=600001;expect(await restart.authenticate(first)).toBeNull();
  const fresh=await restart.forThread('host-one',null,'thread-one');expect(await restart.authenticateContext(fresh)).toEqual({hostId:'host-one',projectId:null,threadId:'thread-one'});
  expect(await restart.list()).toHaveLength(1);await restart.prune([]);expect(await restart.authenticate(fresh)).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('keeps new thread metadata outside files read by the legacy strict loader',async()=>{
 const {readdir,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(tmpdir(),'pool-thread-legacy-'));
 try{
  const store=new HubTokenStore(dir);await store.forThread('host-one',null,'thread-one');
  const names=await readdir(dir);expect(names.filter(name=>name.startsWith('hub-thread-token-'))).toHaveLength(1);
  for(const name of names.filter(name=>name.startsWith('hub-token-'))){expect(JSON.parse(await readFile(path.join(dir,name),'utf8'))).not.toHaveProperty('threadId');}
 }finally{await rm(dir,{recursive:true,force:true});}
});
