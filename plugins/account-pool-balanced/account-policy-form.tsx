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
      if (!parsed.success) { setError('Check the percentages, time zone, and schedule intervals.'); return; }
      setPending(true);
      try { await saveRef.current(parsed.data); setDirty(false); setSaved(true); unsavedRef.current?.(false); }
      catch { setError('Could not save the settings. Try again.'); }
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
      <span className="pool-settings-help">{draft[field] === null ? `Shared value: ${fallback}` : `Account value: ${draft[field]}`}. Clear the field to inherit the shared value.</span>
    </label>
  );
  return <section className="pool-settings-section">
    <label className="pool-settings-toggle"><input type="checkbox" checked={draft.enabled} disabled={pending} onChange={e => change({ enabled: e.target.checked })} />Account-specific settings</label>
    <p className="pool-settings-help">{draft.enabled ? policySummary(draft) : 'Shared rules are active. Account-specific values are saved.'}</p>
    {!account.policy && <p className="pool-settings-help">Fields contain the current shared values. Enabling this saves them as account-specific settings.</p>}
    <fieldset disabled={!draft.enabled || pending} className="pool-settings-fields">
      {hasFiveHour && numberField('fiveHourKeep', '5-hour quota to keep, %', inheritedKeep)}
      {numberField('weeklyKeep', 'Weekly quota to keep, %', inheritedKeep)}
      {account.role === 'reserve' && numberField('reserveDrainHours', 'Enable reserve this many working hours before reset', drainHours)}
      <label className="pool-settings-toggle"><input type="checkbox" checked={draft.schedule !== null} onChange={e => change({ schedule: e.target.checked ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intervals: [{ days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } : null })} />Account schedule</label>
      {draft.schedule && <div className="pool-settings-fields pool-settings-schedule-fields">
        <label className="pool-settings-field pool-settings-inline">Time zone <input aria-label="Time zone" className="pool-settings-control" value={draft.schedule.timeZone} onChange={e => change({ schedule: { ...draft.schedule!, timeZone: e.target.value } })} /></label>
        {draft.schedule.intervals.map((interval, index) => {
          const update = (patch: Partial<typeof interval>) => change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.map((v,i) => i === index ? { ...v, ...patch } : v) } });
          const weekdays = interval.days.length === 5 && [1,2,3,4,5].every(day => interval.days.includes(day));
          const daily = interval.days.length === 7;
          const custom = customIntervals.includes(index) || (!weekdays && !daily);
          return <div key={index} className="pool-settings-schedule">
            <div className="pool-settings-interval">
              <select className="pool-settings-control" aria-label={`Days for interval ${index + 1}`} value={custom ? 'custom' : daily ? 'daily' : 'weekdays'} onChange={e => {
                if (e.target.value === 'custom') setCustomIntervals(values => [...values.filter(v => v !== index), index]);
                else { setCustomIntervals(values => values.filter(v => v !== index)); update({ days: e.target.value === 'daily' ? [0,1,2,3,4,5,6] : [1,2,3,4,5] }); }
              }}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="custom">Custom days</option></select>
              <input aria-label={`Interval ${index + 1} start`} className="pool-settings-control" type="time" value={interval.start} onChange={e => update({ start: e.target.value })} />
              <span aria-hidden="true" className="pool-settings-time-separator">—</span>
              <input aria-label={`Interval ${index + 1} end`} className="pool-settings-control" type="time" value={interval.end} onChange={e => update({ end: e.target.value })} />
              <Button className="pool-settings-remove" aria-label={`Remove interval ${index + 1}`} size="sm" variant="ghost" onClick={() => { setCustomIntervals([]); change({ schedule: { ...draft.schedule!, intervals: draft.schedule!.intervals.filter((_,i) => i !== index) } }); }}><span aria-hidden="true">×</span></Button>
            </div>
            {custom && <div className="pool-settings-days">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((name,day) => <label key={day} className="pool-settings-toggle"><input type="checkbox" checked={interval.days.includes(day)} onChange={e => update({ days: e.target.checked ? [...interval.days,day] : interval.days.filter(d => d !== day) })} />{name}</label>)}</div>}
          </div>;
        })}
        <Button size="sm" variant="outline" onClick={() => change({ schedule: { ...draft.schedule!, intervals: [...draft.schedule!.intervals, { days: [1,2,3,4,5], start: '09:00', end: '18:00' }] } })}>Add interval</Button>
        <p className="pool-settings-help">The selected day is the interval's start day. 20:00–08:00 ends the next day. An account with no intervals is unavailable. Outside its schedule, it will not receive new requests unless “Use until exhausted” is enabled.</p>
      </div>}
    </fieldset>
    {account.drainOnce && <p className="text-sm">Until exhausted: quota protection and schedule are temporarily disabled.</p>}
    <p className="pool-settings-help">Changes are saved automatically. “Use until exhausted” temporarily overrides shared and account-specific quota reserves, schedules, and project restrictions. The mode turns off when a provider limit is first exhausted.</p>
    {error ? <><p role="alert" className="pool-settings-error">{error}</p><Button size="sm" onClick={() => setError('')}>Retry save</Button></> :
      <p role="status" className="pool-settings-status">{pending ? 'Saving…' : dirty ? 'Waiting to save…' : saved ? 'Settings saved' : 'All changes saved'}</p>}

    {dirty && <><p className="text-sm">Save or discard changes before closing this card.</p><Button size="sm" variant="ghost" disabled={pending} onClick={() => {
      setDraft(initialPolicy());
      setDirty(false); setError(''); setSaved(false); onUnsavedChange?.(false);
    }}>Discard changes</Button></>}
  </section>;
}
