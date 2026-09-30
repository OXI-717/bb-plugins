# Use an account until exhausted

Open an account card and enable **Использовать до исчерпания** (Use until exhausted).
The account bypasses the pool's progressive weekly cap and early-switch threshold,
and can serve traffic even when its saved role is reserve. New unbound requests
prefer enabled accounts with this option; existing conversation bindings remain intact.
If several accounts are armed, the normal routing strategy chooses between them.

The option turns off when the pool observes the first exhausted provider quota,
whether shared or model-specific, in response headers or a quota refresh. A confirmed
quota rejection also turns it off. Generic pacing (429), network errors and provider
outages do not. Codex windows are taken from provider data; no five-hour window is assumed.

This option cannot increase subscription limits. Redeem a saved reset in the provider's
own interface, then refresh quotas in the pool. The saved role and cap apply again;
the option stays off until manually enabled. No saved reset is redeemed automatically.
The option survives a pool restart, as does its automatic off state.
