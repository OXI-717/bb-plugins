import { useEffect, useRef, useState } from 'react';
import { accountProjectsSchema, type AccountProjects, type AccountSummary } from './src/contracts.js';

export function AccountProjectsForm({ account, loadProjects, save, onUnsavedChange }: {
  account: AccountSummary;
  loadProjects: () => Promise<Array<{ id: string; name: string }>>;
  save: (projects: AccountProjects) => Promise<void>;
  onUnsavedChange?: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState<AccountProjects>(account.projects ?? { onlySelected: false, rules: [] });
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadRef = useRef(loadProjects); loadRef.current = loadProjects;
  useEffect(() => { let live = true; void loadRef.current().then(value => { if (!Array.isArray(value)) throw new Error("Invalid project catalog"); if (live) setCatalog(value); }).catch(() => { if (live) setCatalogError(true); }); return () => { live = false; }; }, []);
  const change = async (next: AccountProjects) => {
    setDraft(next); setPending(true); setError(''); setSaved(false); onUnsavedChange?.(true);
    try { await save(accountProjectsSchema.parse(next)); setSaved(true); onUnsavedChange?.(false); }
    catch { setError('Не удалось сохранить проекты. Повторите попытку.'); }
    finally { setPending(false); }
  };
  const names = new Map(catalog.map(project => [project.id, project.name]));
  return <section className="space-y-3 border-t pt-4" aria-label="Проекты подписки">
    <div className="font-medium">Проекты</div>
    <p className="text-sm text-muted-foreground">Роль по умолчанию: {account.role === 'primary' ? 'основной' : 'резерв'}. Настройки проекта переопределяют эту роль. Квоты и расписание общие для подписки.</p>
    <fieldset disabled={pending} className="space-y-3">
      <label className="block">Где использовать <select aria-label="Где использовать" className="ml-2 rounded border p-2" value={draft.onlySelected ? 'selected' : 'all'} onChange={e => void change({ ...draft, onlySelected: e.target.value === 'selected' })}>
        <option value="all">Во всех проектах</option><option value="selected">Только в выбранных</option>
      </select></label>
      {draft.rules.length === 0 && <p className="text-sm text-muted-foreground">Список пуст — используется в любом проекте.</p>}
      {draft.rules.map(rule => <div key={rule.projectId} className="flex flex-wrap items-center gap-2 text-sm">
        <span>{names.get(rule.projectId) ?? `Недоступный проект (${rule.projectId})`}</span>
        <select aria-label={`Роль в ${names.get(rule.projectId) ?? rule.projectId}`} className="rounded border p-2" value={rule.role} onChange={e => void change({ ...draft, rules: draft.rules.map(value => value.projectId === rule.projectId ? { ...value, role: e.target.value as typeof rule.role } : value) })}>
          <option value="inherit">По умолчанию</option><option value="primary">Основной</option><option value="reserve">Резерв</option>
        </select>
        <button type="button" aria-label={`Убрать ${names.get(rule.projectId) ?? rule.projectId}`} onClick={() => void change({ ...draft, rules: draft.rules.filter(value => value.projectId !== rule.projectId) })}>Убрать</button>
      </div>)}
      <label className="block">Добавить проект <select aria-label="Добавить проект" className="ml-2 rounded border p-2" value="" onChange={e => { if (e.target.value) void change({ ...draft, rules: [...draft.rules, { projectId: e.target.value, role: 'inherit' }] }); }}>
        <option value="">Выберите проект</option>{catalog.filter(project => !draft.rules.some(rule => rule.projectId === project.id)).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
    </fieldset>
    <p className="text-sm text-muted-foreground">Порядок: основной проекта → резерв проекта → общий основной → общий резерв. «До исчерпания» временно разрешает использование везде.</p>
    {catalogError && <p role="alert" className="text-sm">Не удалось загрузить список проектов. Сохранённые привязки остаются в силе.</p>}
    {pending && <p role="status">Сохраняем…</p>}{saved && <p role="status">Сохранено</p>}
    {error && <div role="alert">{error} <button type="button" disabled={pending} onClick={() => void change(draft)}>Повторить</button></div>}
  </section>;
}
