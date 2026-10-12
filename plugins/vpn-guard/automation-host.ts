import {execFile} from 'node:child_process';
import path from 'node:path';
import {automationInputSchema,automationStatusSchema} from './automation-contract.js';
export async function automationCommand(input:unknown) {
 const parsed=automationInputSchema.parse(input);
 const args=['protection',parsed.action,'--server',parsed.instanceId,'--json'];
 if(parsed.action==='hold'||parsed.action==='release')args.push('--owner',`vpn-guard:${parsed.instanceId}`);
 if(parsed.action==='hold')args.push('--reason','VPN Guard protection block');
 if(parsed.reviewed)args.push('--reviewed');
 if(parsed.restoreRevision)args.push('--expected-revision',parsed.restoreRevision);
 if(path.basename(parsed.executable)!=='oxi-auto')throw new Error('Expected the oxi-auto controller executable.');
 if(!path.isAbsolute(parsed.executable))throw new Error('Automation controller path must be absolute.');
 return new Promise<ReturnType<typeof automationStatusSchema.parse>>((resolve,reject)=>{
  execFile(parsed.executable,args,{timeout:30_000,maxBuffer:262144,encoding:'utf8'},(error,stdout)=>{
   try{
    const status=automationStatusSchema.safeParse(JSON.parse(stdout));
    // Exit 1 is the protocol's explicit partial-action report. A timeout,
    // signal, other failure, or exit 1 without reported errors is not success.
    const partial=error&&error.code===1&&!error.killed&&!error.signal&&status.success&&status.data.errors.length>0;
    if(status.success&&(!error||partial)){resolve(status.data);return;}
   }catch{}
   reject(new Error(error?'Automation controller unavailable or timed out.':'Invalid automation controller response.'));
  });
 });
}
