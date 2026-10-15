import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseAutopilotRepos,type CatalogLocal} from './catalog-contract';

const GITHUB_REMOTE=/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;
const TRACKER=/^tracker:\s*["']?([^"'\s#]+)/m;

function origin(path:string,signal:AbortSignal){return new Promise<string|null>(resolve=>{
 if(!existsSync(join(path,'.git')))return resolve(null);
 execFile('git',['-C',path,'remote','get-url','origin'],{signal,timeout:10000,encoding:'utf8'},(error,stdout)=>resolve(error?null:GITHUB_REMOTE.exec(stdout.trim())?.[1]??null));
});}

/** Tracker из frontmatter AGENTS.md: null — файла нет, 'null' — поле не задано. */
async function tracker(path:string){try{return TRACKER.exec(await readFile(join(path,'AGENTS.md'),'utf8'))?.[1]??'null';}catch{return null;}}

export async function readCatalogLocal(sourcePaths:string[],signal:AbortSignal):Promise<CatalogLocal> {
 const home=process.env.HOME;if(!home)throw Error('HOME не задан на хосте');
 const autopilot=parseAutopilotRepos(await readFile(join(home,'.task-runner','autopilot.conf'),'utf8'));
 const paths=[...new Set(Object.values(autopilot).flat())];
 const origins=Object.fromEntries(await Promise.all(paths.map(async p=>[p,await origin(p,signal)] as const)));
 const trackers=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,await tracker(p)] as const)));
 return {autopilot,origins,trackers};
}
