import {execFile} from 'node:child_process';
import {z} from 'zod';
import {notesConnection,note} from './tasknotes-contract';
type Connection=z.infer<typeof notesConnection>;
export function safeNotePath(path:string){return !!path&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some(p=>p==='..'||p==='.')&&path.endsWith('.md');}
function run(c:Connection,args:string[],signal:AbortSignal){return new Promise<unknown>((resolve,reject)=>execFile(c.executable,args,{signal,timeout:25000,maxBuffer:8*1024*1024,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,OXI_VAULT_PATH:c.vaultPath}},(error,stdout)=>{if(error)return reject(Error('TaskNotes CLI недоступен на выбранном хосте'));try{resolve(JSON.parse(stdout));}catch{reject(Error('TaskNotes вернул некорректный JSON'));}}));}
export async function listNotes(c:Connection,signal:AbortSignal){const rows=z.array(note).parse(await run(c,['list','--json','--project',c.projectName],signal));return rows.filter(n=>safeNotePath(n.path)&&(!c.folders.length||c.folders.some(f=>n.path.startsWith(f.replace(/\/$/,'')+'/')))&&c.tags.every(t=>n.tags.includes(t)));}
export async function readNote(c:Connection,path:string,signal:AbortSignal){if(!safeNotePath(path))throw Error('Недопустимый путь заметки');const rows=await listNotes(c,signal);if(!rows.some(n=>n.path===path))throw Error('Заметка не относится к подключению проекта');return note.parse(await run(c,['show','--json',path],signal));}
