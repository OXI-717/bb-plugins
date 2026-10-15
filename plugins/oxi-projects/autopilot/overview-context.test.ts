import {it,expect} from 'vitest';
import {autopilotOverviewContext} from './overview-context';

it('includes every project and source failure in the review draft without inventing zeroes',()=>{
  const status={now:'2026-09-23T17:00:00Z',projectObservations:[{sourceId:'mac',project:'projectAlpha',at:'2026-09-23T16:55:00Z',rows:['отбор устарел']}],snapshots:[
    {source:{id:'mac',label:'Mac'},updatedAt:'2026-09-23T16:59:00Z',error:null,data:{status:{projects:[{name:'projectAlpha',host:'remote',state:'enabled',issues:78,autoPrs:null,devPrs:0,countsAt:null,partial:true,countsError:'timeout'}],alerts:['projectAlpha: очередь неизвестна']},runs:[{project:'projectAlpha',at:'2026-09-23T16:00:00Z',phase:'Ревью',engine:'codex',reason:'',summary:'PR проверен'}],runsError:null,pipelineError:null}},
    {source:{id:'bad',label:'Другой хост'},updatedAt:null,error:'deadline',data:null},
  ]} as any;
  const context=autopilotOverviewContext(status);
  expect(context).toContain('projectAlpha · хост remote');
  expect(context).toContain('PR ревью ?');
  expect(context).toContain('отбор устарел');
  expect(context).toContain('ошибка deadline');
  expect(context).toContain('PR проверен');
  expect(context).not.toContain('2026-09-23T17:00:00Z');
});
it('explains why an empty source list cannot be treated as an empty workload',()=>{
  const context=autopilotOverviewContext({now:'2026-09-23T17:00:00Z',snapshots:[],projectObservations:[],configurationError:'invalid sources',refreshing:false} as any);
  expect(context).toContain('Ошибка конфигурации источников: invalid sources');
  expect(context).toContain('состояние проектов неизвестно');
});
it('keeps later observations and alerts in a whole-autopilot draft',()=>{
  const status={now:'2026-09-23T17:00:00Z',configurationError:null,projectObservations:[{sourceId:'mac',project:'projectAlpha',at:'now',rows:['first','second','third','critical fourth']}],snapshots:[{source:{id:'mac',label:'Mac'},updatedAt:'now',error:null,data:{status:{projects:[{name:'projectAlpha',host:'mac',state:'enabled',issues:0,autoPrs:0,devPrs:0,countsAt:'now',partial:false,countsError:null}],alerts:[...Array.from({length:20},(_,i)=>`routine ${i}`),'critical last alert']},runs:[],runsError:null,pipelineError:null}}]} as any;
  const context=autopilotOverviewContext(status);
  expect(context).toContain('critical fourth');
  expect(context).toContain('critical last alert');
});
