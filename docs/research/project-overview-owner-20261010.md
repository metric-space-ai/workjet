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

- [Before: installed 0.0.76](project-overview-owner-20261010/before-v0.0.76.png).
- [1440 px](project-overview-owner-20261010/overview-1440.png).
- [420 px](project-overview-owner-20261010/overview-420.png).
- [Recorded viewport measurements](project-overview-owner-20261010/screenshots.json).

Visual run `workjet-project-overview-owner-20261010T232846Z` passed on
`ffce9e6ae6fe6f7d7c3e8c5ce9e99d0e70a8cf9c`, whose product code is identical
to the tested product source below. Both widths have four metrics, three real
worker goals, the requested section order and collapsed diagnostics.
Document widths equal viewport widths (1440 and 420), with no horizontal
overflow. At 1440 px the meeting/decision/link cards form the right column; at
420 px they follow the main content. Prompts, technical routes and inactive
test one-shots are absent from the primary content.

The pending Pinball question cannot be loaded without its thread-detail
connection in this isolated browser. Its question body and answer actions are
therefore not visually accepted here. Native reads, the connected sidebar and
actions need installed-app verification; this evidence does not claim them.

All captured browser and Vite process groups stopped at the terminal cleanup.
Temporary entry files and the browser profile were removed. The daily app and
its data were unchanged.

## Verification

The final product source is `a32ccc5731f19afa5239f5eb22e75aadb2d19c02`.
Canonical gpu3 run `workjet-project-overview-owner-20261010T230422Z`
passed every code check with two test workers and two-CPU affinity:

| Command                                                                                             | Result                                                    |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm exec vp check`                                                                                | Passed                                                    |
| `pnpm exec vp run typecheck`                                                                        | Passed across all workspaces                              |
| `pnpm exec vp test run --project unit --maxWorkers=2` in `apps/web`                                 | 420 files, 3,853 tests passed; 21 overview tests included |
| `pnpm exec vp test run src/settings/DesktopClientSettings.test.ts --maxWorkers=2` in `apps/desktop` | 7 tests passed                                            |
| `pnpm exec vp test run src/settings.test.ts --maxWorkers=2` in `packages/contracts`                 | 46 tests passed                                           |
| `pnpm run guard:content`                                                                            | Passed                                                    |

The run's overall exit was 1 because the separately recorded screenshot step
failed: the host-installed Chrome exited with SIGTRAP before opening a page.
The Vite server was ready; all owned process groups were stopped and the
temporary entry files and browser profile were removed. Successful code checks
are retained independently from that infrastructure failure.

A separate bounded visual run uses the browser matched to the existing
Playwright dependency. It does not repeat the successful code checks.
No merge is authorized before Michael reviews the design.
