import { Section, number, modes, type Row } from "./view";
import {ModelPlanEditor,type ModelPlan} from "./model-plan-editor";
const effort: Record<string, string> = {
  minimal: "Минимальный",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  xhigh: "Очень высокий",
  max: "Максимальный",
  none: "Без рассуждения",
};
function Model({ value }: { value: string }) {
  const cut = value.lastIndexOf(" / ");
  const model = cut >= 0 ? value.slice(0, cut) : value;
  const level = cut >= 0 ? value.slice(cut + 3) : "";
  return (
    <>
      <p className="font-medium break-words">{model || "Нет данных"}</p>
      {level && (
        <p className="text-xs text-muted-foreground mt-1">
          Уровень рассуждения: {effort[level] ?? level}
        </p>
      )}
    </>
  );
}
export function ExecutionSettings({ row, onSave }: { row: Row;onSave?:(plan:ModelPlan)=>Promise<void> }) {
  const p = row.project;
  const controls = p.engineControls;
  const stale = !controls || !!controls.error || Date.now()-Date.parse(controls.checkedAt)>300_000 || !!row.snapshot.error || !row.snapshot.updatedAt || Date.now() - Date.parse(row.snapshot.updatedAt) > 300_000;
  const policy: Record<string, string> = {
    permissive: "Широкий допуск",
    standard: "Стандартный отбор",
    strict: "Строгий отбор",
    none: "Без auto-dev",
  };
  const records = (p.executionPlan ?? []).map((x) => ({
    engine: x.engine,
    task: `${x.taskModel} / ${x.taskEffort}`,
    review: `${x.reviewModel} / ${x.reviewEffort}`,
  }));
  return (
    <Section title="Как выполняется работа">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Состояние", modes[p.state]],
          ["Хост", p.host],
          ["Репозитории", number(p.repoCount)],
          ["PR за проход", number(p.maxPrs)],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-sm font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Паузы движков · {controls?.host ?? p.host}: {controls?.error ?? (!controls ? "не проверены" : stale ? "снимок устарел" : controls.paused.length ? "проверены на хосте" : "нет")}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-muted-foreground border-b border-border">
            <tr>
              <th className="py-3 pr-4 font-normal">Приоритет / движок</th>
              <th className="py-3 pr-4 font-normal">Решение задач</th>
              <th className="py-3 font-normal">Исправление замечаний</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="py-3 pr-4 align-top">
                  <span className="text-muted-foreground mr-2">{i + 1}.</span>
                  {r.engine}
                  {controls?.paused.some(b => b.engine === r.engine) && <p className="mt-1 font-semibold">{stale ? "Был на паузе — статус не подтверждён" : "На паузе · не используется"}</p>}
                </td>
                <td className="py-3 pr-4 align-top">
                  <Model value={r.task} />
                </td>
                <td className="py-3 align-top">
                  <Model value={r.review} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!records.length && (
        <p className="text-sm text-muted-foreground">
          Настройки движков не получены.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Отбор задач: {policy[p.policy] ?? p.policy ?? "нет данных"}. Движки
        перечислены в сохранённом порядке; движки на паузе пропускаются; строки не означают, что все они работают
        одновременно.
      </p>
      {!p.local&&<p className="text-xs text-muted-foreground">Сохранение запишет модельный план в репозиторий конфигурации. Хост применит его при следующем fleet-sync; до этого здесь показана сохранённая конфигурация.</p>}
      {(p.local||p.fleetRevision)?<ModelPlanEditor row={row} onSave={onSave}/>:<p className="text-xs text-muted-foreground">Не получена ревизия репозитория конфигурации. Укажите fleetPath в настройках источника и обновите сводку.</p>}
    </Section>
  );
}
