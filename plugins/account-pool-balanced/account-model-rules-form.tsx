import { Button } from './ui/components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { MODEL_PATTERN, modelRulesSchema, type ModelRules } from './src/model-rules.js';

const MODES = { pin: 'Закрепить', allow: 'Только эти', deny: 'Запретить' } as const;

export function AccountModelRulesForm({ account, save, onUnsavedChange }: {
  account: { provider: string; modelRules?: ModelRules };
  save: (rules: ModelRules, expected: ModelRules | null) => Promise<void>;
  onUnsavedChange?: (value: boolean) => void;
}) {
  const incoming = JSON.stringify(account.modelRules ?? null);
  const baseline = useRef<ModelRules | null>(account.modelRules ?? null);
  const dirty = useRef(false);
  const submitted = useRef<ModelRules | null>(null);
  const conflicted = useRef(false);
  const [draft, setDraft] = useState<ModelRules>(account.modelRules ?? []);
  const [pattern, setPattern] = useState('');
  const [mode, setMode] = useState<'pin' | 'allow' | 'deny'>('pin');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const lastIncoming = useRef(incoming);
  useEffect(() => {
    if (lastIncoming.current === incoming) return;
    lastIncoming.current = incoming;
    const persisted: ModelRules | null = JSON.parse(incoming);
    if (dirty.current && incoming !== JSON.stringify((submitted.current?.length ? submitted.current : null))) { conflicted.current = true; setConflict(true); setSaved(false); setError('Правила изменены в другом сеансе. Загрузите актуальные.'); return; }
    baseline.current = persisted; setDraft(persisted ?? []); setSaved(false);
  }, [incoming]);
  const change = async (next: ModelRules) => {
    if (conflicted.current) return;
    dirty.current = true; submitted.current = next; setDraft(next); setPending(true); setError(''); setSaved(false); onUnsavedChange?.(true);
    try {
      await save(modelRulesSchema.parse(next), baseline.current);
      if (!conflicted.current) { baseline.current = next.length ? next : null; dirty.current = false; setSaved(true); onUnsavedChange?.(false); }
    } catch { setError('Не удалось сохранить правила моделей. Повторите.'); }
    finally { submitted.current = null; setPending(false); }
  };
  const reload = () => {
    baseline.current = account.modelRules ?? null; dirty.current = false; conflicted.current = false;
    setDraft(account.modelRules ?? []); setConflict(false); setError(''); setSaved(false); onUnsavedChange?.(false);
  };
  const candidate = pattern.trim();
  const valid = MODEL_PATTERN.test(candidate) && !draft.some(rule => rule.pattern === candidate && rule.mode === mode);
  const effective = true;
  return <section className="pool-settings-section" aria-label="Правила моделей">
    <h3 className="pool-settings-heading">Правила моделей</h3>
    <p className="pool-settings-help">«Закрепить» отправляет модель сначала на этот аккаунт; «Только эти» ограничивает аккаунт перечисленными моделями; «Запретить» не пускает модель на аккаунт. Шаблон — идентификатор модели или префикс со звёздочкой в конце. Точный идентификатор сильнее префикса, «Запретить» сильнее «Закрепить».{effective ? '' : ' '}</p>
    <fieldset disabled={pending || conflict} className="pool-settings-fields">
      {draft.length === 0 && <p className="pool-settings-help">Правил нет: любая модель идёт по приоритету и квоте пула.</p>}
      {draft.map(rule => <div key={rule.pattern + rule.mode} className="pool-settings-project">
        <span className="pool-settings-project-name">{rule.pattern}</span>
        <span className="pool-settings-control">{MODES[rule.mode]}</span>
        <Button className="pool-settings-remove" size="sm" variant="ghost" type="button" aria-label={`Удалить правило ${rule.pattern}`} onClick={() => void change(draft.filter(item => item !== rule))}>×</Button>
        {rule.mode === 'pin' && <label className="pool-settings-toggle" style={{ gridColumn: '1 / -1' }}><input type="checkbox" aria-label={`Передать ${rule.pattern} другим аккаунтам`} checked={rule.fallback === true}
          onChange={event => void change(draft.map(item => item === rule ? { ...item, fallback: event.target.checked || undefined } : item))} /> Если квота исчерпана — взять другой аккаунт</label>}
      </div>)}
      <label className="pool-settings-field pool-settings-inline">Модель <input aria-label="Шаблон модели" className="pool-settings-control" placeholder="gemini-4-hydrogen*" value={pattern} onChange={event => setPattern(event.target.value)} /></label>
      <label className="pool-settings-field pool-settings-inline">Режим <select aria-label="Режим правила" className="pool-settings-control" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        {Object.entries(MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <Button size="sm" variant="outline" type="button" disabled={!valid || draft.length >= 32} onClick={() => { void change([...draft, { pattern: candidate, mode }]); setPattern(''); }}>Добавить правило</Button>
    </fieldset>
    <p role="status" className="pool-settings-status">{pending ? 'Сохранение…' : saved ? 'Сохранено' : ''}</p>
    {error && <div role="alert" className="pool-settings-error">{error} {conflict
      ? <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={reload}>Загрузить актуальные</Button>
      : <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => void change(draft)}>Повторить</Button>}</div>}
  </section>;
}
