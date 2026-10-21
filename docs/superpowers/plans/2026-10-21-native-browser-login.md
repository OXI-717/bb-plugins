# Native account-browser login

Goal: launch the shared account browser from Pooler as a normal interactive browser, without a CDP pipe or an automation-indicating flag. Preserve native profile selection, the IPv4 proxy, exit timezone, VPN admission and private URL handling.

Accepted direction: remove CDP from shared interactive launch rather than spoofing navigator.webdriver. Existing isolated legacy transport remains compatible; actual shared account launches negotiate a new protocol and refuse old supervisors before forwarding links. Shared browsers use normal application quit (including Command-Q on macOS); no CDP last-window auto-quit.

Navigation: each HTTPS authorization link is encoded in an owner-only temporary HTML document under a fresh private directory. Native profile selection receives only its local file URL. Files expire after a bounded interval, are capped, and are removed when the owned browser exits. An unpredictable local receipt confirms document loading before subsequent launches; blank handoffs use about:blank. Success does not attest completion of an external login.

- [x] Add failing native launch/profile/private URL/legacy rejection tests.
- [x] Implement bounded native supervisor and protocol negotiation, preserving proxy policy.
- [x] Test actual temporary Helium profiles: automation signal false, exact-profile navigation and cookies, proxy/TZ, opaque argv and cleanup. No real login state altered.
- Successful Google account login remains a user check; local browser evidence does not establish the cause of a particular provider rejection.
- [ ] Update documentation, run focused/typecheck/build, independent acceptance and remote CI.
- [ ] Release and perform idle-only update with state verification. Existing browsers require a normal manual quit/reopen.
