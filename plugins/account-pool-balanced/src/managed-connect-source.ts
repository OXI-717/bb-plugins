import {execFile} from 'node:child_process';
import type {HttpScopeAcceptance,HttpScopeEnforcementSource} from './http-scope-acceptance.js';

const key=(a:Readonly<HttpScopeAcceptance>)=>JSON.stringify(a);
/** On-demand Fleet readback. No timer, RPC authority, ambient proxy or fallback. */
export function createManagedConnectSource(now:()=>number=Date.now):HttpScopeEnforcementSource {
  const observations=new Map<string,{at:number,value:unknown}>();
  const flights=new Map<string,Promise<void>>();
  const source:HttpScopeEnforcementSource=a=>{
    const read=observations.get(key(a));
    return read&&now()>=read.at&&now()-read.at<10_000?read.value:undefined;
  };
  source.prepare=a=>{
    const id=key(a), current=flights.get(id);if(current)return current;
    observations.delete(id);
    if(flights.size>=128)return Promise.resolve();
    const flight=new Promise<void>(resolve=>{
      // This exact root-owned executable is installed by Fleet in the coordinated window.
      // Missing helper/sudo permission, timeout and malformed/big output all deny.
      const child=execFile('/usr/bin/sudo',['-n','/usr/local/libexec/pooler-connect-observe'],
        {timeout:8_000,maxBuffer:32_768,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}},(error,stdout)=>{
          if(!error){try{const value:unknown=JSON.parse(stdout);if(observations.size>=128)observations.delete(observations.keys().next().value!);observations.set(id,{at:now(),value});}catch{/* unknown denies */}}
          flights.delete(id);resolve();
        });
      child.stdin?.on('error',()=>undefined);
      child.stdin?.end(JSON.stringify(a));
    });
    flights.set(id,flight);return flight;
  };
  return source;
}
