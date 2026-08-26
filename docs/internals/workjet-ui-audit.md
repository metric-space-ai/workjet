# Workjet UI audit

`pnpm audit:ui -- --port 9300 --output /tmp/workjet-ui-audit` drives the real Workjet Electron renderer through its loopback-only Chrome DevTools Protocol target. It never selects DevTools or a Business OS guest target.

The audit captures the draft, every Code settings page, Machines, Usage, Pull Requests, the composer menus, Command Palette, Terminal drawer, and right panel at three deterministic desktop viewports. Every capture has a PNG plus a machine-readable geometry record. The generated `audit.md` separates blocking findings from review warnings:

- Blocking: horizontal document overflow, horizontally clipped interactive controls, and renderer console errors.
- Review warnings: repeated accessible action labels, controls below the 24 px review threshold, and truncated visible text. These require visual classification because some repeated list actions and ellipses are intentional.

The runner first closes transient overlays and drawers, then opens the one state named by the capture. This prevents persisted UI state from contaminating baselines. It does not submit forms, send messages, modify settings, or operate Business OS guest targets.

`review-batches.json` partitions the screenshot inventory into immutable review packets of at most four captures. A visual-review agent must receive exactly one packet at a time; packets are never combined, even when the reviewer supports a larger context window.

For the post-fix loop, select a bounded subset without changing the canonical matrix, for example: `pnpm audit:ui -- --port 9300 --output /tmp/workjet-ui-keybindings --states settings-keybindings,settings-diagnostics --viewports compact,narrow`.

## Review workflow

1. Start the current Desktop development build with remote debugging enabled.
2. Run the audit into a new absolute output directory.
3. Triage every blocking finding from `audit.json` and visually inspect all PNGs, not only failing rows.
4. Record intentional warnings in the owning component test; fix accidental truncation, duplication, clipping, focus, or responsive breakage.
5. Re-run the same matrix after the fix. A UI slice is complete only when its focused component tests and the affected audit states are clean.

Business OS uses a second renderer/guest boundary and must be audited in a separate matrix: Workjet-owned instance/sidebar/settings/update chrome first, then each verified shell release and its app/chat dock. The guest target remains read-only and is never selected by the Code audit runner.
