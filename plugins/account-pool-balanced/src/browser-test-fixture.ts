/** Keep browser fixtures off ports occupied by unrelated runner traffic. */
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdtempSync, realpathSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
type Box={dataDir:string;heliumRoot:string};
export const fixtureLockPort=(root:string)=>40000+createHash('sha256').update(root).digest().readUInt32BE(0)%20000;
const candidate=()=>{
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'pool-browser-test-')));
  return {dataDir:path.join(root,'data'),heliumRoot:path.join(root,'helium')};
};
export async function browserFixture(next:()=>Box=candidate):Promise<Box>{
  for(let attempt=0;attempt<32;attempt++){
    const box=next();const probe=createServer();
    try{
      await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen({host:'127.0.0.1',port:fixtureLockPort(box.heliumRoot),exclusive:true},resolve);});
      await new Promise<void>(resolve=>probe.close(()=>resolve()));
      // Production still acquires its real kernel lease, including in child-process tests.
      return box;
    }catch(error){
      if(probe.listening)await new Promise<void>(resolve=>probe.close(()=>resolve()));
      if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;
      // Only this helper's still-empty synthetic candidate is discarded.
      rmdirSync(path.dirname(box.heliumRoot));
    }
  }
  throw Error('Cannot allocate an unoccupied browser fixture lease');
}
