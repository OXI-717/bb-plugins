# Pooler errors / Ошибки пула

Pooler-owned failures have a stable reason in `x-bb-pool-error`, in the message prefix, and in JSON error codes where the provider protocol allows it. Anthropic and OpenAI envelope shapes remain native. Cursor uses Connect's standard code/message shape; streaming calls receive a final EndStream envelope with HTTP 200, the original local status in `x-bb-pool-http-status`, and a protocol error inside the envelope. See the [Connect protocol](https://connectrpc.com/docs/protocol/).

| Reason | Meaning / Причина |
| --- | --- |
| POOL_QUOTA_THRESHOLD | Pool's configured reserve threshold reached / Достигнут настроенный порог пула |
| POOL_QUOTA_EXHAUSTED | Provider quota exhausted / Исчерпан лимит провайдера |
| POOL_RATE_LIMITED | Temporary pacing / Временное ограничение частоты |
| POOL_AUTH_REQUIRED | Authentication rejected or unavailable / Ошибка авторизации |
| POOL_ACCESS_DENIED | Provider or access-policy refusal / Отказ провайдера или политики доступа |
| POOL_REQUEST_REJECTED | Other request rejection / Запрос отклонён |
| POOL_ACCOUNT_UNAVAILABLE | All applicable accounts have stored errors; inspect cards / У аккаунтов сохранены ошибки, проверьте карточки |
| POOL_ACCOUNT_POLICY | Other account eligibility rules / Аккаунты недоступны по настройкам пула |
| POOL_NO_ACCOUNTS | No enabled account / Нет включённого аккаунта |
| POOL_PROJECT_RESTRICTED | No account allowed for this project / Нет разрешённого аккаунта проекта |
| POOL_SCHEDULE_RESTRICTED | Schedules closed / Расписания закрыты |
| POOL_UPSTREAM_UNAVAILABLE | Connection or upstream failure / Сбой подключения или провайдера |
| POOL_SHUTTING_DOWN | Hub stopping / Пул останавливается |
| POOL_REQUEST_CANCELED | Caller cancellation / Отмена клиентом |
| VPN_REQUIRED, VPN_GUARD_BLOCKED, VPN_GUARD_UNAVAILABLE | Existing VPN/Guard policy codes / Существующие коды VPN/Guard |

A configured threshold refusal is not proof that the provider has spent the whole quota. For example, a synthetic account at 93.5% with a 90% threshold gets `POOL_QUOTA_THRESHOLD`, with both values in the message. Pool policy and provider exhaustion refusals retain HTTP 403 without Retry-After for ordinary requests, so they do not turn into silent multi-day automatic retries. Connect streaming uses its required HTTP 200 envelope while carrying the same explicit failure.

У каждой причины свой код. Настроенный запас квоты отличается от полного исчерпания. Проценты и известное время сброса отображаются без email, ключей и идентификаторов аккаунтов. Ошибки сохранённой авторизации не выдаются за исчерпанный лимит.

For Claude OAuth refusal, use [reauthorization in the existing card / повторный вход в ту же карточку](claude-reauthorization.md). Removing the subscription is unnecessary.

`VPN_GUARD_UNAVAILABLE` means permission could not be established; it does not itself prove that the VPN is disconnected. From Pooler 0.4.19, `Guard check: timeout`, `rpc_failed` or `invalid_decision` distinguishes the safe failure category without exposing the RPC payload. The server lookup and Guard RPC share a four-second deadline: Guard may need one second for the Pooler policy and 1.5 seconds for host evidence, plus RPC overhead. Status checks all four protected providers concurrently, avoiding four sequential Guard deadlines. An expired check cancels the waiting SDK calls and refuses provider traffic; late permission cannot release that request. Every new request checks again, without reusing an old allow decision.

`VPN_GUARD_UNAVAILABLE` означает, что разрешение не удалось получить; сама ошибка не доказывает отключение VPN. В версии 0.4.19 сообщение различает таймаут (`timeout`), сбой вызова (`rpc_failed`) и некорректный ответ (`invalid_decision`). Общий срок ожидания — четыре секунды. При отказе запрос к провайдеру не начинается, аккаунт не считается испорченным; повторный запрос заново проверяет разрешение. Это не гарантирует прекращения уже открытых сетевых соединений или возобновления остановленных BB-тредов.

Scope: local Pooler refusals and adapter error responses. External BB/CLI wrappers may prepend their own text. Upstream passthrough bodies and a transport disconnect after a stream has started retain their existing behavior. No routing, quota thresholds, account credentials or retry policy is changed by this formatting update.
