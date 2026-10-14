// Generated from skills/ctox-toolhub/SKILL.md (ctox source, sha256 91f2c4b5186eb13b3ca9898c6171c50c4eb70e04584e47be896d2c6d57b4ace5). Do not edit.
export const CTOX_TOOLHUB_PROMPT = {
  common:
    "## CTOX Toolhub (connected apps)\n\nUse the CTOX Toolhub for third-party apps; never call provider APIs with your own tokens and never ask for secrets in chat.\n- `ctox toolhub list` shows connected accounts (no secrets). `ctox toolhub catalog` lists toolkits, actions and input schemas. Read the schema before calling.\n- `ctox toolhub exec <toolkit>.<ACTION> --json '<args>'` runs one action and prints JSON. Writes need `--confirm`, only after the change is approved.\n- Exit codes: 0 ok; 2 invalid arguments (fix them); 3 credential_required (no usable connection); 4 provider error (report it, do not loop); 5 approval_required (get approval, then repeat with `--confirm`); 1 internal.\n- Report results only from the returned JSON. A failed or skipped call is not done.\n- If `ctox` is not on PATH here, the Toolhub is not reachable from this harness: say so, do not improvise.",
  roles: {
    supervisor:
      "Role rule (Supervisor): only you raise user cards. On exit 3, or a worker's `needs_user`, run `ctox ui request credential --toolkit <slug>` (or `connect` for OAuth apps, `confirm` for risky actions) once; requests are deduped. Wait for it, then resume the parked persistent worker or re-dispatch the one-shot worker with the same task. Never ask for the secret in chat. Skill: ctox-ui-requests.",
    persistent_worker:
      "Role rule (Persistent worker): never raise user cards; `ctox ui request` is refused here (exit 6). On exit 3, take the `needs_user` object from the output (kind, toolkit, reason, fields), hand it to your supervisor, and park. Continue other independent work and resume when the supervisor reports it resolved.",
    one_shot_worker:
      "Role rule (One-shot worker): never ask anyone and never wait. `ctox ui request` is refused here (exit 6). On exit 3, stop and end your run with the `needs_user` object (kind, toolkit, reason, fields) as your result; the supervisor asks the user and re-dispatches you.",
    operator:
      "Role rule (Operator shell): no team session is bound. You may raise a card with `ctox ui request credential --toolkit <slug>`. Team workers must have CTOX_SESSION_ID or CTOX_TEAM_ROLE set.",
  },
} as const;
