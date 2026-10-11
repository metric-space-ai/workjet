#!/usr/bin/env bash
# Run through gpu-build-run.sh; all browser state and artifacts are isolated.
set -euo pipefail
export RUST_TEST_THREADS=2
files=(
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
  apps/desktop/src/app/DesktopKeyRecovery.test.ts
  apps/desktop/src/ipc/channels.ts
  apps/desktop/src/ipc/methods/ctox.ts
  apps/desktop/src/ipc/methods/ctox.test.ts
  apps/desktop/src/main.ts
  apps/desktop/src/preload.ts
  apps/server/src/auth/ServerSecretStore.ts
  apps/web/src/components/settings/CtoxDeviceKeyRow.tsx
  apps/web/src/components/settings/CtoxDeviceKeyRow.test.tsx
  apps/web/src/components/settings/BusinessOsSettings.tsx
  apps/web/src/components/ctox/InstanceOnboarding.test.tsx
  packages/contracts/src/ctoxControlDevice.ts
  packages/contracts/src/index.ts
  packages/contracts/src/ipc.ts
  scripts/test-ctox-device-key-settings.mjs
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
  apps/server/src/auth/ServerSecretStore.test.ts \
  apps/web/src/components/settings/CtoxDeviceKeyRow.test.tsx \
  apps/web/src/components/settings/BusinessOsSettings.test.tsx \
  apps/web/src/components/ctox/InstanceOnboarding.test.tsx
pnpm exec effect-tsgo patch
pnpm exec tsgo --noEmit -p apps/desktop/tsconfig.json
pnpm exec tsgo --noEmit -p apps/server/tsconfig.json
pnpm exec tsgo --noEmit -p apps/web/tsconfig.json
DEVICE_UI_EVIDENCE_DIR="${DEVICE_UI_EVIDENCE_DIR:?set an isolated artifact directory}" node scripts/test-ctox-device-key-settings.mjs
