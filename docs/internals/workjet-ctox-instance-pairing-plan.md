# Workjet CTOX instance pairing and active scope

Status: implementation in progress, 2026-08-27.

This file is the continuity checklist for the shared Desktop and Mobile work.
It describes product state, not a second wire protocol.

Current implementation baseline:

- `7a1c8b532` implements compact, one-time, DPoP-bound device-pairing
  references with an explicit canonical Business-OS-instance scope.
- `72c9c0a1a` resolves Desktop presentation IDs to canonical
  `BusinessOsInstanceId` values in the main process without exposing pairing
  secrets to the renderer.
- `13b0303da` removes the global pairing dialog and keeps device actions in the
  regular, instance-scoped Business OS settings. Actions remain fail-closed
  until the selected instance has a verified backend-control authority.
- `9c751db06`, `49405cb8b` and `e3b1ddfaf` scope Mobile Code to the active
  Business OS, simplify the settings hierarchy and prohibit a Code computer or
  primary environment from acting as an implicit device-control route.
- The Android release artifact for `e3b1ddfaf` was installed without clearing
  data on the Galaxy Fold over wireless ADB on 2026-08-27. The visible device
  pass still requires the operator to unlock the phone.
- `99c61badd` contains the typed and tested Computer List/Assign/Unassign
  scaffold. It remains intentionally unmounted until an authoritative producer
  supplies bounded instance inventory, `hostingMode`, backend host identity and
  computer host identities. Renderer connection catalogs, hostnames, CTOX
  presentation source kinds and the primary Code environment are forbidden
  substitutes.

## Canonical model

- A **CTOX instance** is the only user-selectable backend scope.
- A Workjet installation may pair with multiple CTOX instances.
- A CTOX instance may be paired with multiple Workjet installations.
- Pairing is the per-installation authorization edge to one CTOX instance. It
  is not another selectable object.
- Each paired CTOX instance maps locally to one or more Code machine
  environments. Projects, threads, sessions and selectable workers are scoped
  to the complete set owned by the active instance.
- Each computer/machine environment belongs to exactly one CTOX instance. A
  reassignment moves that computer; it never creates a cross-instance shared
  machine.
- Machines and workers are resources inside the active CTOX instance. They are
  not parallel backend entries. A Mobile installation is never a selectable
  worker.
- The active CTOX instance is the single source of truth. `Code | Business OS`
  changes only the visible product surface and never changes the active
  instance.

Local membership relation:

```text
businessOsInstanceId -> environmentId[]
```

The backend control authority is a separate internal relation:

```text
businessOsInstanceId -> backendControlAuthority
```

`backendControlAuthority` is the server-attested route which can mint, list
and revoke device invitations for exactly that CTOX instance. It is not a Code
computer and is never exposed as another selectable Connection. In particular,
the primary Code environment and the first assigned computer must never be used
as a fallback for this route. A managed backend host remains backend-only even
though its control authority can authorize Workjet devices.

Only those stable, non-secret identifiers may be stored in the local binding
table. Pairing secrets remain in the existing secure stores. Business records,
signaling credentials and invite payloads are forbidden in the binding table.

## Binding UI/UX concept

The N:M relation between Workjet installations and CTOX instances is a storage
model, not a navigation model. Computer ownership is separately one-to-many:
one instance owns many computers and each computer has exactly one owner.
Workjet never renders a global graph or parallel lists for Backends,
Environments, Pairings, Machines and Devices. The UI is always scoped to
exactly one active CTOX instance.

### Persistent Workjet chrome

The left column has one stable hierarchy on Desktop, Fold and tablet:

```text
Code | Business OS
WELSCH                         v   <- active CTOX instance
--------------------------------
mode-specific navigation/content
--------------------------------
one global Settings gear
```

- `Code | Business OS` changes only the visible product surface.
- The instance selector changes the complete Workjet scope for both surfaces.
- The selected instance and sidebar open/closed state survive mode switches.
- Code shows only projects, threads, sessions and workers belonging to the
  active instance. Business OS shows only that instance's apps and records.
- The selector contains real independent CTOX instances only. Mac, `gpu1`,
  `gpu3`, phones and other installations never appear there.
- Desktop exposes one sidebar toggle shared by both modes. The embedded
  Business OS guest must not add another global hamburger, launcher shell or
  competing instance selector.
- The sidebar footer has no quick-action icon strip. It may contain exactly one
  global Settings gear. The same gear opens the same regular Workjet Settings
  route from Code and Business OS; all destinations are clearly labelled
  inside that menu.

### Canonical regular Settings

There is exactly one management surface: `Settings -> Business OS`. Every
connected CTOX backend is presented to the user as one Business-OS instance.
The existing regular `Computers` section remains the global inventory of local,
relay, SSH and Tailscale compute targets plus their harnesses. `Business OS`
adds the assignment layer. Selecting `WELSCH` opens one detail view with these
sections:

`Business OS` is the first Settings item and owns the Settings scope. Opening
Settings from Business OS preselects the currently visible instance; opening
from Code uses the same shared active instance. Every subsequent
instance-dependent page consumes that scope and must not implement another
backend/environment/pairing selector or show cross-instance data. If no
Business OS is selected, instance-dependent pages remain unavailable rather
than falling back to a global mixed view.

The former visible `Connections` section is removed. Computer transport setup
lives in `Computers`; Business-OS and Workjet-device authorization lives in
`Business OS`. Credential storage and connection services remain internal.
Legacy settings links redirect to the appropriate one of those two sections.

The legacy/separate `Business OS Einstellungen` dialog and its gear trigger do
not exist in the resulting UI. The single regular Workjet gear opens the same
Settings surface from Code and Business OS.

1. **Übersicht** — display name, connection health and last successful sync.
2. **Workjet Geräte** — app installations authorized for WELSCH, for example
   this Mac, the Fold and an iPad. `Gerät hinzufügen` creates the short-lived
   QR code; every row can be renewed or revoked independently.
3. **Zugewiesene Computers** — compute targets from the existing global
   `Computers` inventory that are available to Code in WELSCH, for example this
   Mac, `gpu1` and `gpu3`. `Computer zuweisen` selects existing inventory rows;
   adding or editing the target itself stays in regular `Computers`.
4. **Diagnose** — technical signaling and sync diagnostics, collapsed by
   default. Manual credentials are an explicit recovery action here, not a
   primary workflow.

One physical computer may have two roles: its Workjet installation is a row in
`Workjet Geräte`, while its execution capability is a row in `Rechner für
Code`. The rows describe roles inside WELSCH and are not duplicate CTOX
instances.

### Backend-host isolation policy

The CTOX backend host and a Code computer are separate roles, even when they
refer to the same physical self-hosted PC.

- A managed CTOX host is always backend-only. It must never be advertised,
  selected or assigned as a Code computer/worker. This is a server-authoritative
  prohibition, not a dismissible client warning.
- Managed Business OS instances may still own separately provisioned external
  computers. The prohibition applies to using the managed backend host itself
  as a worker.
- A self-hosted CTOX instance may assign other computers normally. Co-locating
  the backend and a Code worker on the same self-hosted PC is disabled by
  default and requires an explicit high-risk confirmation.
- The confirmation explains that coding agents can exhaust disk, RAM and CPU;
  failure of a co-located host can simultaneously remove the worker, CTOX sync
  and Business OS availability.
- Host identity and the managed/self-hosted capability come from the
  authoritative Desktop/Server contract. Mobile must not infer them from a
  hostname or invent a local `managed` flag.

### Adding and switching

- `Business OS hinzufügen` pairs this Workjet installation with one additional
  independent instance. It does not add a Machine.
- `Gerät hinzufügen` authorizes another Workjet installation for the currently
  selected instance. It does not install CTOX or create a worker.
- `Computer zuweisen` links an existing regular-Settings computer to the
  currently selected Business OS. Mobile may manage or observe assignments but
  is never itself offered as a worker.
- Switching A -> B restores B's last Code and Business OS navigation state and
  never mixes lists from A. Switching `Code | Business OS` keeps A active.
- Deep links carrying another instance ID require an explicit scope switch
  before opening; they never silently combine data.

### User-facing language

Primary UI uses only `Business OS`, the instance's display name, `Workjet
Geräte`, `Zugewiesene Computers`, `Gerät hinzufügen`, `Computer zuweisen`,
`Verbunden`, `Offline` and `Synchronisiert`. `CTOX Backend`, Environment ID,
pairing edge, signaling endpoint, room, ledger and mail envelopes are technical
terms restricted to status details or the collapsed Diagnose section.

## Mobile implementation checklist

- [x] Persist the one-to-many local instance/machine membership in SQLite.
- [x] Store the binding only after Code and Business OS imports both succeed.
- [x] Roll back newly created partial state when either half fails.
- [x] Selecting a CTOX instance scopes Code to all of its assigned computers.
- [x] Selecting a bound Code environment selects the same CTOX instance.
- [x] Replace global `All environments` with `Alle Rechner in <Instanz>` and
      restrict it to the machine memberships of the active instance.
- [x] Show one shared instance selector in Code and Business OS, including the
      left pane on Fold/tablet layouts.
- [x] Pair each additional CTOX instance through its own short-lived Workjet QR
      code or explicit paste action.
- [x] Show connection state and per-instance actions without separate Machine,
      Backend and Pairing lists.
- [x] Put `Business OS` first in regular Mobile Settings and route visible
      connection/setup entry points into that one management surface.
- [x] Remove the visible Mobile `Environments` row while retaining its internal
      transport services for compatibility and migration.
- [x] Forget/revoke exactly one installation/instance edge and preserve all
      other bindings.
- [x] Preserve Coding-only operation before any CTOX instance is paired.
- [x] Keep the Business OS data path RxDB/WebRTC-only.
- [x] Redeem compact one-time references with a stable device identifier and
      the existing DPoP proof-key thumbprint; never return or persist the full
      secret bundle during invite creation.
- [ ] Consume the authoritative backend-host isolation capability once the
      Desktop/Server contract lands; never offer a managed host as a worker.

## Desktop implementation checklist

- [x] Render the same active CTOX instance selector in the left sidebar of Code
      and Business OS.
- [ ] Derive Code environment, projects, threads, sessions and workers from the
      active instance.
- [x] Keep the active instance stable when switching `Code | Business OS`.
- [ ] Present `Gerät verbinden`, renew and revoke as actions of one instance.
- [ ] Keep Machines/workers nested under the instance rather than presenting
      them as alternative backends.
- [ ] Remove the global device-pairing dialog/CTA and the standalone Machines
      navigation page. Both capabilities live only in the regular settings of
      the selected CTOX instance; legacy routes may redirect there.
- [ ] Enroll Mac, `gpu1`, `gpu3` and other hosts as Machines of the selected
      instance instead of minting additional CTOX instance rows for them.
- [ ] Enforce managed backend hosts as backend-only and require an explicit
      high-risk confirmation before self-hosted backend/worker co-location.
- [ ] Generate compact one-time-reference QR codes and retain guarded manual
      signaling details as an explicit fallback.

Desktop ownership remains with the parallel `Workjet Desktop app` task. Mobile
does not edit Desktop, Server or shared-contract files while that task is
active.

## Verification

- [ ] Pair two CTOX instances in one Workjet installation.
- [ ] Switch A -> B in Business OS and observe Code switch to B.
- [ ] Switch B -> A in Code and observe Business OS switch to A.
- [ ] Toggle modes repeatedly without changing the active instance.
- [ ] Create threads/sessions under each instance and prove no cross-instance
      list mixing.
- [ ] Pair a second Workjet installation to A and prove the first relation is
      unchanged.
- [ ] Revoke one relation and prove all other relations remain functional.
- [ ] Prove the local binding contains identifiers only and no secrets or
      business records.
- [ ] Install the release build on the Galaxy Fold over wireless ADB and run the
      complete QR, instance-switch, restart, offline and resync pass.

## Separate visual deliverable still active

- [ ] Generate sixteen genuinely distinct reference candidates for every
      Business OS app.
- [ ] Program production SVG candidates from first principles.
- [ ] Show generated PNG and SVG reconstruction side by side.
- [ ] Deliver one offline HTML selector with per-app favorites and JSON export.
- [ ] Integrate only operator-approved icons into signed platform asset packs.
