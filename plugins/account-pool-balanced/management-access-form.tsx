import React, { type FormEvent } from 'react';
import { Button } from './ui/components/ui/button';
import { Input } from './ui/components/ui/input';

export function ManagementAccessForm({ value, pending, error, onChange, onSubmit }: {
  value: string; pending: boolean; error: boolean;
  onChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <form className="space-y-3 p-4" aria-label="Доступ к управлению аккаунтами" onSubmit={onSubmit}>
    <h2 className="text-sm font-medium">Управление аккаунтами заблокировано</h2>
    <p className="text-sm text-muted-foreground">Для просмотра аккаунтов и изменения настроек нужен отдельный ключ администратора. Он не передаётся рабочим сессиям. Разблокировка действует 15 минут в этой вкладке.</p>
    <label className="block space-y-1"><span className="text-sm">Ключ администратора</span><Input type="password" autoComplete="off" maxLength={256} value={value} onChange={event => onChange(event.target.value)} disabled={pending} /></label>
    <Button type="submit" disabled={pending || !value}>Разблокировать</Button>
    {error && <p role="alert">Не удалось разблокировать управление. Проверьте ключ или повторите позже.</p>}
  </form>;
}
