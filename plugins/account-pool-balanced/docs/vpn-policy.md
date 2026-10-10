# VPN-only providers and recovery

The **Only VPN** switch applies to every account of the selected provider. Claude, Codex, Cursor and Devin default to VPN-only. Kimi, Z.ai and OpenCode Go are independent of this switch. Use-until-exhaustion never bypasses the network gate.

Before each outbound request the pool checks a local status file on the **pool server**. Model requests, token refresh, browser/device login, quota polling, account profiles, reset-credit details and standalone Devin cloud requests use the same gate. Missing, stale, corrupt, untrusted or disconnected status produces a local `403` with `x-bb-pool-error: VPN_REQUIRED` on model routes. No provider request is attempted and the account is not marked invalid. Cached account information remains visible. Manual quota refresh reports the refusal, including the BB usage panel's Account Pooler source.

## Status writer

Default path: `~/.local/state/vpnks/vpn-state.json` in the server user's home. Configure another absolute path with `bb pool config set vpnStatusFile /path/to/vpn-state.json`; `default` restores the default. The operator-controlled writer must confirm the outbound VPN route and live tunnel. The pool performs no external VPN probes.

The file must be a root-owned regular file, not a symlink, at most 4096 bytes, without group/world write permissions. Write it atomically every 10 seconds:

```json
{
  "schema": "oxi-vpnks/vpn-state/1",
  "updated_unix": 1800000000,
  "state": "connected"
}
```

Only `connected` with a timestamp between now and 60 seconds ago allows protected traffic. Future timestamps also deny traffic. Use `disconnected` otherwise. Extra writer metadata is permitted. Reads, including cleanup, have a one-second deadline; overlapping reads of the same file share one operation, and a stalled operation returns `unknown` without spawning more reads. A server without a configured writer will correctly refuse protected providers, including after suspend.

## Configuration

```sh
bb pool config set vpnOnlyProviders codex,claude,cursor,devin
bb pool status --json
```

The `vpn.state` and `vpn.blockedProviders` fields report the current local decision. A provider's switch in settings changes the same configuration. An explicit deployment opt-out is available with `bb pool config set vpnOnlyProviders none`. Standalone configurations accept the same `vpnOnlyProviders` and `vpnStatusFile` fields.

This gate protects **the pool's traffic**. BB's built-in Codex/Claude usage sources and agents bypassing the pool are separate network clients. Their requests require their own admission checks or an enforced host firewall/VPN policy. A pool switch does not intercept another plugin's fetch or an agent's direct network activity. A heartbeat is not a packet-level firewall; keep the host VPN kill switch enabled to cover state-change races and already-running connections.

## Recovery

Network failures and OAuth HTTP 403 use bounded retry backoff rather than permanent credential rejection. HTML HTTP 403 edge-block pages pause an account for one minute and permit a later attempt. The periodic five-minute quota refresh can recheck legacy saved OAuth-403/HTML edge errors; a successful provider quota response clears them. Manual refresh can also recover them without toggling the account.

OAuth HTTP 400/401 remains an authentication error. Quota exhaustion remains a provider limit. No automatic reset credits are consumed, and client requests are never resent after an uncertain successful outcome.
