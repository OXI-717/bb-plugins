import {describe,it,expect,vi} from 'vitest';
import {execFile} from 'node:child_process';
vi.mock('node:child_process',()=>({execFile:vi.fn((_file,_args,_options,callback)=>callback(null,'{}'))}));
import {readCommand} from './passive-state.js';
describe('headless macOS Tailscale status',()=>{
 it('forces CLI mode for the app binary without changing the worker environment',async()=>{
  vi.stubEnv('TERM',undefined);vi.stubEnv('TAILSCALE_BE_CLI','0');
  try {
   await readCommand('/Applications/Tailscale.app/Contents/MacOS/Tailscale',['status','--json']);
   expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({env:{LC_ALL:'C',TAILSCALE_BE_CLI:'1'}});
   expect(process.env.TAILSCALE_BE_CLI).toBe('0');
   await readCommand('/sbin/route',['-n','get','default']);
   expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({env:{LC_ALL:'C',TAILSCALE_BE_CLI:'0'}});
  } finally {vi.unstubAllEnvs();}
 });
});
