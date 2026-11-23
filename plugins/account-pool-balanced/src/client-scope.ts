import { z } from "zod";
import type { AccountRoute } from "./account-egress.js";

// An operator-issued server authority. No request header/body can supply it.
const accountIds = z.array(z.string().uuid()).max(32).transform(ids => [...new Set(ids)].sort());
const egress = z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),version:z.number().int().positive()}).strict();
export const clientAccountScopeSchema = z.discriminatedUnion("schema", [z.object({
  schema: z.literal("bb-account-pool/client-account-scope/1"),
  accountIds, egress,
}).strict(), z.object({
  schema: z.literal("bb-account-pool/client-proxy-scope/1"),
  accountIds, egress,
}).strict()]);
export type ClientAccountScope = z.infer<typeof clientAccountScopeSchema>;
export function inClientScope(id:string, scope?:ClientAccountScope):boolean {
  return scope === undefined || scope.accountIds.includes(id);
}
export function requiresClientVpn(scope?:ClientAccountScope):boolean {
  return scope?.schema === "bb-account-pool/client-account-scope/1";
}
export function clientRouteAllowed(route:AccountRoute, scope?:ClientAccountScope,accountId?:string,now?:number):boolean {
  return scope === undefined || route.assigned && route.profile !== null &&
    route.profile.id === scope.egress.id && route.profile.version === scope.egress.version &&
    route.profile.failure === "closed" &&
    (scope.schema === "bb-account-pool/client-proxy-scope/1" ? route.profile.transport === "http-connect" :
      route.profile.transport === "ssh-connect" ? route.profile.assurance === "proxy-enforced" :
      accountId!==undefined && now!==undefined && Number.isFinite(now) && inClientScope(accountId,scope) &&
      route.scopeAccepted?.(accountId,now)===true) &&
    route.fetch(true) !== undefined;
}
