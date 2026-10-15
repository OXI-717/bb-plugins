import {UrlLink} from '@get-bb/plugin-sdk/app';
import type {DetailState} from './view';
import type {ProjectDetail} from './work';
import {Section,Empty,date} from './view';
import {WorkActions} from '../work-actions';

function PrList({prs}:{prs:ProjectDetail['prs']}){
  return <div className="space-y-2">{prs.map((pr,i)=><div key={`${pr.repo}/${pr.number}/${i}`} className="border-b border-border pb-2 last:border-0"><p className="text-sm font-medium">{pr.url?<UrlLink href={pr.url}>#{pr.number} · {pr.title||'Открыть PR'}</UrlLink>:`#${pr.number} · ${pr.title||'PR'}`}</p><p className="text-xs text-muted-foreground">{pr.repo.split('/').pop()} · {pr.kind} · {date(pr.at)}</p></div>)}</div>;
}
export function ProjectPrSections({detail,sourceId,project,bbProjectId}:{detail:DetailState|null;sourceId:string;project:string;bbProjectId?:string}){
  const prs=detail?.data?.prs??[];
  const open=prs.filter(pr=>pr.state.toUpperCase()==='OPEN');
  const merged=prs.filter(pr=>pr.state.toUpperCase()==='MERGED');
  const closed=prs.filter(pr=>pr.state.toUpperCase()==='CLOSED');
  const unknown=prs.filter(pr=>!['OPEN','MERGED','CLOSED'].includes(pr.state.toUpperCase()));
  return <div className="space-y-4">
    <Section title={`Открытые PR автопилота · ${open.length}`}>
      {detail?.data?.errors.length?<p role="alert" className="text-sm text-destructive">Список PR неполный: {detail.data.errors.join(' · ')}</p>:null}
      {open.length?<PrList prs={open}/>:<Empty>{detail?.loading?'Проверяем PR…':detail?.data?'Открытых PR в полученном списке нет.':'Список PR ещё не получен.'}</Empty>}
      {bbProjectId&&<WorkActions label="Подготовить приёмку открытых PR" canPrepare={open.length>0&&!detail?.loading&&!detail?.data?.errors.length} reference={{projectId:bbProjectId,source:'autopilot-acceptance',kind:'epic',locator:JSON.stringify([sourceId,project])}}/>}
    </Section>
    <Section title={`Смерженные PR · последние 7 дней · ${merged.length}`}>{merged.length?<PrList prs={merged}/>:<Empty>В полученной истории смерженных PR нет.</Empty>}</Section>
    {closed.length>0&&<Section title={`Закрытые без мержа · ${closed.length}`}><PrList prs={closed}/></Section>}
    {unknown.length>0&&<Section title={`Исход не подтверждён · ${unknown.length}`}><PrList prs={unknown}/></Section>}
  </div>;
}
