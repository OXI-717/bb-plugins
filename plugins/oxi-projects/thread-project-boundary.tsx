import {useEffect, useState, type ReactNode} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import {toast} from 'sonner';
import type {TaskboardRpcContract} from './contract';

function isFederationRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'serverCode' in error &&
    error.serverCode === 'federation_plugin_not_federated';
}

export function ThreadProjectBoundary({threadId, fallbackProjectId, children}: {
  threadId: string;
  fallbackProjectId: string | null;
  children: (projectId: string | null) => ReactNode;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [result, setResult] = useState<
    {threadId: string; kind: 'ready'; projectId: string | null} |
    {threadId: string; kind: 'unavailable'}
  >();

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    void rpc.call('threadProject', {threadId}).then(value => {
      if (!cancelled) setResult({threadId, kind: 'ready', projectId: value.projectId});
    }).catch(error => {
      if (cancelled) return;
      if (isFederationRefusal(error)) {
        setResult({threadId, kind: 'unavailable'});
        return;
      }
      setResult({threadId, kind: 'ready', projectId: fallbackProjectId});
      toast.error('Could not resolve this thread’s Taskboard project.', {
        description: error instanceof Error ? error.message : String(error)
      });
    });
    return () => { cancelled = true; };
  }, [fallbackProjectId, rpc, threadId]);

  if (!result || result.threadId !== threadId) {
    return <p role="status" className="p-4 text-sm text-muted-foreground">Загрузка проекта…</p>;
  }
  if (result.kind === 'unavailable') {
    return <section className="space-y-2 p-4 text-sm">
      <h2 className="font-medium">Проект недоступен через федерацию</h2>
      <p className="text-muted-foreground">Задачи и подключения этого проекта доступны в BB удалённого сервера. Здесь можно продолжать работу в чате.</p>
    </section>;
  }
  return children(result.projectId);
}
