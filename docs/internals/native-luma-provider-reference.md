# Native provider references in Luma configuration

A Luma route retains its existing `gatewayAccountId` for Workjet's local gateway.
For a CTOX-native Supervisor execution it can additionally carry
`nativeAccountReference: { accountId, holderInstanceId, accountRevision }`.

Only the authenticated native provider registry supplies these three values.
A local gateway id, provider name or email address cannot establish this mapping.
The optional reference survives both local settings serialization and the
instance-wide Luma document. Historical routes remain readable without a native
reference; saving them never creates one.

This metadata is not execution authority. CTOX resolves it again under the
current Owner, project binding and admitted Supervisor command or confirmed-plan
lease, checks the holding instance and current account revision, and validates
the selected model against that account's successful live catalog. A missing or
stale native binding must produce its explicit unavailable result rather than
falling back to another account or model.

This contract change does not yet provide a native-account picker or an external
Claude Code Supervisor producer. Neither installed execution nor cross-holder
authorization follows from successfully decoding the reference.
