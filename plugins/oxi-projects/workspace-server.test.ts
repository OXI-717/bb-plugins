import {it,expect,vi} from 'vitest';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
vi.mock('./github/api',()=>({accounts:async()=>['work'],makeRunner:()=>vi.fn(),accountClient:async()=>vi.fn(),listProject:vi.fn(async()=>({items:[],errors:[],limited:[],at:'now'})),readItem:vi.fn()}));
import {listProject} from './github/api';
import {setupWorkspace} from './workspace-server';
const project={id:'projectAlpha',name:'ExampleProject',bbProjectId:'p',autopilotProject:'projectAlpha',repositories:[{repo:'org/a',account:'work'},{repo:'me/b',account:'personal'}]};
it('imports mappings once and preserves edits across reloads',async()=>{const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects'});harness.sdk.stub('plugins.getSettings',async()=>({values:{projects:JSON.stringify([project])}}));await setupWorkspace(bb);expect(await harness.callRpc('github_catalog',null)).toMatchObject({projects:[project]});await harness.callRpc('github_saveProject',{...project,name:'Updated'});const second=createFakePluginHost({pluginId:'oxi-projects',settings:{projects:JSON.stringify([{...project,name:'Updated'}])}});await second.bb.storage.kv.set('catalog-migrated-v1',true);second.harness.sdk.stub('plugins.getSettings',async()=>({values:{projects:JSON.stringify([project])}}));await setupWorkspace(second.bb);expect(await second.harness.callRpc('github_catalog',null)).toMatchObject({projects:[{name:'Updated',repositories:project.repositories}]});});
it('uses BB project mappings and rejects contradictory account assignments',async()=>{const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects',settings:{projects:JSON.stringify([project,{...project,id:'duplicate',repositories:[{repo:'org/a',account:'wrong'}]}])}});harness.sdk.stub('plugins.getSettings',async()=>{throw Error('offline');});const workspace=await setupWorkspace(bb);await expect(workspace.forBb('p')).rejects.toThrow('Конфликт');expect((await workspace.forBb('other')).repositories).toEqual([]);});
it('rejects a truncated GitHub issue list instead of replacing the project cache with partial data',async()=>{vi.mocked(listProject).mockResolvedValueOnce({items:[],errors:[],limited:['org/a'],at:'now'});const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects',settings:{projects:JSON.stringify([project])}});harness.sdk.stub('plugins.getSettings',async()=>{throw Error('offline');});const workspace=await setupWorkspace(bb);await expect(workspace.scopedGithub('p').sdk.plugins.callRpc({pluginId:'github',method:'listItems',input:{},outputSchema:{parse:(v:any)=>v} as any})).rejects.toThrow('неполный список');});
it('surfaces missing legacy account selection without marking import complete or overwriting input',async()=>{
 const raw=JSON.stringify([{id:'legacy',name:'Example',repositories:['org/site']}]);
 const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects'});
 harness.sdk.stub('plugins.getSettings',async()=>({values:{projects:raw}}));
 await setupWorkspace(bb);
 expect((await harness.callRpc('github_catalog',null)).accountError).toContain('аккаунт');
 expect(await bb.storage.kv.get('catalog-migrated-v1')).not.toBe(true);
 expect(JSON.parse(raw)[0].repositories).toEqual(['org/site']);
});
