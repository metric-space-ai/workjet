#!/usr/bin/env bash
# Focused Linux verification. Run through the shared gpu build lane.
set -euo pipefail
export RAYON_NUM_THREADS=2
export UV_THREADPOOL_SIZE=2
export PNPM_HOME="${XDG_CACHE_HOME:-$PWD/.cache}/pnpm"
export COREPACK_HOME="${XDG_CACHE_HOME:-$PWD/.cache}/corepack"
export PATH="$PNPM_HOME:$PATH"
node --version
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm exec effect-tsgo patch
corepack pnpm --dir packages/contracts exec vp test run src/workjetExitModel.test.ts src/ctoxProjectList.test.ts --maxWorkers=2
corepack pnpm --dir apps/web exec vp test run --project unit src/projectExitModel.test.ts src/components/ProjectExitModel.test.tsx src/components/ProjectOverviewCard.test.tsx src/components/ProjectWorkspace.test.tsx src/workjetProjectControl.test.ts --maxWorkers=2
corepack pnpm --dir apps/desktop exec vp test run src/ctox/CtoxGuestManager.test.ts --testNamePattern 'configuration receipts|exit assessment' --maxWorkers=2
corepack pnpm --dir packages/contracts typecheck
corepack pnpm --dir apps/web typecheck
corepack pnpm --dir apps/desktop typecheck
