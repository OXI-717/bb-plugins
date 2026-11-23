# Gemini weekly usage

Use the quota summary operation already used by the Antigravity adapter as
optional enrichment for Gemini OAuth. Request it with the same account and a
project returned by the existing subscription request when available. Preserve
the current quota and admission logic if the summary is unavailable.

Show the explicitly named Gemini five-hour and weekly buckets in Provider Usage
and account details. Omit conflicting or invalid measurements and retain legacy
model observations. Validate the collector, fallback, and display with synthetic
responses before accepting a real observation on the host.
