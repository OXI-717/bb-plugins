
### Antigravity sign-in browser

The Google sign-in button uses the configured Mac account browser host and a
separate Helium onboarding profile. It does not open the operator's default
browser and refuses to fall back when the selected host is unavailable. Select
the Mac browser host before starting sign-in. Existing verified VPN and retained
browser registry requirements apply. The server retains the PKCE session and
exchanges the pasted callback; only its generated authorization URL is sent to
the browser host. Cancelled, consumed and expired sessions cannot be opened.
The onboarding profile is reused for subsequent sign-ins; choose the intended
Google account explicitly. This does not import local browser credentials.

### Guard timing observations

Selected model flights record `guard-check` events for checks before dispatch,
after response headers and after cooldown waits. Timing measures only the actual
Guard call, using a monotonic clock; local VPN evidence and queue time are not
included. Fixed outcomes distinguish direct permission, allowed, blocked,
timeout, invalid decision, RPC failure and unavailable Guard. No raw errors,
headers or credentials are recorded. The request/account/provider identity is
inherited from the existing flight trace. Background enforcement and quota or
login checks are outside this coverage. `observations.guardChecks` summarizes
all retained events, independently of the displayed row page, within existing
journal retention and size limits. It does not reconstruct older failures or
claim provider reachability. Observer failures never change admission decisions.
