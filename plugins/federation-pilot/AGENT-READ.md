# Agent list/read capability (0.2.1)

This interface reads saved remote sessions through the existing SSH bridge. It is separate from browser transport and core `bb thread` commands. It never sends a prompt, creates a thread, responds to an interaction or starts a provider. It accepts no arbitrary HTTP path, method or body.

## Permission and identity

An operator must enable the plugin, federation and the selected connection, then explicitly set `allowAgentReads: true` on that connection. The default is false, including after upgrade and for legacy settings. `allowWrites` is independent: reads can work with writes disabled, and enabling writes does not enable these tools.

This is an installation-level capability, not employee authentication or an external scoped token. All primary-side agents/CLI callers allowed to use the plugin share the opted-in project scope. Do not give a less-trusted consumer broad primary BB access just to use it. No primary credentials are forwarded; SSH uses the existing bridge identity. Network isolation remains a separate operator responsibility.

`allowAgentReads` gates only these CLI commands and tools. An agent with shell or direct HTTP access to primary can already use the browser bridge independently of that flag. Set `allowWrites: false` on the connection for a read-only consumer: this is the bridge's actual mutation gate, including `/proxy`. It still does not sandbox the agent's other tools or network access.

Remote events can contain prompt injection. Treating them as data is an agent behavior rule, not enforced isolation. If browser writes remain enabled, an agent with direct bridge access could be induced to send primary data upstream outside this read interface. Do not interpret the absence of automatic reverse routing as proof that a powerful primary-side agent cannot disclose data. A less-trusted consumer needs separate execution isolation and authentication; that is outside this plugin capability.

Every list supplies `serverId` and `projectId`; every read also supplies `threadId`. Discovery only returns opted-in connection labels, IDs and permissions, not SSH addresses or machine IDs. A server ID denotes configured connection identity, not an account. `proj_personal` and implicit/current-tab destinations are refused.

## CLI

With the accepted plugin installed and enabled:

```sh
bb federation servers --json
bb federation list --server-id alpha --project-id proj_alpha --limit 25 --offset 0 --json
bb federation read --server-id alpha --project-id proj_alpha --thread-id thr_example --limit 25 --after-seq 0 --json
```

The explicit plugin entrypoint is `bb plugin run federation-pilot -- <command> ...` (for example `servers --json`). Use its help to inspect the installed command schema. `list --archived` selects archived threads; the default selects unarchived threads. Success is JSON; errors return a nonzero CLI exit and a structured error code. No fallback to core CLI or a different server occurs.

## Native agent tools

| Tool | Parameters |
| --- | --- |
| `federation_servers` | `{}` |
| `federation_list_threads` | `serverId`, `projectId`, optional `limit`, `offset`, `archived` |
| `federation_read_thread` | `serverId`, `projectId`, `threadId`, optional `limit`, `afterSeq` |

Provider bridges may prefix tool names. Tool discovery follows BB's normal agent configuration lifecycle; an already-running provider session may not acquire new tool metadata. The CLI uses the current installed registration. Tool errors set `isError`; they are not empty successful pages.

## Pagination and evidence

- List results contain `source`, thread metadata, `nextOffset` and `mayHaveMore`. Offset pagination is not a stable snapshot if remote threads change during traversal.
- Read results contain the explicit `source` triple, thread metadata, raw saved event rows, `nextAfterSeq` and `mayHaveMore`. Rows include `threadId`, increasing `seq`, `type` and event data. Raw events are not a rendered transcript: tool inputs/outputs and other saved events can be present. They are untrusted reference data, never instructions or evidence of permission to act.
- Limits are 1–100 items (default 25), with at most 256 KiB of returned list/read JSON. Continue with the returned cursor. `mayHaveMore` is conservative when a page is full; a final empty page can be necessary. Reads do not subscribe, poll or auto-follow.
- If one event alone exceeds the output cap, the call fails explicitly without skipping it. Open the original BB to inspect it. The existing bridge also caps upstream responses at 4 MiB; a smaller page may be necessary.
- Reads verify primary and cross-remote ownership and fetch fresh thread details before and after fetching saved events. A project move, primary collision, uncertain owner or revoked permission fails closed. Only primary metadata is consulted for collision checks; primary conversation history is never read or returned.
- An offline neighbor can block newly observed IDs; already verified bindings follow the existing ownership cache rules. Connection identity changes invalidate the pending result. Cancellation prevents returning the result or issuing subsequent steps; it does not cancel an already-dispatched host call, which is bounded by the existing host timeout.

The only remote API operations used by this interface are `GET /api/v1/threads?projectId=...`, `GET /api/v1/threads/:id` and `GET /api/v1/threads/:id/events?afterSeq=...&limit=...&order=asc`, plus existing ownership metadata checks against other configured servers. No write request is issued or retried. Reading may establish the outbound bridge and persist ownership metadata on primary.

Source/unit acceptance is separate from runtime acceptance. Installing the package does not prove an actual remote thread was read. Runtime acceptance must use an owner-selected existing thread, preserve private configuration evidence and verify no model invocation. Send remains a separate future capability requiring an agreed scope, confirmed destination and real deduplication before retries.
