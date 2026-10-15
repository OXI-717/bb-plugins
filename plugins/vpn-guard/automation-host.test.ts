import {expect,it,vi} from 'vitest';
const execution=vi.hoisted(()=>({error:null as unknown,stdout:'',args:[] as string[]}));
vi.mock('node:child_process',()=>({execFile:(_file:unknown,args:string[],_options:unknown,callback:(error:unknown,stdout:string)=>void)=>{execution.args=args;callback(execution.error,execution.stdout);}}));
import {automationCommand} from './automation-host.js';
const status={schema:'oxi-auto/protection-status/1',blocked:true,holds:[],recoveryPending:true,pausedCount:1,activeRuns:[],errors:[],legacyBlocked:false};
const input={action:'release',executable:'/controller/oxi-auto',instanceId:'test'};
it('rejects killed or failed processes even after schema-valid output',async()=>{
 execution.stdout=JSON.stringify(status);
 for(const error of [{code:1},{code:2},{code:'ETIMEDOUT',killed:true}]){
  execution.error=error;await expect(automationCommand(input)).rejects.toThrow();
 }
});
it('retains explicit partial-action reports from controller exit 1',async()=>{
 execution.error={code:1,killed:false};execution.stdout=JSON.stringify({...status,errors:['Pause incomplete']});
 expect(await automationCommand(input)).toMatchObject({errors:['Pause incomplete']});
 execution.error={code:'ETIMEDOUT',killed:true};
 await expect(automationCommand(input)).rejects.toThrow();
});
it('limits automatic resume to schedules without service restarts',async()=>{
 execution.error=null;execution.stdout=JSON.stringify({...status,blocked:false,recoveryPending:false,pausedCount:0});
 await automationCommand({...input,action:'resume',reviewed:true,restoreRevision:'a'.repeat(64),schedulesOnly:true});
 expect(execution.args).toContain('--schedules-only');
 expect(execution.args).toContain('--expected-revision');
 await automationCommand({...input,action:'resume'});
 expect(execution.args).not.toContain('--schedules-only');
});
