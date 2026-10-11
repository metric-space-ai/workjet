# Project-control timeout diagnostics

The desktop trace span `CtoxGuestManager.requestProjectControl` retains the selected instance, action and fixed failure reason. For a project-list timeout reported by the guest, its optional `phase` distinguishes `collections`, `command`, `bridge`, `query_readiness` and `native_projection`. A native-request deadline is `native_request`; the desktop's own 30-second deadline is `desktop_delivery`.

These values identify the operation that expired. They do not prove that a request reached or completed on the native host. Correlate native command metadata or protocol traces before attributing a server failure. Request messages, payloads, credentials and arbitrary error text never enter the phase field. Older guests and uncategorized errors retain their existing fixed reason without a phase.
