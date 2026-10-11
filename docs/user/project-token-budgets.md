# Token budgets per project cycle

Set **Token-Budget je Zyklus** in project settings. Enter billions of tokens with one decimal place, for example `2,3` or `2.3`. Leave the field empty for unlimited usage.

The cycle runs from one regular meeting to the next. Projects without a meeting use Monday to Monday in Europe/Berlin. Consumption starts again at each cycle boundary.

The project gallery shows measured consumption even without a limit. With a limit it shows consumption, budget and percentage; the display gains a quiet highlight at 80%. Hover or focus the amount for cycle boundaries, input/cache/output counts, thread roles and missing usage. Unknown data remains visible and makes the measured total a lower bound.

Workjet posts system notices at 50, 80, 90, 95 and 98%, and once above 100%. They do not start a supervisor turn. No limit or notice aborts, blocks or throttles work. The supervisor prioritizes preparation of the next meeting when the remaining budget is tight.

## Current coverage

Project attribution uses the same Codex and Claude transcript records and versioned prices as the usage/cost view. Other harnesses with missing attribution appear as unknown. The gallery combines reports from connected computers; automatic notices currently use the reporting server's measured project usage. Complete server-side federation and native Supervisor context are follow-up work.
