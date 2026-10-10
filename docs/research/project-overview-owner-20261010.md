# Owner project overview — 2026-10-10

The reference is the supervisor's `workjet-project-overview.html` mock.
This change replaces the technical worker dashboard with the project summary,
four evidence-based metrics, pending owner questions, goals, results, history
and collapsed diagnostics. The right column contains the next and previous
Jour fixe, recorded owner decisions and links.

## Sources and missing data

- Project configuration supplies the summary, configured KPI, recurring
  meeting, repository and exit-model assessment.
- Scoped thread projections supply saved worker goals, durable goal statuses,
  pending approvals/questions and recorded conversation events.
- Verified native read receipts supply the Jour fixe to-do list and project
  KPIs. A confirmed to-do list takes precedence over worker goals.
- Existing Git status queries supply evidenced merged PRs. Their current
  contract does not include merge timestamps, so a count since the last Jour
  fixe cannot be asserted from those records.
- A completed turn does not mean a goal or meeting task is complete. Missing
  task completion and KPI comparisons remain explicitly unavailable.
- Native supervisor execution is not inferred from the local thread's saved
  model. Missing native execution facts remain unavailable in diagnostics.
- Goals use a concise sentence; handoff paths and technical parentheticals stay
  in the full saved instructions inside diagnostics.
- Inactive one-shots move to the sidebar archive view without deleting or
  altering their retained history. Pending owner input keeps a one-shot active.

German and English interface text follows the saved Project language setting,
or the system language. Authored titles, questions and goals retain their
original content.

## Visual evidence

The source-matched browser check uses the actual Molecularity project and eight
thread projections exported from a read-only, consistent SQLite snapshot.
There are no invented project values or product-view fixtures.

This is an isolated integration rendering of the production
`ProjectWorkspace` component, with the production CSS and theme. It is not an
installed-app acceptance result. The isolated browser has no native CTOX
authority: live native KPI/Jour fixe reads, join actions and the connected
application sidebar are not covered by these screenshots. Establishing a new
login or modifying the daily app was outside the assignment.

The expected comparison with the mock is the section order, dense rows,
separate disruptions, four explained metrics, right-column order and collapsed
diagnostics. Unavailable values intentionally differ from the example values
in the mock.

Final screenshots and lane results are recorded after the bounded check ends.

## Verification

The complete web suite passed on `51880539fa2170c388e8d227d93b5c761472bde4`:
420 files and 3,849 tests. The same run passed `vp check`, contract settings
tests and the content vocabulary guard. Typecheck found one missing new
language field in the desktop settings test fixture; commit `e54910640`
corrects it.

The final lane repeats the required checks and affected tests on the corrected
source. No merge is authorized before Michael reviews the design.
