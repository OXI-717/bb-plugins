import {it,expect,describe} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compare,parseAutopilotRepos,render,type PanelEntry} from './catalog-contract';
import {readCatalogLocal} from './catalog-host';

const BB=[{id:'proj_p',name:'ExampleWorkspace',sources:[{path:'/w'}]}];
const ORIGINS={'/w/site':'example-org/site','/w/blog':'example-org/blog'};
const entry=(over:Partial<PanelEntry>={}):PanelEntry=>({id:'exampleWorkspace',bbProjectId:'proj_p',autopilotProject:'exampleWorkspace',repositories:[{repo:'example-org/site'}],integrations:[{kind:'tasknotes',projectName:'EXAMPLE_TASKS'}],...over});
const check=(autopilot:Record<string,string[]>,panel:PanelEntry[],tracker:string|null='tasknotes:EXAMPLE_TASKS')=>compare({autopilot,origins:ORIGINS,trackers:{'/w':tracker}},panel,BB);
const messages=(f:ReturnType<typeof check>)=>f.map(x=>`${x.level} ${x.scope}: ${x.message}`);

describe('compare',()=>{
 it('reports nothing for a consistent catalog',()=>expect(check({exampleWorkspace:['/w/site']},[entry()])).toEqual([]));
 it('names a repo only in the panel',()=>expect(messages(check({exampleWorkspace:['/w/site']},[entry({repositories:[{repo:'example-org/site'},{repo:'example-org/blog'}]})]))).toEqual(['error panel:exampleWorkspace: example-org/blog есть в панели, но не в автопилоте']));
 it('names a repo only in the autopilot',()=>expect(messages(check({exampleWorkspace:['/w/site','/w/blog']},[entry()]))).toEqual(['error panel:exampleWorkspace: example-org/blog есть в автопилоте, но не в панели']));
 it('reports a missing checkout and ties it to the BB project',()=>{const f=check({exampleWorkspace:['/w/site','/w/gone']},[entry({repositories:[{repo:'example-org/site'},{repo:'example-org/gone'}]})]);expect(f).toHaveLength(1);expect(messages(f)).toContain('error autopilot:exampleWorkspace: /w/gone: нет чекаута или origin не GitHub');expect(f[0]!.projectIds).toEqual(['proj_p']);});
 it('reports autopilot sections without a panel entry and dangling links',()=>{
  expect(messages(check({exampleWorkspace:['/w/site'],extra:[]},[entry()]))).toContain('error autopilot:extra: секции автопилота нет в панели (нет записи с autopilotProject)');
  expect(messages(check({},[entry()]))).toContain('error panel:exampleWorkspace: autopilotProject=exampleWorkspace, но такой секции в автопилоте нет');
 });
 it('reports unlinked and unknown BB projects',()=>{
  const out=messages(check({exampleWorkspace:['/w/site']},[entry({bbProjectId:null})]));
  expect(out).toContain('warn panel:exampleWorkspace: не привязан к проекту bb — задачи не видны ни в одном проекте');
  expect(out).toContain('warn bb:ExampleWorkspace: проект bb без записи в панели — вкладка задач пустая');
  expect(messages(check({exampleWorkspace:['/w/site']},[entry({bbProjectId:'proj_x'})]))).toContain('error panel:exampleWorkspace: bbProjectId=proj_x, но такого проекта в bb нет');
 });
 it('reports a repo claimed by two entries',()=>expect(messages(check({exampleWorkspace:['/w/site']},[entry(),entry({id:'other',autopilotProject:null,integrations:[]})]))).toContain('error repo:example-org/site: репо в нескольких записях панели: exampleWorkspace, other'));
 it('checks the AGENTS.md tracker against TaskNotes',()=>{
  expect(messages(check({exampleWorkspace:['/w/site']},[entry()],'null'))).toEqual(['error bb:ExampleWorkspace: /w/AGENTS.md: tracker не задан, а в панели TaskNotes EXAMPLE_TASKS']);
  expect(messages(check({exampleWorkspace:['/w/site']},[entry()],'local:OTHER'))).toEqual(['error bb:ExampleWorkspace: /w/AGENTS.md: tracker=local:OTHER, а в панели TaskNotes EXAMPLE_TASKS']);
  expect(check({exampleWorkspace:['/w/site']},[entry()],'github:example-org/site')).toEqual([]);
  expect(messages(check({exampleWorkspace:['/w/site']},[entry()],null))).toEqual(['error bb:ExampleWorkspace: /w/AGENTS.md: файла нет, а в панели TaskNotes EXAMPLE_TASKS']);
  expect(check({exampleWorkspace:['/w/site']},[entry({integrations:[]})],null)).toEqual([]);
 });
 it('aggregates entries sharing an autopilot section',()=>expect(check({exampleWorkspace:['/w/site','/w/blog']},[entry(),entry({id:'blog',repositories:[{repo:'example-org/blog'}]})])).toEqual([]));
 it('compares repo names case-insensitively',()=>expect(check({exampleWorkspace:['/w/site']},[entry({repositories:[{repo:'EXAMPLE-ORG/SITE'}]})])).toEqual([]));
 it('reports a TaskNotes connection without a project name',()=>expect(messages(check({exampleWorkspace:['/w/site']},[entry({integrations:[{kind:'tasknotes'}]})]))).toContain('error panel:exampleWorkspace: подключение TaskNotes без имени проекта'));
 it('renders a summary line',()=>{expect(render([])).toContain('Расхождений нет');expect(render(check({},[entry()]))).toContain('Итого: ошибок 1, предупреждений 0.');});
});

it('parses autopilot sections, skipping comments and nested tables',()=>{
 const conf=['[defaults]','engines = ["codex"]','[project.exampleWorkspace]','allow = true','repos = [','  "/w/site",  # main','  "/w/my #repo",','  "/w/blog",',']','dev = "x"  # [project.fake]','[project.exampleWorkspace.dev_engine_settings.codex]','model = "m"','[project.projectAlpha]','enabled = false','repos = ["/w/a", "/w/b"]',''].join('\n');
 expect(parseAutopilotRepos(conf)).toEqual({exampleWorkspace:['/w/site','/w/my #repo','/w/blog'],projectAlpha:['/w/a','/w/b']});
});

it('reads autopilot.conf, origins and trackers on the host',async()=>{
 const home=mkdtempSync(join(tmpdir(),'catalog-'));const src=mkdtempSync(join(tmpdir(),'src-'));
 const {mkdirSync}=await import('node:fs');mkdirSync(join(home,'.task-runner'));
 writeFileSync(join(home,'.task-runner','autopilot.conf'),`[project.p]\nrepos = [\n  "${join(home,'missing')}",\n]\n`);
 writeFileSync(join(src,'AGENTS.md'),'---\ntracker: "tasknotes:EXAMPLE_TASKS"\n---\n');
 const old=process.env.HOME;process.env.HOME=home;
 try{expect(await readCatalogLocal([src,join(home,'none')],new AbortController().signal)).toEqual({autopilot:{p:[join(home,'missing')]},origins:{[join(home,'missing')]:null},trackers:{[src]:'tasknotes:EXAMPLE_TASKS',[join(home,'none')]:null}});}
 finally{process.env.HOME=old;}
});
