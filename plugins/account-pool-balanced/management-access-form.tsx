import React, { type FormEvent } from 'react';
import { Button } from './ui/components/ui/button';
import { Input } from './ui/components/ui/input';

export function ManagementAccessForm({ value, pending, error, onChange, onSubmit }: {
  value: string; pending: boolean; error: boolean;
  onChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <form className="space-y-3 p-4" aria-label="Account management access" onSubmit={onSubmit}>
    <h2 className="text-sm font-medium">Account management is locked</h2>
    <p className="text-sm text-muted-foreground">Viewing accounts and changing settings requires a separate administrator key. It is not passed to work sessions. Unlocking lasts 15 minutes in this tab.</p>
    <label className="block space-y-1"><span className="text-sm">Administrator key</span><Input type="password" autoComplete="off" maxLength={256} value={value} onChange={event => onChange(event.target.value)} disabled={pending} /></label>
    <Button type="submit" disabled={pending || !value}>Unlock</Button>
    {error && <p role="alert">Could not unlock management. Check the key or try later.</p>}
  </form>;
}
