# Workjet CTOX instance pairing and active scope

Status: implementation in progress, 2026-08-27.

This file is the continuity checklist for the shared Desktop and Mobile work.
It describes product state, not a second wire protocol.

## Canonical model

- A **CTOX instance** is the only user-selectable backend scope.
- A Workjet installation may pair with multiple CTOX instances.
- A CTOX instance may be paired with multiple Workjet installations.
- Pairing is the per-installation authorization edge to one CTOX instance. It
  is not another selectable object.
- Each paired CTOX instance maps locally to exactly one complete Code
  environment. Projects, threads, sessions and selectable workers are scoped
  through that environment.
- Machines and workers are resources inside the active CTOX instance. They are
  not parallel backend entries. A Mobile installation is never a selectable
  worker.
- The active CTOX instance is the single source of truth. `Code | Business OS`
  changes only the visible product surface and never changes the active
  instance.

Local relation:

```text
businessOsInstanceId <-> environmentId
```

Only those stable, non-secret identifiers may be stored in the local binding
table. Pairing secrets remain in the existing secure stores. Business records,
signaling credentials and invite payloads are forbidden in the binding table.

## Mobile implementation checklist

- [x] Persist the one-to-one local instance/environment binding in SQLite.
- [x] Store the binding only after Code and Business OS imports both succeed.
- [x] Roll back newly created partial state when either half fails.
- [x] Selecting a CTOX instance selects its Code environment everywhere.
- [x] Selecting a bound Code environment selects the same CTOX instance.
- [x] Hide the cross-instance `All environments` view after managed bindings
      exist; Code must not mix data from different active instances.
- [x] Show one shared instance selector in Code and Business OS, including the
      left pane on Fold/tablet layouts.
- [x] Pair each additional CTOX instance through its own short-lived Workjet QR
      code or explicit paste action.
- [x] Show connection state and per-instance actions without separate Machine,
      Backend and Pairing lists.
- [x] Forget/revoke exactly one installation/instance edge and preserve all
      other bindings.
- [x] Preserve Coding-only operation before any CTOX instance is paired.
- [x] Keep the Business OS data path RxDB/WebRTC-only.

## Desktop implementation checklist

- [ ] Render the same active CTOX instance selector in the left sidebar of Code
      and Business OS.
- [ ] Derive Code environment, projects, threads, sessions and workers from the
      active instance.
- [ ] Keep the active instance stable when switching `Code | Business OS`.
- [ ] Present `Gerät verbinden`, renew and revoke as actions of one instance.
- [ ] Keep Machines/workers nested under the instance rather than presenting
      them as alternative backends.
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
