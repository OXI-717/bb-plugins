import {it,expect} from 'vitest';
import {parseProjectCatalog} from './catalog-compat';
it('keeps current repository account mappings and project identity unchanged',()=>{
 const value=[{id:'group',name:'Example',bbProjectId:'proj_alpha',repositories:[{repo:'org/site',account:'first'},{repo:'org/blog',account:'second'}]}];
 expect(parseProjectCatalog(JSON.stringify(value))[0]).toMatchObject(value[0]);
});
it('migrates legacy repo strings only with an explicit saved account',()=>{
 expect(parseProjectCatalog(JSON.stringify([{id:'group',name:'Example',account:'saved-account',repositories:['org/site']}]))[0].repositories).toEqual([{repo:'org/site',account:'saved-account'}]);
});
it('refuses to guess an account for legacy strings and leaves input unchanged',()=>{
 const raw=JSON.stringify([{id:'group',name:'Example',repositories:['org/site']}]);
 expect(()=>parseProjectCatalog(raw)).toThrow('аккаунт');
 expect(JSON.parse(raw)[0].repositories).toEqual(['org/site']);
});
