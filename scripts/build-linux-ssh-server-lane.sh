#!/usr/bin/env bash
# Executed only within gpu-build-run's admitted gpu3 slot.
set -euo pipefail
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]]
WORKJET_REMOTE_STAGE="${1:?missing build stage}"
[[ "$WORKJET_REMOTE_STAGE" == /mnt/nvme1/build-lane/artifacts/workjet-linux-ssh-*/* ]]
export PATH="/mnt/nvme1/build-lane/cache/node-v24.13.1-linux-x64/bin:$PATH"
[[ "$(node --version)" == v24.13.1 ]]
WORKJET_BUILD_CACHE=/mnt/nvme1/build-lane/cache/workjet-linux-ssh
export npm_config_cache="$WORKJET_BUILD_CACHE/npm"
export XDG_CACHE_HOME="$WORKJET_BUILD_CACHE/xdg"
mkdir -p "$WORKJET_BUILD_CACHE/tools" "$WORKJET_REMOTE_STAGE/output"
if [[ ! -x "$WORKJET_BUILD_CACHE/tools/node_modules/.bin/pnpm" ]]; then
  npm install --prefix "$WORKJET_BUILD_CACHE/tools" --no-audit --no-fund pnpm@11.10.0
fi
export PATH="$WORKJET_BUILD_CACHE/tools/node_modules/.bin:$PATH"
[[ "$(pnpm --version)" == 11.10.0 ]]
pnpm install --frozen-lockfile --store-dir "$WORKJET_BUILD_CACHE/store"
rm -rf apps/server/dist
mkdir -p apps/server/dist
# Git shipping intentionally excludes ignored output. Copy the fresh server
# being packaged, instead of rebuilding different JS for another platform.
tar -xzf "$WORKJET_REMOTE_STAGE/server-dist.tgz" -C apps/server/dist
node scripts/build-ssh-server.mjs "$WORKJET_REMOTE_STAGE/output"
test -s "$WORKJET_REMOTE_STAGE/output/workjet-server-linux-x64.tgz"
test -s "$WORKJET_REMOTE_STAGE/output/workjet-server-linux-x64.tgz.sha256"
echo WORKJET_LINUX_X64_SERVER_ARCHIVE_OK
