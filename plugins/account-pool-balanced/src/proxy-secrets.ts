import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';

/** Never include the input in a validation error (it may contain a password). */
export function parseProxyUrl(value:string):URL {
  try {
    if(value.length>4096 || /[\s\x00-\x1f\x7f]/.test(value))throw Error();
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.hostname.includes(':')||u.pathname!=='/'||u.search||u.hash)throw Error();
    decodeURIComponent(u.username);decodeURIComponent(u.password);
    return u;
  }catch{throw Error('Use an HTTP or HTTPS proxy URL without a path, query or fragment.');}
}
/** Immutable private files retain old versions for pinned conversations. */
export class ProxySecrets {
  constructor(private readonly directory:string){}
  private file(ref:string){return path.join(this.directory,z.string().uuid().parse(ref)+'.json');}
  async write(ref:string,url:string){
    const value=parseProxyUrl(url).href;
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    await fs.chmod(this.directory,0o700);
    await fs.writeFile(this.file(ref),JSON.stringify({url:value}),{mode:0o600,flag:'wx'});
  }
  async read(ref:string):Promise<string>{
    const data=JSON.parse(await fs.readFile(this.file(ref),'utf8'));
    if(typeof data.url!=='string')throw Error('Proxy credential unavailable.');
    return parseProxyUrl(data.url).href;
  }
}
