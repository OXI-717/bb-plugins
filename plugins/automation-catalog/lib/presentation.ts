import type { CatalogList, CatalogTask } from "../src/catalog-types";
import { projectLabel } from "./execution";

export type DisplayNames = {
  hosts: { id: string; name: string }[];
  projects: { id: string; name: string }[];
};

const opaqueId = /^(host|proj|auto|ext)_[\w-]+$/;
const labels = {
  unregistered: ["Нет в реестре", "Добавьте задачу в реестр или укажите причину исключения."],
  coverage: ["Нет свежих данных", "Проверьте, поступают ли данные с машины или из планировщика."],
  noncompliant: ["Неполная запись", "Дополните сведения о задаче в реестре."],
  "missing-required": ["Задача пропала", "Проверьте, сохранилось ли определение в исходном планировщике."],
  resolved: ["Устранено", "Сверка закрыла прежнее предупреждение."],
} as const;

export function registryFinding(task: CatalogTask) {
  if (task.scheduler !== "inventory-audit") return null;
  const match = /^OXI · (unregistered|coverage|noncompliant|missing-required|resolved) · /.exec(task.name);
  const kind = (match?.[1] ?? null) as keyof typeof labels | null;
  const raw = task.description.split(/\. Identity: |^Previous inventory finding recovered\. /)[1]?.split(". No automatic stop.")[0];
  let identity: { host: string; scheduler: string; scope: string; unit: string } | null = null;
  if (raw?.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value) && value.length === 4 && value.every(part => typeof part === "string"))
        identity = { host: value[0], scheduler: value[1], scope: value[2], unit: value[3] };
    } catch {}
  }
  return { kind, identity, source: raw?.startsWith("[") ? undefined : raw,
    label: kind ? labels[kind][0] : "Предупреждение реестра",
    hint: kind ? labels[kind][1] : "Откройте технические сведения для проверки." };
}

function readable(value: string | null | undefined) {
  return value && !opaqueId.test(value) ? value : null;
}

function unitName(unit: string) {
  if (opaqueId.test(unit)) return "Задача BB";
  if (/^oxi-agy-[\da-f]{32}\.service$/.test(unit)) return "Временная служба AGY";
  if (/^cron:[\da-f]+$/.test(unit)) return "Задание cron";
  return unit.replace(/^com\.oxi\./, "").replace(/\.(service|timer)$/, "");
}

export function createPresentation(data?: CatalogList | null, names?: DisplayNames | null) {
  const hosts = new Map(names?.hosts.map(h => [h.id, h.name]));
  const projects = new Map(names?.projects.map(p => [p.id, p.name]));
  const localSources = new Set(data?.sources.filter(s => s.managedHere).map(s => s.id));
  const native = data?.tasks.filter(t => t.scheduler === "bb" && !t.missing && localSources.has(t.sourceId));
  const nativeTasks = new Map(native?.map(t => [JSON.stringify([t.projectId, t.id]), t]));
  const knownProjects = new Map(native?.filter(t => t.projectId && readable(t.projectName))
    .map(t => [t.projectId, t.projectName]));
  const sourceLabels = new Map(data?.sources.map(s => [s.id, s.name]));
  return (t: CatalogTask) => {
    const finding = registryFinding(t);
    const target = finding?.identity;
    const task = target?.scheduler === "bb" ? nativeTasks.get(JSON.stringify([target.scope, target.unit])) : undefined;
    const local = finding || localSources.has(t.sourceId);
    const projectId = t.projectId ?? (target?.scheduler === "bb" ? target.scope : null);
    const projectName = (local && projectId ? readable(projects.get(projectId)) : null) ??
      readable(t.projectName) ?? readable(task?.projectName) ??
      (local && projectId ? readable(knownProjects.get(projectId)) : null);
    const host = t.host === "BB-managed agent" ? null :
      readable(t.hostLabel) ?? readable(hosts.get(t.host)) ?? readable(t.host);
    let title = readable(t.name) ?? "Автоматизация";
    if (finding) {
      title = readable(task?.name) ??
        (target?.unit && target.unit !== "*" ? unitName(target.unit) : undefined) ??
        (target?.scheduler === "cron" ? (target.scope === "root" ? "Системный cron" : "Расписание cron") : undefined) ??
        (target?.scheduler ? "Данные " + target.scheduler : undefined) ??
        (finding.source ? readable(sourceLabels.get(finding.source))
          ?? (finding.source !== t.host && readable(finding.source) ? finding.source.replaceAll("-", " ") : undefined)
          : undefined) ??
        (finding.source === t.host ? "Инвентарь машины" : "Источник инвентаря");
    }
    return { title, host, projectId, project: projectLabel({ ...t, projectId, projectName }), finding };
  };
}
