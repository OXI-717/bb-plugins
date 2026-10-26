# Review and validation for 0.2.0

Review date: 2026-10-26. Scope: frontend routing and lifecycle, backend HTTP/WebSocket policy, host SSH transport, ownership boundaries, failure behavior, configuration and public packaging. Independent adversarial review was followed by targeted fixes and regression checks.

## Findings addressed

- Agent-controlled timeline/tool payloads no longer teach object ownership. Only typed resource positions do; unknown socket IDs trigger a project refresh instead of gaining ownership.
- Primary ownership is checked before transmitting scoped request bodies. Primary objects win in the browser; a trusted collision marker clears tentative deep-link claims without retrying a mutation.
- Remote ownership is explicit per connection. Cross-remote collisions are refused. Verified bindings persist through reloads, and label/write changes retain them. Uncertain new bindings fail closed; verified threads survive a neighboring outage.
- SSH profiles with implicit forwarding or forwarded agents/tun devices are rejected. SSH disables agent/X11/tun forwarding and local commands explicitly.
- Native same-window configuration changes recreate/dispose one transport. Failed installation with unchanged configuration is retried.
- Separate remote channels keep their subscriptions, readiness, reconnect delays and cached lists. Creation replies register new IDs before the client opens the thread.
- Runtime settings, real identifiers, private paths, real-host tests and deployment screenshots were excluded from the public package.

## Validation boundaries

43 focused tests plus 17 policy assertions pass. Eight WebSocketManager integration checks pass. Focused tests cover routing, creation, permissions, poisoning attempts, primary precedence, multi-remote conflicts, offline recovery, actual server-handler policy with simulated SDK/host calls, persistent ownership, SSH preflight and lifecycle. Fresh inventory drops authorization for threads that disappeared; moved or archived threads must pass project membership verification again. This regression failed before the fix and passes with no forwarded body after it. TypeScript and the published BB plugin build are checked. An opt-in probe exercises BB's actual WebSocketManager and partysocket without a network.

A live browser probe runs BB 0.46.1 with the production frontend and backend policy, using two synthetic loopback HTTP/WebSocket peers through a test host adapter. It verifies native rows for both remotes, original chat history, a native send, a native approval response, and creation through the ordinary reuse-environment composer. The host adapter deliberately avoids real SSH and models. This is not a live two-SSH-server or mobile acceptance test.

Remaining product limits are explicit in README: no files/uploads/terminals, no third-party plugin federation, one project per connection, no global search, no per-user scoped agent API, no cloned-ID namespace translation, and no exactly-once send guarantee. The implementation depends on experimental SDK seams and BB's client transport behavior. Abrupt worker termination can leave an SSH child.

The prior transport/ownership review passed. The machine-presentation delta is subject to a separate exact-revision review before release; broader native multi-server support is not claimed.

The machine UI probe uses the same isolated native browser: two separately labelled remote groups, no machine management controls, remote permission labels, remote detail links redirected to read-only groups, and host mutation refused with 403. Disabling removes groups and remote cached rows. A cold host-list invalidation and disposal-order regression were found in that probe and fixed.

## Agent reading candidate 0.2.1

This delta adds a separate default-off `allowAgentReads` setting and native CLI/tools for discovery, scoped lists and saved event pages. It adds no send, creation, provider start or external credentials. Reading checks ownership and fresh project membership, including a second membership check before returning events. Configuration revocation is checked across awaited operations.

The focused plugin suite has 50 tests plus 17 policy assertions; typecheck and plugin build pass. The SDK-backed CLI parser and actual registered server tools are exercised with synthetic upstream responses. BB 0.46.1 source confirms the saved-event GET handler and its camel-case cursor parameters. Tests cover default denial, explicit scope, primary/neighbor collisions, moved threads, revocation, connection changes, cancellation, outages, output bounds and pagination without silent skipped events. Source tests do not launch models or operate a production bridge.

Independent review and release acceptance of this delta are pending. The earlier review does not constitute acceptance of this new API. Actual remote read acceptance requires a separately coordinated installation and permission change; no production capability has been enabled by source tests.
