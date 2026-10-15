#!/usr/bin/env bash
# Backend checks; run through gpu-build-run.sh with two workers.
set -euo pipefail
export RUST_TEST_THREADS=2
files=(
  docs/internals/ctox-device-keys.md

  apps/desktop/src/ctox/fixtures/ctox-dev-desktop-device-proof.mjs
  apps/desktop/src/ctox/fixtures/ctox-dev-desktop-device-proof.d.mts
  apps/desktop/tsconfig.json
  apps/desktop/src/ctox/CtoxControlDevice.ts
  apps/desktop/src/ctox/CtoxControlDeviceClient.ts
  apps/desktop/src/ctox/CtoxControlDeviceClient.test.ts
  apps/desktop/src/ctox/CtoxDevAuth.ts
  apps/desktop/src/ctox/CtoxDevAuth.test.ts
  apps/desktop/src/ctox/CtoxDeviceProofKey.ts
  apps/desktop/src/ctox/CtoxDeviceRequestProof.test.ts
  apps/desktop/src/ctox/CtoxManagedLaunch.ts
  apps/desktop/src/ctox/CtoxManagedLaunch.test.ts
  apps/desktop/src/app/DesktopKeyRecovery.test.ts
  apps/desktop/src/ipc/channels.ts
  apps/desktop/src/ipc/methods/ctox.ts
  apps/desktop/src/ipc/methods/ctox.test.ts
  apps/desktop/src/main.ts
  apps/desktop/src/preload.ts
  apps/server/src/auth/ServerSecretStore.ts

  packages/contracts/src/ctoxControlDevice.ts
  packages/contracts/src/index.ts
  packages/contracts/src/ipc.ts

)
if [[ "${1:-}" == --format ]]; then
  pnpm exec vp fmt --threads 2 "${files[@]}"
else
  pnpm exec vp fmt --check --threads 2 "${files[@]}"
fi
pnpm exec vp lint --threads 2 "${files[@]}"
pnpm exec vp test run --maxWorkers 2 \
  apps/desktop/src/ctox/CtoxDeviceRequestProof.test.ts \
  apps/desktop/src/ctox/CtoxControlDeviceClient.test.ts \
  apps/desktop/src/ctox/CtoxDeviceProofKey.test.ts \
  apps/desktop/src/ctox/CtoxDevAuth.test.ts \
  apps/desktop/src/ctox/CtoxManagedLaunch.test.ts \
  apps/desktop/src/app/DesktopKeyRecovery.test.ts \
  apps/desktop/src/ipc/methods/ctox.test.ts \
  apps/server/src/auth/ServerSecretStore.test.ts
pnpm exec effect-tsgo patch
pnpm exec tsgo --noEmit -p apps/desktop/tsconfig.json
pnpm exec tsgo --noEmit -p apps/server/tsconfig.json
pnpm exec tsgo --noEmit -p apps/web/tsconfig.json
