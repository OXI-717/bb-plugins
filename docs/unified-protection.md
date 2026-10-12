# Unified protection / Единая защита

VPN Guard coordinates protection on explicitly selected hosts. Account Pooler independently enforces its own provider traffic. An optional host-side automation controller owns scheduler holds and recovery; the default plugin install does not enable it.

## VPN evidence / Подтверждение VPN

Both plugins consume `oxi-vpnks/vpn-state/2`: trusted root-owned non-writable regular file, no symlink, bounded read, file freshness 90 seconds, probe freshness 390 seconds, no future timestamps. Connected requires known `ok` reason, IPv4 coverage, utun244, a positive core PID, successful probe and matching epochs. A malformed or inconsistent sample is unknown and denied. Fixed limits are not replaced by values supplied in JSON.

Legacy `/1` remains compatible and visibly unverified until `requireVerifiedVpn` is enabled. Set this option independently in Guard and Pooler after upgrading the writer. With Enforce and verified VPN enabled, Guard refuses linked Pooler requests unless Pooler also enables verification for that provider. A weaker Pooler setting cannot bypass that decision. Pooler strict traffic uses IPv4; IPv6 target literals and IPv6 proxy endpoints are refused. Other providers retain the ordinary transport.

Подтверждение `/2` относится только к IPv4. Старый `/1` отображается как неподтверждённый. Строгий режим по умолчанию выключен для безопасной миграции. Native/ACP-трафик IPv6 не становится защищённым от проверки IPv4.

The canonical TypeScript predicate is `shared/vpn-evidence.ts`. Identical generated copies are shipped inside both self-contained plugin packages; `scripts/check-vpn-contract.mjs` checks equality in CI. Changes must update the canonical source and both shipped copies.

## Automation controller / Контроллер автоматизаций

Configure an absolute path to an operator-installed `oxi-auto` executable on the selected BB server host. The executable must implement protocol `oxi-auto/protection-status/1` and the bounded commands `protection status|hold|release|pause|resume --server <instance-id> --json`. Guard holds use `--owner vpn-guard:<instance-id>`; the controller must verify it is connected to that BB instance before scheduler changes. Optional `--reviewed` is explicit operator acknowledgement of ambiguous restoration.

Guard manual block, or VPN denial in Enforce, acquires its durable hold. Unblock releases only that owner. A manual Raycast hold, emergency hold or pending recovery remains. Removal never automatically resumes schedules. Guard journals its controller binding before requesting a hold and retries interrupted operations. Changing a binding while a hold exists is refused. Controller errors remain visible and must not be interpreted as complete protection.

Ручная пауза, аварийная остановка и причина VPN Guard независимы. После снятия Guard-блока расписания ждут кнопки «Возобновить». Ранее отключённые пользователем расписания не включаются. Неоднозначные или изменённые паузы требуют проверки; список сохранённых расписаний доступен в панели. Raycast и панель используют один контроллер.

The adapter manages the controller on the BB server and its BB schedules. Standalone schedulers on other machines are not automatically covered. Their own controller deployment and policy are separate; do not infer fleet-wide blocking from a local status.

## Bounds / Ограничения

Pause disables future scheduled ticks and cooperatively holds controller-aware background loops. Spawned agent automation threads can be stopped; shared target threads require ownership review. Already-running scripts have no supported cancellation API and may continue. New schedules, manual Run, Send-now, arbitrary processes and native maintenance are not a mandatory network barrier. Enumeration and cancellation are periodic, with bounded partial reports. No system firewall/hosts rules or BB rebuild are added.

Controller status and restoration operate on at most the documented bounded inventory; incomplete inspection is reported. Snapshot intent survives process failure. Restoration never replays expired one-shots and skips ambiguous pauses unless explicitly reviewed.

See [existing plugin-only limits](vpn-plugin-protection-limits.md). Test the actual writer-to-consumer-to-controller chain in an isolated instance before deployment. Do not activate strict mode against a legacy writer or an unavailable controller.

## Deployment / Развёртывание

1. Upgrade Guard, Pooler and the compatible automation controller with activation flags off.
2. Deploy the accepted VPN writer in a coordinated idle window.
3. Confirm a fresh `/2` sample and IPv4 proof on the actual server.
4. Enable Pooler verification for protected providers, then Guard verification and Enforce; verify explicit denials and recovery.
5. Opt in to automation coordination and test independent manual/Guard holds. Keep recovery manual.

This development cycle prepares code and isolated verification only. Production VPN, pool and automation state are not switched automatically.
