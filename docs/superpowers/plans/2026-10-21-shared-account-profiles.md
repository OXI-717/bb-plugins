# Shared native account profiles

Goal: accounts appear together in Helium's native picker, with one managed browser process retaining its proxy, timezone and last-window lifecycle across profile switches.

1. Reproduce Chromium profile/context selection using disposable profiles. Never send authorization URLs through process arguments or the current/default CDP context.
2. Add profile-store tests for shared registration, preservation of opaque migrated data, retry after metadata failure, foreign entries, unsafe sources and encryption mismatch. Change preparation to provision the native store only while Helium is closed, keeping original data and metadata backups.
3. Add shared-supervisor capability negotiation and profile-specific target navigation. Require verified VPN for shared browser launch regardless of the selected account. Preserve model API policy.
4. Exercise cookie separation and return-to-profile navigation against local synthetic HTTPS in real Helium, then close all synthetic windows and verify owned browser exit. Run focused profile/transport/RPC tests, typecheck and build.
5. Obtain independent review and final-head CI, publish an immutable plugin release, then update only during an idle pool window. Existing user browsers must close before first migration; never overwrite an active profile or interrupt model requests.
