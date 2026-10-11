# VPN Guard operations and limits

VPN Guard is a separate BB 0.46+ plugin. It starts in **Observe** mode with no machines selected. Installation and build do not enable enforcement. Select the enrolled machines that may run protected work, then explicitly switch to **Enforce**. An empty selection cannot be enforced. The panel and `bb vpn-guard status --json` show the selected machines, their VPN decisions, stopped turn IDs and native plugin changes.

```
bb vpn-guard status --json
bb vpn-guard hosts <host-id> [host-id...]
bb vpn-guard enforce
bb vpn-guard observe
```

`bb vpn-guard hosts none` clears the selection after returning to Observe. Status for unselected machines is shown as `outside scope`; their VPN state is not read and an offline unselected machine cannot block protected work elsewhere. An enrolled machine that disappears after selection stays in scope with `unknown` state. On each selected machine, install a trusted writer for `~/.local/state/vpnks/vpn-state.json` before enforcing. The server never substitutes its own VPN state for a remote machine's state.

A disappeared selected machine can be unchecked in the panel or removed with `bb vpn-guard hosts <remaining-id>...` (or `none` in Observe). Existing missing selections may remain while the selection is edited; a newly added ID must be enrolled.

The host entry reads only that machine's file. Schema is `oxi-vpnks/vpn-state/1`, `updated_unix` is seconds, and `state` is `connected` or `disconnected`. Only fresh `connected` (0–60 seconds old) allows protected work. The opened inode must be a root-owned regular file, without group/world write permission, at most 4096 bytes; symlinks and future timestamps fail closed. Reads are bounded to 4097 bytes, overlapping stalled reads coalesce, and a one-second timeout returns `unknown`. The status check makes no external VPN request.

Enforcement checks the selected target host at each `message.dispatch` checkpoint. Protected sends wait in BB's queue while VPN state is disconnected or unknown. A five-second reconciliation loop stops already-running protected threads on selected bad hosts. Rechecks release waiting sends when their selected host recovers or Observe is selected. Stopped turns are recorded but never replayed automatically. The guard stays loaded so its waiting messages are not orphan-swept. Protected IDs are `codex`, `claude`, `claude-code`, `cursor`, `acp-cursor`, `devin`, and `acp-devin`; Kimi and Z.ai are unaffected. Other ACP IDs require their own policy.

## Optional global native plugin suspension

Admission and thread stopping do **not** close the native providers' independent model, usage, OAuth, or background requests. If the owner accepts the effect across **all** BB machines, they may enable a separate option:

```
bb vpn-guard global-suspend on --ack-global
bb vpn-guard global-suspend off
```

While Enforce is active and any selected host is bad, this option disables only `provider-codex` and `provider-claude-code` plugins. It does not disable `provider-acp`, which also supplies providers outside this policy. A native plugin disabled this way is unavailable on healthy machines too. The option is off by default. Disabling it or returning to Observe does not automatically restore plugins. Check `ownedDisabledPlugins` in status, review current plugin settings, and explicitly run `bb vpn-guard restore-owned` only when every selected machine is connected.

The ownership journal records an enabled native plugin before Guard attempts to disable it, then records confirmed completion. A crash or error between those writes leaves `ambiguousPluginChanges`; Guard will not restore those entries. Manual repair is required after inspection. Plugins already disabled before Guard acts are never claimed. BB does not expose an actor/revision compare-and-swap for plugin toggles: if a user redundantly disables a plugin while Guard owns it, that intention is indistinguishable. **Explicit restore may re-enable such a user-disabled plugin.** The panel shows this warning next to the restore control. Review plugin settings and coordinate manual changes before restore. The journal is a recovery record, not a transactional ownership guarantee.

An ambiguous pending entry also holds normal dispatches for its native provider. After reviewing and, if needed, manually repairing the plugin state, use the panel's reviewed acknowledgment or `bb vpn-guard acknowledge-ambiguous <plugin-id> --reviewed`. This changes only the pending journal; it never enables a plugin. If global suspension remains on while a selected host is bad, the next reconciliation may try to suspend an enabled plugin again. Suspension and running-thread cleanup are attempted independently, with failures reported together; a failed operation does not silently skip the other.

## What the implementation establishes

In an isolated BB 0.46 instance with separate data directory and port, disabling `provider-codex` removed its provider registration from `bb provider list`; enabling it restored the registration and its usage maintenance capability. The same disable/enable cycle was observed for `provider-claude-code`. No enrolled host or active bridge was present in that instance, so this does **not** establish termination of an already-running bridge, active connections, or all in-flight maintenance requests. The fake SDK tests verify only policy decisions, storage and calls. Strict network denial of native maintenance remains unproven, even with global suspension.

The Account Pooler independently gates its own model, OAuth, usage, profile, reset and background requests. VPN Guard does not change pool settings, accounts or secrets. It does not intercept arbitrary cross-plugin fetches. Already-running script automations are not stopped; future agent automations use the ordinary admission path, while script-mode network activity is outside this guard. Explicit Send-now bypasses `message.dispatch`. Detection of running turns takes up to five seconds plus host RPC and stop latency. In-flight connections can continue. This is BB control, not a packet firewall or VPN kill switch.

The plugin's focused tests cover state file validation, admission, host scope, stop selection, queue recheck, ownership across restart, interrupted disable, concurrent mode writes and abort listener cleanup. Build and tests do not install or enable it on a working BB.
