# Project exit assessments

Every native project has an additional five-year exit measure in its gallery
card and project overview. The existing three prompted KPI slots remain
independent. The gallery opens the assessment directly, including for projects
whose chat history has not been imported.

This integration targets the shared web renderer and Electron project overview.
The separate React Native project route currently goes directly to its supervisor
chat and has no equivalent overview card. It does not gain a valuation screen in
this change; the native authority and shared wire contracts remain reusable there.

## Meaning and authority

E5 is the expected nominal EUR sale proceeds for 100% equity at 60 calendar
months from the recorded assessment date, before transaction fees and personal
taxes. It sums each state's probability × probability of sale × equity price.
Unsold and failed outcomes contribute zero proceeds. Sale probability and price
conditional on sale are separate measures; neither is presented as E5.

The native CTOX engine calculates and persists the result. Workjet displays it
through the existing authenticated project-control port. It never calculates a
valuation from browser KPI text or stores a second valuation in local project
metadata. Native project-list configuration includes additive `exitModel`
metadata; older guests and projects without it still render normally.

The shared Effect schema validates calendar horizons, finite nonnegative amounts,
normalized scenarios, expected-proceeds arithmetic, ordered quantiles and status.
Native assessment project IDs must match metadata and command receipts. Desktop
also checks the command ID and action before forwarding the receipt. The open
panel rejects a response after the selected instance or its selection revision
changes, and after a project change or unmount.

## Controls

- `project.exit_model.read`: `{commandId, projectId}`.
- `project.exit_model.refresh`: `{commandId, projectId, asOf?, resources?}`.
- Resources: `{hoursPerWeek, monthlyBudgetEur, comparisonMode}`. Comparison is
  `equal_resources` or `project_specific`; resources are a proposal, not an
  implicit operating plan.

Native handlers use `ctox.workjet.exit_model.read`, `.refresh` and `.submit`.
The guest maps proposal fields to snake_case. Policy and canonical project-owner
checks remain native. Business records travel over CTOX Sync/RxDB/WebRTC.

Refresh uses an idempotent command ID retained after an uncertain failure. A
successful refresh invalidates the gallery registry. Only the currently open
panel observes research: serial reads every five seconds for at most two minutes.
Closing or changing the panel stops observation. No recurring schedule is created.

## Display states

`not_started`, `researching`, `blocked`, `provisional`, `ready` and `failed` are
explicit. Missing material evidence does not become a zero or an average. Failed
or incomplete current runs have no Euro result. Earlier results appear only in
the dated history. Expired evidence or a due refresh labels a retained calculation
as out of date without rewriting its original date or horizon.

The report exposes scenario contributions, P10/P50/P90, sale probability,
conditional price, zero-proceeds probability, the resource proposal and confirmed
plan, assumptions, evidence references, operating EV, cash and funding. The native
v1 has a SaaS reference adapter and a sourced terminal-equity grid. Unsupported
game/IP operating models remain explicit gaps. Computed results remain provisional
because v1 has no independent evidence or calibration review adapter. Evidence
references are pointers, not proof that their contents have been independently
verified.

PR #204's guarded percentage change is integrated into the summary and report.
It uses the nearest earlier calculated history entry (authority order is newest
first), excludes the current run, and requires a positive baseline and a dated
current result. It is labelled a previous calculated assessment: v1 history has
no regular-Jour-fixe marker. This does not claim the automatic closing integration
proposed in the earlier adaptation concept.

## Verification and delivery

Run `scripts/verify-project-exit-model.sh` with the pinned Node/pnpm toolchain on
the shared admitted Linux lane. It covers the changed contracts, focused web
presentation/routing tests, existing overview and project-control tests, and
contracts/web/desktop type checks. Test values are synthetic and never seed real
projects. Native verification and deployment are separate CTOX delivery steps.

Installed acceptance should exercise gallery → assessment, missing evidence,
resource proposal → bounded research, dated results/history, reconnect and instance
switching in an isolated profile. Source tests alone do not establish installed
product acceptance. Production updates use the existing native and Workjet release
writers.
