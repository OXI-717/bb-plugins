# Cursor routing through the pool

Use the custom ACP provider `acp-oxi-cursor` with command `cursor-route acp`.
The built-in `acp-cursor` continues to use the machine's own login. Python 3 and
`cursor-agent` must be on PATH on every host that launches the custom provider.

Install the wrapper from this checkout (replacing an old symlink safely):

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
