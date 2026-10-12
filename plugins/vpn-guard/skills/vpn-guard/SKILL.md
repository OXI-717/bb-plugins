---
name: vpn-guard
summary: Inspect and manage selected-machine VPN Guard admission.
---

Use `bb vpn-guard status --json` to inspect mode, selected machines, VPN decisions,
and recorded actions. `bb vpn-guard hosts <host-id>...` selects machines before
`bb vpn-guard enforce`; `bb vpn-guard observe` returns to observation. The
optional `global-suspend on --ack-global` disables Codex and Claude native
plugins across every BB machine during a selected-host block. Disabled plugins
need explicit review and `restore-owned`; redundant manual disables cannot be
distinguished. Read `docs/operations.md` before enabling.
Use `bb vpn-guard acknowledge-ambiguous <plugin-id> --reviewed` only after
reviewing an interrupted native plugin change; it clears the journal entry
without changing plugin state.

`bb vpn-guard block` сохраняет ручной блок на выбранных машинах независимо от VPN и режима наблюдения. `bb vpn-guard unblock` снимает его, сохраняя режим. `manualBlock` показан отдельно в status. Ручной блок останавливает защищённые треды; они не повторяются автоматически. Global suspension остаётся отдельным opt-in. При активном блоке нельзя восстанавливать native plugins. Эти команды не закрывают известные обходы Send-now и выполняющихся сетевых запросов.

Pooler0.4.14+: `bb pool config set vpnGuardEnabled true` включает fail-closed связь с Guard0.1.2+ на машине сервера пула. Настройка также доступна в UI. Удаление Guard не открывает трафик связанного пула; удаление/отключение этой связи явно снимает дополнительный барьер. Китайские провайдеры независимы.
