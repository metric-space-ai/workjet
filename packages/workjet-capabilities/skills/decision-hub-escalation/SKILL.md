---
name: decision-hub-escalation
description: Escalate a genuinely blocking owner decision through Workjet's policy-gated Decision Hub tool and wait for its durable resolution.
---

# Decision Hub Escalation

Use `decision_hub_escalate` only when progress is genuinely blocked on a choice
that the owner must make. Do not escalate ordinary implementation judgment,
questions answerable from available evidence, or choices the agent is already
authorized to make.

Before escalating:

- summarize only the evidence needed to decide;
- provide two to eight stable options with concise labels and consequences;
- identify a recommendation when the evidence supports one;
- state the impact of delay and choose `normal`, `high`, or `critical` urgency;
- derive a stable `decisionKey` from the blocking decision, not the current retry;
- omit credentials, secrets, personal data, and unnecessary code or log dumps.

After `decision_hub_escalate` succeeds, end the turn as waiting. Do not continue
by guessing the answer, and do not submit the same decision under a new key.
Workjet will resume the thread once with the durable resolution.

Child workers never call this tool. They report the blocker, evidence, options,
and recommendation through their parent/mailbox channel. The root orchestrator
decides whether to resolve it or escalate it to Decision Hub.
