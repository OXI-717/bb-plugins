# VPN Guard

## Русский

Плагин BB 0.46+ управляет запуском Codex, Claude, Cursor и Devin на выбранных машинах. Начинает с наблюдения. В режиме защиты недоступный VPN удерживает новые сообщения в очереди и останавливает защищённые треды. Кнопка **«Заблокировать»** включает постоянный ручной блок даже при подключённом VPN и в режиме наблюдения. **«Снять блок»** возвращает выбранный режим. Kimi и Z.ai остаются доступны.

В панели можно выбрать RU/EN. Дополнительное глобальное отключение встроенных Codex/Claude включается отдельно и требует ручного восстановления. Это управление BB: Send-now обходит очередь, завершение открытых соединений и bridge-процессов не гарантируется. [Управление и ограничения](docs/operations.md). [Общий стандарт интерфейсов](../../docs/plugin-ui-standard.md).

## English

BB 0.46+ selected-machine admission control for Codex, Claude, Cursor and Devin. Starts in Observe. Enforce holds new protected messages and stops running protected threads on unavailable VPN. **Block** persists a manual override even with connected VPN and in Observe. **Unblock** returns to the selected mode. Kimi and Z.ai remain available. The panel provides RU/EN.

Optional global native Codex/Claude suspension requires separate opt-in and explicit restore. Send-now bypasses admission; active connections and bridges are not proven stopped. See [operations and limits](docs/operations.md). Built from the public BB Plugin SDK; state reading follows Account Pooler policy (MIT).


## Plugin-only network protection

Enable `bb pool config set vpnGuardEnabled true` after upgrading both plugins. Guard checks native and pool Cursor/Devin aliases; linked Pooler refuses protected upstream calls on manual block or unavailable Guard and cancels retained owned traffic at the next policy check. See [implemented guarantees and limits](../../docs/vpn-plugin-protection-limits.md). No BB rebuild or system firewall modification is required; direct/native Send-now and independent maintenance remain outside the strict guarantee.


## Защита без изменения BB / Plugin-only network protection

После обновления VPN Guard 0.1.2 и Pooler 0.4.14 включите `bb pool config set vpnGuardEnabled true` (галка «Подчиняться VPN Guard»). Выберите машину сервера пула в Guard. При ручном блоке или недоступном Guard защищённые вызовы самого пула получают локальный 403; уже удерживаемые им запросы/потоки отменяются при следующей проверке. Kimi/Z.ai остаются независимыми. Без связи ручной блок управляет только тредами BB.

Enable the persisted Pooler linkage after upgrading both plugins. Guard covers Cursor/Devin Pool aliases and supplies an uncached network decision for the pool server. Missing/malformed/timed-out Guard fails closed for protected owned traffic. No BB build or system firewall changes; direct/native Send-now and independent maintenance remain outside the strict guarantee. [Реализованные гарантии и ограничения / guarantees and limits](../../docs/vpn-plugin-protection-limits.md).
