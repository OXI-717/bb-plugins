import {it,expect,vi} from 'vitest';
vi.mock('node:child_process',()=>({execFile:vi.fn()}));
import {execFile} from 'node:child_process';
import {listNotes,readNote,safeNotePath} from './tasknotes-host';
const c={id:'n',label:'Notes',kind:'tasknotes' as const,hostId:'h',vaultPath:'/vault',executable:'/tasknotes',projectName:'Project',folders:['_PROJECTS/Project/tasks'],tags:['chosen']};
it('filters notes to the configured folder/tags and confines reads to project membership',async()=>{vi.mocked(execFile).mockImplementation(((file,args,opts,callback)=>callback(null,JSON.stringify([{path:'_PROJECTS/Project/tasks/a.md',title:'A',status:'open',tags:['chosen']},{path:'_PROJECTS/Other/tasks/b.md',title:'B',status:'open',tags:['chosen']}]),'')) as any);const signal=new AbortController().signal;expect((await listNotes(c,signal)).map(n=>n.title)).toEqual(['A']);await expect(readNote(c,'_PROJECTS/Other/tasks/b.md',signal)).rejects.toThrow('не относится');expect(vi.mocked(execFile).mock.calls.every(call=>!(call[1] as string[]).includes('show'))).toBe(true);});
it('rejects absolute and traversal note paths',()=>{expect(safeNotePath('../a.md')).toBe(false);expect(safeNotePath('/vault/a.md')).toBe(false);expect(safeNotePath('tasks/a.md')).toBe(true);});
