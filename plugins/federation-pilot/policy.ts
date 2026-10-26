export type Inventory={projectId:string,threads:Set<string>,hosts:Set<string>,environments:Set<string>};
const keys=new Set(['projectId','hostId','environmentId','threadId','parentThreadId','sourceThreadId']);
export function routingIds(path:string,body:unknown):string[]{
  const ids=new Set<string>();const u=new URL(path,'http://remote.invalid');
  for(const s of u.pathname.split('/'))if(/^(proj|thr|host|env)_[a-z0-9]+$/.test(s))ids.add(s);
  for(const key of keys){const value=u.searchParams.get(key);if(value)ids.add(value);}
  function walk(value:unknown,depth=0){if(depth>10||!value||typeof value!=='object')return;
    for(const [k,v]of Object.entries(value)){
      // Prompt mentions describe referenced content, not the request destination.
      // Preserve them on the wire; never resolve their thread/project on the
      // receiving server as part of ownership validation.
      if(k==='mentions'&&Array.isArray(v))continue;
      if(keys.has(k)&&typeof v==='string')ids.add(v);else if(v&&typeof v==='object')walk(v,depth+1);}}
  walk(body);return [...ids];
}
export function classifyRequest(method:string,path:string,body:unknown,i:Inventory,allowWrites:boolean):{ok:true}|{ok:false,reason:string}{
  const no=(reason:string)=>({ok:false as const,reason});
  if(!path.startsWith('/api/v1/')||/[\\\r\n#]/.test(path)||/%2f|%5c|%2e/i.test(path)||path.split('?')[0].split('/').some(s=>s==='.'||s==='..'))return no('Недопустимый путь');
  const p=new URL(path,'http://remote.invalid').pathname;const read=method==='GET'||method==='HEAD';
  if(!read&&!allowWrites)return no('Пилот работает только для чтения');
  for(const id of routingIds(path,body)){
    if(id.startsWith('proj_')?id!==i.projectId:id.startsWith('thr_')?!i.threads.has(id):id.startsWith('host_')?!i.hosts.has(id):id.startsWith('env_')?!i.environments.has(id):true)
      return no('Запрос смешивает серверы или выходит за пределы проекта пилота');
  }
  if(read&&['/api/v1/sidebar-bootstrap','/api/v1/projects','/api/v1/threads','/api/v1/hosts','/api/v1/environments'].includes(p))return {ok:true};
  if(p==='/api/v1/threads'&&method==='POST'){
    const b=body as Record<string,any>|null;
    if(!b||b.projectId!==i.projectId)return no('Для нового треда требуется удалённый проект');
    if(b.environment?.machine?.type==='new'||b.environmentSelection?.machine?.type==='new'||b.machine?.type==='new')return no('Создание машин не входит в пилот');
    if(b.sectionId!=null)return no('Локальные секции не входят в пилот');
    return {ok:true};
  }
  if(/^\/api\/v1\/threads\/thr_[a-z0-9]+(?:\/|$)/.test(p)){
    if(p.includes('/plugin-metadata'))return no('Данные сторонних плагинов не входят в пилот');
    return {ok:true};
  }
  if(/^\/api\/v1\/projects\/proj_[a-z0-9]+(?:\/|$)/.test(p))return read||p.endsWith('/default-execution-options')?{ok:true}:no('Изменение проекта не входит в пилот');
  if(read&&/^\/api\/v1\/(hosts\/host_|environments\/env_)/.test(p))return {ok:true};
  if(read&&['/api/v1/system/execution-options','/api/v1/system/providers','/api/v1/system/providers/state','/api/v1/system/environment-providers'].includes(p)&&routingIds(path,null).length)return {ok:true};
  return no('Этот вид операции пока не поддержан пилотом');
}
