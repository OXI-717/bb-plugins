# Models and connections

A separate model chooser for BB. It adds a **Модели** button to a thread header, a side panel and a navigation page. It does not replace, patch or hide BB's native model menu.

- **Локальные подключения** contains provider-owned authentication reported ready on the selected execution machine.
- **Pooler** contains the supported Account Pooler routes with enabled routing and an enabled account. This is configuration evidence, not a network health check or a promise about the next selected account.
- Missing installations, unknown authentication and hidden entries are under **Скрытые и недоступные**. Hiding affects this chooser on this machine only. It does not disable providers, change Pooler routing or stop existing work.
- Native provider artwork is used when available. Known custom pooled connections have compact letter/symbol fallback marks.

Selecting a model for the current provider updates the thread's sticky model and reasoning through BB's public SDK. The current response is not interrupted. A non-default service tier requires a new thread because the SDK thread-update method does not set that field.

Selecting another provider opens BB's own new-thread composer after an explicit click. It seeds a reference to the source thread and reuses its workspace. The user can review the prompt, attachments, environment and permission mode before submission. This is a new provider session, not an in-memory transfer of agent state; the source is not stopped. New threads are parented to the source. Source and target must be in the same project.

Model catalog loading, reasoning reconciliation, draft handling and submission controls remain BB-owned. Confirmed selections are validated again before mutation. If a request's execution routing changes, the operation is rejected instead of silently switching connection groups. No background retry or model request is sent by discovery. Creation uses a bounded persistent journal: an uncertain spawn is not resent automatically, including after plugin reload.

The connection group is a fresh configuration snapshot, not an independent network protection mechanism. Existing threads bypassing the pool are labeled local; creating a new thread from that source rechecks the new thread's actual global routing and may require returning to the connection list. Authentication stays with BB and Account Pooler; this plugin stores visibility preferences and creation receipts only.

The chooser uses a read-only subset of Account Pooler's existing `status.get` and `thread.account` RPCs. It never receives API keys or tokens and does not return account emails in its catalog. If Pooler is unavailable, known pooled routes remain unavailable rather than being relabeled local.

## CLI and RPC

`bb model-connections list --host MACHINE_ID --json`

`bb model-connections list --thread THREAD_ID --json`

Inspect `catalog`, `visibility`, `apply` and `create` with `bb plugin rpc inspect model-connections`. Mutation inputs use the same validated contract as the panel. The `create` method accepts the host composer's request, an expected provider/group and a UUID request ID. BB's spawn API performs canonical validation of environment, attachments, mentions and execution policy; the plugin validates its envelope and forwards it unchanged.

## Development

Run `npm ci`, `npm run typecheck`, focused Vitest files, and `bb plugin build .` from this plugin directory. Full repository suites run in CI. Test fixtures are synthetic. Visual checks must include narrow and wide viewports, loading/error states and keyboard navigation. Core BB and Account Pooler do not need to be reloaded to install this separate plugin.
