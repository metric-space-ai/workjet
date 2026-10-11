# Instance activity and removal — 2026-10-11

PR: https://github.com/metric-space-ai/workjet/pull/415

Settings previously offered selection and paired-instance unlinking. There was no persisted per-instance activity policy and no local hide/restore path for managed instances.

`CtoxInstancePreferences` stores only public instance descriptors and `enabled` / `disabled` / `removed` in the desktop registry directory. Discovery retains the marker. Activity changes use the cached descriptor instead of running discovery. A stop marker is written before pooled guests are closed. Admission guards cover guest preparation, managed launch, paired/local/SSH resolution and shell-fleet checks. Local and SSH discovery retain the descriptor without network probes while disabled or removed.

The Instances table uses the shared switch, separate Selected label, quiet state/reason text and inline removal confirmation. The local instance has no trash. Managed removal is a local marker; Add instance restores it. Paired removal invokes the existing `removePairedInstance` path and existing session cleanup. Re-importing a pairing or SSH connection restores its activity. No project, thread or worktree deletion is called.

The selected-instance guard is checked in the UI against the live selection and in IPC against its submitted selection snapshot. Activity state is persisted by the desktop; it is not a React-only setting.

Registry overlap with `codex/safe-storage-key-loss-recovery`: the import of preferences, local/SSH probe options, launch-resolution admission checks and final discovery merge are touched. Pairing document formats, encryption, damaged-secret recovery, and `removePairedInstance` are unchanged.

Verification is recorded below after the lane and isolated UI run finish. Installed-product acceptance remains with the supervisor after merge.

Screenshot scope: the production `InstancesTable` and shared settings section, served in an isolated browser profile on gpu3 with synthetic public descriptors and a file-backed callback. Native persistence and connection suppression are tested separately. No installed app data, credentials, keychain or safeStorage helper is used.
