# Supervisor worker access choice — 2026-10-11

Owner: `01a1227e-c0ad-7950-9446-ef5dc0797e90`. PR: https://github.com/metric-space-ai/workjet/pull/410. Base: `ff38037713befb6e3df52c2dd3e01131f03db365`, with #403 and #402 merged.

## Cause and change

#403 added an explicit chooser to `NativeWorkerSourceControl`, but #402 rendered that component headlessly in the Supervisor. Two matching ready connections blocked automatic binding, while the chooser was hidden.

The headless status now carries the same filtered ready connections and selection callback. The Supervisor renders the shared `WorkerSourceConnectionPicker` in its quiet status row above the editor. Choosing one invokes the existing #403 binding path. No new grant or access path is created, and the composer bar does not gain a control.

A unique ready connection still binds automatically. A ready saved binding hides the row even if another grant exists. Foreign, expired and incompatible connections remain filtered out and are rejected by the existing callback guard. Two ready replacements can be selected when a previous grant expired, without demanding login for the old grant. Other connection failures retain the existing single recovery action.

## Checks

The first green step passed 47 tests in three affected files on gpu3, run `workjet-supervisor-access-status-20261011T061002Z`, before the first WIP commit. Tests cover headless ambiguity becoming a visible row, explicit selection and saved binding, disappearance after binding, unique/bound empty status, rejected foreign/expired IDs, and ready replacement selection.

Required final checks are `pnpm exec vp check`, `pnpm exec vp run typecheck`, the affected tests below, and `node scripts/audit-workjet-content.mjs`. The exact final head, results and canonical lane receipt are retained in the PR and in the durable owner evidence under `~/.codex/task-evidence/composer-bar-restore-20261009/supervisor-worker-access-status-20261011/`.

```sh
cd apps/web
pnpm exec vp test run --project unit --maxWorkers 2 \
  src/components/chat/NativeWorkerSourceControl.test.tsx \
  src/components/chat/NativeSupervisorComposer.test.tsx \
  src/workjetWorkerSourceConnection.test.ts
```

## Isolated screenshots

The screenshots use production `NativeWorkerSourceControl`, `NativeSupervisorConnectionStatus`, picker, editor styles and ordinary composer controls. Only the worker-connection query and binding-save callback are replaced by an isolated fixture backend. It exposes two ready connections of one instance, plus an expired and a foreign connection that must not appear as choices. The browser selects the second ready connection, verifies exactly one saved binding, reloads and verifies that the chooser disappears.

Earlier screenshot attempts stopped at the cold Vite startup, a Chromium network-change error, and a fixture whose purported foreign access mistakenly used the selected tenant's identity. The final fixture uses a different tenant identity; no identity-matching rule was relaxed or changed. Failed attempts completed their owned cleanup and are not acceptance passes.

The successful browser run was `workjet-supervisor-access-status-20261011T062148Z`, using production component blobs from `1594fdac19a31a7467c4d9bfe77c234bde27ec75`. Chromium's startup network-change errors were recovered by one bounded reload and retained in the proof. The settled rendering, selection, saved binding and reload checks passed with no further browser errors. At 420 px the document scroll width is 420 px and the status row's width and scroll width are both 362 px. Component blob IDs are retained in [source.json](supervisor-worker-access-status-20261011/source.json).

No installed app data, protected files, credentials, login, keychain command or safeStorage helper is accessed. The displayed project/computer/connections are clearly labeled synthetic test fixtures. This is an isolated component acceptance check, not installed native execution acceptance.

- [Ambiguous state, 1440 px](supervisor-worker-access-status-20261011/supervisor-access-1440.png)
- [Ambiguous state, 420 px](supervisor-worker-access-status-20261011/supervisor-access-420.png)
- [Browser proof](supervisor-worker-access-status-20261011/proof.json)
- [Owned cleanup](supervisor-worker-access-status-20261011/cleanup.json)

The bounded gpu3 UI unit owns the browser and Vite process groups. It stops both and removes its temporary source entry and HTML in a finalizer. No Mac lease or installed app change is involved. The lane admitted promptly; no resource-wait loop was used. The PR is ready for the supervisor to merge after checks; this thread does not merge.
