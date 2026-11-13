# Адресная проверка Antigravity — протокол diagnostic v1

`native.probe({accountId, executorId, hostId, projectId, model?})` выполняет одну
адресную проверку. Без model запрашивается только свежий каталог. С model
выполняется один фиксированный ACP prompt без MCP и запросов инструментов,
после явного выбора modelId из свежего каталога. Подписка и оплата не выводятся
из каталога. Только точный ответ модели после успешного завершения и cleanup
может вернуть `model-responded / verified:true`.

Pooler повторно применяет project/caller/host, VPN, maintenance и занятость.
Сервер выдаёт короткоживущий случайный токен (только stdin обработчика хоста),
привязанный к точным account/executor/host/project/model и reservationId.
HTTP admission принимает kind=diagnostic только с этим разрешением. Оно
потребляется ровно одним acquire, без replay даже с прежним sessionId.
Обычные task/catalog candidates сохраняют enabled; preference не меняется.
Диагностика использует общую lease аккаунта, poll/heartbeat и stopped release.

Исполнение поддерживается только fixed Linux HostProcess. Prepared execution
и Secret Service unlock не понижаются до этого режима: возвращается отсутствие
поддержки. Корневой Fleet entrypoint читает bounded diagnostic frame по stdin,
сверяет authority/account/host/profile inode, родительский процесс, route и gateway.
Клиент запускается тем же HostProcess с cgroup/BPF, фиксированным HOME, официальным
executable/hash, отдельным D-Bus для независимого профиля и пустым рабочим каталогом.
Остановка относится только к созданному этой проверкой процессу. Неподтверждённая
остановка сохраняет занятую lease; timeout не объявляет очистку состоявшейся.

Результаты: not-started, runtime-unavailable, catalog-received, model-responded,
verification-required, model-unavailable, provider-error, stop-unconfirmed.
Ошибки возвращаются фиксированными категориями без URL, OAuth и сырых логов.
Google challenge не повторяется. Модельные запросы не переключаются на другой аккаунт.

## Совместимость и доставка

Нужны обе части: Pooler server+host с nativeProbeCapabilities/nativeProbe и Fleet
host bundle с agy_native_probe.py, включённым в immutable receipt. Протокол1;
номера выпуска не изменены. Старый host entry/отсутствующий модуль возвращает
runtime-unavailable до выдачи разрешения. Старый Pooler не принимает diagnostic kind.
Несогласованная пара отказывает до запуска официального клиента.

Адресные Linux regression-прогоны выполнены; независимое ревью и сквозная приёмка
установленной пары остаются отдельными этапами. Установка и живые запросы не выполнены.
`bb pool native preflight <target-json>` не получает lease, не запускает провайдера
и не изменяет сохранённые сессии или события. Истёкшие и uncertain/queued lease
отражаются как занятость; аудит не выполняет их восстановление. Prepared execution
и unlock дают blocked независимо от доступности протокола хоста. Проверка протокола
сама по себе не доказывает готовность root profile: требуется и Fleet preflight.
Предварительное создание обычных аккаунтов остаётся через существующий AccountDraftForm;
официальные Google профили не дублируются новым OAuth onboarding.
