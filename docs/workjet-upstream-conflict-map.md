# Workjet ↔ upstream T3 conflict map

Recovery document for upstream maintenance. Everything below was measured, not
estimated. Re-measure before acting if `upstream/main` has moved.

- Measured: 2026-08-20
- Workjet tip: `2e6e817fa` (`codex/workjet-native-foundation`, also
  `agent/up-upstream-reconnect`)
- Public T3 baseline: `6ae44b418` (= `origin/main` of the fork)
- Sanitized Workjet baseline: `39d3a27d3`
- `upstream/main`: `beab6886f` (`fix(web): import dependency-heavy Open VSX themes (#7642)`)
- Reconnect proof branch: `scratch/ancestry-probe` = `98cd9ef0f`
- Evidence logs: `/Volumes/tmp/workjet/logs/up-reconnect-*.log`

## 1. Baseline identity and ancestry (verified)

| Fact                       | Command                                           | Result                                          |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Trees identical            | `git rev-parse 39d3a27d3^{tree} 6ae44b418^{tree}` | both `7a67bc947abca4ef3af6becd996fb4b29c036489` |
| Content identical          | `git diff 39d3a27d3 6ae44b418`                    | empty, rc 0                                     |
| No ancestry                | `git merge-base 39d3a27d3 6ae44b418`              | no output, rc 1                                 |
| Both histories same length | `git rev-list --count <sha>`                      | 2516 each                                       |
| Disjoint roots             | `git rev-list --max-parents=0 <sha>`              | `eccf5145b` vs `f194c9661`                      |
| Same commit metadata       | `git log -1 --format=…`                           | identical author, dates, subject                |

The sanitized side is a full 2516-commit parallel rewrite of T3 history with
identical trees and identical author/committer metadata, not a truncated import.
Only the object ids differ.

### Correction to the plan text

- The stack is **485 commits**, not 225 (`git rev-list --count 39d3a27d3..HEAD`).
  348 of those are first-parent; the remaining 137 arrive through 7 merges, three
  of which import foreign repositories wholesale:
  `aeb31abab` Web Stack (130), `4faa03874` PDF parser (5),
  `3ac7b90e3` provider gateway (2).
- `upstream/main` is **`beab6886f`**, not `d484735c6`. `d484735c6` is still an
  ancestor; upstream advanced 62 commits past it and 172 commits past `6ae44b418`.

## 2. Reconnect technique

Three options were executed and measured. The number that matters is what the
GitHub PR "Commits" tab would list for a PR against `origin/main` (`6ae44b418`).
Today that number is **3001**.

| Option                                                                                              | Ancestry established | Tip tree preserved     | Commits a PR lists                  | Verdict                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A. `git replace --graft` on the first Workjet commit                                                | locally only         | yes                    | 485 locally, **3001 on the server** | **rejected** — replace refs are a local object-store overlay; `git --no-replace-objects` already sees 3001, and GitHub never honours them |
| B. synthetic `-s ours`-shaped merge at the tip (`git commit-tree HEAD^{tree} -p HEAD -p 6ae44b418`) | yes, real            | yes (`git diff` empty) | **3002**                            | rejected — establishes ancestry but leaves the whole sanitized history in the PR                                                          |
| C. **graft-bake / re-parent replay** of the 485 commits onto `6ae44b418`                            | yes, real            | yes (`git diff` empty) | **485**                             | **chosen**                                                                                                                                |

### The chosen technique, exactly

`39d3a27d3` and `6ae44b418` are tree-identical, so the stack can be re-parented
without touching a single tree. Walk `git rev-list --topo-order --reverse
39d3a27d3..<tip>`, and for each commit call `git commit-tree` with the _original_
tree and the mapped parents (`39d3a27d3` → `6ae44b418`, every other in-range
parent → its image), preserving author, committer, both dates, and the message
verbatim. Only parent links, and therefore ids, change.

`git rebase --onto 6ae44b418 39d3a27d3 <tip>` is the human-facing equivalent and
would also apply cleanly, but it is the worse tool here: without
`--rebase-merges` it flattens the 7 merges and tries to replay the 137 imported
foreign-history commits as standalone patches; with `--rebase-merges` it still
re-applies patches rather than reusing trees, so tip-tree identity becomes an
outcome to hope for instead of an invariant. The replay guarantees it.

The exact script that produced `scratch/ancestry-probe`. Note `git log -1
--format=%P` for the parents — see the root-commit trap in section 5.

```bash
#!/bin/bash
set -euo pipefail
OLD_BASE=$(git rev-parse 39d3a27d3)
NEW_BASE=$(git rev-parse 6ae44b418)
TIP=$(git rev-parse HEAD)
MAPFILE=$(mktemp)
echo "$OLD_BASE $NEW_BASE" > "$MAPFILE"

lookup() {
  local v
  v=$(grep -m1 "^$1 " "$MAPFILE" | cut -d' ' -f2 || true)
  [ -n "$v" ] && echo "$v" || echo "$1"
}

while read -r sha; do
  args=()
  for p in $(git log -1 --format=%P "$sha"); do args+=(-p "$(lookup "$p")"); done
  new=$(
    GIT_AUTHOR_NAME=$(git log -1 --format=%an "$sha") \
    GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$sha") \
    GIT_AUTHOR_DATE=$(git log -1 --format=%aD "$sha") \
    GIT_COMMITTER_NAME=$(git log -1 --format=%cn "$sha") \
    GIT_COMMITTER_EMAIL=$(git log -1 --format=%ce "$sha") \
    GIT_COMMITTER_DATE=$(git log -1 --format=%cD "$sha") \
    git commit-tree "$sha^{tree}" "${args[@]}" -F <(git log -1 --format=%B "$sha")
  )
  echo "$sha $new" >> "$MAPFILE"
done < <(git rev-list --topo-order --reverse "$OLD_BASE..$TIP")

git branch -f scratch/ancestry-probe "$(lookup "$TIP")"
```

### Verification of `scratch/ancestry-probe` (`98cd9ef0f`)

```
git diff --exit-code HEAD scratch/ancestry-probe            → rc 0 (empty)
git rev-parse scratch/ancestry-probe^{tree} HEAD^{tree}     → both 22470086e09f649fdaca764487409e4fd51cff70
git merge-base --is-ancestor 6ae44b418 scratch/…            → rc 0   (ancestry exists)
git merge-base --is-ancestor 6ae44b418 HEAD                 → rc 1   (control: none today)
git merge-base --is-ancestor 39d3a27d3 scratch/…            → rc 1   (sanitized history detached)
git rev-list --count origin/main..scratch/…                 → 485    (predicted 485)
git rev-list --count --first-parent origin/main..scratch/…  → 348    (predicted 348)
git rev-list --count --merges origin/main..scratch/…        → 7      (predicted 7)
git rev-list --max-parents=0 scratch/…                      → 4 roots (T3 root + 3 imported repos)
```

A PR from the reconnected branch to `origin/main` would therefore show 485
commits and a diff of exactly the Workjet changes, against a base that is a
genuine T3 commit on `upstream/main`'s first-parent line.

**Caveat to accept before executing on the real branch:** the 485 commit ids all
change. Nothing else does. Do it once, announce it, and re-point every agent
branch in the same pass.

**`git replace` hygiene:** the option-A probe created replace ref
`33993e00d0518a8cb7afb5267c7e91a67c37332e` and deleted it in the same run
(`git replace -d`, rc 0; `git replace -l` empty afterwards; the ancestry check
returned to rc 1). No replace ref remains in the repository.

## 3. Conflict map — `scratch/ancestry-probe` × `upstream/main` (`beab6886f`)

Once ancestry exists, `git merge upstream/main` is a normal three-way merge with
merge-base `6ae44b418` and 172 upstream commits to absorb. Result:

- **25 conflicted files, 43 conflict hunks, 1 modify/delete.**
- Independently reproduced by `git merge-tree --write-tree --name-only`
  (same 25 paths, result tree `478af7a88`).
- **Zero conflicts on Workjet-added files.** All 25 are files that existed in
  `6ae44b418` and that both sides edited. The additive-file strategy is holding.

`WJc`/`UPc` = number of commits touching the file since `6ae44b418` on the
Workjet side / the upstream side. High on both = a durable hot spot.

### 3a. Structural — Workjet owns the behaviour; expect these to recur every cycle

| File                                                       | Hunks         | WJc | UPc | Collision                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------- | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`   | 5             | 1   | 3   | Workjet threads `compiledManagedPrompt` through the same option records upstream keeps extending (`browserToolsAvailable`). Recurring _by construction_: every new upstream turn-option collides.                                |
| `apps/desktop/scripts/electron-launcher.mjs`               | 4             | 2   | 1   | Workjet added `ctox-desktop`/`ctox-desktop-dev` schemes and pinned `DEVELOPMENT_MAC_ICON_PATH`; upstream parameterized the same call sites to `sourceIconPath`.                                                                  |
| `scripts/build-desktop-artifact.ts`                        | 4             | 7   | 2   | Business OS shell `extraResources`, provider-gateway host artifacts and the capability-parity gate sit inside the same functions upstream reworks (`linuxServerBackend`, asar unpack).                                           |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`        | 3             | 4   | 4   | Workjet added product-mode routing (`/usage`, `/machines`) and footer back-navigation; upstream refactored the same component.                                                                                                   |
| `apps/server/src/provider/Layers/ProviderService.ts`       | 2             | 2   | 1   | Workjet capability context and MCP session preparation injected into functions upstream reworks.                                                                                                                                 |
| `scripts/build-desktop-artifact.test.ts`                   | 2             | 7   | 2   | follows the packaging script.                                                                                                                                                                                                    |
| `apps/desktop/src/app/DesktopEnvironment.ts`               | 1             | 3   | 2   | Workjet adds `developmentDockIconPath` → `assets/ctox/…`; upstream removed the field.                                                                                                                                            |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts`          | 1             | 3   | 2   | CTOX identity expectations.                                                                                                                                                                                                      |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`            | 1             | 1   | 2   | CTOX identity expectations.                                                                                                                                                                                                      |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`   | 1             | 2   | 1   | CTOX branding expectations.                                                                                                                                                                                                      |
| `apps/desktop/scripts/electron-launcher.test.mjs`          | 1             | 1   | 1   | follows the launcher.                                                                                                                                                                                                            |
| `apps/web/src/components/settings/DiagnosticsSettings.tsx` | 1             | 1   | 4   | `SupportBundleSection` inserted into the container element upstream re-typed (`width="expanded"`).                                                                                                                               |
| `scripts/package.json`                                     | 1             | 2   | 1   | Workjet packaging deps.                                                                                                                                                                                                          |
| `apps/web/src/orchestrationEventEffects.test.ts`           | modify/delete | 1   | 1   | **OWNER DECISION.** Upstream deleted it in `277322933` _"test: remove redundant and stale tests (#6267)"_; Workjet still edits it. Keep the Workjet copy (it now covers Workjet orchestration effects) or drop it with upstream. |

Subtotal: 13 content-conflict files, 27 hunks, plus 1 modify/delete.

### 3b. Incidental — append/import adjacency, resolution is mechanically "keep both"

| File                                                              | Hunks | WJc | UPc |
| ----------------------------------------------------------------- | ----- | --- | --- |
| `apps/web/src/components/chat/ChatComposer.tsx`                   | 3     | 4   | 9   |
| `apps/web/src/components/ChatView.tsx`                            | 2     | 13  | 16  |
| `apps/web/src/components/threadSidebarWidth.test.ts`              | 2     | 1   | 1   |
| `pnpm-lock.yaml`                                                  | 2     | 5   | 4   |
| `apps/desktop/src/ipc/channels.ts`                                | 1     | 9   | 4   |
| `packages/contracts/src/settings.ts`                              | 1     | 2   | 4   |
| `apps/server/src/provider/CodexDeveloperInstructions.ts`          | 1     | 1   | 1   |
| `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts` | 1     | 1   | 1   |
| `apps/server/src/provider/Layers/ProviderService.test.ts`         | 1     | 3   | 1   |
| `apps/web/src/components/chat/MessagesTimeline.tsx`               | 1     | 5   | 9   |
| `apps/web/src/components/desktopUpdate.logic.ts`                  | 1     | 1   | 2   |

Subtotal: 11 files, 16 hunks. The dominant shape is _both sides appended to the
same import block or the same constant list_. `ChatView.tsx` and
`ChatComposer.tsx` have the highest joint churn (13×16 and 4×9 commits) and will
keep producing these; they are cheap but unavoidable.

`pnpm-lock.yaml` must be regenerated (`pnpm install --lockfile-only`), never
hand-merged.

### Mitigations that would remove recurring conflicts cheaply

1. Move the Workjet import blocks in `ChatView.tsx`, `ChatComposer.tsx`,
   `SidebarChrome.tsx` and `settings.ts` into a single `workjet*` barrel import
   placed after a blank line at the end of the import block. Turns ~8 hunks per
   cycle into 0.
2. Append Workjet IPC channels in `apps/desktop/src/ipc/channels.ts` below a
   marked `// --- Workjet channels ---` section separated by two blank lines.
3. Extract the Workjet turn-option threading out of `CodexSessionRuntime.ts`
   into a helper the runtime calls once, so upstream's option additions and
   Workjet's stop sharing line ranges. This is the single highest-value change:
   5 of 43 hunks, and structurally guaranteed to repeat.

## 4. Strategy lines measured against reality

Measured with `git diff --name-status 6ae44b418 scratch/ancestry-probe`
(2107 changed paths).

### "Maintain a short, ordered Workjet patch stack" — **FALSE, both halves**

- Not short: 485 commits (348 first-parent).
- Not ordered. Position of first/last commit matching each theme along the
  348-commit first-parent chain, oldest = #1:

  | Theme         | Commits | First | Last |
  | ------------- | ------- | ----- | ---- |
  | contracts     | 15      | #6    | #305 |
  | capabilities  | 18      | #14   | #322 |
  | provider      | 31      | #3    | #332 |
  | CTOX services | 79      | #5    | #315 |
  | shell UI      | 20      | #35   | #284 |
  | branding      | 1       | #123  | #123 |

  Every theme spans essentially the whole range. This is chronological
  development, fully interleaved — there is no ordered stack to rebase.
  The honest options are to drop the ordering goal, or to declare the reconnect
  the moment where the stack is rebuilt as ordered branches. Recommendation:
  drop it. The additive-file shape (below) already delivers what ordering was
  supposed to buy, and reordering 485 commits is not worth 43 hunks per cycle.

### "Prefer additive files and adapters over invasive rewrites" — **TRUE**

| Kind     | Count | Share |
| -------- | ----- | ----- |
| Added    | 1900  | 90.2% |
| Modified | 206   | 9.8%  |
| Deleted  | 1     | 0.05% |
| Renamed  | 0     | 0%    |

The single deletion is `.repos/alchemy-effect/.vendor/alchemy`. Added files
concentrate in genuinely new trees: `native/provider-gateway` 1389,
`native/web-stack` 146, `native/pdf-parse` 45, `packages/workjet-capabilities` 17.
Modified T3 core spreads over `apps/server` 79, `apps/web` 57, `apps/desktop` 33,
`packages/client-runtime` 14, `packages/contracts` 10. Of those 206 modified
files, only 25 conflict against 172 upstream commits — a 12% collision rate.

### "Avoid changing internal T3 identifiers that are not user-visible" — **TRUE, held**

| Identifier class                                                  | Baseline             | Tip                  | Removed/renamed   |
| ----------------------------------------------------------------- | -------------------- | -------------------- | ----------------- |
| Desktop IPC channel literals (`apps/desktop/src/ipc/channels.ts`) | 78                   | 101                  | **0**             |
| `Schema.Literal("…")` in `packages/contracts`                     | 228                  | 253                  | **0**             |
| `Schema.TaggedStruct("…")` in `packages/contracts`                | 13                   | 40                   | **0**             |
| `_tag: "…"` in `packages/contracts`                               | 11                   | 40                   | **0**             |
| `CREATE TABLE` names in `apps/server`                             | 18                   | 25                   | **0**             |
| `localStorage` keys                                               | 2                    | 2                    | **0**             |
| Workspace package names (`@t3tools/*`)                            | 5                    | 5                    | **0** (identical) |
| macOS bundle id                                                   | `com.t3tools.t3code` | `com.t3tools.t3code` | unchanged         |

The copy sweep added identifiers and never renamed one. The CTOX URL schemes are
additive too: the launcher registers `["ctox-desktop", "t3code"]`, keeping the
legacy scheme.

## 5. Environment traps for the next session

- `origin/main` of the fork is **`6ae44b418`, the public T3 commit** — not the
  Workjet tip. The Workjet stack is on `codex/workjet-native-foundation`, which
  shares no ancestor with `origin/main`. Any `git log origin/main..` count above
  3000 is this problem, not a real diff.
- BSD `grep` on macOS silently treats several of these `.tsx` files as binary and
  reports 0 matches for `<<<<<<<`. Always use `grep -a` when counting conflict
  hunks, or the map undercounts (it did: 43 hunks, not the 39 a plain `grep` reports).
- `git rev-list --parents -n1 <root>` prints only the commit's own id for a root
  commit; `cut -d' ' -f2-` on that single field returns the id again, so a naive
  re-parent script gives each imported repository root _itself_ as a parent. Use
  `git log -1 --format=%P`, which is empty for roots. Symptom: `origin/main..tip`
  is 488 instead of 485 and three roots appear twice.
- The stack contains 4 root commits (T3 plus three imported repositories).
  `git rebase` and `git filter-branch` both handle these badly; the re-parent
  replay does not care.
- Probe merges belong in a throwaway worktree
  (`git worktree add --detach /Volumes/tmp/workjet/agentwt/scratch-merge-probe`),
  never in an agent worktree. Checking out the 17863-file tree takes ~30 s.
- Fetching `upstream` pulls ~40 branches and force-updates several; only
  `upstream/main` is meaningful here.
