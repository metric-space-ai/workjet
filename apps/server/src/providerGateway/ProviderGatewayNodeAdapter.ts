// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Explicit Node platform boundary injected into the Effect gateway service.
import { spawn } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  GatewayHostProcess,
  GatewayProcessExit,
  ProviderGatewayPlatform,
} from "./ProviderGatewayService.ts";

const readBoundedResponse = async (response: Response, maximumBytes: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("oversized");
  if (!response.ok || response.body === null) throw new Error("unavailable");
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("oversized");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<A> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error("timeout"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const nodeProviderGatewayPlatform: ProviderGatewayPlatform = {
  joinPath: (...parts) => NodePath.join(...parts),
  defaultExecutable: (stateDir) =>
    process.env.WORKJET_PROVIDER_GATEWAY_HOST_EXECUTABLE ??
    NodePath.join(stateDir, "provider-gateway-host"),
  byteLength: (value) => (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength),
  chunkText: (value) => (typeof value === "string" ? value : Buffer.from(value).toString("utf8")),
  bytesToHex: (value) => Buffer.from(value).toString("hex"),
  withTimeout,
  readText: async (path, maximumBytes) => {
    const stat = await NodeFs.stat(path);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("invalid file");
    return NodeFs.readFile(path, "utf8");
  },
  writePrivateText: async (path, content) => {
    await NodeFs.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await NodeFs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await NodeFs.chmod(temporary, 0o600);
      await NodeFs.rename(temporary, path);
      await NodeFs.chmod(path, 0o600);
    } catch (error) {
      await NodeFs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  remove: async (path) => NodeFs.rm(path, { force: true }),
  spawn: (executable, args) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
      windowsHide: true,
    });
    const exit = new Promise<GatewayProcessExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });
    if (child.pid === undefined || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new Error("spawn failed");
    }
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      kill: (signal) => child.kill(signal),
    } satisfies GatewayHostProcess;
  },
  managementGet: async (endpoint, route, key, maximumBytes) => {
    const response = await fetch(new URL(route, endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    return JSON.parse(await readBoundedResponse(response, maximumBytes)) as unknown;
  },
};
