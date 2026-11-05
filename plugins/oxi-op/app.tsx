import { useState } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
export default definePluginApp(app => {
    app.slots.pendingInteraction({ id: 'credential', component: function Credential({ interaction, submit, cancel }) {
            const [password, setPassword] = useState('');
            const [busy, setBusy] = useState(false);
            const [failed, setFailed] = useState(false);
            const payload = interaction.payload as {
                mode: string;
                title: string;
                username?: string;
                profile: string;
                projectId: string;
                threadId: string;
                label: string;
                hostId: string;
                hostLabel: string;
                vaultId: string;
                vaultLabel: string;
                purpose: string;
                secrets: {variable?: string; reference?: string; item?: string; field?: string}[];
            };
            const storing = payload.mode === 'store';
            return <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setFailed(false); try {
                await submit(storing ? { password } : { approved: true });
                setPassword('');
            }
            catch {
                setFailed(true);
            }
            finally {
                setBusy(false);
            } }} className="oxi-op-form" style={{ padding: 16, display: 'grid', gap: 12, overflowWrap: 'anywhere', fontSize: 14, lineHeight: 1.5 }}>
   <style>{`
     .oxi-op-form button { font: inherit; font-weight: 500; min-height: 40px; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--input, #52525b); cursor: pointer; transition: opacity .15s, background-color .15s; }
     .oxi-op-form button[type=submit] { color: var(--background, #18181b); background: var(--foreground, #fafafa); border-color: transparent; }
     .oxi-op-form button[type=button] { color: inherit; background: transparent; }
     .oxi-op-form button:hover:not(:disabled) { opacity: .85; }
     .oxi-op-form button:disabled { opacity: .45; cursor: not-allowed; }
     .oxi-op-form button:focus-visible, .oxi-op-form input:focus-visible { outline: 2px solid var(--ring, #a1a1aa); outline-offset: 3px; }
     .oxi-op-form input { font: inherit; color: inherit; background: var(--background, #18181b); border: 1px solid var(--input, #52525b); border-radius: 8px; min-height: 40px; margin-top: 6px; }
     .oxi-op-form summary { cursor: pointer; }
   `}</style>
   <strong>{storing ? 'Сохранить пароль' : 'Разрешить использование секрета'}: {payload.title}</strong>
   <span>Проект: {payload.label}</span>
   <span>Цель: {payload.purpose}</span>
   <div>{payload.secrets.map((secret, index) => <div key={index}>{secret.reference ? <><span>Секрет ({secret.variable}): </span><code>{secret.reference}</code></> : <>Запись: {secret.item}. Поле: {secret.field}.</>}</div>)}</div>
   <span>Машина: {payload.hostLabel}. Сейф: {payload.vaultLabel}.</span>
   <details><summary>Сессия и границы доступа</summary><div>Проект: {payload.projectId}<br/>Сессия: {payload.threadId}<br/>Профиль: {payload.profile}<br/>Машина: {payload.hostId}<br/>Сейф: {payload.vaultId}</div></details>
   {storing && <><span>Учётная запись: {payload.username || 'не указана'}. Пароль передаётся через сервер BB на выбранную машину и не включается в историю разговора.</span><label>Пароль<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: 8 }}/></label></>}
   <span>Разрешение действует на эту операцию плагина. Окно 1Password отдельно разрешает доступ CLI к аккаунту.</span>
   {failed && <span role="alert">Не удалось отправить. Повторите попытку.</span>}
   <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}><button type="submit" disabled={busy || (storing && !password)}>{busy ? 'Отправка…' : storing ? 'Сохранить и проверить' : 'Разрешить эту операцию'}</button><button type="button" onClick={() => { setPassword(''); cancel(); }} disabled={busy}>Отмена</button></div>
  </form>;
        } });
});
