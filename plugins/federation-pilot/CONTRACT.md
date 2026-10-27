# Experimental bridge contract

All paths below are beneath `/api/v1/plugins/federation-pilot/http` on the **primary** BB. SDK `local` authentication uses the BB browser request guard: an Origin is checked when supplied, with JSON content type required for mutations. This is not authentication of arbitrary non-browser network clients; secure the primary server's network exposure separately. This HTTP bridge is an internal client seam, not a scoped external agent API. Version 0.2.1 separately registers the opt-in native CLI/tools documented in [agent reading](AGENT-READ.md); they do not expose an arbitrary HTTP proxy.

| Endpoint | Meaning |
| --- | --- |
| `GET /config` | `{enabled, servers:[{serverId,label,projectId,allowWrites}]}`; SSH settings are omitted |
| `GET /check` | Per-connection read-only inventory check; no model launch |
| `GET /diagnostics` | Last 30 failures with server, method, path and error; no request bodies |
| `POST /proxy` | Explicit destination and upstream request envelope |
| `POST /image-upload` | Fixed image upload envelope; requires connection writes |
| `GET /image-content?serverId=alpha&projectId=proj_alpha&path=image.png` | Bounded saved raster bytes, read-only; no arbitrary URL/path |
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

## Image route (0.2.2)

`POST /image-upload` accepts exactly `{serverId, projectId, filename, mimeType, bytesBase64}`. PNG/JPEG/GIF/WebP signatures must match the declared type; the decoded file is limited to 4 MiB and the streaming JSON envelope is bounded before parsing. The bridge rechecks configuration and project ownership before and after the host call. It forwards only a newly constructed multipart `file` field to the fixed project attachment API, never primary headers, credentials or a host file path. The filename is sanitized and given the detected raster extension.

Success returns the native `{type: "localImage", sourceProjectId, path, name, mimeType, sizeBytes}` metadata, with a single stored raster filename and matching type/size. `sourceProjectId` must match the requested project; older replies without it are normalized to that fixed upload destination. No model is started by an upload. Sending that attachment in a chat is the existing, separately authorized send action.

`GET /image-content` accepts exactly `serverId`, `projectId` and a single stored raster filename in `path`. Traversal, host paths and extra/duplicate parameters are rejected. Every read checks project ownership and current connection identity. The response has a validated raster content type, no-store, nosniff and a restrictive sandbox CSP. Upstream headers and redirects are not forwarded. This endpoint shares the existing installation trust boundary; it is not an external scoped credential or an agent-read permission.

An upload can succeed remotely before a timeout, cancellation or configuration revocation is observed. There is no automatic retry or claim of exactly-once upload. Neither image endpoint enrolls machines, changes SSH forwarding, reads primary files or grants remote-to-primary execution.
