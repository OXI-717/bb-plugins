import {expect,it} from 'vitest';
import {newTrace,observationSchema} from './request-journal.js';
it('records only a bounded self-reported Claude version with the trusted caller binding',()=>{
 const trace=(ua:string|null,provider:'claude'|'codex'='claude')=>newTrace(provider,'trusted-machine','proj_abcdef','thr_abcdef','synthetic-model','other',ua);
 expect(trace('claude-cli/2.1.312 (external, cli)').clientVersion).toBe('2.1.312');
 for(const ua of [null,'Bearer synthetic-secret','claude-cli/2.1.312-private','claude-cli/2.1.312'+ 'x'.repeat(256),'claude-cli/not-a-version'])expect(trace(ua).clientVersion).toBeNull();
 expect(trace('claude-cli/2.1.312','codex').clientVersion).toBeNull();
 expect(trace('claude-cli/2.1.312').clientHash).toBe(trace('untrusted-user-agent').clientHash);
 expect(observationSchema.shape.clientVersion.safeParse('secret-value').success).toBe(false);
 expect(JSON.stringify(trace('Bearer synthetic-secret'))).not.toContain('synthetic-secret');
});
