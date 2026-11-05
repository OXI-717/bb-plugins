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
                label: string;
                hostId: string;
                vaultId: string;
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
            } }} style={{ padding: 16, display: 'grid', gap: 12 }}>
   <strong>{storing ? 'Save to 1Password' : 'Approve credential use'}: {payload.title}</strong>
   <span>Project: {payload.label}. Access: {payload.profile}.</span>
   <span>Host: {payload.hostId}. Vault: {payload.vaultId}.</span>
   {storing && <><span>Account: {payload.username || 'unspecified'}. The credential is sent through BB to this host and omitted from conversation history.</span><label>Password<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: 8 }}/></label></>}
   {failed && <span role="alert">Submission failed. Please retry.</span>}
   <div><button type="submit" disabled={busy || (storing && !password)}>{storing ? 'Save and verify' : 'Approve this operation'}</button> <button type="button" onClick={() => { setPassword(''); cancel(); }} disabled={busy}>Cancel</button></div>
  </form>;
        } });
});
