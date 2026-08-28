// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off -- Explicit Node platform boundary injected into the Effect gateway service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
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
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("invalid file");
    return NodeFSP.readFile(path, "utf8");
  },
  writePrivateText: async (path, content) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await NodeFSP.chmod(temporary, 0o600);
      await NodeFSP.rename(temporary, path);
      await NodeFSP.chmod(path, 0o600);
    } catch (error) {
      await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  remove: async (path) => NodeFSP.rm(path, { force: true }),
  spawn: (executable, args) => {
    const child = NodeChildProcess.spawn(executable, [...args], {
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
  managementRequest: async (endpoint, route, key, method, maximumBytes) => {
    const response = await fetch(new URL(route, endpoint), {
      method,
      headers: { authorization: `Bearer ${key}` },
      // The host's request reader requires a Content-Length on POST.
      ...(method === "POST" ? { body: "" } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("unavailable");
    if (response.body === null) return null;
    const text = await readBoundedResponse(response, maximumBytes);
    return text.trim() === "" ? null : (JSON.parse(text) as unknown);
  },
  signalProcess: (pid, signal) => {
    try {
      return process.kill(pid, signal === "probe" ? 0 : signal);
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  allocateLoopbackPort: () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address !== null && typeof address === "object") resolve(address.port);
          else reject(new Error("no port"));
        });
      });
    }),
};
