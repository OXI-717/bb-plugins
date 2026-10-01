import { useEffect, useRef, useState } from 'react';
import { accountPolicySchema, type AccountPolicy, type AccountSummary } from './src/contracts.js';
import { policySummary } from './src/account-policy.js';
import { Button } from './ui/components/ui/button';

export function AccountPolicyForm({ account, threshold, drainHours, save, onUnsavedChange }: {
  account: AccountSummary; threshold: number; drainHours: number;
  save: (policy: AccountPolicy) => Promise<void>;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const [draft, setDraft] = useState<AccountPolicy>(() => account.policy ?? accountPolicySchema.parse({ enabled: false }));
  const [pending, setPending] = useState(false);
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
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <input className="w-full rounded border p-2" type="number" min={field === 'reserveDrainHours' ? 1 : 0} max={field === 'reserveDrainHours' ? 168 : 100}
        value={draft[field] ?? ''} placeholder={`Общее: ${fallback}`} onChange={e => change({ [field]: e.target.value === '' ? null : Number(e.target.value) })} />
      <span className="text-muted-foreground">{draft[field] === null ? `Общее значение: ${fallback}` : `Личное значение: ${draft[field]}`}. Пустое поле — наследовать.</span>
    </label>
  );
  return <section className="space-y-3 border-t pt-4">
    <label className="flex gap-2"><input type="checkbox" checked={draft.enabled} disabled={pending} onChange={e => change({ enabled: e.target.checked })} />Индивидуальные настройки</label>
    <p className="text-sm text-muted-foreground">{draft.enabled ? policySummary(draft) : 'Действуют общие правила. Личные значения сохраняются.'}</p>
    <fieldset disabled={!draft.enabled || pending} className="space-y-3">
      {hasFiveHour && numberField('fiveHourKeep', 'Оставлять квоту 5 часов, %', Math.round((1 - threshold) * 100))}
      {numberField('weeklyKeep', 'Оставлять недельную квоту, %', Math.round((1 - threshold) * 100))}
      {account.role === 'reserve' && numberField('reserveDrainHours', 'Подключать резерв за рабочих часов до сброса', drainHours)}
      <label className="flex gap-2"><input type="checkbox" checked={draft.schedule !== null} onChange={e => change({ schedule: e.target.checked ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intervals: [{ days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } : null })} />Личное расписание</label>
      {draft.schedule && <div className="space-y-3">
        <label className="block">Часовой пояс <input aria-label="Часовой пояс" className="rounded border p-2" value={draft.schedule.timeZone} onChange={e => change({ schedule: { ...draft.schedule!, timeZone: e.target.value } })} /></label>
        {draft.schedule.intervals.map((interval, index) => {
          const update = (patch: Partial<typeof interval>) => change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.map((v,i) => i === index ? { ...v, ...patch } : v) } });
          return <div key={index} className="space-y-2 rounded border p-2">
            <div className="flex flex-wrap gap-2">{['Вс','Пн','Вт','Ср','Чт','Пт','Сб'].map((name,day) => <label key={day}><input type="checkbox" checked={interval.days.includes(day)} onChange={e => update({ days: e.target.checked ? [...interval.days,day] : interval.days.filter(d => d !== day) })} />{name}</label>)}</div>
            <label>С <input type="time" value={interval.start} onChange={e => update({ start: e.target.value })} /></label>{' '}
            <label>До <input type="time" value={interval.end} onChange={e => update({ end: e.target.value })} /></label>{' '}
            <Button size="sm" variant="ghost" onClick={() => change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.filter((_,i) => i !== index) } })}>Удалить интервал</Button>
          </div>;
        })}
        <Button size="sm" variant="outline" onClick={() => change({ schedule: { ...draft.schedule!, intervals: [...draft.schedule!.intervals, { days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } })}>Добавить интервал</Button>
        <p className="text-sm text-muted-foreground">Дни относятся к началу интервала. 20:00–08:00 заканчивается на следующий день. Без интервалов аккаунт недоступен. Вне расписания новые запросы не запускаются.</p>
      </div>}
    </fieldset>
    {account.drainOnce && <p className="text-sm">До исчерпания: защита остатка временно отключена, расписание продолжает действовать.</p>}
    <p className="text-sm text-muted-foreground">Изменения сохраняются автоматически. Режим «Использовать до исчерпания» временно отменяет общий и индивидуальный запас квоты, но не расписание. После первого исчерпанного лимита режим выключается.</p>
    {error ? <><p role="alert">{error}</p><Button size="sm" onClick={() => setError('')}>Повторить сохранение</Button></> :
      <p role="status">{pending ? 'Сохранение…' : dirty ? 'Ожидание сохранения…' : saved ? 'Настройки сохранены' : 'Все изменения сохранены'}</p>}

    {dirty && <><p className="text-sm">Карточку можно закрыть после сохранения или отмены изменений.</p><Button size="sm" variant="ghost" disabled={pending} onClick={() => {
      setDraft(account.policy ?? accountPolicySchema.parse({ enabled: false }));
      setDirty(false); setError(''); setSaved(false); onUnsavedChange?.(false);
    }}>Отменить изменения</Button></>}
  </section>;
}
