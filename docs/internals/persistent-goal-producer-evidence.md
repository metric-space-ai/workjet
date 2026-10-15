# Persistent goal producer evidence

These optional fields live in WorkjetThreadConfig v2 goal and survive the orchestration journal and projection rebuild. Older snapshots remain readable. They describe observed execution, not authority, project admission or proof of completion.

## Actual producers

- `lastExecution`: ProviderRuntimeIngestion consumes canonical events from the registered provider, requires the current provider instance and current turn, and journals the emitting driver, instance, turn ID, terminal/running state, source event ID, source and observation time.
- `lastExecution.author`: nullable model evidence for the last observed turn. ClaudeAdapter emits a bounded metadata event from the SDK's own assistant message model field, only for a persistent Parent and never from a subagent message. A configured/requested model is not an author witness. Other harnesses remain null until they expose equivalent response evidence.
- `executor`: PersistentGoalReactor records its implementation ID, actual current instance and whether the native goal get/set protocol succeeded or Workjet emulation is used. Driver names alone do not establish native support.
- `lastVerifiedProgress`: nullable verifier receipt reference. This change installs no verification writer. New goals explicitly use null. A completed turn, goal status, kanban card, summary or updatedAt timestamp never populates it.

The author field does not identify who assigned the goal, the Owner or the Supervisor. That assignment identity is not supplied by the existing goal command and must not be inferred from parentThreadId. The UI should show it as the observed response model, and show missing authorship or verification as unknown.

## Admission of observations

`thread.goal.execution-observed` and `thread.goal.executor-observed` are internal orchestration commands, absent from ClientOrchestrationCommand. The decider requires an unarchived persistent Parent with an existing goal and its current provider session. Execution observations must match the current turn and driver. Executor observations are fenced by the goal revision. A late assistant model snapshot may enrich the same completed turn but cannot restart it. New turns do not inherit a previous model witness.

Client thread creation strips producer and verification fields. Configuration updates retain the existing journalled goal instead of accepting client evidence. Goal controls and kanban updates do not manufacture verifier receipts.

Observation updates preserve goal status and revision. The evidence timestamp records the producer event or reactor observation only; it is not a proof timestamp. No host-secret material, account tokens or provider output bodies are stored in these fields.

## Verification

Focused tests exercise actual adapter emission, subagent exclusion and duplicate snapshots, reactor native/emulated observations, persisted command decisions, stale/foreign identities, client spoof rejection and unknown verification. Provider fixtures test the contract; they do not prove real model execution or installed acceptance.

Main owns the UI and installed-product acceptance. This change claims neither installed G2/E acceptance nor an enforced autonomous-worktree sandbox.
