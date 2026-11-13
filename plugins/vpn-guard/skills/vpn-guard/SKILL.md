---
name: vpn-guard
summary: Inspect and manage selected-machine VPN Guard admission.
---

Use `bb vpn-guard status --json` to inspect mode, selected machines, VPN decisions,
and recorded actions. `bb vpn-guard hosts <host-id>...` selects machines before
`bb vpn-guard enforce`; `bb vpn-guard observe` returns to observation. The
optional `global-suspend on --ack-global` disables Codex and Claude native
plugins across every BB machine during a selected-host block. Guard automatically
restores confirmed owned plugins after the manual block is released and all
selected machines have current connected VPN evidence. Prior manual disables
remain off; redundant manual disables during an owned pause cannot be distinguished.
Interrupted ambiguous changes still require review; `restore-owned` retries recovery. Read `docs/operations.md` before enabling.
Use `bb vpn-guard acknowledge-ambiguous <plugin-id> --reviewed` only after
reviewing an interrupted native plugin change; it clears the journal entry
without changing plugin state.

`bb vpn-guard block` сохраняет ручной блок на выбранных машинах независимо от VPN и режима наблюдения. `bb vpn-guard unblock` снимает его, сохраняя режим. `manualBlock` показан отдельно в status. Ручной блок останавливает защищённые треды; они не повторяются автоматически. Global suspension остаётся отдельным opt-in. При активном блоке нельзя восстанавливать native plugins. Эти команды не закрывают известные обходы Send-now и выполняющихся сетевых запросов.

Pooler0.4.14+: `bb pool config set vpnGuardEnabled true` включает fail-closed связь с Guard0.1.2+ на машине сервера пула. Настройка также доступна в UI. Удаление Guard не открывает трафик связанного пула; удаление/отключение этой связи явно снимает дополнительный барьер. Китайские провайдеры независимы.

Use `bb vpn-guard block --host <host-id>` / `unblock --host <host-id>` for an independent manual block on one selected machine. The panel exposes the same control beside each selected machine. Machine names and IDs come from the enrolled host inventory. This blocks protected BB sessions on that execution host even with connected VPN; it does not change other hosts, the VPN enforcement mode, or global native-plugin enablement. It persists across reload and VPN recovery. Release a machine block before removing that machine from protection. Legacy `block` / `unblock` without `--host` control the separate all-selected-machines block; releasing either kind does not clear the other.

Pooler network decisions still use the actual pool server host: a laptop execution block must not deny unrelated server requests. Automation coordination follows only the pinned controller host. Send-now, standalone clients and already-running network traffic retain the documented limitations.
