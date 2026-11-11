export function connectionText(s,now=Date.now()) {
 const labels={connected:'Connected',connecting:'Connecting',bridge_offline:'Bridge machine offline',bridge_unavailable:'Bridge worker unavailable',ssh_unavailable:'SSH unavailable',remote_bb_unavailable:'Remote BB unavailable'};
 return `${labels[s.status]??'Checking'} · Last success: ${s.lastSuccess===null?'never':new Date(s.lastSuccess).toLocaleTimeString()}${s.outageSince===null?'':` · Outage: ${Math.max(0,Math.floor((now-s.outageSince)/1000))}s`}${s.retryAt===null?'':` · Next check: ${Math.max(0,Math.ceil((s.retryAt-now)/1000))}s`}`;
}
export function mountConnectionStatus(win,pluginId,signal){
 const box=win.document.createElement('details');box.style.cssText='position:fixed;bottom:12px;right:12px;max-width: min(480px,90vw);z-index:1000;background:var(--background,#222);color:var(--foreground,#fff);padding:8px;border:1px solid #888;border-radius:6px;font:12px sans-serif';
 const title=win.document.createElement('summary');title.textContent='OXI Federation · connection status';box.append(title);
 const rows=win.document.createElement('div');box.append(rows);win.document.body.append(box);
 let timer=null,stopped=false;
 async function refresh(){try{const r=await win.fetch(`/api/v1/plugins/${pluginId}/http/connections`,{signal});if(!r.ok)return;const data=await r.json();if(stopped)return;rows.replaceChildren();for(const s of data.servers){const row=win.document.createElement('p');row.textContent=`${s.serverId}: ${connectionText(s)}`;rows.append(row);}}catch{}finally{if(!stopped)timer=win.setTimeout(refresh,5000);}}
 const dispose=()=>{stopped=true;if(timer!==null)win.clearTimeout(timer);box.remove();signal.removeEventListener('abort',dispose);};signal.addEventListener('abort',dispose,{once:true});if(signal.aborted)dispose();else void refresh();return dispose;
}
