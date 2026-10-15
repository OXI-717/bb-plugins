import {useBbNavigate, type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import {useState} from 'react';
import {parseTaskLink, TASK_DETAIL_PANEL_ID} from './task-links';

export function ProjectTaskLink({attributes, source}: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const [error, setError] = useState('');
  const target = parseTaskLink(attributes);
  if (!target) return <span>{source}</span>;
  let label = target.locator;
  try { if (attributes.label) label = decodeURIComponent(attributes.label).slice(0, 120); } catch { /* Invalid label: show locator. */ }
  const locatorLabel = label.length > 80 ? `${label.slice(0, 77)}…` : label;
  return <span className="inline-flex flex-col items-start gap-1"><button
    type="button"
    className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-primary hover:bg-accent"
    title={`Проект ${target.projectId} · ${target.source} · ${target.locator}`}
    onClick={() => {
      const opened = navigate.openThreadPanel({actionId:TASK_DETAIL_PANEL_ID,title:locatorLabel,params:target});
      setError(opened ? '' : 'Боковая панель недоступна в этом представлении. Открой сообщение в основном треде.');
    }}
  >Открыть задачу сбоку · {locatorLabel}</button>{error && <span role="alert" className="text-xs text-destructive">{error}</span>}</span>;
}
