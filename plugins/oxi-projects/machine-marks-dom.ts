import {resolveMachineMark,machineMarkStyle,type MachineHost,type MachineMarksConfig} from './machine-marks';
import {createMachineGlyph} from './machine-glyph';

type ThreadMachine={id:string;host:MachineHost|null;parentThreadId?:string|null;projectId?:string;isHidden?:boolean};
/** Roll up known stops in linear time; never read additional thread metadata. */
function stoppedAncestors(threads:readonly ThreadMachine[],stoppedIds:ReadonlySet<string>){
 const byId=new Map(threads.filter(t=>!t.isHidden).map(t=>[t.id,t]));const ancestors=new Set<string>();
 for(const id of stoppedIds){
  let child=byId.get(id);const seen=new Set<string>([id]);
  while(child?.parentThreadId){
   const parent=byId.get(child.parentThreadId);
   if(!parent||parent.projectId!==child.projectId||seen.has(parent.id))break;
   seen.add(parent.id);if(ancestors.has(parent.id))break;ancestors.add(parent.id);child=parent;
  }
 }
 return ancestors;
}
export function createMachineMarkStore(){
 let snapshot=new Map<string,ReturnType<typeof resolveMachineMark>>();const listeners=new Set<()=>void>();
 let rendered:ReadonlySet<string>=new Set();const renderedListeners=new Set<()=>void>();
 return {
  set(threads:readonly ThreadMachine[],config:MachineMarksConfig|null,stoppedIds:ReadonlySet<string>=new Set()){
   const ancestors=stoppedAncestors(threads,stoppedIds);
   snapshot=new Map(threads.map(t=>{const mark=resolveMachineMark(t.host,config);const self=stoppedIds.has(t.id),descendant=ancestors.has(t.id);return [t.id,mark&&(self||descendant)?{...mark,stopped:true,label:`${mark.label} · ${self?'Остановлена':'Есть остановленные дочерние сессии'}`}:mark];}));for(const fn of listeners)fn();
  },
  get(id:string){return snapshot.get(id)??null;},
  subscribe(fn:()=>void){listeners.add(fn);return ()=>{listeners.delete(fn);};},
  renderedIds(){return rendered;},
  setRenderedIds(ids:ReadonlySet<string>){if(ids.size===rendered.size&&[...ids].every(id=>rendered.has(id)))return;rendered=new Set(ids);for(const fn of renderedListeners)fn();},
  subscribeRendered(fn:()=>void){renderedListeners.add(fn);return ()=>{renderedListeners.delete(fn);};}
 };
}
export const machineMarkStore=createMachineMarkStore();

/** Additive shell decoration: never edits native titles, providers or status glyphs. */
export function mountMachineMarks(doc:Document,store:ReturnType<typeof createMachineMarkStore>){
 const win=doc.defaultView;if(!win)return ()=>{};
 let disposed=false;let frame:number|null=null;let active:HTMLButtonElement|null=null;
 const owned=new Set<HTMLButtonElement>();
 const tooltip=doc.createElement('div');tooltip.dataset.oxiMachineTooltip='';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;
 Object.assign(tooltip.style,{position:'fixed',zIndex:'10000',maxWidth:'min(320px, calc(100vw - 16px))',padding:'6px 8px',borderRadius:'6px',background:'var(--popover, #222)',color:'var(--popover-foreground, #fff)',fontSize:'12px',pointerEvents:'none'});
 const hide=()=>{active?.removeAttribute('aria-expanded');active=null;tooltip.hidden=true;};
 const show=(button:HTMLButtonElement)=>{active=button;tooltip.textContent=button.getAttribute('aria-label');tooltip.hidden=false;if(!tooltip.isConnected)doc.body.append(tooltip);const rect=button.getBoundingClientRect();tooltip.style.left=`${Math.max(8,Math.min(rect.left,win.innerWidth-tooltip.getBoundingClientRect().width-8))}px`;tooltip.style.top=`${Math.max(8,Math.min(rect.bottom+4,win.innerHeight-tooltip.getBoundingClientRect().height-8))}px`;button.setAttribute('aria-expanded','true');};
 const remove=(button:HTMLButtonElement)=>{if(active===button)hide();button.remove();owned.delete(button);};
 function reconcile(){
  frame=null;if(disposed)return;
  const wanted=new Set<HTMLButtonElement>();
  const renderedIds=new Set<string>();
  for(const link of Array.from(doc.querySelectorAll<HTMLElement>('[data-sidebar-thread-id]'))){
   const row=link.parentElement;const title=row?.querySelector<HTMLElement>('.bb-thread-title');
   if(!row||!title||!title.parentElement||title.closest('[contenteditable=true]')||title.querySelector('input,textarea,[contenteditable=true]'))continue;
   const mark=store.get(link.dataset.sidebarThreadId??'');if(!mark)continue;
   renderedIds.add(link.dataset.sidebarThreadId!);
   let button=Array.from(owned).find(b=>b.parentElement===title.parentElement);
   if(!button){
    button=doc.createElement('button');button.type='button';button.dataset.oxiMachineMark='';
    Object.assign(button.style,{position:'relative',zIndex:'10',pointerEvents:'auto',display:'inline-flex',alignItems:'center',justifyContent:'center',flex:'0 0 20px',width:'20px',height:'20px',marginInlineEnd:'6px',padding:'0',border:'0',cursor:'help'});
    button.addEventListener('pointerenter',()=>show(button!));button.addEventListener('pointerleave',hide);button.addEventListener('focus',()=>show(button!));button.addEventListener('blur',hide);
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();show(button!);});
    button.addEventListener('dblclick',event=>{event.preventDefault();event.stopPropagation();});
    owned.add(button);title.before(button);
   }
   const glyphKey=`${mark.icon}:${mark.stopped===true}`;
   if(button.dataset.oxiMachineIcon!==glyphKey){button.replaceChildren(createMachineGlyph(doc,mark.icon,mark.stopped));button.dataset.oxiMachineIcon=glyphKey;}
   const styleKey=`${mark.kind}:${mark.stopped===true}`;
   if(button.dataset.oxiMachineKind!==styleKey){Object.assign(button.style,machineMarkStyle(mark.kind,mark.stopped));button.dataset.oxiMachineKind=styleKey;}
   if(button.getAttribute('aria-label')!==mark.label){button.setAttribute('aria-label',mark.label);button.title=mark.label;if(active===button)show(button);}
   wanted.add(button);
  }
  for(const button of owned)if(!wanted.has(button))remove(button);
  store.setRenderedIds(renderedIds);
 }
 function schedule(){if(!disposed&&frame===null)frame=win!.requestAnimationFrame(reconcile);}
 const observer=new win.MutationObserver(schedule);observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-sidebar-thread-id','class','contenteditable']});
 const unsubscribe=store.subscribe(schedule);const key=(e:KeyboardEvent)=>{if(e.key==='Escape')hide();};
 doc.addEventListener('keydown',key);win.addEventListener('scroll',hide,true);win.addEventListener('resize',hide);schedule();
 return ()=>{if(disposed)return;disposed=true;observer.disconnect();unsubscribe();if(frame!==null)win.cancelAnimationFrame(frame);for(const b of owned)remove(b);store.setRenderedIds(new Set());tooltip.remove();doc.removeEventListener('keydown',key);win.removeEventListener('scroll',hide,true);win.removeEventListener('resize',hide);};
}
