# Gemini matching usage reports

The provider can return several model identifiers with exactly the same
percentage, reset and token type. Equality alone does not establish that they
share an allowance, and it does not map a legacy identifier to a new model.

The account card and Provider Usage summarize these equal observations as
"matching reports". Only known, identical token types are grouped. Different
values or resets stay separate; unknown token types stay separate. Percentages
are never summed. Original model identifiers and observations remain in account
details and storage. A grouped window applies to multiple reports, so it has no
single model identifier. Routing, thresholds and quota collection do not change.

Validate the summary through the native usage RPC and account card, and retain
negative cases for differing token types, percentages and resets. Model
availability comes from the ACP agent; a model absent from the usage response
must not receive an invented quota or reset.
