# Experimental bridge contract

All paths below are beneath `/api/v1/plugins/federation-pilot/http` on the **primary** BB. SDK `local` authentication uses the BB browser request guard: an Origin is checked when supplied, with JSON content type required for mutations. This is not authentication of arbitrary non-browser network clients; secure the primary server's network exposure separately. This is an internal client seam, not a scoped agent API. No standalone CLI commands or agent tools are registered.

| Endpoint | Meaning |
| --- | --- |
| `GET /config` | `{enabled, servers:[{serverId,label,projectId,allowWrites}]}`; SSH settings are omitted |
| `GET /check` | Per-connection read-only inventory check; no model launch |
| `GET /diagnostics` | Last 30 failures with server, method, path and error; no request bodies |
| `POST /proxy` | Explicit destination and upstream request envelope |
| WebSocket `/remote-ws?serverId=alpha` | Subscriptions and filtered change notifications for that connection |

Proxy example (all identifiers are synthetic):

```json
{
  "serverId": "alpha",
  "method": "GET",
  "path": "/api/v1/threads/thr_example/timeline",
  "body": null
}
```

The proxy's POST envelope does not launch a model. The upstream method above is GET. Use `/api/v1/threads?projectId=proj_alpha` for a scoped list or `/api/v1/threads/thr_example` for detail. The destination project must match the configured connection. Response status/content type/body are taken from upstream, after ownership and policy checks.

Sending is upstream `POST /api/v1/threads/<id>/send`, with `body` containing the serialized native BB send request. The bridge preserves that body; consumers must use the native request schema for their BB version. Sending can launch an agent, so never invoke it as part of discovery or reading. `allowWrites` is broader than send-only.

Identity is `(primary installation, serverId, projectId, threadId)`. Do not infer ownership from display names, current tab or model provider. Do not replay errors against another server. An acknowledgement is upstream HTTP acceptance, not model completion; read status/timeline or subscribe to changes for completion. There is no automatic POST retry or exactly-once guarantee.

A primary ownership collision returns 409 with a server-generated `x-bb-federation-primary` header so the browser can discard a tentative remote claim. Other unavailable/uncertain ownership checks fail closed. Remote response headers cannot inject this marker.

Before adding an autonomous integration, define a separate authenticated interface with explicit capabilities such as `read:list`, `read:timeline`, `send`. The current bridge is not that interface. Keep primary-to-remote access one-way and do not copy conversations, share primary credentials with remotes, or enroll primary machines on remote servers.
