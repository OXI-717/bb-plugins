import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';

// Один проект описан в трёх списках: секция автопилота, запись панели и проект BB.
// Сверка только называет расхождения и ничего не меняет.

export const finding=z.object({level:z.enum(['error','warn']),scope:z.string(),message:z.string(),projectIds:z.array(z.string()).default([])});
export type Finding=z.infer<typeof finding>;
export const catalogLocal=z.object({autopilot:z.record(z.string(),z.array(z.string())),origins:z.record(z.string(),z.string().nullable()),trackers:z.record(z.string(),z.string().nullable())});
export type CatalogLocal=z.infer<typeof catalogLocal>;
export const catalogReport=z.object({findings:z.array(finding),checkedAt:z.number()});

export const catalogHostContract=defineRpcContract({
 catalogLocal:{input:z.object({sourcePaths:z.array(z.string())}),output:catalogLocal},
 // jiraEnv только читает текстовый файл внутри $HOME на хосте — без исполнения.
 jiraEnv:{input:z.object({path:z.string(),prefix:z.string().optional()}),output:z.object({baseUrl:z.string(),cloudId:z.string(),email:z.string(),token:z.string()})}
});
export const catalogContract=defineRpcContract({catalogCheck:{input:z.object({projectId:z.string().nullable()}),output:catalogReport}});

export type PanelEntry={id:string;bbProjectId?:string|null;autopilotProject?:string|null;repositories:{repo:string}[];integrations?:{kind:string;projectName?:string}[]|null};
export type BbProject={id:string;name:string;sources:{path:string}[]};

function stripComment(line:string){let quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='\\'&&quoted){i++;continue;}if(c==='"')quoted=!quoted;else if(c==='#'&&!quoted)return line.slice(0,i);}return line;}

/** `[project.<name>]` → repos из autopilot.conf; вложенные `[project.<name>.x]` и комментарии не мешают. */
export function parseAutopilotRepos(text:string):Record<string,string[]> {
 const result:Record<string,string[]>={};let current:string|null=null;let inRepos=false;
 for(const raw of text.split('\n')) {
  const line=stripComment(raw).trim();
  if(!line||line.startsWith('#'))continue;
  const header=/^\[([^\]]+)\]$/.exec(line);
  if(header&&!inRepos){const m=/^project\.([^.]+)$/.exec(header[1]!);current=m?m[1]!:null;if(current)result[current]??=[];continue;}
  if(!current)continue;
  if(!inRepos){const m=/^repos\s*=\s*\[(.*)$/.exec(line);if(!m)continue;inRepos=true;collect(m[1]!);continue;}
  collect(line);
 }
 function collect(chunk:string){for(const m of chunk.matchAll(/"((?:[^"\\]|\\.)*)"/g))result[current!]!.push(JSON.parse(`"${m[1]}"`));if(chunk.includes(']'))inRepos=false;}
 return result;
}

export function compare(local:CatalogLocal,panel:PanelEntry[],bbProjects:BbProject[]):Finding[] {
 const findings:Finding[]=[];const add=(level:Finding['level'],scope:string,message:string,projectIds:(string|null|undefined)[])=>findings.push({level,scope,message,projectIds:[...new Set(projectIds.filter((id):id is string=>!!id))]});
 const bbById=new Map(bbProjects.map(p=>[p.id,p]));
 const linked=new Set(panel.map(e=>e.autopilotProject).filter(Boolean));
 for(const name of Object.keys(local.autopilot).sort())if(!linked.has(name))add('error',`autopilot:${name}`,'секции автопилота нет в панели (нет записи с autopilotProject)',[]);
 const key=(slug:string)=>slug.toLowerCase(); // GitHub owner/repo не различает регистр
 const groups=new Map<string,PanelEntry[]>();
 for(const entry of panel)if(entry.autopilotProject)groups.set(entry.autopilotProject,[...(groups.get(entry.autopilotProject)??[]),entry]);
 for(const [ap,entries] of groups) {
  // Одну секцию автопилота можно разложить на несколько записей панели: сверяем их объединение.
  const scope=entries.length===1?`panel:${entries[0]!.id}`:`panel:${entries.map(e=>e.id).join('+')}`,ids=entries.map(e=>e.bbProjectId);
  if(!(ap in local.autopilot)){for(const e of entries)add('error',`panel:${e.id}`,`autopilotProject=${ap}, но такой секции в автопилоте нет`,[e.bbProjectId]);continue;}
  const panelRepos=new Map(entries.flatMap(e=>e.repositories).map(r=>[key(r.repo),r.repo]));
  const found=new Map<string,string>();let unresolved=false;
  for(const path of local.autopilot[ap]!){const slug=local.origins[path]??null;if(slug===null){unresolved=true;add('error',`autopilot:${ap}`,`${path}: нет чекаута или origin не GitHub`,ids);}else found.set(key(slug),slug);}
  for(const [k,slug] of [...found].sort())if(!panelRepos.has(k))add('error',scope,`${slug} есть в автопилоте, но не в панели`,ids);
  // Нерезолвленный путь уже назван выше; не выдаём его ещё раз как «нет в автопилоте».
  if(!unresolved)for(const [k,slug] of [...panelRepos].sort())if(!found.has(k))add('error',scope,`${slug} есть в панели, но не в автопилоте`,ids);
 }
 for(const entry of panel) {
  const scope=`panel:${entry.id}`;
  if(!entry.bbProjectId)add('warn',scope,'не привязан к проекту bb — задачи не видны ни в одном проекте',[]);
  else if(!bbById.has(entry.bbProjectId))add('error',scope,`bbProjectId=${entry.bbProjectId}, но такого проекта в bb нет`,[]);
  for(const i of entry.integrations??[])if(i.kind==='tasknotes'&&!i.projectName)add('error',scope,'подключение TaskNotes без имени проекта',[entry.bbProjectId]);
 }
 const owners=new Map<string,{slug:string;entries:PanelEntry[]}>();
 for(const entry of panel)for(const r of entry.repositories){const o=owners.get(key(r.repo))??{slug:r.repo,entries:[]};o.entries.push(entry);owners.set(key(r.repo),o);}
 for(const [,{slug,entries}] of [...owners].sort(([a],[b])=>a.localeCompare(b)))if(entries.length>1)add('error',`repo:${slug}`,`репо в нескольких записях панели: ${entries.map(e=>e.id).join(', ')}`,entries.map(e=>e.bbProjectId));
 for(const project of bbProjects) {
  const scope=`bb:${project.name}`;const entries=panel.filter(e=>e.bbProjectId===project.id);
  if(!entries.length){add('warn',scope,'проект bb без записи в панели — вкладка задач пустая',[project.id]);continue;}
  const notes=[...new Set(entries.flatMap(e=>e.integrations??[]).filter(i=>i.kind==='tasknotes'&&i.projectName).map(i=>i.projectName!))].sort();
  for(const source of project.sources) {
   const tracker=local.trackers[source.path];
   if(tracker===undefined)continue;
   if(tracker===null){if(notes.length)add('error',scope,`${source.path}/AGENTS.md: файла нет, а в панели TaskNotes ${notes.join(', ')}`,[project.id]);continue;}
   if(tracker==='null'){if(notes.length)add('error',scope,`${source.path}/AGENTS.md: tracker не задан, а в панели TaskNotes ${notes.join(', ')}`,[project.id]);continue;}
   const m=/^(?:tasknotes|local):(.+)$/.exec(tracker);
   if(m&&!notes.includes(m[1]!))add('error',scope,`${source.path}/AGENTS.md: tracker=${tracker}, а в панели TaskNotes ${notes.join(', ')||'не подключены'}`,[project.id]);
  }
 }
 return findings;
}

export function render(findings:Finding[]):string {
 if(!findings.length)return 'Расхождений нет: автопилот, панель и проекты bb совпадают.';
 const sorted=[...findings].sort((a,b)=>Number(a.level!=='error')-Number(b.level!=='error')||a.scope.localeCompare(b.scope));
 const errors=findings.filter(f=>f.level==='error').length;
 return [...sorted.map(f=>`${f.level.toUpperCase().padEnd(5)} ${f.scope}: ${f.message}`),'',`Итого: ошибок ${errors}, предупреждений ${findings.length-errors}.`].join('\n');
}
