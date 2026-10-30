
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
