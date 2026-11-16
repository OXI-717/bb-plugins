import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { accountPoolRpcContract } from './src/rpc.js';
import type { managementRpcContract } from './src/management-wire.js';
import type { ManagementGrant } from './src/management-wire.js';
import { Button } from './ui/components/ui/button';
import { ManagementAccessForm } from './management-access-form';

let currentGrant: ManagementGrant | null = null;
const listeners = new Set<() => void>();
const publish = (grant: ManagementGrant | null) => {
  currentGrant = grant;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useManagementGrant() {
  const grant = useSyncExternalStore(subscribe, () => currentGrant, () => null);
  useEffect(() => {
    if (!grant) return;
    const remaining = grant.expiresAt - Date.now();
    if (remaining <= 0) { publish(null); return; }
    const timer = setTimeout(() => { if (currentGrant === grant) publish(null); }, remaining);
    return () => clearTimeout(timer);
  }, [grant]);
  return grant;
}

type PoolRpc = ReturnType<typeof useRpc<typeof accountPoolRpcContract>>;
export function usePoolRpc(): PoolRpc {
  const rpc = useRpc<typeof managementRpcContract>();
  const grant = useManagementGrant();
  return useMemo(() => ({ call: async (method: string, input: unknown) => {
    if (!grant || grant.expiresAt <= Date.now()) throw new Error('Management access is locked.');
    const result = await rpc.call('management.call', { token: grant.token, method, input });
    if (!result.ok) { if (currentGrant === grant) publish(null); throw new Error('Management access is locked.'); }
    return result.result;
  } }) as PoolRpc, [rpc, grant]);
}

export function ManagementGate({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof managementRpcContract>();
  const grant = useManagementGrant();
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { try { window.localStorage.removeItem('account-pool:status'); } catch {} }, []);
  const lock = useCallback(async () => {
    const previous = currentGrant;
    publish(null);
    if (previous) await rpc.call('management.lock', { token: previous.token }).catch(() => {});
  }, [rpc]);
  if (grant) return <>
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Управление разблокировано до {new Date(grant.expiresAt).toLocaleTimeString('ru-RU')}.</p><Button size="sm" onClick={() => void lock()}>Заблокировать управление</Button></div>
    {children}
  </>;
  return <ManagementAccessForm value={key} pending={pending} error={error} onChange={setKey} onSubmit={async event => {
    event.preventDefault(); setPending(true); setError(false);
    try { publish(await rpc.call('management.unlock', { key, scope: 'manage', ttlSeconds: 900 })); }
    catch { setError(true); }
    finally { setKey(''); setPending(false); }
  }} />;
}
