import {z} from 'zod';

export const guardEventSchema=z.object({
  at:z.number().int().nonnegative().max(8_640_000_000_000_000),
  kind:z.enum(['vpn_connected','vpn_blocked','manual_block_on','manual_block_off','thread_stopped','native_paused','native_restored','native_pause_failed','native_restore_failed','automation_hold','automation_release','automation_restored','automation_failed','automation_recovered']),
  hostId:z.string().max(160).optional(),threadId:z.string().max(160).optional(),
  pluginId:z.enum(['provider-codex','provider-claude-code']).optional(),
  reason:z.enum(['manual_block','host_rpc_failed','host_catalog_unavailable','vpn_unavailable','no_route','no_core','probe_failed','probe_stale','healing','invalid_evidence','file_stale_or_schema','probe_unverified','operation_failed','controller_unavailable','epoch_changed','sleep_gap','starting']).optional(),
}).strict();
export type GuardEvent=z.infer<typeof guardEventSchema>;
export function eventJournal(initial:unknown,save:(events:GuardEvent[])=>Promise<void>,onError:()=>void) {
  const parsed=z.array(guardEventSchema).max(100).safeParse(initial);
  let events=parsed.success?parsed.data:[];
  let writing:Promise<void>|null=null;
  let dirty=false;
  let closed=false;
  function flush():Promise<void> {
    if(writing)return writing;
    writing=(async()=>{
      while(dirty&&!closed){dirty=false;try{await save([...events]);}catch{try{onError();}catch{ /* Diagnostics never interrupt protection. */ }}}
    })().finally(()=>{writing=null;if(dirty&&!closed)void flush();});
    return writing;
  }
  return {
    snapshot:()=>[...events],
    close:()=>{closed=true;dirty=false;},
    append(event:Omit<GuardEvent,'at'>) {
      if(closed)return Promise.resolve();
      const entry=guardEventSchema.parse(Object.fromEntries(Object.entries({...event,at:Date.now()}).filter(([,value])=>value!==undefined)));
      events=[...events,entry].slice(-100);dirty=true;
      return flush();
    },
  };
}
