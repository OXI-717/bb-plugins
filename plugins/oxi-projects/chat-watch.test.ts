import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readChatSnapshot} from './chat-watch-host';
import {classifyChatObservation,evaluateChatSnapshot,formatChatContext} from './chat-watch-contract';

it('separates useful output and routine noise from suspected problems',()=>{
 expect(classifyChatObservation({text:'demo-lms: открыт follow-up PR: #1311',lastAt:100},200)).toBe('output');
 expect(classifyChatObservation({text:'очередь пуста → выбрать задачу',lastAt:100},200)).toBe('routine');
 expect(classifyChatObservation({text:'verify-stage red (unknown)',lastAt:100},200)).toBe('problem');
 expect(classifyChatObservation({text:'verify-stage red (unknown)',lastAt:100},100+25*60*60)).toBe('stale');
});

it('measures convergence without treating handled as fixed',()=>{
 const evaluation=evaluateChatSnapshot({cursor:'1',collectedDate:null,lastMessageAt:100,incidents:[
  {text:'открыт follow-up PR: #1',messageId:1,count:1,handled:false,lastAt:100},
  {text:'очередь пуста',messageId:2,count:3,handled:true,lastAt:100},
  {text:'host failed',messageId:3,count:2,handled:true,lastAt:100},
 ],runs:[],total:3},200);
 expect(evaluation).toMatchObject({problems:1,outputs:1,routine:1,stale:0,repeated:2,handled:2,total:3});
});
it('reads bounded evidence and previous thread links without mutating watcher state',async()=>{const dir=await mkdtemp(join(tmpdir(),'watch-test-'));try{const path=join(dir,'state.db');execFileSync('python3',['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("CREATE TABLE meta(key,value); INSERT INTO meta VALUES('cursor','42'); CREATE TABLE incidents(text,message_id,count,handled,last_at,active); INSERT INTO incidents VALUES('failure',42,9,1,1,1); INSERT INTO incidents VALUES('recovered',41,1,1,0,0); CREATE TABLE runs(id,status,thread_id,reserved_at); INSERT INTO runs VALUES(1,'idle','thr_previous',1);")
c.commit()`,path]);const s=await readChatSnapshot(path,new AbortController().signal);expect(s.incidents[0]).toMatchObject({count:9,handled:true,text:'failure'});expect(s).toMatchObject({total:2,currentTotal:1});expect(s.incidents.some(i=>i.text==='recovered'&&i.active===false)).toBe(true);expect(formatChatContext(s)).toContain('@thread:thr_previous');expect(await readChatSnapshot(path,new AbortController().signal)).toEqual(s);}finally{await rm(dir,{recursive:true,force:true});}});
