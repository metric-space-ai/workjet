# Prompted project KPI presentation

The card and compact editor accept the presentation subset of CTOX #368’s `ProjectKpis` contract. This change adds no wire action and no browser-side calculation. Crew confirmed that #368 currently provides the DTO contract only: native storage, handlers, resolution/refresh and the Workjet guest read/configure bridge remain their follow-up work.

Production callers therefore do not pass `kpis` or `onSaveKpis` yet. The editor explicitly disables prompt editing while that bridge is unavailable. Repository, website, project information and Jour fixe continue through the existing typed `project.configure` receipt path. Metadata-only saves retain the existing overview slots instead of converting suggested placeholders into stored values.

Once Crew and Shell provide the native guest bridge, pass its authorized project-scoped DTO and configure receipt callback to the card/editor. The callback receives up to three nonempty `{ kpi_id, prompt }` entries and the expected native revision. Clearing all sentences produces an empty list. Existing KPI IDs are retained; new slots use `kpi-1` through `kpi-3`. The bridge must implement the canonical native operation ID and revision semantics, not an invented HTTP data route.

The presentation rejects snapshots for another project, another KPI or prompt revision, snapshots without project-scoped sources, and invalid calculation times. Failed, resolving and missing-source states never display an attached snapshot. Stale results retain their native stale reason. Native authority owns freshness, source access, computation and receipts.

Surface coverage: gallery configuration and Settings share the same editor; web and Electron share these components. React Native has separate project navigation and is not changed by this visual slice. Local/remote connections retain the existing metadata control path. Provider adapters are unaffected.
