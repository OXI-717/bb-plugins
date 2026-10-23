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

Enforcement checks the selected target host at each `message.dispatch` checkpoint. Protected sends wait in BB's queue while VPN state is disconnected or unknown. A five-second reconciliation loop stops already-running protected threads on selected bad hosts. Rechecks release waiting sends when their selected host recovers or Observe is selected. Stopped turns are recorded but never replayed automatically. The guard stays loaded so its waiting messages are not orphan-swept. Every provider ID is protected, including generic ACP engines and future IDs, except the exact Kimi/Z.ai routes: `kimi`, `zai`, `z-ai`, `acp-opencode-kimi`, `acp-opencode-zai`. A model name containing Kimi or GLM does not exempt a generic engine. Linked Pooler checks all its providers except Kimi and Z.ai, including OpenCode Go. This is admission control; already-issued traffic and Send-now remain outside a strict network guarantee.

## Optional global native plugin suspension

Admission and thread stopping do **not** close the native providers' independent model, usage, OAuth, or background requests. If the owner accepts the effect across **all** BB machines, they may enable a separate option:

```
bb vpn-guard global-suspend on --ack-global
bb vpn-guard global-suspend off
```

While Enforce is active and any selected host is bad, this option disables only `provider-codex` and `provider-claude-code` plugins. It does not disable `provider-acp`, which also supplies providers outside this policy. A native plugin disabled this way is unavailable on healthy machines too. The option is off by default. Guard automatically restores confirmed `ownedDisabledPlugins` after the manual block is released and every selected machine has current connected VPN proof. Recovery retries on subsequent reconciliations, including after restart. Turning the option off stops new ownership but does not discard outstanding recovery: Guard continues to re-suspend still-owned plugins on unavailable VPN, even in Observe, until their recovery completes with verified VPN. Clearing machine scope also keeps them paused until a nonempty healthy scope is selected, or an operator explicitly uses `bb vpn-guard restore-owned`. Plugins already disabled before Guard remain disabled. BB does not distinguish a redundant manual disable of a plugin already paused by Guard; it may resume when VPN returns. Interrupted disables stay ambiguous and require acknowledgment; Guard never infers ownership from a disabled state alone.

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

**«Снять блок»** (EN: **Unblock**) сохраняет текущий режим Observe/Enforce и перечитывает очередь. Новые остановленные Guard треды продолжаются после восстановления VPN и проверок активности; старые записи истории сами не запускаются. Наблюдение не снимает ручной блок: для этого нужна отдельная кнопка или команда `unblock`. При включённом ручном блоке нельзя очистить весь список машин или восстановить встроенные плагины. Если включена дополнительная глобальная блокировка, она действует и при ручном блоке. После снятия блока Guard автоматически восстанавливает свои подтверждённые отключения, когда VPN подключён на всех выбранных машинах.

The persistent `manualBlock` override blocks protected dispatches and stops protected running turns on selected machines even with connected VPN and in Observe. Real VPN status remains visible. At least one selected machine is required. Unblock retains Observe/Enforce and rechecks the queue; newly recorded Guard stops can continue after verified recovery and activity checks. Historical stops are not imported. Observe does not release a manual block. Global native suspension, when explicitly enabled, also applies during manual block; restore is forbidden until unblock; confirmed Guard-owned native plugins then resume automatically when all selected machines have current VPN proof. All existing Send-now, script, bridge and in-flight limitations still apply.

## Связь с Pooler / Pooler linkage

Guard защищает также `acp-oxi-cursor` и `acp-oxi-devin-pool`: обычные сообщения удерживаются и запущенные защищённые треды останавливаются на выбранных машинах.

В Account Pooler включите **«Подчиняться VPN Guard»** или выполните `bb pool config set vpnGuardEnabled true`. Требуются VPN Guard 0.1.2+ и Pooler 0.4.14+. Настройка сохраняется; старые конфигурации не включают её автоматически. Pooler запрашивает версионированное решение Guard для **машины сервера пула**, а не доверяет имени клиента. Поэтому при переносе пула выберите эту машину в Guard. Ручной блок действует даже при подключённом VPN; недоступный/отключённый/старый Guard, неизвестная машина сервера, неправильный ответ или таймаут дают временный локальный 503 до обращения к защищённому провайдеру. Китайские провайдеры не затрагиваются.

Все обращения, которые выполняет пул (модели, OAuth, обновление токенов, квоты, профиль и фоновые запросы), используют общий сетевой барьер. Уже открытые запросы и потоки пула отменяются при следующей проверке активных запросов (период 1 с плюс время решения Guard). Это отмена средствами fetch/AbortSignal, не гарантия нулевого трафика уже переданных пакетов. Состояние VPN в статусе остаётся настоящим; список заблокированных провайдеров отражает обе политики.

Enable **Follow VPN Guard** in Pooler (`bb pool config set vpnGuardEnabled true`). Requires Guard 0.1.2+ and Pooler 0.4.14+. This persisted opt-in checks a versioned Guard decision for the actual pool server host before provider-owned outbound calls, without caching allows. Missing/disabled/old/unresponsive Guard or invalid identity/response denies protected traffic locally. Select the pool server host in Guard; remote client identity does not choose this scope. Chinese providers remain independent. Open Pooler requests/streams are aborted at the next active-request check (1 s plus policy latency), using AbortSignal rather than packet-level isolation.

## Automation recovery / Восстановление автоматизаций

With automation coordination enabled, controller-owned schedules resume automatically when the selected BB server has confirmed VPN evidence and no manual block, controller hold or legacy lock remains. This includes edited or previously ambiguous pauses; there is no review checkbox. Guard obtains a current controller revision before resuming, and changed revisions are retried rather than forced. Manual Raycast and emergency holds require explicit Resume. Native plugin recovery follows its own ownership journal and waits for every selected machine to have confirmed VPN.

При подключённом контроллере расписания возобновляются автоматически после восстановления подтверждённого VPN на выбранном сервере BB. Ручная пауза и аварийный стоп сохраняются до кнопки «Возобновить». Дополнительной галки подтверждения нет. Ранее отключённые расписания вне списка восстановления не включаются; расписание в списке может возобновиться, даже если его редактировали или повторно выключали вручную. Для сохранения паузы используйте общий ручной блок автоматизаций.

При включённой настройке «Приостанавливать встроенные Codex и Claude без VPN» Guard отключает их глобально, а после восстановления VPN на всех выбранных машинах возвращает только свои подтверждённые отключения. Ранее выключенные плагины не затрагиваются. Неоднозначные операции после сбоя остаются в журнале для проверки.

## Fast protection and event history / Быстрая защита и журнал

VPN/native/thread reconciliation and configuration writes use a separate serialized lane from controller operations. A slow controller call no longer holds that lane. Configuration RPCs report the saved policy while automation coordination may still be pending: inspect `automations.busy`, `needsReconcile`, `error`, `lastAttemptAt`, `lastSuccessAt` and `retryAt`. Controller actions remain serialized. Policy/scope/VPN changes invalidate old operation responses; an old successful response does not confirm the new intent or clear its binding. The latest policy is reconciled again. Controller failures retry no earlier than five seconds unless a new policy needs applying.

An already issued controller command cannot be atomically recalled by the plugin SDK. It can finish before the latest hold is reapplied; running scripts and scheduler transitions still have the documented in-flight limits. Protection admission and thread/native reconciliation continue separately. Slow native plugin lifecycle operations and host checks still contribute latency; this is not a hard real-time or packet-level guarantee.

The collapsible RU/EN event history retains at most 100 records in plugin KV: observed VPN state and fixed reason, manual block, stop requests, confirmed native suspension/recovery and automation hold/release/recovery/failure. Only bounded IDs, timestamps, allowlisted event/reason codes and native plugin IDs are stored. No raw exception text or provider payload is recorded. Journal write failures do not stop protection. New history is not inferred from historical stopped IDs.

Проверка VPN и остановка тредов больше не ждут медленного контроллера автоматизаций. Панель показывает «Применяется», пока он работает, и время следующей попытки при ошибке. Кнопка ручного блока остаётся доступна во время команды возобновления. Запоздалый ответ старой операции не подтверждает новое состояние защиты. Уже отправленная команда контроллера может завершиться до повторного применения нового блока; это ограничение не скрывается.

«Журнал событий» хранит последние 100 наблюдений и действий с временем и причиной. История доступна после перезапуска; старые события задним числом не создаются. Ошибка записи журнала не отключает защиту. История не является доказательством полного прекращения сетевого трафика или уже выполняющихся скриптов.

### Thread stop history

“Previously stopped by Guard” is a bounded history of up to 100 distinct thread IDs, not a count of threads currently blocked or awaiting continuation. Recorded threads may already be active, finished, archived or deleted. Expand the section to open a recorded thread using BB navigation; opening it does not send a message. Guard does not automatically continue stopped agent threads. Automation schedule recovery and native plugin recovery are separate.

Thread titles are read from BB only while the history is expanded, with at most four concurrent lookups and up to 100 recorded IDs. Ordinary status/protection checks do not resolve titles. Blank titles and unavailable threads have explicit localized labels; IDs are kept in technical details. Closing the list stops queued lookups and ignores late results.

### Recovering interrupted threads

The history shows titles without technical identifiers. Continue is available for an idle thread with an owned stop observation and no later thread update or queued messages. The server rechecks the stop, current VPN proof and native ownership before sending a normal start message through BB admission. It persists a claim before sending: an uncertain send is never retried automatically. Open the thread to resolve an uncertain request or to continue a changed thread. Old history without an owned observation remains navigation-only. Stopped threads are never replayed in bulk.

Timed-out file reads fail closed but their timeout result is discarded so the next check can read fresh proof. Outstanding underlying file operations remain bounded at 16. Panel status polls coalesce; a slow response is not invalidated by a newer routine tick. A read-only status deadline does not cancel or repeat control mutations.

Continue uses a separate per-thread in-flight fence and a separate durable-claim write queue, so stalled reads or sends cannot hold the protection/configuration lane. It revalidates stop ownership, policy generation, disposal and thread state after asynchronous VPN/claim work, immediately before normal submission. BB exposes no atomic compare-and-send API: a thread update in the final gap cannot be ruled out. Normal start/admission still handles busy threads and current protection.

Automatic recovery uses ordinary BB admission and preserves manual blocks and newer user activity. See [recovery policy / правила продолжения](../../../docs/pool-errors.md).

## Remote host status

The server reads VPN evidence from the selected machine through the host RPC. Each read allows a 10-second host worker deadline; BB adds its own transport allowance. RPC failure still produces an unknown state and denies protected work. There is no last-known-connected cache or consecutive-failure exemption.

The response is checked again on arrival: the status file must remain at most 90 seconds old and its verified probe at most 390 seconds old, with no future timestamps. These limits also apply when the server and protected machine are different hosts.

`bb vpn-guard status --json` includes `hosts[].rpc` for selected VPN hosts: a safe category (`ok`, `timeout`, `host_unavailable`, `cancelled`, `rpc_error`) and elapsed milliseconds. The category describes the RPC, not VPN health. Failure logs contain the category and elapsed time, never the exception payload. Direct hosts do not need VPN evidence.
