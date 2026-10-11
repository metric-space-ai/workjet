// @effect-diagnostics nodeBuiltinImport:off -- Bounded host probe process boundary.
// @effect-diagnostics globalDate:off -- Snapshot timestamp, not scheduling.
// @effect-diagnostics preferSchemaOverJson:off -- system_profiler's external JSON boundary.
import type { ComputerFacts, WorkjetComputer } from "@workjet/contracts";

/** Each command owns a bounded child; no package installs or network catalog requests. */
export const COMPUTER_PROBE_SCRIPT = String.raw`set -eu
probe_tmp="$(mktemp -d)"
trap 'rm -rf "$probe_tmp"' EXIT HUP INT TERM
bounded() {
  seconds="$1"; shift
  if command -v perl >/dev/null 2>&1; then
    if perl -MPOSIX -e '
      $seconds=shift @ARGV; $pid=fork(); die "fork" unless defined $pid;
      if ($pid == 0) { POSIX::setsid(); exec @ARGV; exit 127; }
      $SIG{ALRM}=sub { kill "TERM",-$pid; select undef,undef,undef,0.2; kill "KILL",-$pid; waitpid($pid,0); exit 124; };
      alarm $seconds; waitpid($pid,0); $code=$? >> 8; alarm 0; kill "KILL",-$pid; exit $code;
    ' "$seconds" "$@" > "$probe_tmp/out" 2>/dev/null; then cat "$probe_tmp/out"; else printf 'warning=%s timed out or unavailable\n' "$1" >&2; fi
  elif command -v timeout >/dev/null 2>&1; then
    if timeout -k 1 "$seconds" "$@" > "$probe_tmp/out" 2>/dev/null; then cat "$probe_tmp/out"; else printf 'warning=%s timed out or unavailable\n' "$1" >&2; fi
  else printf 'warning=%s unavailable: no bounded process runner\n' "$1" >&2
  fi
}
platform="$(uname -s)"
printf 'os=%s\narch=%s\nhome=%s\n' "$platform" "$(uname -m)" "$HOME"
root="$HOME/.workjet/computer-work"
mkdir -p "$root"
printf 'root=%s\nfree_kib=%s\n' "$root" "$(df -Pk "$root" | awk 'END {print $4}')"
if [ "$platform" = Darwin ]; then
  printf 'cores=%s\nram=%s\n' "$(sysctl -n hw.logicalcpu)" "$(sysctl -n hw.memsize)"
  printf 'machine=%s\n' "$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F '"' '/IOPlatformUUID/ {print $(NF-1)}')"
  bounded 8 system_profiler SPDisplaysDataType -json | tr -d '\n' | sed 's/^/apple_gpu=/'; printf '\n'
else
  printf 'cores=%s\nram=%s\n' "$(nproc)" "$(awk '/MemTotal:/ {printf "%.0f", $2 * 1024}' /proc/meminfo)"
  printf 'machine=%s\n' "$(cat /etc/machine-id 2>/dev/null || true)"
  if command -v nvidia-smi >/dev/null 2>&1; then bounded 4 nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | sed 's/^/gpu=/'; fi
fi
for tool in rustc cargo node pnpm python3 python go docker podman; do
  if command -v "$tool" >/dev/null 2>&1; then
    if [ "$tool" = go ]; then result="$(bounded 3 "$tool" version)"; else result="$(bounded 3 "$tool" --version)"; fi
    printf 'tool.%s=%s\n' "$tool" "$(printf '%s' "$result" | head -n 1)"
  fi
done
for tool in codex claude cursor-agent grok opencode greppy minimax pi; do
  if command -v "$tool" >/dev/null 2>&1; then
    result="$(bounded 3 "$tool" --version)"
    printf 'coding.%s=%s\n' "$tool" "$(printf '%s' "$result" | head -n 1)"
  fi
done
`;

export function parseComputerProbe(
  stdout: string,
  stderr = "",
  now = new Date().toISOString(),
): ComputerFacts {
  const values = new Map<string, string>();
  const gpus: ComputerFacts["gpus"][number][] = [];
  const toolchains: Record<string, string> = {};
  const codingTools: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const split = line.indexOf("=");
    if (split < 1) continue;
    const key = line.slice(0, split),
      value = line
        .slice(split + 1)
        .trim()
        .slice(0, key === "apple_gpu" ? 262144 : 4096);
    if (key === "gpu") {
      const comma = value.lastIndexOf(",");
      const memory = Number(value.slice(comma + 1).trim());
      if (comma > 0)
        gpus.push({
          model: value.slice(0, comma).trim(),
          vramBytes: Number.isFinite(memory) ? memory * 1024 * 1024 : null,
          unifiedMemory: false,
        });
    } else if (key.startsWith("tool.") && value) toolchains[key.slice(5)] = value;
    else if (key.startsWith("coding.") && value) codingTools[key.slice(7)] = value;
    else values.set(key, value);
  }
  if (values.get("apple_gpu")) {
    const displays: unknown = JSON.parse(values.get("apple_gpu")!);
    if (
      typeof displays === "object" &&
      displays !== null &&
      "SPDisplaysDataType" in displays &&
      Array.isArray(displays.SPDisplaysDataType)
    ) {
      for (const item of displays.SPDisplaysDataType) {
        if (typeof item !== "object" || item === null) continue;
        const model = item.sppci_model ?? item._name;
        const vram =
          typeof item.spdisplays_vram === "string"
            ? /([0-9.]+)\s*(MB|GB)/iu.exec(item.spdisplays_vram)
            : null;
        if (typeof model === "string")
          gpus.push({
            model,
            vramBytes: vram
              ? Number(vram[1]) * (vram[2]!.toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2)
              : null,
            unifiedMemory: /Apple/iu.test(model),
          });
      }
    }
  }
  const number = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid detected ${key}`);
    return value;
  };
  const cpuCores = number("cores");
  if (!Number.isInteger(cpuCores) || cpuCores < 1 || !values.get("home") || !values.get("os"))
    throw new Error("Incomplete computer probe");
  return {
    checkedAt: now,
    machineId: values.get("machine") || null,
    operatingSystem: values.get("os")!,
    architecture: values.get("arch") || "unknown",
    cpuCores,
    ramBytes: number("ram"),
    homeDirectory: values.get("home")!,
    workDirectory: values.get("root")!,
    freeBytes: number("free_kib") * 1024,
    gpus,
    toolchains,
    codingTools,
    warnings: stderr
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("warning="))
      .map((line) => line.slice(8, 4096)),
  };
}

const CODING_TOOL_HARNESSES = [
  ["claude", "claude-code"],
  ["codex", "codex-cli"],
  ["opencode", "opencode"],
  ["grok", "grok-cli"],
  ["cursor-agent", "cursor-agent"],
  ["greppy", "greppy"],
  ["minimax", "minimax-code"],
  ["pi", "pi-code"],
] as const;
export function detectedComputerHarnesses(
  saved: WorkjetComputer["harnesses"],
  facts: ComputerFacts,
): WorkjetComputer["harnesses"] {
  return CODING_TOOL_HARNESSES.map(([tool, harness]) => {
    const existing = saved.find((row) => row.harness === harness);
    return {
      ...existing,
      harness,
      available: existing?.executableOverride ? existing.available : !!facts.codingTools[tool],
    };
  });
}

export const MINIMUM_COMPUTER_FREE_BYTES = 20 * 1024 ** 3;
export function deriveComputerCapacity(facts: ComputerFacts) {
  return {
    concurrentBuilds: 1 as const,
    workersPerBuild: facts.cpuCores,
    useGpu: facts.gpus.length > 0,
    directory: facts.workDirectory,
    enoughFreeSpace: facts.freeBytes >= MINIMUM_COMPUTER_FREE_BYTES,
  };
}
