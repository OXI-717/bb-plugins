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
  if (account.drainOnce) return 0;
  const rule = projectRule(account, projectId);
  if (account.projects?.onlySelected && account.projects.rules.length > 0 && !rule) return null;
  return (rule ? 1 : 3) + (projectRole(account, projectId) === "reserve" ? 1 : 0);
}
