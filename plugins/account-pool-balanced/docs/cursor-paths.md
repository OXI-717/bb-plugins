# Cursor routing through the pool

Use the custom ACP provider `acp-oxi-cursor` with command `cursor-route acp`.
The built-in `acp-cursor` continues to use the machine's own login. Python 3 and
`cursor-agent` must be on PATH on every host that launches the custom provider.

Install the wrapper from the published plugin's checkout (replacing an old symlink safely).
Updating the server plugin does not replace a separately installed launcher. Repeat this
installation on each client host after a launcher update and compare its SHA256 with
`scripts/cursor-route.py` in the installed release before testing an existing session:

```bash
mkdir -p "$HOME/.local/bin"
install -m 755 plugins/account-pool-balanced/scripts/cursor-route.py "$HOME/.local/bin/cursor-route.new"
mv -f "$HOME/.local/bin/cursor-route.new" "$HOME/.local/bin/cursor-route"
```

Configure that command in the ACP plugin's custom agents. Account Pooler contributes
`CURSOR_API_ENDPOINT`, a revocable machine token as `CURSOR_API_KEY`, and
`CURSOR_POOL_RPC_GATEWAY=1` for this provider. Add the Cursor account's supported API key
on the hub; subscription credentials are never copied onto clients.

## How the gateway works

BB's plugin HTTP router matches paths exactly. The wrapper starts an ephemeral localhost
forwarder and sends Cursor's RPC paths through the single `/cursor/rpc` route, preserving
binary request bodies and streaming responses. The hub accepts methods in `aiserver.vN`
and `agent.vN` service namespaces, plus Cursor's settings, traces and bundle routes.
New RPC methods in those namespaces need no catalogue update. The upstream host remains
fixed in pool settings; arbitrary URLs, traversal and authentication RPCs are rejected.
A future change outside these namespaces or to the wire protocol may still require an update.

The wrapper replaces any caller-supplied `--agent-endpoint` with the forwarder, preventing server configuration
from sending the agent stream directly upstream with the wrong token. Its isolated config
uses HTTP/1 for the agent stream, even when `CURSOR_CONFIG_DIR` was already set.
The user's own config directory is not modified. Legacy exact routes remain for older wrappers.

## Authentication isolation

`auth/exchange_user_api_key` is answered locally by the hub with the client's own pool
token as both access and refresh token. Only the hub exchanges the real account API key
for an upstream access token. Pooled sessions always set
`AGENT_CLI_CREDENTIAL_STORE=memory`, including when a custom config directory is supplied.
Changing `CURSOR_CONFIG_DIR` alone does not isolate macOS Keychain.
Without a pool endpoint the wrapper passes through to the normal local Cursor login.

## Verification

The tests exercise a synthetic future RPC, authorization isolation, binary bodies and
streaming through a local fake CLI. CI runs the wrapper checks on Linux and macOS.
For a live check, launch a fresh pooled thread and ask it to run `echo pool-ok` and read
one local file. Model replies alone do not prove that tool setup RPCs work.


### Request admission

Cursor inference RPCs (`Run`, `RunSSE`, `RunPoll`) retain the configured per-account
request limit. Known control RPCs, including `BidiAppend` and startup metadata,
use a separate bounded per-account lane with the same limit and queue bounds.
Two long-lived inference streams must not block the append requests needed to
advance those streams or the metadata needed to start a session. Unknown methods
retain ordinary admission. Account selection, quota cooldown, authentication and
VPN Guard checks still apply to both lanes. Total in-flight requests can therefore
reach twice the configured limit for Cursor; inference capacity does not increase.

## Interrupted model streams

The launcher observes Connect envelope boundaries with at most five header bytes
of parser state; model payloads and wire bytes are not retained or rewritten.
A model response with HTTP 200 is incomplete if its body disconnects before the
Connect end envelope, or HTTP ends cleanly without that envelope. A socket failure
after a complete end envelope does not invalidate the RPC. This follows the
[Connect streaming protocol](https://connectrpc.com/docs/protocol/).

For one unambiguous ACP prompt, a confirmed interruption converts Cursor's false
`end_turn` success or the exact incomplete-envelope ACP error into the existing
local `POOL_UPSTREAM_UNAVAILABLE` JSON-RPC error. Other RPC errors are preserved. Detection does not depend on assistant text, including text emitted before
the interruption. Auxiliary RPCs, stale model requests, ambiguous concurrent
prompts, client disconnection and ACP cancellation do not acquire this attribution.
A fresh model request clears the previous interruption.

The existing bounded native turn retry can then continue the same thread with its
original provider, model and accepted history. The retry classifier accepts the
exact local marker from the latest ACP provider error detail in the failed request;
a raw incomplete-envelope error or assistant text alone cannot authorize a retry. The gateway does not replay HTTP
requests or tools, manufacture a Connect success frame, or bypass Guard. This
restores failure/recovery semantics; it does not prevent upstream socket failures.

## Controlled stream recovery check

Use `bb pool stream-probe --thread <thread-id> --json` to inspect active Cursor
model response bodies for a single thread. It returns only server request UUIDs,
thread IDs and byte counts. Auxiliary RPCs and responses without an attributed
thread are excluded. No upstream operation or Guard policy change is performed.

In an explicitly authorized, synthetic test session, interrupt one observed body:

```sh
bb pool stream-probe --thread <thread-id> --interrupt-request <request-uuid> --confirm --json
```

The two identities must match the same currently open response with bytes read.
A stale UUID, another thread, a header wait or an already finished request returns
`interrupted: false`. One interruption removes the target; it cannot abort a new
retry or a neighbouring stream. The command is an authenticated BB CLI operation,
not an HTTP route for provider clients. It does not replay inference or tools.
Observe the actual ACP failure, bounded native retry, preserved history and tool
execution ledger independently. A controlled local body failure does not prove
the cause of an earlier upstream TCP closure.

Cursor also labels binary Connect frames as `text/event-stream`. This does not
make its body textual SSE. The launcher observes the same bounded envelope state
for this MIME type. The pool propagates Cursor body errors without appending a
textual SSE error event; textual SSE handling for other providers is preserved.
The stream probe reports an allowlisted MIME category (`other` for unknown types).


### Bounded failed-stream diagnostics

The standalone launcher retains at most 64 metadata events and emits at most
three diagnostic snapshots per process to stderr on a body read failure or a
recognized transport-error notification. Ordinary success stays silent. The
notification is an observation only: it does not make assistant text retryable.
Snapshots contain local counters, timing, prompt/token match booleans and
transport framing state, never prompt IDs, session IDs, payloads, URLs, raw
errors or credentials. The hub supplies its own request UUID in
`x-bb-pool-request-id` only on Cursor model responses, replacing any upstream
value. This links one launcher stream to a controlled stream-probe interruption.
A transport end-envelope and the application-level `turnEnded` are separate
conditions; these diagnostics alone do not establish recovery.

On POSIX hosts the same failure snapshots are also appended privately to
`cursor-pool-diagnostics.jsonl` in the existing `BB_THREAD_STORAGE` directory.
The file is limited to 1 MiB, uses mode 0600, refuses symlinks, and skips a write
when busy or unavailable. This is needed because ACP retains stderr until exit.
Diagnostics never create a new storage directory or change the ACP result.


ACP recovery also applies when the CLI puts global `--model` or
`--agent-endpoint` options before `acp`. The launcher recognizes their values
without reordering or rewriting arguments; option values named `acp`, print
commands and unknown options do not activate the ACP relay. A confirmed local
interruption can normalize the exact structured `Stream ended without turnEnded`
RPC error as well as `incomplete envelope`. Assistant text alone still cannot
trigger recovery.

The exact structured aborted socket-hang-up RPC error is normalized only after a
confirmed interruption of the current local model response. Cancellation, stale
requests, other aborted errors and assistant text alone cannot authorize this.
Native failed-turn handling emits bounded metadata about verification,
classification and scheduling phases. Fixed phase/outcome labels and opaque
core identifiers are recorded without SDK exception text. A reached phase does
not prove that a retry was scheduled.


The ACP relay releases model sockets owned by a completed prompt generation,
including older model requests of that same prompt. The CLI process remains
alive for later prompts. Session cancellation is scoped to the named session.
A registration racing with its prompt's reply is closed immediately. Unknown
ownership, ambiguous reused live request IDs and unrelated prompts are not
closed based on a thread-wide idle event. The registry is bounded, and finished
HTTP bodies remove their entries. This cleanup does not change Guard policy
or authorize retries.
