# Workjet Mobile: Business OS provenance and parity gate

## Canonical product

`apps/mobile/` is the only Workjet user app for iOS and Android. Its existing
bundle/package identifiers, Expo project slug and device storage keys remain
unchanged during the soft migration so an update replaces the installed app
without duplicating local data.

The user-visible name is `Workjet`. `CTOX` names the backend/daemon only. New
links use `workjet://` (or the matching development/preview variant). Existing
`ctox-mobile*://`, `ctox-business-os-mobile://pair` and `t3code*://` inputs are
accepted and normalized during the migration window.

## Donor provenance

The architecture donor is
`/Users/michaelwelsch/Documents/ctox/src/apps/business-os-mobile` at commit
`8bc569bad88ffb107fb24104e2c26fe7b9204c43`. It is a prototype, not a second
product app, release target or source of user-facing branding. The legacy
`src/apps/business-os-desktop` Electron app is not a product basis.

## First safe slice

- [x] Visible Expo app identity and primary Mobile surfaces use `Workjet`.
- [x] Existing bundle/package IDs, Expo slug and local storage identities stay
      unchanged.
- [x] Production, development and preview Workjet schemes are canonical;
      historical schemes remain inbound aliases.
- [x] A persistent `Code | Business OS` root choice exists. Existing Code flows
      remain the default and do not require a CTOX Backend.
- [x] Business-OS links select the Business OS root without logging, decoding
      or persisting their payload in the navigation layer.
- [x] The `ctox-business-os-invite` v1 codec validates type, version, TTL,
      capability TTL, room prefix, `webrtc`, `rxdb-webrtc`, disabled HTTP bridge and
      exclusively credential-free `wss:` signaling URLs. Generated links use only
      `workjet://business-os/pair`.
- [x] Tablet orientation is unrestricted so 3:4 portrait and 4:3 landscape are
      supported by both platform builds. The setup surface uses the existing
      responsive tokens and caps its readable width.

This slice does not claim Business OS runtime parity. Its setup state is
deliberately explicit rather than presenting non-functional server/password
fields.

## Second Business OS slice

- [ ] Add the Settings actions `QR-Code anzeigen`, `Erneuern`, `Widerrufen` and
      `QR-Code scannen`. Users never type a signaling server or password.
- [ ] Generate and revoke short-lived invites through an already authenticated
      CTOX Backend. Show instance and expiry, and redact the QR when Workjet moves
      to the background or system snapshot where the platform permits it.
- [ ] Import QR/deep-link/paste payloads only after explicit confirmation;
      atomically write room password and capability token to Expo SecureStore and
      clear the pasteboard after successful paste import.
- [ ] Store only non-secret, opaque backend references in the existing Mobile
      SQLite registry; support multiple independent CTOX Backends and one active
      backend per Business OS session.
- [ ] Consume the signed, version-compatible CTOX shell pack in the canonical
      Workjet WebView with per-instance IndexedDB/WebRTC isolation. Do not add an
      HTTP data proxy or fallback.
- [ ] Prove iOS/Android WebView, IndexedDB and direct RxDB/WebRTC sync with
      restart, offline/resync, multi-instance and 3:4/4:3 tablet E2E coverage.
- [ ] Add QR roundtrip, renewal/revocation, multi-backend, SecureStore,
      paste-clear, background/screenshot-redaction and secret-leak tests.

## Release gate for the donor

Do not publish the standalone CTOX Mobile prototype. Once the second slice has
demonstrated the parity items above, block the donor as a release target and
remove it in a separate, reviewable change. Until then it remains provenance
evidence only.
