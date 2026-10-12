import {it,expect} from 'vitest';
import {createBrowseCache,visibleProjectItems} from './browse-cache';
it('preserves separate project/filter snapshots with bounded session memory',()=>{const cache=createBrowseCache(2);const a:any=[{title:'A'}],b:any=[{title:'B'}];cache.set('a/open',a);cache.set('a/closed',b);expect(cache.get('a/open')).toBe(a);cache.set('b/open',[]);expect(cache.get('a/open')).toBeUndefined();expect(cache.get('a/closed')).toBe(b);});
it('bounds initial rendering without dropping the cached remainder',()=>{const items=Array.from({length:500},(_,i)=>i);expect(visibleProjectItems(items)).toHaveLength(30);expect(visibleProjectItems(items,60)).toHaveLength(60);expect(items).toHaveLength(500);});

import {recoverBrowseFailure} from './browse-cache';
it('keeps a successful empty result after a refresh failure in the same scope',()=>{
 expect(recoverBrowseFailure({key:'alpha/filter',items:[]},'alpha/filter')).toEqual({items:[],stale:true});
});
it('never recovers another project or filter as a successful result',()=>{
 const snapshot={key:'alpha/filter',items:[{title:'Private to alpha'}]};
 expect(recoverBrowseFailure(snapshot,'beta/filter')).toEqual({items:[],stale:false});
 expect(recoverBrowseFailure(null,'alpha/filter')).toEqual({items:[],stale:false});
});
