# Pooler errors / Ошибки пула

Pooler-owned failures have a stable reason in `x-bb-pool-error`, in the message prefix, and in JSON error codes where the provider protocol allows it. Anthropic and OpenAI envelope shapes remain native. Cursor uses Connect's standard code/message shape; streaming calls receive a final EndStream envelope with HTTP 200, the original local status in `x-bb-pool-http-status`, and a protocol error inside the envelope. See the [Connect protocol](https://connectrpc.com/docs/protocol/).

| Reason | Meaning / Причина |
| --- | --- |
| POOL_QUOTA_THRESHOLD | Pool's configured reserve threshold reached / Достигнут настроенный порог пула |
| POOL_QUOTA_EXHAUSTED | Provider quota exhausted / Исчерпан лимит провайдера |
| POOL_RATE_LIMITED | Temporary pacing / Временное ограничение частоты |
| POOL_AUTH_REQUIRED | Authentication rejected or unavailable / Ошибка авторизации |
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

Scope: local Pooler refusals and adapter error responses. External BB/CLI wrappers may prepend their own text. Upstream passthrough bodies and a transport disconnect after a stream has started retain their existing behavior. No routing, quota thresholds, account credentials or retry policy is changed by this formatting update.
