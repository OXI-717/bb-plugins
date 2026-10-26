// Presentation only. Never change host IDs, types, provider IDs or permissions.
export function remoteMachineName(host, peer) {
  return `🌐 ${host.name} · Remote BB: ${peer.label} (${peer.serverId})`;
}
export function remotePermission(mode) {
  return ({full:'Full Access',auto:'Approve for me','accept-edits':'Accept Edits'})[mode] ?? 'Unknown';
}

// BB 0.46 exposes no machine-row slot. Use its content-script seam and public
// DOM, not React state. Own only sibling groups and a stylesheet. Native rows
// remain React-owned; CSS removes them from display, keyboard and accessibility.
export function mountRemoteMachines(win, getMachines) {
  const doc=win.document;
  if(!doc || !win.MutationObserver)return {refresh(){},dispose(){}};
  const style=doc.createElement('style');
  style.dataset.federationMachines='';doc.head.append(style);
  const panel=doc.createElement('section');
  panel.dataset.federationMachines='';panel.setAttribute('aria-label','Machines on remote BB servers');
  panel.style.cssText='margin-top:20px;margin-bottom:20px;';
  let stopped=false,queued=false,signature='';
  function navigateToList(){
    win.history.replaceState(win.history.state,'','/settings/machines');
    win.dispatchEvent(new win.PopStateEvent('popstate',{state:win.history.state}));
  }
  function refresh(){
    if(stopped)return;
    const machines=getMachines();
    const ids=new Set(machines.map(m=>m.host.id));
    const css=machines.map(({host})=>`[data-machine-row]:has(a[href="/settings/machines/${host.id}"]) { display:none !important; }`).join('\n');
    if(style.textContent!==css)style.textContent=css;
    const route=/^\/settings\/machines\/(host_[a-z0-9]+)(?:\/|$)/u.exec(win.location.pathname);
    if(route && ids.has(route[1])){navigateToList();return;}
    const sections=[...doc.querySelectorAll('[data-machine-row]')].filter(row=>{
      const href=row.querySelector('a[href]')?.getAttribute('href');
      return machines.some(m=>href===`/settings/machines/${m.host.id}`);
    }).map(row=>row.closest('section')).filter(Boolean);
    const section=sections[0];
    if(!section || !machines.length){panel.remove();return;}
    if(section.nextElementSibling!==panel)section.after(panel);
    const next=JSON.stringify(machines);
    if(next===signature && panel.childNodes.length)return;
    signature=next;
    panel.replaceChildren();
    const title=doc.createElement('h2');title.textContent='🌐 Machines on remote BB servers';title.style.cssText='font-size:14px;font-weight:600;';panel.append(title);
    const note=doc.createElement('p');note.textContent='These machines belong to their remote BB server. Manage them there; they are not enrolled in this BB.';note.style.cssText='font-size:12px;opacity:.7;margin:6px 0 12px;';panel.append(note);
    for(const serverId of new Set(machines.map(m=>m.serverId))){
      const rows=machines.filter(m=>m.serverId===serverId);
      const group=doc.createElement('section');group.style.cssText='border:1px solid var(--border, #8886);border-radius:8px;padding:12px 16px;margin:8px 0;';
      const heading=doc.createElement('h3');heading.textContent=`Remote BB: ${rows[0].label} (${serverId})`;heading.style.cssText='font-size:13px;font-weight:600;margin-bottom:8px;';group.append(heading);
      for(const {host,state} of rows){
        const row=doc.createElement('div');row.dataset.federationMachine=host.id;row.style.cssText='padding:8px 0;';
        const name=doc.createElement('div');name.textContent=`🌐 ${host.name}`;name.style.cssText='font-size:14px;';
        const detail=doc.createElement('div');detail.style.cssText='font-size:12px;opacity:.7;margin-top:4px;';
        detail.textContent=`Remote bridge: ${state} · Permissions on remote server: ${remotePermission(host.maxPermissionMode)}`;
        row.append(name,detail);group.append(row);
      }
      panel.append(group);
    }
  }
  function schedule(){if(stopped||queued)return;queued=true;win.queueMicrotask(()=>{queued=false;refresh();});}
  function onClick(event){
    const link=event.target?.closest?.('a[href]');
    const id=/^\/settings\/machines\/(host_[a-z0-9]+)$/u.exec(link?.getAttribute('href')??'')?.[1];
    if(id && getMachines().some(m=>m.host.id===id)){event.preventDefault();event.stopImmediatePropagation();navigateToList();schedule();}
  }
  const observer=new win.MutationObserver(schedule);observer.observe(doc.body,{childList:true,subtree:true});
  doc.addEventListener('click',onClick,true);win.addEventListener('popstate',schedule);
  refresh();
  return {refresh:schedule,dispose(){stopped=true;observer.disconnect();doc.removeEventListener('click',onClick,true);win.removeEventListener('popstate',schedule);style.remove();panel.remove();}};
}
