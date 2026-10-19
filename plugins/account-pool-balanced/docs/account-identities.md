# Account email in a thread

The header supports every pooled provider: Claude, Codex, Cursor, Devin, Kimi, Z.ai and OpenCode Go. It shows the email, or the saved label when no email is available, for the account last observed on a successful request from that thread. It does not predict the next selection or borrow another thread's last-used account.

OAuth email comes from the provider and cannot be changed with the metadata editor. An opaque API key does not establish its registration email. For these accounts, open the card and set **Email аккаунта**. The supplied address is local metadata, not verified identity or an authorization change. Empty input clears it. Conflicting edits are rejected; unsaved input remains available until an explicit reset.

New provider launches receive an opaque thread-scoped hub token bound to the BB host, project and thread. The server records observations from that authenticated context. Caller-supplied thread headers cannot change the binding. Existing native Claude/Codex processes retain their session-based fallback; older ACP processes need a fresh provider launch before thread-specific observations are available. Until then the header reports no data. No running thread is stopped just to populate a label.

Thread token files use a separate prefix so the old strict token loader ignores their metadata during rollback. Existing host/project tokens and external clients keep their format and behavior. Rolling back can require a new provider launch to obtain a token understood by the old version. Rotation and host removal cover thread tokens too. Tokens and request contents are never shown in the header.

Bypassed or disabled pool routes do not claim a pooled account. A missing observation stays unknown. Removing an observed account shows it as removed rather than substituting a different account.
