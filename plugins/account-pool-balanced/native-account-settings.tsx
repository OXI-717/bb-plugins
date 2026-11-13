import type {NativeProbeInput,NativeProbeResult} from './src/native-probe-wire';
import {useEffect, useState} from 'react';
import {Button} from './ui/components/ui/button';
import {AccountProjectsForm} from './account-projects-form';
import type {NativeAccounts, NativeAccountUpdate} from './src/native-accounts.js';
type Account=NativeAccounts['accounts'][number];
type Projects=Array<{id:string;name:string}>;
type Patch=Omit<NativeAccountUpdate,'accountId'|'expectedRevision'>;
export function NativeAccountCard({account,open,loadProjects,managed=true}:{managed?:boolean;account:Account;open:()=>void;loadProjects:()=>Promise<Projects>}) {
  const [projects,setProjects]=useState<Projects>([]);
  useEffect(()=>{let live=true;void loadProjects().then(value=>{if(live)setProjects(value);}).catch(()=>{});return()=>{live=false;};},[]);
  const names=new Map(projects.map(p=>[p.id,p.name]));
  const selected=account.projects?.onlySelected&&account.projects.rules.length>0;
  return <div className="space-y-2 border-b border-border py-3 last:border-b-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className="min-w-0 break-all text-left text-sm font-medium text-foreground hover:underline" onClick={open}>Google · {account.label??'Antigravity'}</button>
      <Button size="sm" variant="outline" aria-label={`Настройки Google · ${account.label??'Antigravity'}`} onClick={open}>Настроить</Button>
    </div>
    <p className="text-xs text-muted-foreground">{!managed?'Управляемый режим выключен':account.uncertain>0?'Требуется проверка остановки':account.executors.some(e=>e.enabled)?'Включён · доступ к моделям проверяется при запросе':'Выключен'} · {account.role==='reserve'?'Резервный':'Основной'}{account.priority!==undefined?` · приоритет ${account.priority}`:account.executors.some(e=>e.preferred)?' · первый для новых сессий':''}</p>
    <p className="text-xs text-muted-foreground">{selected?'Только выбранные проекты':'Во всех проектах'}{account.projects?.rules.length?`: ${account.projects.rules.map(r=>`${names.get(r.projectId)??r.projectId}${r.role==='primary'?' — основной':r.role==='reserve'?' — резервный':''}`).join('; ')}`:''}</p>
    <p className="text-xs text-muted-foreground">Автопилот: {account.executors.some(e=>e.enabled&&e.autopilotAllowed)?'разрешён':'выключен'}.</p>
    <p className="text-xs text-muted-foreground">В работе: {account.active}; в очереди: {account.queued}; остановка не подтверждена: {account.uncertain}.</p>
    <p className="text-xs text-muted-foreground">Лимит здесь не измеряется. Состояние входа проверяет официальный клиент на машине исполнителя.</p>
  </div>;
}
export function NativeAccountSettings({account,revision,save,loadProjects,probe}:{probe?:(input:NativeProbeInput)=>Promise<NativeProbeResult>;account:Account;revision:string;save:(input:NativeAccountUpdate)=>Promise<void>;loadProjects:()=>Promise<Projects>}) {
  const priority=account.priority??(account.executors.some(e=>e.preferred)?0:10);
  const [draft,setDraft]=useState(String(priority));
  const [label,setLabel]=useState(account.label??'');
  useEffect(()=>setLabel(account.label??''),[account.label]);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [probeMessage,setProbeMessage]=useState('');
  const [probeProjects,setProbeProjects]=useState<Projects>([]);
  const [probeProject,setProbeProject]=useState('');
  const [probeModel,setProbeModel]=useState('');
  useEffect(()=>{let live=true;void loadProjects().then(value=>{if(live)setProbeProjects(value);}).catch(()=>{});return()=>{live=false;};},[]);
  const probeText:Record<NativeProbeResult['status'],string>={
    'not-started':'Проверка не запускалась. Проверьте доступность исполнителя и настройки проекта.',
    'runtime-unavailable':'Установленная версия исполнителя не поддерживает адресную проверку.',
    'catalog-received':'Каталог получен. Ответ модели ещё не проверен.',
    'model-responded':'Модель ответила. Аккаунт и исполнитель сверены; диагностический процесс остановлен.',
    'verification-required':'Google требует подтверждения. Пройдите проверку в браузере вместе с владельцем. Повторного запроса не было.',
    'model-unavailable':'Модель отсутствует в свежем каталоге этого аккаунта. Запрос модели не выполнялся.',
    'provider-error':'Официальный клиент не подтвердил ответ модели. Причина не установлена.',
    'stop-unconfirmed':'Остановка проверки не подтверждена. Повторный запуск заблокирован занятой сессией.',
  };
  useEffect(()=>setDraft(String(priority)),[priority]);
  const change=async(patch:Patch)=>{
    setPending(true);setError('');
    try{await save({accountId:account.accountId,expectedRevision:revision,...patch});}
    catch(reason){
      const text=reason instanceof Error?reason.message:'';
      setError(text.includes('native-executor-busy')?'Проекты и места запуска нельзя менять, пока у аккаунта есть сессии. Роль и приоритет можно изменить сейчас.':text.includes('native-selection-changed')?'Настройки изменились в другой сессии. Обновите данные и повторите.':'Не удалось сохранить настройки. Обновите данные и повторите.');
      throw reason;
    }finally{setPending(false);}
  };
  const apply=(patch:Patch)=>{void change(patch).catch(()=>{});};
  return <div className="space-y-4">
    <section className="pool-settings-section" aria-label="Выбор аккаунта">
      <h3 className="pool-settings-heading">Аккаунт Google</h3>
      <p className="pool-settings-help">{account.label??'Имя ещё не задано'}</p>
      <p className="pool-settings-help">Имя служит подписью в пуле. Подтверждённый email и подписку проверяет официальный клиент Google.</p>
      <fieldset disabled={pending} className="pool-settings-fields">
        <label className="pool-settings-field pool-settings-inline">Имя аккаунта<input className="pool-settings-control" aria-label="Имя аккаунта" maxLength={120} value={label} onChange={e=>setLabel(e.target.value)} onBlur={()=>{if(label.trim()&&label.trim()!==account.label)apply({label:label.trim()});}}/></label>
        <label className="pool-settings-field pool-settings-inline">Роль по умолчанию<select className="pool-settings-control" aria-label="Роль по умолчанию" value={account.role??'primary'} onChange={e=>apply({role:e.target.value as 'primary'|'reserve'})}><option value="primary">Основной</option><option value="reserve">Резервный</option></select></label>
        <label className="pool-settings-field pool-settings-inline">Приоритет<input className="pool-settings-control" type="number" min="-10000" max="10000" step="1" aria-label="Приоритет аккаунта" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} onBlur={()=>{
          const next=Number(draft);if(draft.trim()===''||!Number.isInteger(next)||Math.abs(next)>10000){setError('Приоритет должен быть целым числом от −10000 до 10000.');return;}
          if(next!==priority)apply({priority:next});
        }}/></label>
      </fieldset>
      <p className="pool-settings-help">Меньшее число выбирается раньше среди аккаунтов с одинаковой ролью и привязкой к проекту. Изменения действуют на новые сессии; текущие продолжаются на прежнем аккаунте.</p>
    </section>
    <section className="pool-settings-section" aria-label="Доступ Google и модель">
      <h3 className="pool-settings-heading">Доступ Google и модель</h3>
      <p className="pool-settings-help">{account.executors.some(e=>e.enabled)?'Запуск разрешён настройками пула. Ответ Google пока не проверен этой страницей.':'Обычные сессии выключены. Адресная проверка запускается отдельно кнопкой ниже.'}</p>
      <p className="pool-settings-help">Модель выбирается в форме новой сессии BB для Antigravity. Сохранённый каталог не подтверждает доступ этой подписки к модели; он проверяется при запросе.</p>
      <p className="pool-settings-help">При Verification Required завершите проверку Google в браузере с владельцем. Успешный вход и оплата сами по себе не подтверждают доступ к модели.</p>
      <p className="pool-settings-help">Измеренный лимит и состояние оплаты недоступны. Страница не запускает повторный вход.</p>
    </section>
    {account.mixedProjects&&<p role="status">У мест запуска разные проекты. Сохранение проектов применит одну настройку ко всему аккаунту.</p>}
    <fieldset disabled={pending}><AccountProjectsForm account={{role:account.role??'primary',projects:account.projects}} showQuotaHelp={false} loadProjects={loadProjects} save={projects=>change({projects})}/></fieldset>
    <section className="pool-settings-section" aria-label="Места запуска">
      <h3 className="pool-settings-heading">Места запуска и автопилот</h3>
      <p className="pool-settings-help">Вход Google хранится отдельно на каждой машине. Выключенное место запуска не участвует в новых сессиях.</p>
      <div className="pool-settings-fields"><label className="pool-settings-field">Проект для проверки<select className="pool-settings-control" aria-label="Проект для проверки" value={probeProject} onChange={event=>setProbeProject(event.target.value)}><option value="">Выберите проект</option>{probeProjects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="pool-settings-field">Модель для проверки<input className="pool-settings-control" aria-label="Модель для проверки" maxLength={160} placeholder="Только каталог" value={probeModel} onChange={event=>setProbeModel(event.target.value)}/></label></div>
      <p className="pool-settings-help">Проверка выполняет один запрос указанной модели без инструментов. Пустое поле получает только каталог. Включать аккаунт и менять основной для этого не требуется.</p>
      <fieldset disabled={pending} className="pool-settings-fields">{account.executors.map(e=><div key={e.id} className="space-y-2 py-2">
        <p className="pool-settings-help break-all">Исполнитель: {e.id}</p><p className="pool-settings-help break-all">Машина: {e.hostId??'не указана'} · {e.enabled?'разрешён настройками':'выключен'}</p>
        <Button size="sm" variant="outline" disabled={pending||!probe||!probeProject||!e.hostId} onClick={()=>{setPending(true);setProbeMessage('');void probe!({accountId:account.accountId,executorId:e.id,hostId:e.hostId!,projectId:probeProject,...(probeModel.trim()?{model:probeModel.trim()}:{} )}).then(result=>setProbeMessage(`${new Date(result.observedAt).toISOString().replace('T',' ').slice(0,19)+' UTC'} · ${result.model??'Каталог'} · ${probeText[result.status]}${result.catalog.length?` Моделей в каталоге: ${result.catalog.length}.`:''}`)).catch(()=>setProbeMessage('Проверка не запускалась или результат не подтверждён. Проверьте разрешения проекта и занятость аккаунта.')).finally(()=>setPending(false));}}>Проверить аккаунт</Button>
        <label className="pool-settings-toggle"><input type="checkbox" aria-label={`Включить ${e.id}`} checked={e.enabled} onChange={event=>apply({executor:{id:e.id,enabled:event.target.checked}})}/>Включён</label>
        <label className="pool-settings-toggle"><input type="checkbox" aria-label={`Разрешить автопилоту ${e.id}`} checked={e.autopilotAllowed} onChange={event=>apply({executor:{id:e.id,autopilotAllowed:event.target.checked}})}/>Разрешить автопилоту</label>
      </div>)}</fieldset>
    </section>
    {probeMessage&&<p role="status" className="pool-settings-help">{probeMessage}</p>}
    {pending&&<p role="status">Сохраняем…</p>}
    {error&&<p role="alert" className="pool-settings-error">{error}</p>}
  </div>;
}
