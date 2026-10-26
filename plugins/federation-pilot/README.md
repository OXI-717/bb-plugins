# BB Federation (experimental)

Work with independent BB servers in one ordinary BB thread tree. Each configured remote project keeps its original threads, provider and execution environment. The plugin merges lists, routes HTTP to the owning server, and forwards change notifications into BB's native client. It does not modify BB core, copy conversations or enroll the primary machine on a remote server.

This is an **experimental client transport**, tested against BB 0.46.0/0.46.1 and plugin SDK 0.6.49. It replaces browser `fetch` and the core WebSocket constructor; BB updates can break it. Pin and test upgrades. This is not a native BB multi-server API or a per-user access-control system.

## Install

On the primary BB installation:

```sh
bb plugin install git:https://github.com/OXI-717/bb-plugins.git@^0.2.0 --subdirectory plugins/federation-pilot --tag-prefix federation-pilot/
```

Or add the `oxi-public` marketplace and install `federation-pilot@oxi-public`. The plugin starts disabled. Configure it on the primary server; no plugin installation on the remote BB is needed.

## Configure arbitrary remote servers

Open the plugin settings. `servers` is a JSON array, with one independently selected project per entry and up to eight entries. Replace these synthetic examples with your own IDs and SSH profiles:

```json
[
  {
    "serverId": "alpha",
    "label": "Alpha",
    "projectId": "proj_alpha",
    "bridgeHostId": "host_bridge",
    "sshTarget": "bb-alpha",
    "remotePort": 38886,
    "allowWrites": false
  },
  {
    "serverId": "beta",
    "label": "Beta",
    "projectId": "proj_beta",
    "bridgeHostId": "host_bridge",
    "sshTarget": "bb-beta",
    "remotePort": 38886,
    "allowWrites": false
  }
]
```

- `serverId` is a stable, unique connection name, not an account identity. Use lowercase letters, digits and hyphens, starting with a letter.
- `projectId` is an existing project on that remote BB. `proj_personal` is excluded. IDs of configured projects must be distinct. A connection currently exposes one project, not the entire remote installation.
- `bridgeHostId` is an **already enrolled primary-side machine** with working SSH access to the remote. Several remotes can use the same bridge machine. Do not enroll it on the remote BB.
- `sshTarget` is an SSH host alias or `user@host`. Configure any custom SSH port in the alias. SSH keys and credentials remain on the bridge machine; the plugin does not collect them.
- `remotePort` is the remote BB HTTP port on loopback. Verify it for that installation.
- `allowWrites` defaults to false. Turning it on allows supported thread mutations, **including deletion, archive, retry and context changes**. It is not a send-only permission.
- Set an entry's `enabled` to false to remove it; set the plugin's top-level `enabled` to true to activate configured entries. Open tabs notice settings changes within about five seconds and reconnect.

Use a dedicated SSH profile without `LocalForward`, `RemoteForward`, `DynamicForward`, `ForwardAgent` or `Tunnel`. The plugin checks `ssh -G`, rejects implicit forwarding, and disables agent/X11/tun forwarding and local commands. It creates only a loopback `ssh -L` tunnel to remote loopback. Host-key verification is not disabled; establish and verify trust on the bridge machine beforehand. Noninteractive SSH must work in the BB host daemon's environment, which may differ from your terminal's SSH agent.

The legacy single-server fields remain readable for existing pilot installations. A nonempty `servers` value takes precedence; `[]` deliberately selects no remotes.

## Working in the native client

Remote project names include their configured label. Thread rows show the standard Network icon, neutral while connected and red while offline. Open and send messages in the ordinary chat. Permission responses use the original remote interaction API.

Remote machine names carry a globe and their remote server label/ID in native selectors. Machine settings show separate **Machines on remote BB servers** groups, without local machine management controls. **Permissions on remote server: Full Access** describes execution permissions on that remote machine, not a grant to primary. Remote machine detail links return to these read-only groups. No machine records, provider IDs or host types are fabricated. Host mutations are refused by both the client transport and backend policy.

Machine grouping uses the content-script DOM seam (`data-machine-row` and exact settings links), because this BB version has no machine-row extension slot. It is version-sensitive like the transport; verify the machine page and disable cleanup after upgrades.

For a new thread, select the remote project **and its remote environment or machine**. BB's initial machine and unscoped model list still come from primary; the plugin rejects a mixed local/remote creation instead of guessing. Selecting a remote environment loads that server's execution options. No new provider is introduced.

The ordinary `bb thread` CLI and agents' BB tools still address their own BB installation. A remote agent cannot read a primary thread just because its ID was mentioned. Mentions are forwarded as message content, not expanded into private conversation history.

## Ownership and failure behavior

Primary objects always take precedence. Before forwarding a scoped request body, the server checks primary ownership through BB's SDK. Only an explicit 404 establishes absence. A new remote ownership assignment is also checked against the other configured servers. Verified assignments persist in plugin storage across reloads; labels and write permissions do not invalidate them. Changing connection identity requires revalidation.

An unavailable neighbor blocks **new, unverified IDs**; already verified threads remain usable. Remote failures never retry a message on primary. Each remote has its own WebSocket, reconnect delay and cached lists, so one channel's outage does not disconnect primary or the others. Socket readiness includes an upstream handshake and heartbeat.

Cloned databases with the same IDs on different remotes are unsupported: conflicting objects are refused rather than guessed. There is no namespace translation. Do not repoint an existing connection identity to a different database; configure a new identity and revalidate it.

A successful send HTTP response means BB accepted the request, not that the agent finished. The bridge does not promise exactly-once delivery. After an ambiguous timeout, inspect the original timeline before manually retrying a send.

## Scope and limits

Supported: one project per configured connection, native thread history and messages, live changes, native interaction responses, thread creation with an existing remote environment/machine, and selectors for remote execution options.

Not federated: uploads/attachments, file APIs and previews, terminals, other plugins' actions, global search/count/running/attention, new-machine creation, local sections for remote threads, or per-user remote authentication. Mobile clients, version-mismatched servers beyond the tested pair, and plugins installed only on remote are not verified. Request bodies must be JSON (3 MiB maximum); responses are bounded to 4 MiB.

This bridge uses the primary installation's existing trust boundary. Any primary client with access to the plugin endpoint gets the configured project permissions. It does not provide a scoped token for an autonomous agent, distinguish employees, or isolate malicious users sharing the same BB installation. A separate read-only/send-only consumer needs its own narrow authenticated API before deployment. Do not expose the bridge as an unauthenticated internet proxy.

Normal disposal closes owned sockets, timers and SSH children. Abrupt host-worker termination may leave an SSH child until the operating system or an administrator cleans it up.

The bridge creates an outbound SSH local forward, not remote machine enrollment. This does not establish independent network isolation: existing network routes, firewall rules and externally exposed BB endpoints remain the operator's responsibility. SDK local authentication is a browser Origin/JSON guard, not a scoped credential for arbitrary network clients.

Archived or deep-linked threads absent from sidebar-bootstrap must be revalidated after inventory refresh; live updates can pause until their next read. Ownership records in plugin storage are not currently pruned.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```

The tests use synthetic IDs and fake networks; they do not start models, use real SSH targets or change a BB installation. `tests/ws-manager.integration.mts` is an optional compatibility probe against BB's actual WebSocketManager: set `BB_CHECKOUT` to a BB 0.46.1 source checkout with dependencies installed and run it with that checkout's TypeScript runner. No private checkout path is built in.

See [the bridge contract](CONTRACT.md) and [review and validation](REVIEW.md). The public source in this directory is canonical. Runtime settings, logs, screenshots and real deployment evidence must remain outside this repository.
