import {expect,it} from 'vitest';
import {poolErrorResponse} from './pool-errors.js';
it('renders Cursor unary Connect errors with a stable policy reason',async()=>{
 const r=poolErrorResponse('cursor',403,'Порог пула 90%, использовано 94.69%',{'x-bb-pool-error':'POOL_QUOTA_THRESHOLD'});
 expect(r.status).toBe(403);expect(r.headers.get('retry-after')).toBeNull();
 expect(await r.json()).toMatchObject({code:'permission_denied',message:expect.stringContaining('POOL_QUOTA_THRESHOLD')});
});
it.each(['proto','json','Proto'])('renders framed Cursor %s streaming EndStream errors',async codec=>{
 const r=poolErrorResponse('cursor',403,'Quota policy blocked',{'x-bb-pool-error':'POOL_QUOTA_THRESHOLD'},new Request('http://fixture.test',{headers:{'content-type':'application/connect+'+codec}}));
 expect(r.status).toBe(200);expect(r.headers.get('content-type')).toBe('application/connect+'+codec.toLowerCase());
 const bytes=Buffer.from(await r.arrayBuffer());expect(bytes[0]).toBe(2);expect(bytes.readUInt32BE(1)).toBe(bytes.length-5);
 expect(JSON.parse(bytes.subarray(5).toString())).toMatchObject({error:{code:'permission_denied',message:expect.stringContaining('POOL_QUOTA_THRESHOLD')}});
});
it.each(['claude','codex','kimi','zai','opencode-go','devin'] as const)('preserves %s envelope while sharing error codes',async provider=>{
 const r=poolErrorResponse(provider,503,'Upstream unreachable');
 expect(r.headers.get('x-bb-pool-error')).toBe('POOL_UPSTREAM_UNAVAILABLE');
 expect(await r.json()).toMatchObject({error:{code:'POOL_UPSTREAM_UNAVAILABLE',message:expect.stringContaining('POOL_UPSTREAM_UNAVAILABLE')}});
});
