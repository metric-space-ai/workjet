# Harness probes

Research fixtures for the installed Mac CLIs, not a production harness adapter or product-acceptance suite. Read the [compendium](../../docs/research/harness-compendium-20261009.md) and its limits before interpreting a receipt. The scripts own their child PIDs, use bounded deadlines, and save both success and failure. Many discovery scripts return zero after recording a rejected capability: **read the JSON result**, not only the process exit code. `verify_exchange.py` instead fails unless the actual native tool envelopes match in both directions.

Run sequentially. These inference/CLI probes do not install packages or need a compiler. Use the shared admission gate for any later dependency installation, build or broad suite. Keep disposable profiles under the tmp volume. Set `TMPDIR` for Greppy's raw logs and `PYTHONPYCACHEPREFIX` for Python caches; do not use the live Workjet home as a test profile.

```sh
export TMPDIR=/Volumes/tmp/dev-artifacts/workjet/harness-compendium/tmp
export PYTHONPYCACHEPREFIX=/Volumes/tmp/dev-artifacts/workjet/harness-compendium/pycache
mkdir -p "$TMPDIR"
# From this checkout; substitute your own installed paths where necessary.
greppy bash-smart -- python3 scripts/harness-probes/codex_probe.py \
  --binary /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  --cwd /Volumes/tmp/dev-artifacts/workjet/harness-compendium/codex-probe \
  --out docs/research/harness-probe-evidence-20261009/codex-probe.json
```

| Script | Purpose / required inputs |
|---|---|
| `capture.py` | Bounded version/help command; `--name`, `--out` directory, `--cwd`, then `-- COMMAND`. Owned-PID timeout cleanup. |
| `codex_probe.py` | Paused native goal, developer/project conflict, dynamic echo, Responses-item import, native compact completion and export. |
| `codex_goal_probe.py` | One active tiny objective, native complete-state check, clear and archive. Uses the existing account; no token budget added. |
| `claude_probe.py` | Stream-JSON SDK discovery/control, role/MCP attempt, compact and local goal commands. Login failures remain failures. Optional gateway key helper is invoked privately, not printed. |
| `acp_probe.py` | ACP discovery/resume plus deliberately rejected guessed extensions; `--prompt` optionally performs one tiny model turn. A -32601 is not evidence that a differently named native feature is absent. |
| `acp_tools_probe.py` | `--harness opencode` proves agent mode and MCP echo. The legacy Grok root-flag route is retained as a negative probe; use `grok_prompt_probe.py` for correct metadata. |
| `grok_goal_probe.py` | Native `/goal` status/create/status/clear; assistant text alone is not completion. |
| `grok_prompt_probe.py` | ACP `_meta.rules` and `_meta.systemPromptOverride` against project conflict. No global prompt edits. |
| `grok_history_probe.py` | Readable foreign context, native slash compact/no-op event, recall and Markdown export of the owned session. |
| `opencode_history_probe.py` | Two live-listed models, same-session config switch, native compact/recall, own JSON export/import. Requires `--catalog` and a private `--key-helper`. |
| `greppy_probe.py` | Authenticated local gateway, native foreign-history ACK/replay, distinct same-session model change, actual MCP rejection. Requires `--catalog`, `--key-helper`; no secret enters ACP. |
| `pi_probe.py` + `pi-extension.ts` | Native role hook, unprefixed echo, basic RPC discovery and HTML export. Uses existing auth; current-model setter is a no-op but Pi may persist its default. |
| `pi_history_probe.py` | Fresh disposable `PI_CODING_AGENT_DIR`, converted v3 JSONL, native compact/recall, distinct live-listed Z.ai model, HTML export. Requires existing `ZAI_API_KEY`; never prints it. |
| `live_catalog.py` | Authenticated `GET /models`, metadata/IDs only. Credential from named environment variable or private helper, never stdout/argv. |
| `workjet_mailbox_probe.py` | Fresh installed-server profile, two persisted threads, production RPC sends, then native Pi ↔ OpenCode tools. Requires existing Z.ai auth and local gateway helper. |
| `mailbox_exchange.py`, `mcp_mailbox.py`, `pi-mailbox-extension.ts` | Session-bound native/MCP tool facades used by that probe. |
| `mailbox_tools.py`, `mailbox_tools_cli.py`, `workjet_bridge.mjs` | Send through real mailbox RPC; probe-only read-only inbox facade. Source and two permitted targets come from a private scratch config. **Not a production read API or authorization implementation.** |
| `verify_exchange.py` | Match Pi send ↔ OpenCode read and OpenCode send ↔ Pi read by envelope ID/body/source/target. |
| `publish_evidence.py` | Secret/model-menu redaction, reasoning omission and stream aggregation before Git publication. Uses the measured observed catalog; does not assert the catalog is perpetually fresh. |

Refresh the observed CTOX catalog with the required `User-Agent: Workjet-Model-Catalog` and `Accept: application/json` headers. Only rows with `status: observed` can supply suggestions. A catalog receipt has an expiry; refresh before running a later probe. Intersect its IDs with authenticated holding-account `/models` results; do not substitute static harness menus. Probe scripts inherit credentials privately and do not log authentication requests. Provider-qualified OpenCode routing values are built only from those observed IDs.

Reproduce the cross-harness probe using the already installed server, without building or launching the real desktop profile:

```sh
greppy bash-smart -- python3 scripts/harness-probes/workjet_mailbox_probe.py \
  --server /Users/michaelwelsch/.workjet/runtime/versions/0.0.70/node_modules/workjet/dist/bin.mjs \
  --base-dir /Volumes/tmp/dev-artifacts/workjet/harness-compendium/workjet-mailbox \
  --out docs/research/harness-probe-evidence-20261009/workjet-mailbox-native.json \
  --catalog docs/research/harness-probe-evidence-20261009/live-catalog.json \
  --key-helper /Users/michaelwelsch/.codex/bin/cli-proxy-token.py

greppy bash-smart -- python3 scripts/harness-probes/verify_exchange.py \
  --receipt docs/research/harness-probe-evidence-20261009/workjet-mailbox-native.json \
  --out docs/research/harness-probe-evidence-20261009/cross-harness-summary.json

greppy bash-smart -- python3 scripts/harness-probes/publish_evidence.py \
  docs/research/harness-probe-evidence-20261009
```

The mailbox launcher uses a unique base directory on every run, mode-0600 bootstrap/config files, an ephemeral loopback port and `--no-browser`. It creates only test records in that profile, never updates the installed application, and terminates its captured server PID in `finally`. Pi's executor profile is disposable. OpenCode custom provider settings are process-local environment data. The native sessions are externally attached to the two Workjet identities by the facade; this is transport/injection proof, not installed adapter acceptance. Remove private scratch profiles after the receipt is sanitized and preserved.

Pi's `set_model` writes the profile's default as well as changing the session. Never run a distinct-model Pi probe against the owner's global profile; use `pi_history_probe.py`'s isolation. A small session's `Nothing to compact` or Grok's unchanged-token compact event is a no-op, not proof of a successful reduction. Wait for Pi's final `agent_end` without `willRetry`, Codex's `contextCompaction` completion, and each ACP prompt/summary event rather than sleeping for business-flow completion.
