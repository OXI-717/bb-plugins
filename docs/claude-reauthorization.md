# Claude reauthorization / Повторная авторизация Claude

When Claude rejects OAuth refresh, the account card records `[OAUTH_REAUTH_REQUIRED]` and shows **Нужна авторизация** for an enabled account. Enabling an account checks its quotas; a failed check remains visible instead of making the account appear healthy. A usage HTTP 401 triggers one access refresh and retry. A second 401 also requires authorization.

Open the existing Claude account card and select **Авторизоваться заново**. Sign in with that account in the browser and paste the authorization code. The completed profile must match the stored account UUID, or its email when no UUID was previously recorded. A different identity is rejected before replacing the saved authorization. No new pool account is created.

ID, label, enabled state, role, priority, project assignments and individual settings are preserved. Disabled accounts remain disabled. Successful reauthorization clears the old account error and temporary hold; enabled accounts are checked again. An account removed during login is not recreated.

HTTP 400 alone does not identify the cause. The card includes only recognized OAuth error codes, such as `invalid_grant`, when present in a bounded response. Raw response descriptions and tokens are excluded. Network errors, timeout, HTTP 403, 408, 429 and server errors retain the existing transient recovery behavior. VPN policy still applies to refresh, profile and login calls.

Откройте существующую карточку Claude и нажмите **Авторизоваться заново**. В браузере войдите именно в нужный аккаунт, затем вставьте код. Удалять подписку и добавлять её заново не требуется: проекты, роль, лимиты и состояние включения сохраняются. При входе в другой аккаунт замена не выполняется.

Ошибка обновления OAuth отличается от исчерпания квоты. По одному HTTP 400 нельзя утверждать, что токен отозван или истёк. Если провайдер возвращает известный код, карточка показывает его без секретов и полного тела ответа. Временный сбой сети не требует повторного входа.
