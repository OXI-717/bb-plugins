import {execFile} from 'node:child_process';
import {chatSnapshot} from './chat-watch-contract';
const script=`import sqlite3,json,sys,pathlib
p=pathlib.Path(sys.argv[1]).resolve(strict=True)
c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=3)
c.execute('PRAGMA query_only=ON')
meta=dict(c.execute('SELECT key,value FROM meta'))
rows=c.execute('SELECT substr(text,1,1200),message_id,count,handled,last_at,active FROM incidents ORDER BY last_at DESC LIMIT 30').fetchall()
runs=c.execute('SELECT id,status,thread_id,reserved_at FROM runs ORDER BY id DESC LIMIT 5').fetchall()
print(json.dumps(dict(cursor=meta.get('cursor','0'),collectedDate=meta.get('date'),lastMessageAt=c.execute('SELECT MAX(last_at) FROM incidents').fetchone()[0],total=c.execute('SELECT COUNT(*) FROM incidents').fetchone()[0],currentTotal=c.execute('SELECT COUNT(*) FROM incidents WHERE active=1').fetchone()[0],incidents=[dict(text=r[0],messageId=r[1],count=r[2],handled=bool(r[3]),lastAt=r[4],active=bool(r[5])) for r in rows],runs=[dict(id=r[0],status=r[1],threadId=r[2],at=r[3]) for r in runs])))`;
export async function readChatSnapshot(databasePath:string,signal:AbortSignal){return new Promise<ReturnType<typeof chatSnapshot.parse>>((resolve,reject)=>execFile('python3',['-c',script,databasePath],{signal,timeout:10000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>{if(error)return reject(Error('Не удалось прочитать сохранённые сообщения watcher на хосте'));try{resolve(chatSnapshot.parse(JSON.parse(stdout)));}catch{reject(Error('Неподдерживаемый формат данных watcher'));}}));}
