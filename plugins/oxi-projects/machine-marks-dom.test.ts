// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {mountMachineMarks,createMachineMarkStore} from './machine-marks-dom';
const config={enabled:true,hosts:{host_mac:{kind:'local' as const},host_main:{kind:'primary' as const}}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,35));
afterEach(()=>{document.body.replaceChildren();});
function row(id='thr_a'){
 const el=document.createElement('div');el.innerHTML=`<a data-sidebar-thread-id="${id}" href="/threads/${id}"></a><span><i data-provider-icon>model</i><span class="bb-thread-title">Original title</span></span><i data-status>working</i>`;document.body.append(el);return el;
}
it('adds exactly one independent mark without editing model, status, title or links',async()=>{
 const r=row();const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_mac',name:'Mac'}}],config);await tick();
 expect(r.querySelectorAll('[data-oxi-machine-mark]')).toHaveLength(1);
 expect(r.querySelector('[data-oxi-machine-mark]')?.textContent).toBe('💻');
 expect((r.querySelector('[data-oxi-machine-mark]') as HTMLElement).style.pointerEvents).toBe('auto');
 expect(r.querySelector('[data-provider-icon]')?.textContent).toBe('model');
 expect(r.querySelector('.bb-thread-title')?.textContent).toBe('Original title');
 expect(r.querySelector('[data-status]')?.textContent).toBe('working');
 expect(r.querySelector('a')?.getAttribute('href')).toBe('/threads/thr_a');
 store.set([{id:'thr_a',host:{id:'host_main',name:'Main'}}],config);await tick();
 expect(r.querySelector('[data-oxi-machine-mark]')?.textContent).toBe('🖥️');
 dispose();expect(document.querySelector('[data-oxi-machine-mark]')).toBeNull();
});
it('handles added/recycled rows, renamed hosts and deleted/missing environments',async()=>{
 const store=createMachineMarkStore();const dispose=mountMachineMarks(document,store);
 store.set([{id:'thr_a',host:{id:'host_main',name:'First'}}],config);const r=row();await tick();
 store.set([{id:'thr_a',host:{id:'host_main',name:'Renamed'}}],config);await tick();
 expect(r.querySelector('button')?.getAttribute('aria-label')).toContain('Renamed');
 r.querySelector('a')!.setAttribute('data-sidebar-thread-id','thr_b');await tick();expect(r.querySelector('button')).toBeNull();
 store.set([{id:'thr_b',host:{id:'host_other',name:'Remote'}}],config);await tick();expect(r.querySelector('button')?.textContent).toBe('☁️');
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
