# Worker run ledger

Workjet records commissioned workers before dispatch in its existing SQLite store.
The record separates selected configuration from harness-observed execution. Missing
execution facts stay null. Runtime output, verified remote acknowledgements and the
existing native PR receipts fill the first milestones without reopening terminal runs.
The result commit is the first verified worker delivery; the PR head can separately
show a later parent repair.

## CLI

The TypeScript CLI uses the current orchestrator's provider-scoped MCP bearer
(`WORKJET_MCP_BEARER_TOKEN`) and its Workjet MCP endpoint. It does not open Desktop
credential files or borrow an Owner session. The older standalone Swift CLI is not
modified by this implementation.

```sh
workjet workers list --url "$WORKJET_ENDPOINT" --json
workjet health --probe-workers --url "$WORKJET_ENDPOINT" --json
workjet run --pool worker --task-type backend --difficulty standard \
  --brief-file task.txt --url "$WORKJET_ENDPOINT" --json
workjet run "Worker name" --brief-file task.txt --url "$WORKJET_ENDPOINT" --json
workjet ledger list --json
workjet ledger show RUN --json
workjet runs mark RUN integrated --score 8 --rework small --cause model \
  --note "The first delivery needed a small correction."
```

A pending remote acknowledgement exposes the saved request ID. Reconcile it with
`--remote-request-id`; do not commission a replacement worker. Protocol sessions
created by a CLI command are closed independently of the parent harness session.

## Qualification and selection

`workers list`, `health` and pool dispatch share one qualification function. A saved
worker profile supplies the configured home harness and account route, not model-list
or reachability evidence. Qualification also requires an enabled account, a fresh
authenticated account model list, usable account health, a fresh successful model
check and an available installed native harness. GPT's configured provider uses Codex;
Claude's uses Claude Code. Other providers retain their registered native harness.
Missing drivers never acquire a Codex proxy route.

The current producer verifies local harnesses through the existing provider registry.
It has no live remote-harness health observation, so remote profiles remain ineligible
for random selection. Explicit remote dispatch retains its existing native admission
path and its source and target ledger records. Explicit local dispatch of a named
profile is not gated by this qualification either: it keeps the caller's or the parent's
model selection and only adds its ledger record. Native-account-only routes likewise
need their authoritative model/health export before they can enter this gateway-backed
pool; neither configuration nor a historical successful run substitutes for that proof.

The lottery is uniform over unique provider/model identities. Duplicate accounts or
profiles do not increase a model's probability. The receipt stores the candidates,
probabilities, random value, snapshot hash and date before worker creation. A repeated
brief SHA-256 returns the original draw even after restart or quota failure. An
unavailable original selection fails without redrawing. Named workers are manual and
excluded from comparative sampling. The strategy boundary leaves room for later
Thompson sampling; it is not enabled in this step.

Abortion classes use typed runtime/gateway classes only. An unclassified provider
failure remains `task`; messages do not produce guessed authentication or quota facts.
Pending acknowledgements and failed rollback do not prove a stopped worker.

## Assessment and next step

The first assessment is immutable. `--final` adds a separate final assessment. Quota
is unassessed and cannot receive a numeric capability score. A missing assessment
produces a warning while preserving legacy disposition marking.

- [ ] Step 2: correlate authenticated worker-proxy requests and gateway token receipts
      with `run_id` and request identity. The proxy must overwrite caller attribution;
      never join usage by time or model name. No token or cost attribution is implemented
      in this step.
