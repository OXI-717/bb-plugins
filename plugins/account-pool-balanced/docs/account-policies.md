
### Account-specific rules

Open an account card and enable **Account-specific settings**. Changes are saved
automatically after a short pause in editing. Before closing the card, wait for
the “Settings saved” status; if saving fails, use the retry button. For the
5-hour and weekly quotas, set the share to **keep**: 50% means the pool stops
sending new requests after half of the quota has been used. An empty field
inherits the shared switch threshold. The 5-hour control is hidden when the
provider does not report that window. Weekly protection also accounts for
weekly quotas by model family. Priority and role are changed from the account
menu; neither overrides the remaining-quota protection. The progressive weekly
cap can stop usage before the account-specific threshold.

An account schedule defines allowed days and time intervals in the selected
time zone. For 20:00–08:00, the selected day is the interval's start day. The end
time is exclusive. An empty schedule allows no new requests; a disabled schedule
allows use at any time. Schedules apply to both primary and reserve accounts.
For a reserve account, you can set how many working hours before the weekly reset
it starts being used alongside primary accounts. Shared rest days still apply
to this calculation.

Disabling account-specific settings preserves their values but restores the
shared thresholds and eligibility rules. **Use until exhausted** temporarily
overrides quota protection while preserving the schedule. Account-specific
thresholds take effect again after the first provider limit is exhausted.
Estimates use the latest provider quotas, including usage outside the pool;
requests already in progress are not interrupted. This is not a separate client
usage counter or a guarantee of the exact remaining quota during parallel use.
