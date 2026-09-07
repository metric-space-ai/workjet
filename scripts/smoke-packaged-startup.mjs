// oxlint-disable t3code/no-global-process-runtime -- Standalone CI process boundary with a fresh temporary profile.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { CdpClient } from "./lib/cdpClient.ts";

async function reservePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No smoke-test port allocated");
  return { port: address.port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function backendListening(port) {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}

async function renderedWindow(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok || !response.body) return false;
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw new Error("Startup target list exceeds its limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const targets = JSON.parse(text);
  if (!Array.isArray(targets) || targets.length > 32) return false;
  const target = targets.find(
    (item) =>
      item.type === "page" &&
      typeof item.url === "string" &&
      item.url.startsWith("t3code://app/") &&
      typeof item.webSocketDebuggerUrl === "string",
  );
  if (!target) return false;
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    return (
      (await client.evaluate(`Boolean(document.body?.innerText.trim() &&
      document.querySelector('button, [role="button"]'))`)) === true
    );
  } finally {
    client.close();
  }
}

async function main() {
  if (NodeOS.platform() !== "darwin") throw new Error("This packaged startup smoke requires macOS");
  const [executable, reportPath] = process.argv.slice(2);
  if (
    !executable ||
    !reportPath ||
    !NodePath.isAbsolute(executable) ||
    !NodePath.isAbsolute(reportPath)
  ) {
    throw new Error(
      "Usage: node scripts/smoke-packaged-startup.mjs ABSOLUTE_EXECUTABLE ABSOLUTE_REPORT",
    );
  }
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-startup-"));
  const debug = await reservePort();
  const backend = await reservePort();
  await Promise.all([debug.close(), backend.close()]);
  const env = {
    ...process.env,
    T3CODE_DESKTOP_APP_DATA_DIR: NodePath.join(root, "app-data"),
    T3CODE_HOME: NodePath.join(root, "home"),
    T3CODE_PORT: String(backend.port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = NodeChildProcess.spawn(
    executable,
    [`--remote-debugging-port=${debug.port}`, "--remote-debugging-address=127.0.0.1"],
    { env, cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let tail = "";
  const errorTags = new Set();
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  const capture = (chunk) => {
    tail = (tail + String(chunk)).slice(-64 * 1024);
    for (const tag of tail.match(/\b[A-Z][A-Za-z]+Error\b/g) ?? []) errorTags.add(tag);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const closed = new Promise((resolve) => child.once("close", () => resolve(true)));
  const running = () => !spawnFailed && child.exitCode === null && child.signalCode === null;
  const started = Date.now();
  let ready = false;
  const gatewayFailed = () => errorTags.has("ProviderGatewayHostArtifactError");
  try {
    while (Date.now() - started < 120_000) {
      if (!running() || gatewayFailed()) break;
      try {
        ready = (await backendListening(backend.port)) && (await renderedWindow(debug.port));
      } catch {
        ready = false;
      }
      if (ready) {
        // Let deferred startup failures reach the log before accepting liveness.
        await NodeTimersPromises.setTimeout(2000);
        ready = running() && !gatewayFailed() && (await backendListening(backend.port));
        break;
      }
      await NodeTimersPromises.setTimeout(500);
    }
  } finally {
    // This detached process group contains only this fresh smoke-test app.
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      await Promise.race([exited, NodeTimersPromises.setTimeout(2000)]);
      // A child can exit before its helpers, which still own this process group.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    // Check stream closure before destroying handles: inherited pipes must
    // not hide a surviving backend after the Electron parent has stopped.
    const parentProcessClosed = await Promise.race([
      closed,
      NodeTimersPromises.setTimeout(3000, false),
    ]);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    ready = ready && !gatewayFailed() && parentProcessClosed;
    const report = {
      ready,
      elapsedMs: Date.now() - started,
      errorTags: [...errorTags].slice(0, 20),
      childPid: child.pid,
      backendPort: backend.port,
      debugPort: debug.port,
      parentProcessClosed,
    };
    await NodeFSP.mkdir(NodePath.dirname(reportPath), { recursive: true });
    await NodeFSP.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await NodeFSP.rm(root, { recursive: true, force: true });
    console.log(JSON.stringify(report));
  }
  if (!ready) throw new Error("Packaged Workjet backend and renderer did not become ready");
}

await main();
