import type { AccountProjects } from "./contracts.js";
type ProjectAccount = { role: "primary" | "reserve"; drainOnce?: boolean; projects?: AccountProjects };
export function projectRule(account: ProjectAccount, projectId: string | null) {
  return projectId === null ? undefined : account.projects?.rules.find(rule => rule.projectId === projectId);
}
export function projectRole(account: ProjectAccount, projectId: string | null): "primary" | "reserve" {
  const role = projectRule(account, projectId)?.role;
  return role === undefined || role === "inherit" ? account.role : role;
}
export function projectTier(account: ProjectAccount, projectId: string | null): number | null {
  const rule = projectRule(account, projectId);
  if (account.projects?.onlySelected && account.projects.rules.length > 0 && !rule) return null;
  // Manual drain changes priority only inside its project/general group.
  // Project access is evaluated first and cannot be widened by a drain flag.
  return (rule ? 0 : 3) + (account.drainOnce ? 0 : projectRole(account, projectId) === "reserve" ? 2 : 1);
}
