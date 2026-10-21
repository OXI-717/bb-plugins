## Возможности

Пул выбирает аккаунт для запроса и показывает расход квот, дату и время сброса (МСК). Карточка аккаунта также показывает число успешных запросов через пул с момента установки версии 0.4.2; это не остаточная квота провайдера. Доступны последовательная и сбалансированная стратегии, основные и резервные аккаунты, индивидуальные потолки расхода. Поддерживаемые адаптеры: Claude, Codex, Kimi, Z.AI, OpenCode Go, Cursor и Devin Local CLI. Для Devin пока нет числовой телеметрии квот, поэтому он не публикуется в общей панели Usage; один запуск CLI закреплён за одним PAT, переключение происходит при новом запуске после ограничения аккаунта.

## Локальная настройка

Аккаунты добавляются в установленном BB. Секреты, порядок аккаунтов, пороги и маршрутизация остаются на сервере пользователя и не передаются с marketplace. Новый пользователь начинает с пустого пула. Для отдельного треда можно обойти пул и использовать его собственную авторизацию.

## Требования

BB 0.46.1 или новее, Node/npm для установки из Git и аккаунты провайдеров, которые вы вправе использовать. Подписки и API оплачиваются отдельно; плагин не увеличивает лимиты аккаунтов. Доступность моделей определяется провайдером.

## Команды

Настройки доступны через интерфейс и `bb pool --help`. Инструкция для Devin CLI и других внешних клиентов — [External clients](docs/external-clients.md). Проверка состояния — `bb pool status`, обновление — `bb plugin update account-pool-balanced`. Не включайте одновременно встроенный Account Pooler: оба используют команду `bb pool`.

`bb pool browser open <id|email|label> [--url <https-url>]` opens a persistent Helium account browser named `<Provider> · <email>`. Without an explicit URL, every provider opens the neutral local page `about:blank`. URLs accept HTTPS without embedded credentials; command output shows only the site origin. `POOL_BROWSER_EXECUTABLE` overrides the Helium binary.

In Pooler settings, choose **Открыть в браузере** from an account's action menu or its details. A missing profile is created on first open; later opens reuse it. Details accept an optional HTTPS link, including a provider authorization link. Existing Claude reauthorization also offers **Открыть в профиле аккаунта** for its current authorization URL. The window opens on the Pooler server machine, not on a remote dashboard device. Browser sign-in and account connection to the pool remain separate; the existing OAuth/API-key onboarding is unchanged. Authorization URLs are not saved in settings or browser-launch acknowledgements. UI navigation uses owner-only temporary local HTML documents (0700 directory, 0600 files), so the link does not appear in browser process arguments. Documents expire after five minutes or are removed on owned-browser exit; at most 32 may be outstanding. Abnormal supervisor termination can leave private files in the OS temporary directory. The browser runs without DevTools, automation switches or webdriver spoofing. Prefer the UI for one-time authorization links; an explicit CLI `--url` value is still visible in the caller’s command line.

All accounts use ordinary native profiles in one Helium user-data root. The native profile menu lists them together, including when Helium is opened manually. The first managed launch registers the current account list while Helium is fully closed. A newly added account needs one closed-browser window to update the list. Each account keeps a separate profile directory, cookies and site storage. The registry remains in the BB server plugin data directory under `browser-profiles/registry.json`; `bb pool browser list [--json]` reports the binding and existence of each profile.

Upgrading from separate `Pool Accounts/Profile N` roots requires closing all Helium processes once. Migration copies the active isolated profile to a fresh native directory, retaining both the isolated source and any older native copy. It preserves unrelated native profiles and removes an obsolete picker entry only when its name matches the old account binding. Existing registry/Local State snapshots and a resumable migration plan stay beside the registry. Copy failures do not switch the binding; completed copies are reused after a metadata-write failure. Missing/unsafe sources, occupied destinations and incompatible encryption metadata refuse migration. Do not open Helium during migration. Copies use the same application and OS storage; moving them across hosts or browser applications is unsupported. Registry operations use a kernel-owned loopback lease across CLI/RPC processes.

Managed launch requires VPN/2 verified IPv4 evidence and a valid exit timezone for **every browser profile**, including Kimi/Z.ai: native switching can reach protected accounts without calling Pooler again. This does not change the pool API providers' VPN exemptions. One detached supervisor owns the common browser's local IPv4 CONNECT proxy and process timezone. Switching profiles within that browser retains its process settings. Every managed open rechecks VPN/geo before handoff. The browser launch check is not a continuous VPN monitor or packet firewall.

Navigation uses Helium's native profile-directory launch with a private local document that redirects to the requested HTTPS URL. An unguessable readiness receipt from the private document is handled locally by the proxy (no external request and no authorization URL in its response). It confirms the local document loaded before allowing another launch; it does not confirm the destination page or account sign-in. Blank handoffs use ordinary native launch acceptance. Shared-profile protocol 4 rejects older automated supervisors before sending a URL; fully quit Helium once after upgrading and reopen from Pooler.

The supervisor survives plugin reloads and keeps the proxy alive until the owned browser exits. Shared browsers use normal native lifetime: on macOS close the application with Command-Q; closing the last window can leave Helium running in the Dock. Automatic last-window quit is intentionally not provided by attaching a debugger to the interactive browser. Changing exit timezone/executable requires closing the shared browser first. An already-running unmanaged Helium cannot be adopted: close it and start through Pooler. Direct Dock launch without a supervisor uses ordinary system networking and lifetime. macOS/Linux Unix sockets are supported.


Use the provider UI for manual login, billing and [saved resets](docs/saved-resets.md). The command does not log in, export cookies or change pool routing.


## Защита без изменения BB / Plugin-only network protection

После обновления VPN Guard 0.1.2 и Pooler 0.4.14 включите `bb pool config set vpnGuardEnabled true` (галка «Подчиняться VPN Guard»). Выберите машину сервера пула в Guard. При ручном блоке или недоступном Guard защищённые вызовы самого пула получают временный локальный 503; уже удерживаемые им запросы/потоки отменяются при следующей проверке. Kimi/Z.ai остаются независимыми. Без связи ручной блок управляет только тредами BB.

Enable the persisted Pooler linkage after upgrading both plugins. Guard covers Cursor/Devin Pool aliases and supplies an uncached network decision for the pool server. Missing/malformed/timed-out Guard fails closed for protected owned traffic. No BB build or system firewall changes; direct/native Send-now and independent maintenance remain outside the strict guarantee. [Реализованные гарантии и ограничения / guarantees and limits](../../docs/vpn-plugin-protection-limits.md).

Devin quota collection is not implemented. Its accounts remain available for routing but are omitted from the shared Usage inventory; stale quota-resource requests fail explicitly without a provider call.

[Единая защита / Unified protection](../../docs/unified-protection.md): VPN evidence /2, optional automation controller, independent pause reasons and explicit recovery. Strict mode and controller integration default off.

Контроллер автоматизаций не требуется для работы Pooler или его связи с VPN Guard и не входит в комплект публичных плагинов. Он нужен только для дополнительного управления расписаниями.

An automation controller is not required for Pooler or its VPN Guard linkage and is not bundled with the public plugins. It is only needed for optional scheduler control.

[Ошибки пула / Pooler errors](../../docs/pool-errors.md): stable reason codes, provider-native responses and distinct quota threshold/exhaustion messages. Коды причин и сообщения отличают настроенный порог от исчерпания лимита провайдера.

Automatic recovery uses ordinary BB admission and preserves manual blocks and newer user activity. See [recovery policy / правила продолжения](../../docs/pool-errors.md).

[Аккаунт в заголовке треда](docs/account-identities.md): email или сохранённое название реально использованной подписки для всех провайдеров. Для API-ключей email можно указать в карточке; OAuth-адрес приходит от провайдера.
