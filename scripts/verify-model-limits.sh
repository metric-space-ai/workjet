#!/usr/bin/env bash
set -euo pipefail
export PATH="$BUILD_LANE_BIN/../cache/node-v24.13.1-linux-x64/bin:$PATH"
export COREPACK_HOME="$BUILD_LANE_BIN/../cache/workjet-corepack"
export RUST_TEST_THREADS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 MAKEFLAGS=-j2 RAYON_NUM_THREADS=2
mkdir -p "$TMPDIR/pnpm-shims"
corepack enable --install-directory "$TMPDIR/pnpm-shims" pnpm
export PATH="$TMPDIR/pnpm-shims:$PATH"
export npm_config_jobs=2
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vp fmt --threads 2 --check apps/web/src/components/settings/WorkjetModelsQuota.ts apps/web/src/components/settings/WorkjetModelsQuota.test.ts apps/web/src/components/settings/WorkjetModelsHealth.ts apps/web/src/components/settings/WorkjetModelsHealth.test.ts apps/web/src/components/settings/WorkjetModelsProviders.tsx apps/web/src/components/settings/WorkjetModelsProviders.test.tsx apps/server/src/providerGateway/ProviderGatewayAccountHealth.test.ts packages/contracts/src/workjet.ts scripts/model-limits-browser.mjs
pnpm --dir apps/web exec vp test run --project unit --maxWorkers 2 src/components/settings/WorkjetModelsQuota.test.ts src/components/settings/WorkjetModelsHealth.test.ts src/components/settings/WorkjetModelsProviders.test.tsx
pnpm --dir apps/server exec vp test run --maxWorkers 2 src/providerGateway/ProviderGatewayAccountHealth.test.ts
pnpm --dir packages/contracts exec tsgo --noEmit
pnpm --dir apps/web exec tsgo --noEmit
pnpm exec vp lint --threads 2 apps/web/src/components/settings/WorkjetModelsQuota.ts apps/web/src/components/settings/WorkjetModelsQuota.test.ts apps/web/src/components/settings/WorkjetModelsHealth.ts apps/web/src/components/settings/WorkjetModelsHealth.test.ts apps/web/src/components/settings/WorkjetModelsProviders.tsx apps/web/src/components/settings/WorkjetModelsProviders.test.tsx apps/server/src/providerGateway/ProviderGatewayAccountHealth.test.ts packages/contracts/src/workjet.ts scripts/model-limits-browser.mjs
export PLAYWRIGHT_BROWSERS_PATH="$BUILD_LANE_BIN/../cache/models-playwright-1.60.0"
npm install --prefix "$CARGO_TARGET_DIR/limits-browser-tools" --no-audit --no-fund --ignore-scripts playwright@1.60.0
export WORKJET_LIMITS_PLAYWRIGHT_MODULE="$CARGO_TARGET_DIR/limits-browser-tools/node_modules/playwright/index.mjs"
export WORKJET_LIMITS_OWNER=01a12a65-6fe2-7cd0-a6a5-433d24ab0693
export WORKJET_LIMITS_BASE=496692d68152d11af68cf2ecf9fc061d34845d07
node scripts/model-limits-browser.mjs
