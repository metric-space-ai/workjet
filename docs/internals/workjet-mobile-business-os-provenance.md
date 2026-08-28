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

- [x] Add the Settings actions `QR-Code anzeigen`, `Erneuern`, `Widerrufen` and
      `QR-Code scannen`. Users never type a signaling server or password.
- [x] Generate and revoke short-lived invites through an already authenticated
      CTOX Backend. Show instance and expiry, and redact the QR when Workjet moves
      to the background or system snapshot where the platform permits it.
- [x] Import QR/deep-link/paste payloads only after explicit confirmation;
      atomically write room password and capability token to Expo SecureStore and
      clear the pasteboard after successful paste import.
- [x] Store only non-secret, opaque backend references in the existing Mobile
      SQLite registry; support multiple independent CTOX Backends and one active
      backend per Business OS session.
- [ ] Consume the signed, version-compatible CTOX shell pack in the canonical
      Workjet WebView with per-instance IndexedDB/WebRTC isolation. Do not add an
      HTTP data proxy or fallback.
- [ ] Prove iOS/Android WebView, IndexedDB and direct RxDB/WebRTC sync with
      restart, offline/resync, multi-instance and 3:4/4:3 tablet E2E coverage.
- [ ] Add QR roundtrip, renewal/revocation, multi-backend, SecureStore,
      paste-clear, background/screenshot-redaction and secret-leak tests.

### Second-slice implementation status

The create/revoke control plane is bound to the typed Environment HTTP client
introduced in Workjet commit `8e2160b5b`. It calls
`businessOs.createMobileInvite` and `businessOs.revokeMobileInvite` through the
shared Environment command introduced in Workjet commit `69263a58c`. That path
selects an authenticated, unambiguous environment and creates a fresh
request-bound proof for relay-managed DPoP connections; Mobile does not read or
reimplement bearer, cookie or DPoP credentials.

The Mobile registry uses the existing `t3code-client.db` identity and adds
`business_os_instances` plus a singleton selection row. Room passwords and
capability tokens are stored only under opaque, device-bound Expo SecureStore
references. Re-pairing writes both new secrets and the registry row before old
references are deleted. Forgetting an instance removes only its two references
and its isolated WebView profile.

The native shell host is present but cannot activate a production shell yet:

- iOS serves `workjet-business-os://<storage-uuid>/business-os/index.html`
  through `WKURLSchemeHandler` and a `WKWebsiteDataStore` created from that
  instance's UUID.
- Android serves
  `https://appassets.androidplatform.net/business-os/index.html` through
  `WebViewAssetLoader`, requires `MULTI_PROFILE`, and assigns a distinct
  AndroidX WebKit profile before the first load. Unsupported WebViews stop.
- Both hosts deny media/geolocation requests, externalize only explicit HTTPS
  link activations, disable mixed content/file access and inject the direct
  RxDB/WebRTC bootstrap into a no-store `index.html` response.
- Both hosts expose a write-only `workjetBusinessOsNotify` entry for Decision
  Hub. iOS uses a named `WKScriptMessageHandler`; Android uses the same
  origin-bound AndroidX WebMessage channel as the lifecycle contract and does
  not expose `addJavascriptInterface`. The entry accepts only a bounded title/body, opaque decision/tag tokens
  and urgency; context, options, credentials and arbitrary navigation targets
  cannot cross it. Workjet schedules a native local notification on iOS and on
  Android's high-importance `decision-hub` channel after the user has granted
  device notification permission. Delivery is immediate while the isolated
  Business OS shell is active and syncing. The durable CTOX unread-notification
  row provides catch-up after reconnect; this bridge is not a replacement for
  a remote APNs/FCM push when the app is fully suspended or terminated.

Activation remains fail-closed because the signed shell distribution endpoint
is present but its production producer and bundled public-key trust map have not
landed. Mobile resolves it through the shared DPoP-capable Environment command
from Workjet commit `9df756456` and validates the
`ctox.mobile.shell-pack-distribution.v1` response from server commit `12029616d`.
The adapter refuses before making the authenticated request unless exactly one
current and one next Ed25519 key are bundled. The accepted manifest envelope is
`ctox.mobile.shell-pack.v1`: pack ID, exact Business OS revision, exact app
version, total size, per-file path/size/SHA-256, signing key ID and an Ed25519
signature over canonical manifest JSON. Unknown keys, expired or unsafe artifact
URLs, traversal, extra or missing files, wrong hashes, signatures, versions or
revisions are rejected. `index.html` and `mobile-apps.json` are mandatory signed
pack members. `vendor/ctox-office/**` remains a separate on-demand
pack and is rejected from the base shell.

Unit and static guards cover canonical QR roundtrip, expiry, response mismatch,
atomic re-pair/rollback, multiple independent backends, restart-loaded
selection, paste clearing, background/screenshot protection hooks, canonical
origins, `MULTI_PROFILE`, direct-data-plane guards, signature/hash/revision
failure, download consent/cancel/offline/retry states and the 3:4/4:3 breakpoint.
The complete Mobile unit suite currently passes with 125 files and 750 tests;
the focused native-shell and branding verification contributes 6 files and 35 tests. The iOS native
module target also compiles with the new Business OS scheme handler included.
Real IndexedDB/WebRTC offline/restart/resync and Office delivery E2E remain open
until a production shell artifact can be acquired.

## Native Mobile-OS shell slice

The Business OS root no longer renders the desktop shell as its launcher. It
now owns a native route model for Setup, Home, App, Search/App Library, Recents
and Settings while keeping Code navigation isolated and usable without a CTOX
Backend.

- Home uses adaptive, horizontally paged desks, a platform-specific dock,
  folders, badges, haptic edit/drag mode and local per-instance placement.
- iOS uses the existing native glass material only for the dock and transient
  controls. Android uses an extended reachable header, adaptive icon geometry,
  edge-to-edge safe-area spacing and the hardware/predictive-back entry point.
- Compact, medium and expanded grids cover phone, 3:4 portrait and 4:3
  landscape. App descriptors declare phone/tablet readiness and one of
  `list-detail`, `feed`, `form`, `canvas` or `document`.
- Search/App Library and Recents are native. Recents persist only app ID and
  timestamp; no WebView screenshot, record or secret crosses the native
  boundary.
- The per-instance layout, dock, folders and Recents live in the existing
  `t3code-client.db` data identity. Forgetting an instance deletes this row in
  addition to its secrets and isolated WebView profile.
- The versioned `workjet.business-os-shell.v1` bridge accepts only host
  configuration, catalog, app lifecycle, back, declared action and aggregate
  badge metadata. TypeScript, Swift and Kotlin reject unknown top-level fields,
  oversized messages and unsupported types. Android is bound to
  `https://appassets.androidplatform.net`; iOS uses a named
  `WKScriptMessageHandler`.
- The signed CTOX shell adds `mobile-apps.json`, `mobile-host.js` and
  `mobile-host.css`. In mobile-host mode it removes the desktop topbar,
  start/task surfaces, open-app tabs, window headers/resizers and side panes;
  Desktop behavior is untouched when the native bootstrap attribute is absent.
- Runtime icons never cross as SVG, HTML or remote URLs. The native catalog
  maps known apps to trusted packaged symbols and uses a deterministic local
  fallback for unknown apps.

The App Canvas is permanently mounted for the selected instance once a native,
verified pack activation exists. Until real current+next production Ed25519
keys and a real distribution are bundled, the activation input remains absent
and the App route displays a native fail-closed state. This slice therefore does
not yet claim real-device RxDB/WebRTC parity, background catch-up or completed
module-by-module phone/tablet approval. Mobile is a client only and never
registers itself as a selectable worker.

Visible Mobile identity is guarded as `Workjet` in Expo-generated iOS/Android
display metadata, primary surfaces, accessibility labels and widget metadata.
The approved existing mark is retained. Technical bundle/package identifiers,
SQLite/SecureStore keys, CocoaPods/Xcode target names and inbound legacy URL
aliases remain unchanged for update and data continuity.

## Release gate for the donor

Do not publish the standalone CTOX Mobile prototype. Once the second slice has
demonstrated the parity items above, block the donor as a release target and
remove it in a separate, reviewable change. Until then it remains provenance
evidence only.
