import type {WorkItem} from './contract';
// Session cache only: the authoritative, durable cache remains SQLite on the server.
export function createBrowseCache(capacity=20){
 const entries=new Map<string,WorkItem[]>();
 return {
  get:(key:string)=>entries.get(key),
  set(key:string,items:WorkItem[]){entries.delete(key);entries.set(key,items);while(entries.size>capacity)entries.delete(entries.keys().next().value!);},
 };
}
export const browseCache=createBrowseCache();
export function visibleProjectItems<T>(items:T[],limit=30):T[]{return items.slice(0,limit);}
export function recoverBrowseFailure<T>(snapshot:{key:string;items:T[]}|null,requestKey:string):{items:T[];stale:boolean}{
 return snapshot?.key===requestKey?{items:snapshot.items,stale:true}:{items:[],stale:false};
}
