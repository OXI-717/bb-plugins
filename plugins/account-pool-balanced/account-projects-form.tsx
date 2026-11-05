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
      setError('Settings changed in another session. Reload the latest settings.');
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
    catch { setError('Could not save project rules. Try again.'); }
    finally { submitted.current = null; setPending(false); }
  };
  const reload = () => {
    baseline.current = account.projects ?? null; dirty.current = false; conflicted.current = false;
    setDraft(account.projects ?? { onlySelected: false, rules: [] }); setConflict(false); setError(''); setSaved(false); onUnsavedChange?.(false);
  };
  const names = new Map(catalog.map(project => [project.id, project.name]));
  return <section className="pool-settings-section" aria-label="Subscription projects">
    <h3 className="pool-settings-heading">Projects</h3>
    <p className="pool-settings-help">Default role: {account.role === 'primary' ? 'primary' : 'reserve'}. Project rules override this role. Quotas and schedules are shared across the subscription.</p>
    <fieldset disabled={pending || conflict} className="pool-settings-fields">
      <label className="pool-settings-field pool-settings-inline">Use in <select aria-label="Use in" className="pool-settings-control" value={draft.onlySelected ? 'selected' : 'all'} onChange={e => void change({ ...draft, onlySelected: e.target.value === 'selected' })}>
        <option value="all">All projects</option><option value="selected">Selected projects only</option>
      </select></label>
      {draft.rules.length === 0 && <p className="pool-settings-help">The list is empty; this account can be used in any project.</p>}
      {draft.rules.map(rule => <div key={rule.projectId} className="pool-settings-project">
        <span className="pool-settings-project-name">{names.get(rule.projectId) ?? `Unavailable project (${rule.projectId})`}</span>
        <select aria-label={`Role in ${names.get(rule.projectId) ?? rule.projectId}`} className="pool-settings-control" value={rule.role} onChange={e => void change({ ...draft, rules: draft.rules.map(value => value.projectId === rule.projectId ? { ...value, role: e.target.value as typeof rule.role } : value) })}>
          <option value="inherit">Default</option><option value="primary">Primary</option><option value="reserve">Reserve</option>
        </select>
        <Button className="pool-settings-remove" size="sm" variant="ghost" type="button" aria-label={`Remove ${names.get(rule.projectId) ?? rule.projectId}`} onClick={() => void change({ ...draft, rules: draft.rules.filter(value => value.projectId !== rule.projectId) })}><span aria-hidden="true">×</span></Button>
      </div>)}
      <label className="pool-settings-field pool-settings-inline pool-settings-project-add">Add project <select aria-label="Add project" className="pool-settings-control" value="" onChange={e => { if (e.target.value) void change({ ...draft, rules: [...draft.rules, { projectId: e.target.value, role: 'inherit' }] }); }}>
        <option value="">Choose a project</option>{catalog.filter(project => !draft.rules.some(rule => rule.projectId === project.id)).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
    </fieldset>
    <p className="pool-settings-help">Order: project primary → project reserve → global primary → global reserve. “Until exhausted” temporarily allows use in every project.</p>
    {catalogError && <p role="alert" className="text-sm">Could not load the project list. Saved rules remain in effect.</p>}
    <p role="status" className="pool-settings-status">{pending ? "Saving…" : saved ? "Saved" : ""}</p>
    {error && <div role="alert" className="pool-settings-error">{error} {conflict
      ? <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={reload}>Reload latest settings</Button>
      : <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => void change(draft)}>Retry</Button>}</div>}
  </section>;
}
