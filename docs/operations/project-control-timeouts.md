# Project-control timeout diagnostics

The desktop trace span `CtoxGuestManager.requestProjectControl` retains the selected instance, action and fixed failure reason. For a project-list timeout reported by the guest, its optional `phase` distinguishes `collections`, `command`, `bridge`, `query_readiness` and `native_projection`. A native-request deadline is `native_request`; the desktop's own 30-second deadline is `desktop_delivery`.

A guest supporting the optional `onCommandTiming` observer supplies `guestCommandId` and numeric `command.stage.<name>.ms` attributes for completed intervals. These include capability acquisition, document/database preparation, sync readiness, fresh peer authority, dependency delivery/revalidation, local persistence, push acknowledgement, local-to-native intake, native processing, projection commit and commit-to-browser observation. An unfinished preinsert interval has `command.pending.stage` and `command.pending.ms`. Partial samples omit unobserved intervals. Push acknowledgement and native intake can overlap; do not sum them as sequential stages.

The observer is scoped to the guest-generated command ID and requests the existing command timing probe. It requires the matching CTOX shell change; older guests ignore the optional observer and retain existing behavior. A desktop delivery timeout before the guest returns has no stage sample. No sample means unknown, not zero elapsed time.

These values identify the operation that expired. They do not prove that a request reached or completed on the native host. Correlate native command metadata or protocol traces before attributing a server failure. Request messages, payloads, credentials and arbitrary error text never enter the phase or timing fields.
