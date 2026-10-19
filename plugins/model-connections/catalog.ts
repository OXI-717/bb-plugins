export interface CatalogProvider {
  id: string;
  name: string;
  available: boolean;
  logoUrl: string | null;
  icon: string;
}
export interface PoolSnapshot {
  routing: Record<string, boolean>;
  accounts: { provider: string; enabled: boolean }[];
}
export interface Connection extends CatalogProvider {
  group: "local" | "pool";
  selectable: boolean;
  hidden: boolean;
  detail: string;
  mark: string | null;
}
export const pooledRoutes: Readonly<Record<string, string>> = {
  codex: "codex",
  "claude-code": "claude",
  "acp-oxi-cursor": "cursor",
  "acp-oxi-devin-pool": "devin",
  "acp-opencode-kimi": "kimi",
  "acp-opencode-kimi-highspeed": "kimi",
  "acp-opencode-zai": "zai",
  "acp-opencode-go": "opencode-go",
};
export function classifyConnections(
  providers: CatalogProvider[],
  states: ReadonlyMap<string, string>,
  pool: PoolSnapshot | null,
  hidden: string[],
  bypassedProvider: string | null,
): Connection[] {
  const seen = new Set<string>();
  const rows: Connection[] = [];
  for (const p of providers) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const key = pooledRoutes[p.id];
    const dedicated =
      key !== undefined && p.id !== "codex" && p.id !== "claude-code";
    const local =
      key === undefined ||
      (!dedicated &&
        (pool?.routing[key] === false || bypassedProvider === p.id));
    const state = states.get(p.id) ?? "unknown";
    const configured =
      key !== undefined &&
      pool?.routing[key] === true &&
      pool.accounts.some((a) => a.provider === key && a.enabled);
    let detail = local
      ? "Нужна проверка подключения"
      : pool === null
        ? "Пул недоступен"
        : pool.routing[key] !== true
          ? "Маршрут выключен"
          : !configured
            ? "Нет включённых аккаунтов"
            : "Через пул";
    if (local && state === "ready") detail = "Локальная авторизация";
    if (state === "not_installed") detail = "Не установлен";
    else if (local && state === "unauthenticated") detail = "Требуется вход";
    else if (local && state === "expired") detail = "Требуется повторный вход";
    else if (local && state === "unsupported_version")
      detail = "Требуется обновление";
    if (!p.available) detail = "Подключение недоступно";
    const marks: Record<string, string> = {
      kimi: "K",
      zai: "GLM",
      "opencode-go": "Go",
      devin: "D",
      cursor: "↗",
    };
    rows.push({
      ...p,
      group: local ? "local" : "pool",
      hidden: hidden.includes(p.id),
      selectable:
        p.available &&
        state !== "not_installed" &&
        (local ? state === "ready" : !!configured),
      detail,
      mark:
        !p.logoUrl && p.icon === "Toolbox" && key ? (marks[key] ?? null) : null,
    });
  }
  return rows;
}
