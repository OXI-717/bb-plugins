# Saved usage-limit resets

Open a Claude or Codex account card to see saved manual resets, their remaining count, and each expiry date and time. Deadlines include seconds and the explicit Moscow time zone (MSK, UTC+3). Automatic five-hour and weekly window resets are shown separately.

The pool only reads reset information. Apply a saved reset using the provider's own UI. Credentials and redemption handles are not returned to the browser.

For Codex, the quota response provides the available count and a separate read supplies individual expiry dates. If details cannot be fetched, the card keeps the known count and reports that expiry details are unavailable.

For Claude OAuth accounts, the same usage request also asks for saved reset offers, matching the read-only request used by Claude Code 2.1.282 (`cedar_ember=1&skip_spend=1`). The request carries the CLI user-agent surface associated with these OAuth credentials. A grant may contain several uses; the card sums remaining uses and shows which limits the grant restores. Some grants require reaching a limit before redemption. Exhausted, expired, paused and future grants are not counted as currently available.

Missing, malformed or ineligible reset metadata means availability is unknown, not zero. It does not prevent valid usage-window data from updating. Servers rejecting the optional query with HTTP 400, 404 or 422 get one plain-usage retry; auth, throttling and server failures do not trigger that compatibility retry.

Use **Refresh quotas** in the account card to collect current reset information. The card shows when the count was last checked. Stored observations survive restarts; they are not a guarantee that a grant is still available after use elsewhere.

Provider background: [Claude limit resets](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset) and [Codex banked resets](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work).
