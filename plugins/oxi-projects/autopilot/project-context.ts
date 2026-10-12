import {isFreshProjectDetail,freshProjectSignals} from "./work";
import type {z} from "zod";
import type {rpcContract} from "./contract";
type Status=z.infer<typeof rpcContract.status.output>;
type Detail=z.infer<typeof rpcContract.project.output>;
export function projectAnalysisContext(status:Status,sourceId:string,project:string,detail:Detail,timeZone="UTC"):string{
 const snapshot=status.snapshots.find(s=>s.source.id===sourceId),p=snapshot?.data?.status.projects.find(p=>p.name===project);
 if(!snapshot||!p)throw Error("Проект отсутствует в источнике");
 const recent=(stamp:string|null|undefined)=>{const age=Date.now()-Date.parse(stamp??"");return Number.isFinite(age)&&age>=-60000&&age<300000;};
 const sourceFresh=!snapshot.error&&recent(snapshot.updatedAt);
 const fresh=!detail.error&&detail.data?.project===project&&isFreshProjectDetail(detail.data);
 const problems=[...new Set([
  ...(sourceFresh&&p.engineControls?.error?[`Паузы движков на ${p.host}: ${p.engineControls.error}`]:[]),
  ...(p.countsError?[`Счётчики: ${p.countsError}`]:[]),
  ...(sourceFresh?snapshot.data?.status.alerts.filter(x=>x.startsWith(`${project}:`))??[]:[]),
  ...(snapshot.error?[`Источник: ${snapshot.error}`]:[]),
  ...(detail.error?[`Проверка: ${detail.error}`]:[]),
  ...(fresh?freshProjectSignals(detail.data).flatMap(s=>s.rows):[]),
  ...(fresh?detail.data!.errors:[]),
 ])];
 const runs=(snapshot.data?.runs.filter(r=>r.project===project)??[]).slice(0,3);
 const lines=[`Проект автопилота: ${project}`,`Хост исполнения: ${p.host}`,`Источник: ${sourceId}; снимок: ${snapshot.updatedAt??"неизвестно"}`,`Состояние снимка: ${sourceFresh?"свежий":"устарел или обновление не удалось; старые предупреждения исключены"}`,`Состояние: ${p.state}; issues: ${p.issues??"неизвестно"}; PR ревью: ${p.autoPrs??"неизвестно"}; PR задач: ${p.devPrs??"неизвестно"}`,`Счётчики обновлены: ${p.countsAt??"неизвестно"}; частичные: ${p.partial?"да":"нет"}`,`Проверка: ${detail.data?.observedAt??"нет"}; ${fresh?"свежая":"устарела или отсутствует; старые сигналы исключены"}${detail.loading?"; обновляется":""}`,"",`Уникальные проблемы: ${problems.length} (до 15 в контексте)`,...problems.slice(0,15).map(x=>`- ${x.slice(0,450)}`),"","Последние прогоны:",...runs.map(r=>`${r.at} · ${r.phase} · ${r.engine} · запущено ${r.launched??"?"} · ${(r.reason||r.summary).slice(0,450)}`),"",`Снимок пауз движков (${p.engineControls?.checkedAt??"время неизвестно"}) на ${p.engineControls?.host??p.host}: ${p.engineControls?.error??(p.engineControls?p.engineControls.paused.slice(0,8).map(x=>`${x.engine}: ${x.reason.slice(0,150)}`).join("; ")||"нет":"не проверены")}`,`Диагностика: bb oxi-autopilot project ${sourceId} ${project}`,"Сохранённые наблюдения, не доказательство текущей поломки. Сначала перепроверь состояние. Другие проекты в этот разбор не входят."];
 const formatter=new Intl.DateTimeFormat("ru-RU",{timeZone,year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
 return lines.join("\n").replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)\b/g,value=>Number.isFinite(Date.parse(value))?formatter.format(new Date(value)):value).slice(0,11000);
}
