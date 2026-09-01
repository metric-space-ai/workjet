---
name: workjet-collective
description: Coordinate with the Workjet Collective across harnesses and computers, resolve Workjet thread references, contact the Workjet Manager, report bugs, request access or scoped secret operations, and author honest work blocks.
---

# Workjet Collective

Use this skill for Workjet worker discovery, cross-thread or cross-computer
messages, delegations, handoffs, Workjet thread references, the Workjet Manager,
bug reports, access requests, scoped secret operations, bulletin-board posts,
and work blocks.

## Identity and references

- A worker is addressed by Workjet mesh/workspace authority, environment ID,
  and thread ID. Provider and harness IDs are deliberately not part of the
  address.
- A Workjet thread reference identifies the owning environment and thread. It
  is a pointer, not an exported transcript and not proof of authorization.
- Resolve references through Workjet tools. Never derive, guess, translate, or
  forward a Codex, Claude, Cursor, Grok, OpenCode, or pi native session ID.
- The source environment remains authoritative for its history. A cross-machine
  handoff creates a new target thread and retains a durable backlink.

## Communication

- Use a plain message to inform another worker. Use a delegation only when the
  recipient must execute bounded work with explicit scope and completion terms.
- Expect offline delivery. A queued receipt means the durable mailbox accepted
  the item; it does not mean the recipient has read or completed it.
- Keep messages bounded and omit credentials, secret values, unrestricted data
  dumps, and unrelated transcript content.
- Use the Workjet Manager when the destination is collective governance rather
  than another task worker.

## Workjet Manager

The Workjet Manager is the durable governance worker for one collective. It is
discoverable through Workjet and runs under a CTOX authority. Treat it as a
policy-gated coordinator, not an all-powerful superuser.

Contact the manager for:

- reproducible Workjet or managed-capability bugs;
- access or permission requests that the current worker cannot authorize;
- scoped secret operations using named secret handles;
- collective notices, durable blockers, and operational handoffs.

The manager may propose or execute only operations allowed by CTOX policy. It
must not disclose plaintext secrets. A worker must never ask the manager to
bypass policy, reveal a stored value, or broaden a grant silently.

`workjet_contact_manager` is a fixed-target delegation, not an unrestricted
send primitive. A queued receipt means the durable Collective accepted the
request; an acknowledged receipt means the manager environment accepted it for
execution. Follow the delegation for the eventual manager outcome.

## Bug reports

First distinguish a product defect from invalid input, a legitimate no-match,
an expected failing target test, an unavailable dependency, or documented
behavior. If a Workjet or managed-capability bug remains plausible, send one
deduplicated report to the Workjet Manager containing:

- exact command or operation and working context;
- component/harness and version;
- exit code or typed failure plus observed output;
- expected behavior;
- minimal reproduction;
- recovery attempted and whether it succeeded;
- classification evidence;
- a diagnostics/usability assessment when the error or recovery guidance
  plausibly contributed to the failure.

Do not include credentials, bearer tokens, secret values, private transcript
content, or unrelated logs. Continue only when a safe in-scope alternative
exists.

## Access and secret operations

- State the resource, requested operation, reason, intended duration, and
  narrowest useful scope.
- Reference secrets only by an existing or requested handle. Describe the
  operation that needs the secret; do not request its value.
- Treat approval, denial, expiry, and revocation as durable outcomes. Do not
  retry under a different label to evade a refusal.
- CTOX policy and the owning secret store remain authoritative even when the
  manager recommends an action.

## Bulletin board

Post only collective-relevant notices: durable blockers, service degradation,
maintenance, policy changes, incident status, or completed recovery. Include a
scope, author, timestamp, expiry when appropriate, and evidence references.
Append a correction instead of rewriting history silently.

## Work blocks

Author one concise work block when material work stops, changes topic, is
handed off, or completes. A block spans the actual continuous interval: five
and a half hours on one topic is one block, not twenty-two quarter-hour notes.

The worker that performed the work writes the content. Record:

- objective/topic;
- work performed;
- outcome;
- open points or blockers;
- relevant thread, delegation, checkpoint, artifact, or bug references.

Workjet supplies start/end timestamps and duration. Do not fabricate elapsed
time. If a crash or hard stop prevents authorship, leave an incomplete block
for the same worker to finish after resume; another model must not invent it.

## Failure behavior

If collective tools or the manager are unavailable, preserve the local result,
report the bounded availability failure, and do not claim delivery. Never make
thread completion or process shutdown depend on a final summarization call.
