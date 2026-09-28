/** A private, checksum-pinned runtime for SSH hosts without a compatible Node. */
export const SSH_NODE_VERSION = "24.13.1";

// Published by nodejs.org/dist/v24.13.1/SHASUMS256.txt.
const ARCHIVES = {
  "Linux:x86_64": ["linux-x64", "7ad28fb172a9ab0593f86c1a39e5c268d0d8fc3d6cb0167f455b5655a7a6e2fd"],
  "Linux:aarch64": [
    "linux-arm64",
    "4873459d7c9b28feaa1f0fade9bb9c81cb702670991ff80a51d805325c5e3456",
  ],
  "Darwin:x86_64": [
    "darwin-x64",
    "527f0578d9812e7dfa225121bda0b1546a6a0e4b5f556295fc8299c272de5fbf",
  ],
  "Darwin:arm64": [
    "darwin-arm64",
    "8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6",
  ],
} as const;

export function buildManagedRemoteNodeScript(): string {
  const platforms = Object.entries(ARCHIVES)
    .map(
      ([platform, [archive, checksum]]) =>
        `    '${platform}') workjet_node_platform='${archive}'; workjet_node_sha='${checksum}' ;;`,
    )
    .join("\n");
  return `
install_workjet_node() (
  set -eu
  case "$(uname -s):$(uname -m)" in
${platforms}
    *) printf 'Automatic Node setup is unavailable for this SSH platform.\\n' >&2; exit 1 ;;
  esac
  workjet_node_base="$HOME/.workjet/runtime/node"
  workjet_node_name="node-v${SSH_NODE_VERSION}-$workjet_node_platform"
  workjet_node_destination="$workjet_node_base/$workjet_node_name"
  if [ -x "$workjet_node_destination/bin/node" ] && [ "$("$workjet_node_destination/bin/node" --version)" = 'v${SSH_NODE_VERSION}' ]; then exit 0; fi
  for workjet_tool in curl tar mktemp; do
    command -v "$workjet_tool" >/dev/null 2>&1 || { printf 'Automatic Node setup needs %s on the SSH host.\\n' "$workjet_tool" >&2; exit 1; }
  done
  if command -v sha256sum >/dev/null 2>&1; then workjet_hash_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then workjet_hash_command=shasum
  else printf 'Automatic Node setup needs SHA-256 verification on the SSH host.\\n' >&2; exit 1
  fi
  umask 077
  mkdir -p "$workjet_node_base"
  workjet_node_stage="$(mktemp -d "$workjet_node_base/.download.XXXXXXXX")"
  trap 'rm -rf "$workjet_node_stage"' EXIT
  printf 'Preparing the Workjet runtime on this computer…\\n' >&2
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 \\
    "https://nodejs.org/dist/v${SSH_NODE_VERSION}/$workjet_node_name.tar.gz" -o "$workjet_node_stage/node.tar.gz"
  if [ "$workjet_hash_command" = sha256sum ]; then
    workjet_node_actual="$(sha256sum "$workjet_node_stage/node.tar.gz")"
  else workjet_node_actual="$(shasum -a 256 "$workjet_node_stage/node.tar.gz")"; fi
  workjet_node_actual="\${workjet_node_actual%% *}"
  if [ "$workjet_node_actual" != "$workjet_node_sha" ]; then printf 'Workjet runtime checksum verification failed; nothing was installed.\\n' >&2; exit 1; fi
  tar -xzf "$workjet_node_stage/node.tar.gz" -C "$workjet_node_stage"
  test "$("$workjet_node_stage/$workjet_node_name/bin/node" --version)" = 'v${SSH_NODE_VERSION}'
  if [ -e "$workjet_node_destination" ]; then
    if [ -x "$workjet_node_destination/bin/node" ] && [ "$("$workjet_node_destination/bin/node" --version)" = 'v${SSH_NODE_VERSION}' ]; then exit 0; fi
    printf 'The private Workjet Node runtime is damaged and must be repaired.\\n' >&2; exit 1
  fi
  if ! mv "$workjet_node_stage/$workjet_node_name" "$workjet_node_base/" 2>/dev/null; then
    test -x "$workjet_node_destination/bin/node" && test "$("$workjet_node_destination/bin/node" --version)" = 'v${SSH_NODE_VERSION}'
  fi

)

use_workjet_node() {
  case "$(uname -s):$(uname -m)" in
${platforms}
    *) return 1 ;;
  esac
  PATH="$HOME/.workjet/runtime/node/node-v${SSH_NODE_VERSION}-$workjet_node_platform/bin:$PATH"
  export PATH
  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;
}
