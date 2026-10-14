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

The host entry reads only that machine's file. Schema is `oxi-vpnks/vpn-state/2`, `updated_unix` is seconds, and `state` is `connected` or `disconnected`. Only coherent `connected` evidence allows protected work: file age ≤90 seconds, successful IPv4 probe age ≤390 seconds, matching tunnel/probe epochs, and the expected interface/core. Future timestamps fail closed. Confirmation is mandatory; there is no verification opt-out. The opened inode must be a root-owned regular file, without group/world write permission, at most 4096 bytes; symlinks and future timestamps fail closed. Reads are bounded to 4097 bytes, overlapping stalled reads coalesce, and a one-second timeout returns `unknown`. The status check makes no external VPN request.

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

## Ручная блокировка / Manual block

В панели **«Заблокировать»** (EN: **Block**) блокирует защищённую работу на выбранных машинах даже при подключённом VPN и в режиме наблюдения. Настройка сохраняется после перезапуска. В статусе `manualBlock` показывается отдельно от фактического VPN; данные VPN не подменяются. Требуется хотя бы одна выбранная машина.

```
bb vpn-guard block
bb vpn-guard unblock
```

**«Снять блок»** (EN: **Unblock**) сохраняет текущий режим Observe/Enforce и перечитывает очередь. Уже остановленные задачи не повторяются. Наблюдение не снимает ручной блок: для этого нужна отдельная кнопка или команда `unblock`. При включённом ручном блоке нельзя очистить весь список машин или восстановить встроенные плагины. Если включена дополнительная глобальная блокировка, она действует и при ручном блоке. Снятие блока не восстанавливает эти плагины автоматически.

The persistent `manualBlock` override blocks protected dispatches and stops protected running turns on selected machines even with connected VPN and in Observe. Real VPN status remains visible. At least one selected machine is required. Unblock retains Observe/Enforce and rechecks the queue without replaying stopped turns. Observe does not release a manual block. Global native suspension, when explicitly enabled, also applies during manual block; restore is forbidden until unblock and remains manual. All existing Send-now, script, bridge and in-flight limitations still apply.

## Связь с Pooler / Pooler linkage

Guard защищает также `acp-oxi-cursor` и `acp-oxi-devin-pool`: обычные сообщения удерживаются и запущенные защищённые треды останавливаются на выбранных машинах.

В Account Pooler включите **«Подчиняться VPN Guard»** или выполните `bb pool config set vpnGuardEnabled true`. Требуются VPN Guard 0.1.2+ и Pooler 0.4.14+. Настройка сохраняется; старые конфигурации не включают её автоматически. Pooler запрашивает версионированное решение Guard для **машины сервера пула**, а не доверяет имени клиента. Поэтому при переносе пула выберите эту машину в Guard. Ручной блок действует даже при подключённом VPN; недоступный/отключённый/старый Guard, неизвестная машина сервера, неправильный ответ или таймаут дают локальный 403 до обращения к защищённому провайдеру. Китайские провайдеры не затрагиваются.

Все обращения, которые выполняет пул (модели, OAuth, обновление токенов, квоты, профиль и фоновые запросы), используют общий сетевой барьер. Уже открытые запросы и потоки пула отменяются при следующей проверке активных запросов (период 1 с плюс время решения Guard). Это отмена средствами fetch/AbortSignal, не гарантия нулевого трафика уже переданных пакетов. Состояние VPN в статусе остаётся настоящим; список заблокированных провайдеров отражает обе политики.

Enable **Follow VPN Guard** in Pooler (`bb pool config set vpnGuardEnabled true`). Requires Guard 0.1.2+ and Pooler 0.4.14+. This persisted opt-in checks a versioned Guard decision for the actual pool server host before provider-owned outbound calls, without caching allows. Missing/disabled/old/unresponsive Guard or invalid identity/response denies protected traffic locally. Select the pool server host in Guard; remote client identity does not choose this scope. Chinese providers remain independent. Open Pooler requests/streams are aborted at the next active-request check (1 s plus policy latency), using AbortSignal rather than packet-level isolation.
