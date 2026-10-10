# Native provider references and Luma selection

A Luma route can identify a Workjet gateway account through `gatewayAccountId`,
or a CTOX instance account through
`nativeAccountReference: { accountId, holderInstanceId, accountRevision }`.
At least one reference is required. Native-only routes never invent a local
gateway ID; historical gateway routes remain readable.

Only the authenticated native provider registry supplies native references.
Settings → Models reads that registry through the selected instance's existing
Owner/Admin command bus. Refresh adopts already configured native accounts and
observes their real authenticated model list. It does not create credentials
or log in on the operator's behalf.

Claude's shared model string is stored once per provider with a policy revision.
Individual accounts can exclude shared models. The Luma editor offers only the
selected account's fresh, enabled model set and observes the same account again
before saving. An account-revision mismatch or failed observation leaves the
draft open. The success toast waits for the actual instance configuration
receipt; conflicts retain the draft.

A catalog circle means inference has not been checked. Discovering a model
never creates a green inference checkmark, and no fallback list is used for a
native-only account. This public projection contains no secrets.

This metadata is not execution authority. CTOX resolves it again under the
current Owner, project binding and admitted Supervisor command or confirmed-plan
lease, checks the holding instance and current account revision, and validates
the selected model against that account's successful live catalog.
The external Claude Code holding executor and remote Claude OAuth login remain
separate dependencies; saving a Luma does not prove installed execution.
The Monday Supervisor execution path and its defaults are unchanged.
