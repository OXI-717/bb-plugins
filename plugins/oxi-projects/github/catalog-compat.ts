import {z} from 'zod';
import {project,login} from './contract';
export class LegacyAccountSelectionError extends Error {
 constructor(){super('Старые настройки репозиториев не содержат выбранный аккаунт. Укажи account явно для каждого репозитория в прежнем каталоге и перезагрузи плагин; исходные настройки сохранены.');}
}
export function parseProjectCatalog(raw:string){
 return z.array(z.record(z.string(),z.unknown())).parse(JSON.parse(raw)).map(value=>{
  const repos=value.repositories;
  if(!Array.isArray(repos)||!repos.some(repo=>typeof repo==='string'))return project.parse(value);
  const account=login.safeParse(value.account);
  if(!account.success)throw new LegacyAccountSelectionError();
  return project.parse({...value,repositories:repos.map(repo=>typeof repo==='string'?{repo,account:account.data}:repo)});
 });
}
