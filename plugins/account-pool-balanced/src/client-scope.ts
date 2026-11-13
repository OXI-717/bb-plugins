import { z } from "zod";
import type { AccountRoute } from "./account-egress.js";

// An operator-issued server authority. No request header/body can supply it.
export const clientAccountScopeSchema = z.object({
  schema: z.literal("bb-account-pool/client-account-scope/1"),
  accountIds: z.array(z.string().uuid()).max(32).transform(ids => [...new Set(ids)].sort()),
  egress: z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),version:z.number().int().positive()}).strict(),
}).strict();
export type ClientAccountScope = z.infer<typeof clientAccountScopeSchema>;
export function inClientScope(id:string, scope?:ClientAccountScope):boolean {
  return scope === undefined || scope.accountIds.includes(id);
}
export function clientRouteAllowed(route:AccountRoute, scope?:ClientAccountScope,accountId?:string,now?:number):boolean {
  return scope === undefined || route.assigned && route.profile !== null &&
    route.profile.id === scope.egress.id && route.profile.version === scope.egress.version &&
    route.profile.failure === "closed" &&
    (route.profile.transport === "ssh-connect" ? route.profile.assurance === "proxy-enforced" :
      accountId!==undefined && now!==undefined && Number.isFinite(now) && inClientScope(accountId,scope) &&
      route.scopeAccepted?.(accountId,now)===true) &&
    route.fetch(true) !== undefined;
}
