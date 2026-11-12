// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {mountMachineMarks,createMachineMarkStore} from './machine-marks-dom';
const config={enabled:true,hosts:{host_mac:{kind:'local' as const},host_main:{kind:'primary' as const}}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,35));
afterEach(()=>{document.body.replaceChildren();});
it('rolls a child stop through existing ancestor glyphs and clears after resume or reparenting',async()=>{
 const root=row('thr_root'),parent=row('thr_parent'),child=row('thr_child'),sibling=row('thr_sibling');
 const host={id:'host_mac',name:'Example Mac'};
 const threads=[{id:'thr_root',host},{id:'thr_parent',host,parentThreadId:'thr_root'},{id:'thr_child',host,parentThreadId:'thr_parent'},{id:'thr_sibling',host,parentThreadId:'thr_root'}];
 const store=createMachineMarkStore(),dispose=mountMachineMarks(document,store);
 store.set(threads,config,new Set(['thr_child']));await tick();
 for(const r of [root,parent,child]){expect(r.querySelectorAll('button')).toHaveLength(1);expect(r.querySelector('[data-machine-stop]')).not.toBeNull();expect(r.querySelector('button')?.textContent).toBe('');}
 expect(parent.querySelector('button')?.getAttribute('aria-label')).toContain('Есть остановленные дочерние сессии');
 expect(child.querySelector('button')?.getAttribute('aria-label')).toContain('Остановлена');expect(sibling.querySelector('[data-machine-stop]')).toBeNull();
 store.set(threads.map(t=>t.id==='thr_child'?{...t,parentThreadId:'thr_sibling'}:t),config,new Set(['thr_child']));await tick();
 expect(parent.querySelector('[data-machine-stop]')).toBeNull();expect(sibling.querySelector('[data-machine-stop]')).not.toBeNull();
 store.set(threads,config);await tick();expect(document.querySelector('[data-machine-stop]')).toBeNull();dispose();
});
it('does not roll up hidden, unknown or cross-project children and terminates parent cycles',()=>{
 const host={id:'host_mac',name:'Example Mac'},store=createMachineMarkStore();
 store.set([{id:'thr_root',host,projectId:'proj_a'},{id:'thr_hidden',host,projectId:'proj_a',parentThreadId:'thr_root',isHidden:true},{id:'thr_foreign',host,projectId:'proj_b',parentThreadId:'thr_root'}],config,new Set(['thr_hidden','thr_foreign','thr_missing']));
 expect(store.get('thr_root')?.stopped).not.toBe(true);
 store.set([{id:'thr_a',host,parentThreadId:'thr_b'},{id:'thr_b',host,parentThreadId:'thr_a'},{id:'thr_orphan',host,parentThreadId:'thr_missing'}],config,new Set(['thr_a','thr_orphan']));
 expect(store.get('thr_b')?.stopped).toBe(true);expect(store.get('thr_a')?.label).toContain('Остановлена');
});
it('adds stop inside the existing machine glyph, without an extra button or visible label, and clears it on resume',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 const threads=[{id:'thr_a',host:{id:'host_remote',name:'Example remote'}}];
 store.set(threads,config);await tick();const button=r.querySelector('button')!;const normalColor=button.style.color;
 store.set(threads,config,new Set(['thr_a']));await tick();
 expect(r.querySelectorAll('button')).toHaveLength(1);expect(r.querySelectorAll('[data-machine-stop]')).toHaveLength(1);
 expect(button.querySelector('svg')?.getAttribute('data-machine-glyph')).toBe('cloud');expect(button.textContent).toBe('');
 expect(button.style.color).not.toBe(normalColor);expect(button.getAttribute('aria-label')).toContain('Остановлена');
 expect(r.querySelector('.bb-thread-title')?.textContent).toBe('Original title');expect(r.querySelector('[data-status]')?.textContent).toBe('working');
 store.set(threads,config);await tick();expect(r.querySelector('[data-machine-stop]')).toBeNull();expect(button.style.color).toBe(normalColor);dispose();
});
function row(id='thr_a'){
 const el=document.createElement('div');el.innerHTML=`<a data-sidebar-thread-id="${id}" href="/threads/${id}"></a><span><i data-provider-icon>model</i><span class="bb-thread-title">Original title</span></span><i data-status>working</i>`;document.body.append(el);return el;
}
it('adds exactly one independent mark without editing model, status, title or links',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_mac',name:'Mac'}}],config);await tick();
 expect(r.querySelectorAll('[data-oxi-machine-mark]')).toHaveLength(1);
 expect(r.querySelector('[data-oxi-machine-mark] svg')?.getAttribute('data-machine-glyph')).toBe('laptop');
 expect((r.querySelector('[data-oxi-machine-mark]') as HTMLElement).style.pointerEvents).toBe('auto');
 expect(r.querySelector('[data-provider-icon]')?.textContent).toBe('model');
 expect(r.querySelector('.bb-thread-title')?.textContent).toBe('Original title');
 expect(r.querySelector('[data-status]')?.textContent).toBe('working');
 expect(r.querySelector('a')?.getAttribute('href')).toBe('/threads/thr_a');
 store.set([{id:'thr_a',host:{id:'host_main',name:'Main'}}],config);await tick();
 expect(r.querySelector('[data-oxi-machine-mark] svg')?.getAttribute('data-machine-glyph')).toBe('server');
 dispose();expect(document.querySelector('[data-oxi-machine-mark]')).toBeNull();
});
it('handles added/recycled rows, renamed hosts and deleted/missing environments',async()=>{
 const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_main',name:'First'}}],config);const r=row();await tick();
 store.set([{id:'thr_a',host:{id:'host_main',name:'Renamed'}}],config);await tick();
 expect(r.querySelector('button')?.getAttribute('aria-label')).toContain('Renamed');
 r.querySelector('a')!.setAttribute('data-sidebar-thread-id','thr_b');await tick();expect(r.querySelector('button')).toBeNull();
 store.set([{id:'thr_b',host:{id:'host_other',name:'Remote'}}],config);await tick();expect(r.querySelector('svg')?.getAttribute('data-machine-glyph')).toBe('cloud');
 store.set([{id:'thr_b',host:null}],config);await tick();expect(r.querySelector('button')).toBeNull();
 dispose();
});
it('shows host names as text in a click/focus tooltip and cleans up all owned UI',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_mac',name:'<img onerror=alert(1)>'}}],config);await tick();
 r.querySelector('button')!.click();expect(document.querySelector('[role=tooltip]')?.textContent).toContain('<img');
 expect(document.querySelector('[role=tooltip] img')).toBeNull();
 store.set([],null);await tick();expect(document.querySelector('[data-oxi-machine-mark]')).toBeNull();
 dispose();expect(document.querySelector('[data-oxi-machine-tooltip]')).toBeNull();
 row();await tick();expect(document.querySelector('[data-oxi-machine-mark]')).toBeNull();
});
it('skips unsupported layouts and removes its mark while the title is being edited',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_mac',name:'Mac'}}],config);await tick();
 r.querySelector('.bb-thread-title')!.replaceWith(document.createElement('input'));await tick();expect(r.querySelector('button')).toBeNull();
 dispose();
});
it('separates the title and colors the glyph itself when a thread moves machines',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_mac',name:'Mac'}}],config);await tick();
 const button=r.querySelector<HTMLButtonElement>('button')!;
 expect(button.style.marginInlineEnd).toBe('6px');
 expect(button.style.backgroundColor).toBe('transparent');
 expect(button.style.boxShadow).toBe('');
 const local=button.style.color;expect(local).not.toBe('');
 store.set([{id:'thr_a',host:{id:'host_main',name:'Main'}}],config);await tick();
 expect(button.style.color).not.toBe(local);
 expect(button.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
 expect(r.querySelector('.bb-thread-title')?.textContent).toBe('Original title');
 dispose();
});
