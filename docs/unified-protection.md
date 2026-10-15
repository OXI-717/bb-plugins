# Unified protection / Единая защита

VPN Guard coordinates protection on explicitly selected hosts. Account Pooler independently enforces its own provider traffic. An optional host-side automation controller owns scheduler holds and recovery; the default plugin install does not enable it.

## Public setup / Публичная установка

VPN Guard and Account Pooler can be installed and used together without an automation controller. Configure the local VPN state source and selected hosts, then enable Pooler's Guard linkage as described in [plugin-only protection](vpn-plugin-protection-limits.md). This provides the documented protected-thread admission and Pooler request policy. The optional automation controller is not bundled with these public plugins and is not an installation dependency.

VPN Guard и Account Pooler можно установить и использовать вместе без контроллера автоматизаций. Настройте источник VPN-статуса, выберите машины и включите связь Pooler с Guard. Контроллер не входит в комплект публичных плагинов и не является обязательной зависимостью. Без него доступны описанные управление защищёнными тредами и политика запросов пула; общее приостановление и восстановление расписаний не подключено.

The panel's automation status **Not linked** is normal when no controller is configured; it does not indicate a failure of Guard or Pooler protection. **Не подключено** в строке автоматизаций — нормальное состояние без дополнительного контроллера, а не ошибка VPN-защиты.

## VPN evidence / Подтверждение VPN

Both plugins consume `oxi-vpnks/vpn-state/2`: trusted root-owned non-writable regular file, no symlink, bounded read, file freshness 90 seconds, probe freshness 390 seconds, no future timestamps. Connected requires known `ok` reason, IPv4 coverage, utun244, a positive core PID, successful probe and matching epochs. A malformed or inconsistent sample is unknown and denied. Fixed limits are not replaced by values supplied in JSON.

Only `oxi-vpnks/vpn-state/2` is accepted. Verified fresh IPv4 evidence is mandatory, with no switch to weaken it. Older evidence is denied. Guard requires the linked Pooler to advertise immutable `vpnPolicyVersion: 2` and protect the requested provider; older Poolers are denied until upgraded. Protected Pooler traffic always uses IPv4; IPv6 target literals and IPv6 proxy endpoints are refused. Kimi and Z.ai retain their independent transport.

Подтверждение текущего формата обязательно и относится только к IPv4. Устаревшие данные отклоняются; переключателя ослабления проверки нет. Native/ACP-трафик IPv6 не становится защищённым от проверки IPv4.

The canonical TypeScript predicate is `shared/vpn-evidence.ts`. Identical generated copies are shipped inside both self-contained plugin packages; `scripts/check-vpn-contract.mjs` checks equality in CI. Changes must update the canonical source and both shipped copies.

## Automation controller / Контроллер автоматизаций

This is an advanced opt-in integration for an operator's own automation setup, not a required public component. Leave `coordinateAutomations` off unless you already have a compatible controller. Это дополнительная интеграция с собственными автоматизациями: оставьте её выключенной, если совместимого контроллера у вас нет.

To opt in, configure an absolute path to an independently installed `oxi-auto` executable on the selected BB server host. The executable must implement protocol `oxi-auto/protection-status/1` and the bounded commands `protection status|hold|release|pause|resume --server <instance-id> --json`. Guard holds use `--owner vpn-guard:<instance-id>`; the controller must verify it is connected to that BB instance before scheduler changes. Optional `--reviewed` is explicit operator acknowledgement of ambiguous restoration.

Guard manual block, or VPN denial in Enforce, acquires its durable hold. Unblock releases only that owner. A manual Raycast hold, emergency hold or pending recovery remains. Removal never automatically resumes schedules. Guard journals its controller binding before requesting a hold and retries interrupted operations. Changing a binding while a hold exists is refused. Controller errors remain visible and must not be interpreted as complete protection.

Exit 1 with a valid status and explicit `errors` is a partial-action report; signals, timeouts and other exit codes are failures even after valid output. Guard confirms its owner is present after hold and absent after release. An unsuccessful release retains the durable binding for retry. Unrelated recovery errors remain visible after confirmed release and do not prevent explicit recovery.

Ручная пауза, аварийная остановка и причина VPN Guard независимы. После снятия Guard-блока расписания ждут кнопки «Возобновить». Ранее отключённые пользователем расписания не включаются. Неоднозначные или изменённые паузы требуют проверки; список сохранённых расписаний доступен в панели. Raycast и панель используют один контроллер.

The adapter manages the controller on the BB server and its BB schedules. Standalone schedulers on other machines are not automatically covered. Their own controller deployment and policy are separate; do not infer fleet-wide blocking from a local status.

## Bounds / Ограничения

Pause disables future scheduled ticks and cooperatively holds controller-aware background loops. Spawned agent automation threads can be stopped; shared target threads require ownership review. Already-running scripts have no supported cancellation API and may continue. New schedules, manual Run, Send-now, arbitrary processes and native maintenance are not a mandatory network barrier. Enumeration and cancellation are periodic, with bounded partial reports. No system firewall/hosts rules or BB rebuild are added.

Controller status and restoration operate on at most the documented bounded inventory; incomplete inspection is reported. Snapshot intent survives process failure. Restoration never replays expired one-shots and skips ambiguous pauses unless explicitly reviewed.

See [existing plugin-only limits](vpn-plugin-protection-limits.md). Test the actual writer-to-consumer chain in an isolated instance before deployment; include the controller only if you opt into automation coordination. Do not deploy these versions without a verified current writer, or automation coordination against an unavailable controller.

## Deployment / Развёртывание

1. Prepare the accepted current VPN writer on each protected host and the Pooler server. Confirm a fresh `/2` sample with coherent IPv4 proof before upgrading consumers.
2. Back up settings and coordinate an idle maintenance window. Upgrade Pooler 0.4.21 and Guard 0.1.6 together; a mixed pair refuses protected traffic. The combined updater requires Observe before reload; return to the desired Guard mode afterward. Pooler VPN verification itself is always required.
3. Confirm immutable Pooler `vpnPolicyVersion: 2`, selected host scope and Guard linkage. There is no separate verification setter.
4. Enable the desired Guard Enforce policy and check explicit denials and recovery without bypassing unknown evidence.
5. Optional: connect a compatible automation controller, opt in to coordination and test independent manual/Guard holds. Verify writer readiness on that controller's actual consumers before upgrading it. Keep recovery manual. Skip this step when no controller is installed.

This development cycle prepares code and isolated verification only. Production VPN, pool and automation state are not switched automatically.
