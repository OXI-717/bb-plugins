import { Button } from './ui/components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { accountProjectsSchema, type AccountProjects, type AccountSummary } from './src/contracts.js';

export function AccountProjectsForm({ account, loadProjects, save, onUnsavedChange }: {
  account: AccountSummary;
  loadProjects: () => Promise<Array<{ id: string; name: string }>>;
  save: (projects: AccountProjects, expectedProjects: AccountProjects | null) => Promise<void>;
  onUnsavedChange?: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState<AccountProjects>(account.projects ?? { onlySelected: false, rules: [] });
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dirty = useRef(false);
  const conflicted = useRef(false);
  const submitted = useRef<AccountProjects | null>(null);
  const baseline = useRef(account.projects ?? null);
  const incoming = JSON.stringify(account.projects ?? null);
  const lastIncoming = useRef(incoming);
  useEffect(() => {
    if (lastIncoming.current === incoming) return;
    lastIncoming.current = incoming;
    const persisted: AccountProjects | null = JSON.parse(incoming);
    if (dirty.current && incoming !== JSON.stringify(submitted.current)) {
      conflicted.current = true; setConflict(true); setSaved(false);
      setError('Настройки изменились в другой сессии. Загрузите актуальные настройки.');
    } else {
      baseline.current = persisted;
      if (!dirty.current) { setDraft(persisted ?? { onlySelected: false, rules: [] }); setSaved(false); }
    }
  }, [incoming]);
  const loadRef = useRef(loadProjects); loadRef.current = loadProjects;
  useEffect(() => { let live = true; void loadRef.current().then(value => { if (!Array.isArray(value)) throw new Error("Invalid project catalog"); if (live) setCatalog(value); }).catch(() => { if (live) setCatalogError(true); }); return () => { live = false; }; }, []);
  const change = async (next: AccountProjects) => {
    if (conflicted.current) return;
    dirty.current = true; submitted.current = next;
    setDraft(next); setPending(true); setError(''); setSaved(false); onUnsavedChange?.(true);
    try {
      await save(accountProjectsSchema.parse(next), baseline.current);
      if (!conflicted.current) { baseline.current = next; dirty.current = false; setSaved(true); onUnsavedChange?.(false); }
    }
    catch { setError('Не удалось сохранить проекты. Повторите попытку.'); }
    finally { submitted.current = null; setPending(false); }
  };
  const reload = () => {
    baseline.current = account.projects ?? null; dirty.current = false; conflicted.current = false;
    setDraft(account.projects ?? { onlySelected: false, rules: [] }); setConflict(false); setError(''); setSaved(false); onUnsavedChange?.(false);
  };
  const names = new Map(catalog.map(project => [project.id, project.name]));
  return <section className="pool-settings-section" aria-label="Проекты подписки">
    <h3 className="pool-settings-heading">Проекты</h3>
    <p className="pool-settings-help">Роль по умолчанию: {account.role === 'primary' ? 'основной' : 'резерв'}. Настройки проекта переопределяют эту роль. Квоты и расписание общие для подписки.</p>
    <fieldset disabled={pending || conflict} className="pool-settings-fields">
      <label className="pool-settings-field pool-settings-inline">Где использовать <select aria-label="Где использовать" className="pool-settings-control" value={draft.onlySelected ? 'selected' : 'all'} onChange={e => void change({ ...draft, onlySelected: e.target.value === 'selected' })}>
        <option value="all">Во всех проектах</option><option value="selected">Только в выбранных</option>
      </select></label>
      {draft.rules.length === 0 && <p className="pool-settings-help">Список пуст — используется в любом проекте.</p>}
      {draft.rules.map(rule => <div key={rule.projectId} className="pool-settings-project">
        <span className="pool-settings-project-name">{names.get(rule.projectId) ?? `Недоступный проект (${rule.projectId})`}</span>
        <select aria-label={`Роль в ${names.get(rule.projectId) ?? rule.projectId}`} className="pool-settings-control" value={rule.role} onChange={e => void change({ ...draft, rules: draft.rules.map(value => value.projectId === rule.projectId ? { ...value, role: e.target.value as typeof rule.role } : value) })}>
          <option value="inherit">По умолчанию</option><option value="primary">Основной</option><option value="reserve">Резерв</option>
        </select>
        <Button className="pool-settings-remove" size="sm" variant="ghost" type="button" aria-label={`Убрать ${names.get(rule.projectId) ?? rule.projectId}`} onClick={() => void change({ ...draft, rules: draft.rules.filter(value => value.projectId !== rule.projectId) })}><span aria-hidden="true">×</span></Button>
      </div>)}
      <label className="pool-settings-field pool-settings-inline pool-settings-project-add">Добавить проект <select aria-label="Добавить проект" className="pool-settings-control" value="" onChange={e => { if (e.target.value) void change({ ...draft, rules: [...draft.rules, { projectId: e.target.value, role: 'inherit' }] }); }}>
        <option value="">Выберите проект</option>{catalog.filter(project => !draft.rules.some(rule => rule.projectId === project.id)).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
    </fieldset>
    <p className="pool-settings-help">Порядок: основной проекта → резерв проекта → общий основной → общий резерв. «До исчерпания» временно разрешает использование везде.</p>
    {catalogError && <p role="alert" className="text-sm">Не удалось загрузить список проектов. Сохранённые привязки остаются в силе.</p>}
    <p role="status" className="pool-settings-status">{pending ? "Сохраняем…" : saved ? "Сохранено" : ""}</p>
    {error && <div role="alert" className="pool-settings-error">{error} {conflict
      ? <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={reload}>Загрузить актуальные настройки</Button>
      : <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => void change(draft)}>Повторить</Button>}</div>}
  </section>;
}
