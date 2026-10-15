# Pi role instructions

Pi sessions receive Workjet's compiled managed instructions through the native
`--append-system-prompt` option. The append preserves Pi's default system prompt
and applies to every turn in that process, including in-session model changes.
The compiled MCP session prompt takes precedence over the direct thread-config
fallback.

On native conversation resume, Workjet supplies the current compiled instructions
again. Roles and managed instructions are never inserted into the user's first
message or copied into the imported conversation history. Empty instructions add
no system option; imported history remains ordinary conversation context.

The adapter's child-process regressions cover all three role prompts, two turns,
resume with changed compiled instructions, unchanged user history, direct config
fallback, and empty instructions. The fixture records only the system-append
argument, replacement flag, and session path; it never records credentials or the
process environment.

This is the role-systemprompt correction for the native Pi adapter introduced in
PR #301. It does not add a Pi sandbox, attest a live model response, or establish
installed autonomous goal-loop acceptance. Pi continues to reject approval-required
mode, and the central execution-policy admission guard remains authoritative.
