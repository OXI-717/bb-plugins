import { useEffect, useRef, useState } from 'react';
import { accountPolicySchema, type AccountPolicy, type AccountSummary } from './src/contracts.js';
import { policySummary } from './src/account-policy.js';
import { Button } from './ui/components/ui/button';

export function AccountPolicyForm({ account, threshold, drainHours, save, onUnsavedChange }: {
  account: AccountSummary; threshold: number; drainHours: number;
  save: (policy: AccountPolicy) => Promise<void>;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const inheritedKeep = Number(((1 - threshold) * 100).toFixed(10));
  const initialPolicy = () => account.policy ?? accountPolicySchema.parse({
    enabled: false, fiveHourKeep: inheritedKeep, weeklyKeep: inheritedKeep, reserveDrainHours: drainHours,
  });
  const [draft, setDraft] = useState<AccountPolicy>(initialPolicy);
  const [pending, setPending] = useState(false);
  const [customIntervals, setCustomIntervals] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const unsavedRef = useRef(onUnsavedChange);
  unsavedRef.current = onUnsavedChange;
  useEffect(() => {
    if (!dirty || pending || error) return;
    const timer = setTimeout(async () => {
      const parsed = accountPolicySchema.safeParse(draft);
      if (!parsed.success) { setError('Проверьте проценты, часовой пояс и интервалы расписания.'); return; }
      setPending(true);
      try { await saveRef.current(parsed.data); setDirty(false); setSaved(true); unsavedRef.current?.(false); }
      catch { setError('Не удалось сохранить настройки. Повторите попытку.'); }
      finally { setPending(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, dirty, pending, error]);
  const change = (patch: Partial<AccountPolicy>) => { setDraft(p => ({ ...p, ...patch })); setSaved(false); setDirty(true); setError(''); onUnsavedChange?.(true); };
  const hasFiveHour = account.provider === 'claude' || account.fiveHourUtilization !== null || account.limitWindows.some(w => w.windowMinutes === 300);
  const numberField = (field: 'fiveHourKeep' | 'weeklyKeep' | 'reserveDrainHours', label: string, fallback: number) => (
    <label className="pool-settings-field pool-settings-inline pool-settings-number">
      <span>{label}</span>
      <input className="pool-settings-control" type="number" min={field === 'reserveDrainHours' ? 1 : 0} max={field === 'reserveDrainHours' ? 168 : 100}
        value={draft[field] ?? fallback} onChange={e => change({ [field]: e.target.value === '' ? null : Number(e.target.value) })} />
      <span className="pool-settings-help">{draft[field] === null ? `Общее значение: ${fallback}` : `Личное значение: ${draft[field]}`}. Очистить поле — наследовать общее значение.</span>
    </label>
  );
  return <section className="pool-settings-section">
    <label className="pool-settings-toggle"><input type="checkbox" checked={draft.enabled} disabled={pending} onChange={e => change({ enabled: e.target.checked })} />Индивидуальные настройки</label>
    <p className="pool-settings-help">{draft.enabled ? policySummary(draft) : 'Действуют общие правила. Личные значения сохраняются.'}</p>
    {!account.policy && <p className="pool-settings-help">Поля заполнены текущими общими значениями. При включении они сохранятся как индивидуальные.</p>}
    <fieldset disabled={!draft.enabled || pending} className="pool-settings-fields">
      {hasFiveHour && numberField('fiveHourKeep', 'Оставлять квоту 5 часов, %', inheritedKeep)}
      {numberField('weeklyKeep', 'Оставлять недельную квоту, %', inheritedKeep)}
      {account.role === 'reserve' && numberField('reserveDrainHours', 'Подключать резерв за рабочих часов до сброса', drainHours)}
      <label className="pool-settings-toggle"><input type="checkbox" checked={draft.schedule !== null} onChange={e => change({ schedule: e.target.checked ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intervals: [{ days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } : null })} />Личное расписание</label>
      {draft.schedule && <div className="pool-settings-fields pool-settings-schedule-fields">
        <label className="pool-settings-field pool-settings-inline">Часовой пояс <input aria-label="Часовой пояс" className="pool-settings-control" value={draft.schedule.timeZone} onChange={e => change({ schedule: { ...draft.schedule!, timeZone: e.target.value } })} /></label>
        {draft.schedule.intervals.map((interval, index) => {
          const update = (patch: Partial<typeof interval>) => change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.map((v,i) => i === index ? { ...v, ...patch } : v) } });
          const weekdays = interval.days.length === 5 && [1,2,3,4,5].every(day => interval.days.includes(day));
          const daily = interval.days.length === 7;
          const custom = customIntervals.includes(index) || (!weekdays && !daily);
          return <div key={index} className="pool-settings-schedule">
            <div className="pool-settings-interval">
              <select className="pool-settings-control" aria-label={`Дни интервала ${index + 1}`} value={custom ? 'custom' : daily ? 'daily' : 'weekdays'} onChange={e => {
                if (e.target.value === 'custom') setCustomIntervals(values => [...values.filter(v => v !== index), index]);
                else { setCustomIntervals(values => values.filter(v => v !== index)); update({ days: e.target.value === 'daily' ? [0,1,2,3,4,5,6] : [1,2,3,4,5] }); }
              }}><option value="daily">Каждый день</option><option value="weekdays">Будни</option><option value="custom">Свои дни</option></select>
              <input aria-label={`Начало интервала ${index + 1}`} className="pool-settings-control" type="time" value={interval.start} onChange={e => update({ start: e.target.value })} />
              <span aria-hidden="true" className="pool-settings-time-separator">—</span>
              <input aria-label={`Конец интервала ${index + 1}`} className="pool-settings-control" type="time" value={interval.end} onChange={e => update({ end: e.target.value })} />
              <Button className="pool-settings-remove" aria-label={`Удалить интервал ${index + 1}`} size="sm" variant="ghost" onClick={() => { setCustomIntervals([]); change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.filter((_,i) => i !== index) } }); }}><span aria-hidden="true">×</span></Button>
            </div>
            {custom && <div className="pool-settings-days">{['Вс','Пн','Вт','Ср','Чт','Пт','Сб'].map((name,day) => <label key={day} className="pool-settings-toggle"><input type="checkbox" checked={interval.days.includes(day)} onChange={e => update({ days: e.target.checked ? [...interval.days,day] : interval.days.filter(d => d !== day) })} />{name}</label>)}</div>}
          </div>;
        })}
        <Button size="sm" variant="outline" onClick={() => change({ schedule: { ...draft.schedule!, intervals: [...draft.schedule!.intervals, { days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } })}>Добавить интервал</Button>
        <p className="pool-settings-help">Дни относятся к началу интервала. 20:00–08:00 заканчивается на следующий день. Без интервалов аккаунт недоступен. Вне расписания новые запросы не запускаются, кроме режима «Использовать до исчерпания».</p>
      </div>}
    </fieldset>
    {account.drainOnce && <p className="text-sm">До исчерпания: защита остатка и расписание временно отключены.</p>}
    <p className="pool-settings-help">Изменения сохраняются автоматически. Режим «Использовать до исчерпания» временно отменяет общий и индивидуальный запас квоты, расписание и ограничения по проектам. После первого исчерпанного лимита режим выключается.</p>
    {error ? <><p role="alert" className="pool-settings-error">{error}</p><Button size="sm" onClick={() => setError('')}>Повторить сохранение</Button></> :
      <p role="status" className="pool-settings-status">{pending ? 'Сохранение…' : dirty ? 'Ожидание сохранения…' : saved ? 'Настройки сохранены' : 'Все изменения сохранены'}</p>}

    {dirty && <><p className="text-sm">Карточку можно закрыть после сохранения или отмены изменений.</p><Button size="sm" variant="ghost" disabled={pending} onClick={() => {
      setDraft(initialPolicy());
      setDirty(false); setError(''); setSaved(false); onUnsavedChange?.(false);
    }}>Отменить изменения</Button></>}
  </section>;
}
