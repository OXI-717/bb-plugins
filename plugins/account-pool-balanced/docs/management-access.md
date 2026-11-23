# Доступ к управлению Pooler

В0.4.83 обычный интерфейс настроек, индикатор аккаунта и витрина квот восстановлены без ключа по указанию владельца. Клиентские RPC снова обслуживают интерфейс. Ограничение CLI сохраняется: подробные команды требуют короткого операторского допуска через stdin.

Это сокращает случайное раскрытие из обычных CLI-команд, но не отделяет браузер владельца от произвольного клиента RPC. Без поддержки идентичности вызывающего в ядре BB такая изоляция не заявляется. UI больше не требует разблокировки.

С0.4.89 плагин VPN Guard снова может читать настройки защиты пула (`config.get`) без допуска: без этого Guard показывал связь как недоступную и отказывал бы пулу на машине с обязательным VPN. В настройках нет учётных данных. Остальные методы для Guard закрыты, включая изменение настроек; для других плагинов действует прежний список.

При инициализации сервер создаёт закрытый корневой ключ в `<dataDir>/plugins/<plugin-id>/secrets/accounts/management/operator.env`, каталог0700/файл0600. Он не выдаётся через API/settings/окружение. Ключи и допуски нельзя печатать или передавать аргументами процесса. Административная сессия получает краткоживущий `read`/`manage` допуск, сервер хранит только его SHA-256 отпечаток.

## CLI для допущенной сессии

Используется один приватный JSON-запрос через stdin; значения не входят в командную строку:

- `bb pool management unlock --request-stdin`: `{ "key": "<operator-key>", "scope": "read", "ttlSeconds": 300, "output": "<new-private-file-on-pool-server>" }`. Новый файл содержит допуск; существующий файл не перезаписывается. Команда возвращает только срок и уровень допуска.
- `bb pool management execute --request-stdin`: `{ "token": "<short-lived-grant>", "argv": ["account", "list", "--json"] }`. Импорт credentials или OAuth-кода также передаётся внутри этого приватного JSON, без второго stdin-флага.
- `bb pool management lock --request-stdin`: `{ "token": "<short-lived-grant>" }`.

Файл выдачи находится на сервере пула, даже если CLI вызван с другой машины. Передача допуска допущенной сессии — отдельное приватное действие администратора. В JSON нельзя вставлять секреты в тексте задачи или чата. CLI с подставленным номером разрешённого треда или без номера треда не получает прав. `--help` не выполняет операцию.

## Обновление и границы

Штатный обновлятор использует приватный ключ локально и короткие допуски. После0.4.82 management RPC сохранены, поэтому обновление и снятие паузы совместимы. Старый парный upgrade-protection.sh не адаптирован.

Ядро BB не менялось. Same-UID файлы/процессы, общие API BB и старые provider.env-resolved журналы вне гарантий. Токены не отзываются и журналы не удаляются этим выпуском.

### Cached quota summary

`bb pool status --summary` is a read-only JSON command available without a
management grant. It returns a server timestamp and fixed quota signals for
Claude, Codex, Gemini, Grok, Z.AI and IFM. Readiness here describes cached
quota status. It does not evaluate project or network admission.

The summary contains counts and an exhaustion flag. The minimum usage
percentage is null unless at least two quota-ready accounts have complete,
fresh numeric evidence. Counts and repeated samples can reveal operational
activity. The command does not refresh quotas or return account identifiers.
