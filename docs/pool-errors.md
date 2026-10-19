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

Scope: local Pooler refusals and adapter error responses. External BB/CLI wrappers may prepend their own text. Upstream passthrough bodies and a transport disconnect after a stream has started retain their existing behavior. Error formatting does not change account routing, quota thresholds or credentials. Automatic recovery is described below.

## Transport diagnostics / Диагностика соединений

Transport warnings retain the `Account Pooler <provider> transport failed: <code>.` prefix and append a bounded JSON object:

```json
{"code":"UND_ERR_CONNECT_TIMEOUT","category":"connect","elapsedMs":10021,"transport":"ipv4","stage":"fetch_headers","operation":"model"}
```

`elapsedMs` measures one actual fetch attempt until response headers or failure, using a monotonic clock. It excludes admission checks, account selection and response-body reads. `transport` describes the selected Pooler fetch (`ipv4` or `default`), not the actual VPN node or proxy route. `operation` separates model calls from auxiliary calls such as quota and OAuth requests. Auxiliary failures now use the same diagnostic boundary; compare counters by operation when analyzing old and new logs.

`category` comes only from recognized error codes: `dns`, `connect`, `socket`, `tls`, `headers`, `body`, `session`, `abort`, `timeout`, or `unknown`. A generic timeout does not establish a connection stage. Only a bounded error/aggregate cause traversal is inspected; unknown codes, error messages, URLs, headers, account identifiers and tokens are never included. The existing prefix may remain `unclassified transport error` while the JSON supplies a recognized TLS or abort category.

Policy refusals before fetch and owner cancellations do not generate transport warnings. A native `AbortSignal.timeout` expiration is reported as a request deadline (`REQUEST_DEADLINE`, category `timeout`), rather than being suppressed as a cancellation. Stream failures after headers are outside this diagnostic scope. These records provide evidence about a failed attempt, not proof that VPN, DNS, the provider or Pooler caused it. Diagnostics alone do not retry or change admission; recovery is a separate policy below.

В журнал добавляются безопасная категория, длительность отдельной попытки, выбранный транспорт и тип вызова. Отказы Guard и отмена владельцем не считаются сетевыми сбоями. Запись не раскрывает адреса и секреты и сама по себе не устанавливает причину отказа.

## Automatic recovery / Автоматическое продолжение

Pooler 0.4.24 schedules up to three additional native BB retries for structured connection/stream failures on enabled pooled routes: 30 seconds, two minutes and five minutes, with up to 10% jitter. These are queued failed-turn references, not copies of the user message. BB preserves whether the original input was accepted. Authentication, billing, quota/policy refusals and unknown errors are not retried; built-in overload and rate-limit recovery remains separate. A bypassed route, changed thread or existing queue prevents a new automatic retry. User activity cancels a still-queued Pooler-owned retry. Uncertain scheduling is not blindly repeated.

VPN refusals use HTTP **503** plus `Retry-After: 10` and their existing stable reason code. Authentication/account-policy failures retain their own 401/403 behavior. Cursor streaming retains the Connect HTTP 200 envelope and carries the local 503 in `x-bb-pool-http-status`. Guard holds queued retries until fresh proof permits dispatch; waiting consumes no additional failed attempt.

The bundled Cursor launcher normalizes a narrow CLI defect: a model call rejected by the local Pooler can otherwise appear as an assistant answer followed by successful ACP completion. With one attributable prompt, a matching local error header, matching session error text and `end_turn`, the launcher returns a JSON-RPC failure. Auxiliary requests, ambiguous concurrent prompts, cancellation, later successful model attempts and arbitrary assistant text are not treated as failed turns. The launcher must be installed separately on each client host; updating the server plugin alone does not replace an existing `cursor-route` executable. Existing incorrectly completed turns are not replayed.

Guard 0.1.14 separately recovers **new** Guard-owned stops after verified VPN and native-plugin recovery, including Observe after an explicit manual unblock. Recovery verifies the actual interrupted turn, provider/environment identity and current request; a stop acknowledgement timestamp alone never establishes ownership. Optional ownership reads run outside the enforcement lane. BB native retry requires an errored turn; a stopped idle turn therefore uses a checked continuation through ordinary admission. Historical stop IDs are not imported. Manual block, later user activity, a changed stop, archive/delete or queued work prevents continuation. Up to three local scheduling attempts are allowed; an uncertain send retains its claim and is never automatically duplicated. Slow continuation calls do not occupy the enforcement lane; no more than four automatic continuation workers run per Guard instance; ineligible hosts do not starve recovered hosts. The SDK has no atomic compare-and-send, so a final activity race cannot be eliminated by a plugin.

Временные сетевые отказы повторяются через очередь BB, максимум три раза. Пока действует блокировка Guard, сообщение ждёт разрешения и не расходует попытки. Новые остановленные Guard треды продолжаются после восстановления подтверждённого VPN; ручной блок и новые действия пользователя сохраняются. При неизвестном результате отправки автоматического дубля не будет. Старые записи истории сами не запускаются.
