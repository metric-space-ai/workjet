#!/usr/bin/env bash
set -euo pipefail
export PATH="$BUILD_LANE_BIN/../cache/node-v24.13.1-linux-x64/bin:$PATH"
export COREPACK_HOME="$BUILD_LANE_BIN/../cache/workjet-corepack"
export RUST_TEST_THREADS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 MAKEFLAGS=-j2 RAYON_NUM_THREADS=2 npm_config_jobs=2
mkdir -p "$TMPDIR/pnpm-shims"
corepack enable --install-directory "$TMPDIR/pnpm-shims" pnpm
export PATH="$TMPDIR/pnpm-shims:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
files=(apps/web/src/components/chat/NativeSupervisorComposer.tsx apps/web/src/components/chat/NativeSupervisorComposer.test.tsx apps/web/src/components/chat/NativeSupervisorActualRoute.tsx apps/web/src/components/chat/NativeSupervisorActualRoute.test.tsx apps/web/src/components/chat/useSupervisorRouteDisplay.ts apps/web/src/workjetSupervisorRoute.ts apps/web/src/workjetSupervisorRoute.test.ts apps/web/src/workjetSupervisorRouteV2.test.ts packages/contracts/src/ctox.ts packages/contracts/src/workjetSupervisorRoute.ts packages/contracts/src/workjetSupervisorRouteV2.ts packages/contracts/src/workjetSupervisorRouteV2.test.ts)
pnpm exec vp fmt --threads 2 --check "${files[@]}"
pnpm --dir apps/web exec vp test run --project unit --maxWorkers 2 src/components/chat/NativeSupervisorComposer.test.tsx src/components/chat/NativeSupervisorActualRoute.test.tsx src/workjetSupervisorRoute.test.ts src/workjetSupervisorRouteV2.test.ts src/nativeSupervisorComposer.test.ts src/supervisorComposerSelection.test.ts
pnpm --dir packages/contracts exec vp test run --maxWorkers 2 src/workjetSupervisorRoute.test.ts src/workjetSupervisorRouteV2.test.ts
pnpm --dir packages/contracts exec tsgo --noEmit
pnpm --dir apps/web exec tsgo --noEmit
pnpm exec vp lint --threads 2 "${files[@]}"
