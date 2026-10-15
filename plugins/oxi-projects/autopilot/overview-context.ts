import type { z } from 'zod';
import type { rpcContract } from './contract';

type Status = z.infer<typeof rpcContract.status.output>;

export function autopilotOverviewContext(status: Status, timeZone='UTC'): string {
  const formatter=new Intl.DateTimeFormat('ru-RU',{timeZone,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const stamp=(value:string|null|undefined)=>{
    if(!value)return 'неизвестно';
    const parsed=Date.parse(value);
    return Number.isFinite(parsed)?formatter.format(new Date(parsed)):'неизвестно';
  };
  const readable=(value:string)=>value.replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)\b/g,match=>stamp(match));
  const lines = [
    `Снимок панели: ${stamp(status.now)}`,
    'Это сохранённые данные панели, не свежий запуск автопилота. Нулевой счётчик не доказывает отсутствие работы; проверяй время, частичность и ошибки источника.',
  ];
  if(status.configurationError) lines.push(`Ошибка конфигурации источников: ${readable(status.configurationError)}`);
  if(status.snapshots.length===0) lines.push('Источников в снимке нет; состояние проектов неизвестно.');
  for (const snapshot of status.snapshots) {
    lines.push('', `Источник: ${snapshot.source.label} (${snapshot.source.id}) · обновлён ${stamp(snapshot.updatedAt)} · ошибка ${snapshot.error ? readable(snapshot.error) : 'нет'}`);
    if (!snapshot.data) continue;
    if (snapshot.data.runsError) lines.push(`История: ${readable(snapshot.data.runsError)}`);
    if (snapshot.data.pipelineError) lines.push(`Пайплайны: ${readable(snapshot.data.pipelineError)}`);
    for (const project of snapshot.data.status.projects) {
      const observations = status.projectObservations.find(o => o.sourceId === snapshot.source.id && o.project === project.name);
      const projectRuns = snapshot.data.runs.filter(r => r.project === project.name);
      const runs = projectRuns.slice(0, 1);
      lines.push(`Проект ${project.name} · хост ${project.host} · ${project.state} · issues ${project.issues ?? '?'} · PR ревью ${project.autoPrs ?? '?'} · PR задач ${project.devPrs ?? '?'} · счётчики ${stamp(project.countsAt)}${project.partial ? ' (частично)' : ''}${project.countsError ? ` · ошибка ${readable(project.countsError)}` : ''}`);
      if (observations) for(const row of [...new Set(observations.rows)]) lines.push(`  Наблюдение ${stamp(observations.at)}: ${readable(row).slice(0,400)}`);
      for (const run of runs) lines.push(`  Прогон ${stamp(run.at)} · ${run.phase} · ${run.engine} · ${readable(run.reason || run.summary || `кандидатов ${run.candidates ?? '?'}, запущено ${run.launched ?? '?'}`)}`);
      if(projectRuns.length>runs.length)lines.push(`  Более ранние прогоны: ${projectRuns.length-runs.length} не включены в краткий контекст; открой историю проекта.`);
    }
    for (const alert of [...new Set(snapshot.data.status.alerts)]) lines.push(`Сигнал: ${readable(alert)}`);
  }
  const context = lines.join('\n');
  if (context.length > 12_000) return context.slice(0,11_800)+"\nКонтекст сокращён до 12 000 символов. Для полной диагностики выбери разбор отдельного проекта.";
  return context;
}
