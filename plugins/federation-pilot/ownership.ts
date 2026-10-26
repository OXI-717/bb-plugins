// A remote cannot claim an entity present on primary or another configured remote.
// Check before forwarding the request body. An unavailable peer is not absence.
export function entityPath(id:string){
 const kinds:Record<string,string>={thr:'threads',proj:'projects',host:'hosts',env:'environments'};
 const m=/^(thr|proj|host|env)_[a-z0-9]+$/.exec(id);if(!m)throw Error('Invalid entity ID');
 return `/api/v1/${kinds[m[1]]}/${id}`;
}
export async function assertExclusive(ids:string[],primary:(id:string)=>Promise<boolean>,others:Array<(id:string)=>Promise<boolean>>){
 for(const id of new Set(ids)){
  if(await primary(id))throw Error(`Identifier collision on primary: ${id}`);
  for(const exists of others)if(await exists(id))throw Error(`Identifier collision between remotes: ${id}`);
 }
}

export class PrimaryCollisionError extends Error{id:string;constructor(id:string){super(`Identifier collision on primary: ${id}`);this.id=id;}}
