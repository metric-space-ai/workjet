# Workjet Collective

## Architecture

Workjet Collective is the provider-neutral coordination layer for Codex,
Claude Code, Cursor, Grok, and OpenCode workers. A worker address consists of
the Workjet mesh workspace, environment, and thread. Harness-native session IDs
are local implementation details and never cross the Collective boundary.

```text
Codex / Claude / Cursor / Grok / OpenCode
                 |
       Workjet managed prompt + MCP
                 |
     durable mailbox and delegations
                 |
       CTOX Sync store-and-forward
                 |
       dedicated Manager thread
                 |
   CTOX Decision Hub + Secret Store policy
```

Workjet remains the thread and mailbox authority. CTOX Sync is the only
cross-machine transport. It carries sealed mailbox envelopes, acknowledgements,
delegation state, and prompt snapshots; it does not replicate provider-native
thread databases. CTOX remains authoritative for owner decisions, access
policy, and secret storage.

## Thread references

The canonical shareable reference is:

```text
workjet://app/threads/<environment-id>/<thread-id>
```

Desktop navigation normalizes this external path to Workjet's internal thread
route. Agents resolve the same reference with `workjet_resolve_thread`. A link
is a stable pointer and routing address, not an exported transcript or an
authorization token.

## Harness coverage

Every Workjet thread receives the immutable Collective baseline before global
and thread-specific managed instructions. Codex, Claude Code, and Grok use the
existing managed-prompt path. Cursor and OpenCode persist a managed-prompt
fingerprint in their resume cursor and inject the current prompt exactly once
per effective revision. Changing the managed prompt causes one new injection;
resuming an unchanged session does not duplicate it.

The full, versioned skill is exposed to every standard, orchestrator, and
worker role through `workjet_collective_guide`. Tool visibility and server-side
authorization do not depend on the harness.

## Manager

`managerThreadReference` designates exactly one thread as the Workjet Manager.
When that thread runs, Workjet appends manager-specific authority and safety
instructions. Other workers cannot choose a manager destination:
`workjet_contact_manager` resolves only the configured reference.

A manager contact is a durable delegation, not a plain notification. Local
delivery wakes the delegation executor immediately; remote delivery is queued
and acknowledged through CTOX Sync. The manager handles bugs, access requests,
secret-handle operations, bulletins, and blockers. It uses the thread's bound
CTOX Decision Hub capability for policy-gated decisions and replies through the
delegation channel.

The manager is not a superuser. Workjet rejects common plaintext credential
shapes at the tool boundary, and the skill forbids requesting or returning
secret values. CTOX policy and the CTOX Secret Store remain authoritative.

## Work blocks

Workers call `workjet_record_work_block` when continuous work stops, changes
topic, is handed off, or completes. The worker authors the topic, work,
outcome, open points, and references. Workjet supplies timestamps and duration
and appends a durable `workjet-work-block` thread activity.

Blocks represent continuous work rather than fixed intervals. Five and a half
hours on one topic is one block. A hard stop leaves the missing block visible
as incomplete; another model must not invent its content. The Collective home
reads the latest durable block for recent threads and labels active work that
has not produced a block yet.

## Operational invariants

- Cross-machine inline message bodies are forbidden; remote envelopes use the
  existing sealed payload path.
- A queued receipt proves durable acceptance, not completion.
- Thread links never convey credentials or authorization.
- Manager requests use a fixed configured target and do not widen normal
  worker mailbox permissions.
- Secret values never enter prompts, work blocks, bulletins, or receipts.
- Work completion never depends on a final summarization call succeeding.
