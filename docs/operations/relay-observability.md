# Relay observability

> For maintainers. Using Workjet? See [docs/user](../user/).

Production relay and signaling diagnostics use Cloudflare Worker logs and the
Cloudflare dashboard. Client-side OpenTelemetry export is disabled by default.
An operator may configure a separate OTLP-compatible collector for an isolated
deployment, but Workjet does not provision or require an external telemetry
vendor.

Logs and errors must never contain pairing references, bootstrap credentials,
refresh grants, DPoP proofs, room passwords, capability tokens, Business OS
records, or WebRTC payloads. Pairing and device-session responses use
`no-store`, `no-cache`, and `no-referrer` headers.
