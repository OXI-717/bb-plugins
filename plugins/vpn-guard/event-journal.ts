import {z} from 'zod';

export const guardEventSchema=z.object({
  at:z.number().int().nonnegative(),
  kind:z.enum(['vpn_connected','vpn_blocked','manual_block_on','manual_block_off','thread_stopped','native_paused','native_restored','native_pause_failed','native_restore_failed','automation_hold','automation_release','automation_restored','automation_failed','automation_recovered']),
  hostId:z.string().max(160).optional(),threadId:z.string().max(160).optional(),
  pluginId:z.enum(['provider-codex','provider-claude-code']).optional(),
  reason:z.enum(['manual_block','host_rpc_failed','host_catalog_unavailable','vpn_unavailable','no_route','no_core','probe_failed','probe_stale','healing','invalid_evidence','file_stale_or_schema','probe_unverified','operation_failed','controller_unavailable','epoch_changed','sleep_gap','starting']).optional(),
}).strict();
export type GuardEvent=z.infer<typeof guardEventSchema>;
export function eventJournal(initial:unknown,save:(events:GuardEvent[])=>Promise<void>,onError:()=>void) {
  const parsed=z.array(guardEventSchema).max(100).safeParse(initial);
  let events=parsed.success?parsed.data:[];
  let tail=Promise.resolve();
  return {
    snapshot:()=>[...events],
    append(event:Omit<GuardEvent,'at'>) {
      const entry=guardEventSchema.parse(Object.fromEntries(Object.entries({...event,at:Date.now()}).filter(([,value])=>value!==undefined)));
      const write=tail.then(async()=>{events=[...events,entry].slice(-100);await save([...events]);});
      tail=write.catch(onError);
      return tail;
    },
  };
}
