# Prompted project KPI presentation

Project cards read their KPI projection through `project.kpis.read` on the selected CTOX guest. The compact gallery editor now saves up to three sentences with `project.kpis.configure`, a stable operation ID and the expected native revision. Clearing all sentences sends an empty prompt list. The existing RxDB/WebRTC path owns these actions; no HTTP data route or browser calculation is added.

Editing is enabled only after a successful, project-scoped KPI read and when native project configuration is available. The confirmed configure receipt must match the command and project, carry that project's KPI data and advance the revision. Denials, unsupported older shells and connection failures retain previous values and show the editor's save error. Responses arriving after the gallery's instance or project scope changes cannot update the new gallery. Local projects and Settings' local overview editor retain their existing behavior.

Prompts preserve native KPI IDs. New slots receive `kpi-1` through `kpi-3` without collisions. Saving a sentence does not invent a value or bind a recipe: the native Supervisor must resolve its source and recipe under current authority. Missing sources stay `missing_source`.

Presentation rejects snapshots for another project, KPI or prompt revision, snapshots without scoped sources, and invalid calculation times. Failed, resolving and missing-source states never display an attached snapshot. Stale results retain their native stale reason. Native authority owns freshness, source access, computation and receipts.

Web and Electron share the gallery and editor. React Native has separate project navigation and is unchanged. Provider adapters and existing metadata/meeting saves are unaffected.
