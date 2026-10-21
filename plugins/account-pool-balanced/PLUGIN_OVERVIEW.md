## Возможности

Пул выбирает аккаунт для запроса и показывает расход квот, дату и время сброса (МСК). Карточка аккаунта также показывает число успешных запросов через пул с момента установки версии 0.4.2; это не остаточная квота провайдера. Доступны последовательная и сбалансированная стратегии, основные и резервные аккаунты, индивидуальные потолки расхода. Поддерживаемые адаптеры: Claude, Codex, Kimi, Z.AI, OpenCode Go, Cursor и Devin Local CLI. Для Devin пока нет числовой телеметрии квот, поэтому он не публикуется в общей панели Usage; один запуск CLI закреплён за одним PAT, переключение происходит при новом запуске после ограничения аккаунта.

## Локальная настройка

Аккаунты добавляются в установленном BB. Секреты, порядок аккаунтов, пороги и маршрутизация остаются на сервере пользователя и не передаются с marketplace. Новый пользователь начинает с пустого пула. Для отдельного треда можно обойти пул и использовать его собственную авторизацию.

## Требования

BB 0.46.1 или новее, Node/npm для установки из Git и аккаунты провайдеров, которые вы вправе использовать. Подписки и API оплачиваются отдельно; плагин не увеличивает лимиты аккаунтов. Доступность моделей определяется провайдером.

## Команды

Настройки доступны через интерфейс и `bb pool --help`. Инструкция для Devin CLI и других внешних клиентов — [External clients](docs/external-clients.md). Проверка состояния — `bb pool status`, обновление — `bb plugin update account-pool-balanced`. Не включайте одновременно встроенный Account Pooler: оба используют команду `bb pool`.

`bb pool browser open <id|email|label> [--url <https-url>]` opens a persistent Helium account browser named `<Provider> · <email>`. Each supported provider defaults to its console or account website. URLs accept HTTPS without embedded credentials; command output shows only the site origin. `POOL_BROWSER_EXECUTABLE` overrides the Helium binary.

In Pooler settings, choose **Открыть в браузере** from an account's action menu or its details. A missing profile is created on first open; later opens reuse it. Details accept an optional HTTPS link, including a provider authorization link. Existing Claude reauthorization also offers **Открыть в профиле аккаунта** for its current authorization URL. The window opens on the Pooler server machine, not on a remote dashboard device. Browser sign-in and account connection to the pool remain separate; the existing OAuth/API-key onboarding is unchanged. Authorization URLs are not saved in settings or browser-launch acknowledgements. UI navigation uses inherited Chromium DevTools pipes, so the link does not appear in browser process arguments or a debugging TCP endpoint. Prefer the UI for one-time authorization links; an explicit CLI `--url` value is still visible in the caller’s command line.

Each account has a separate browser process and user-data root under Helium's native data location, in `Pool Accounts/Profile N`; its profile is `Profile N` inside that root. Ordinary Helium and different account windows can remain open. The registry stays in the BB server plugin data directory under `browser-profiles/registry.json`. `bb pool browser list [--json]` displays the stored account email and profile state.

On first use of an older native profile, the original Helium must be closed once. The command copies that account's profile and Local State into a staged isolated root, then atomically publishes the completed copy. Original profiles, settings and authentication files remain intact. Copies use the same Helium application and OS storage; moving them to another host or browser is unsupported. Later opens reuse the migrated data and never overwrite it from the original. Malformed or inaccessible registry/state files fail closed. Concurrent CLI/RPC processes serialize allocation using a kernel-owned loopback lease; a conflicting port produces a bounded retry error.

The browser timezone is validated from a bounded IPv4 geo probe. Guarded providers (claude/codex/cursor/devin) require VPN/2 `connected` + `verified_ipv4` and a known exit timezone before each open. A detached supervisor owns a private Unix control socket and one local HTTPS CONNECT proxy per account. Proxy destination sockets use IPv4; browser launches use a fixed proxy without DIRECT fallback, remove the loopback bypass, disable QUIC and restrict non-proxied WebRTC UDP. Plain HTTP is rejected. [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) describes fixed-proxy and CONNECT semantics. This constrains browser URL traffic; it is not a system packet sandbox or a claim about extensions and every browser subsystem. No system IPv6 or overlay changes are required.

After upgrading from a supervisor without private pipe navigation, close only that account browser and reopen it once. Capability negotiation happens before any URL is sent. The supervisor survives plugin reloads and closes its proxy/control resources when the account browser exits. Reopening uses the live socket rather than a stale PID marker. Changing the exit timezone while that account browser runs requires closing that account window and reopening it. A supervisor failure leaves the fixed proxy unavailable; close that account window and retry. Other Helium windows are unaffected. The transport currently supports macOS/Linux Unix sockets.

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
