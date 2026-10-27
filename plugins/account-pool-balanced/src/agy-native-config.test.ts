import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
it('parses only synthetic distributed defaults without executing archive code or accepting unsafe paths',async()=>{
 const {stderr}=await promisify(execFile)('python3',[fileURLToPath(new URL('../scripts/test_agy_native_oauth_config.py',import.meta.url))],{timeout:10000,maxBuffer:65536});
 expect(stderr).toContain('OK');
});
