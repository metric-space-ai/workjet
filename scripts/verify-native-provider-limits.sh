#!/usr/bin/env bash
set -euo pipefail
export PATH="$BUILD_LANE_BIN/../cache/node-v24.13.1-linux-x64/bin:$PATH"
export COREPACK_HOME="$BUILD_LANE_BIN/../cache/workjet-corepack"
export RUST_TEST_THREADS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 MAKEFLAGS=-j2 RAYON_NUM_THREADS=2 npm_config_jobs=2
mkdir -p "$TMPDIR/pnpm-shims"
corepack enable --install-directory "$TMPDIR/pnpm-shims" pnpm
export PATH="$TMPDIR/pnpm-shims:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
files=(apps/web/src/components/settings/NativeProviderLimits.tsx apps/web/src/components/settings/NativeProviderLimits.test.tsx apps/web/src/components/settings/NativeProviderLimits.expiry.test.tsx apps/web/src/components/settings/NativeProviderRows.tsx apps/web/src/components/settings/WorkjetModelsQuota.ts apps/web/src/components/settings/WorkjetModelsProviders.tsx scripts/native-provider-limits-browser.mjs)
pnpm exec vp fmt --threads 2 --check "${files[@]}"
pnpm --dir apps/web exec vp test run --project unit --maxWorkers 2 src/components/settings/NativeProviderLimits.test.tsx src/components/settings/NativeProviderLimits.expiry.test.tsx src/components/settings/useInstanceProviders.limits.test.tsx src/components/settings/WorkjetModelsQuota.test.ts src/components/settings/WorkjetModelsHealth.test.ts src/components/settings/WorkjetModelsProviders.test.tsx
pnpm --dir packages/contracts exec vp test run --maxWorkers 2 src/workjetNativeProviders.test.ts
pnpm --dir packages/contracts exec tsgo --noEmit
pnpm --dir apps/web exec tsgo --noEmit
pnpm exec vp lint --threads 2 "${files[@]}"
export PLAYWRIGHT_BROWSERS_PATH="$BUILD_LANE_BIN/../cache/models-playwright-1.60.0"
export WORKJET_LIMITS_PLAYWRIGHT_MODULE="$BUILD_LANE_BIN/../target/workjet-model-rest-limits-20261011/limits-browser-tools/node_modules/playwright/index.mjs"
if [[ ! -f "$WORKJET_LIMITS_PLAYWRIGHT_MODULE" ]]; then
  npm install --prefix "$CARGO_TARGET_DIR/limits-browser-tools" --no-audit --no-fund --ignore-scripts playwright@1.60.0
  export WORKJET_LIMITS_PLAYWRIGHT_MODULE="$CARGO_TARGET_DIR/limits-browser-tools/node_modules/playwright/index.mjs"
fi
export WORKJET_LIMITS_OWNER=01a12b1d-2380-7a70-9159-cca95e86f2e0
node scripts/native-provider-limits-browser.mjs
