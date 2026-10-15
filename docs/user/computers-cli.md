# Discover computers from the command line

Inside an authenticated remote worker, run `workjet computers list --json`. Workjet supplies the worker's ephemeral source channel. Discovery reads the source computer registry and shared Luma profiles through the worker's current admission; it does not require an Owner token.

Outside a worker, run `workjet computers list --url https://your-workjet-server --json` with an existing authenticated access token in `WORKJET_ACCESS_TOKEN`. The session needs orchestration read permission. The selected URL determines which server registry is read.

The response contains registered computer IDs, labels, Workjet environment IDs, connection presentation types, configured harness availability and associated worker profile IDs, names, harnesses, roles and capabilities. Omit `--json` for tab-separated output. Credentials, executable paths, profile instructions and model configuration are excluded.

This is saved configuration, not an online probe or a guarantee that a build can run. Computer and environment IDs are Workjet identities, not CTOX instance IDs. Empty registries return an empty computer list; unavailable servers and rejected credentials fail the command.

Worker access uses the injected `WORKJET_WORKER_SOURCE_URL` and `WORKJET_WORKER_SOURCE_KEY`. It takes precedence over ordinary server access and accepts only the loopback worker harness. Missing or revoked worker access fails the command without falling back to an Owner session. Native configuration read failures also fail discovery. Tokens are never printed.
