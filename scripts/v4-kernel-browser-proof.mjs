import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

const root = NodePath.resolve(import.meta.dirname, "..");
const webRequire = NodeModule.createRequire(NodePath.join(root, "apps/web/package.json"));
const desktopRequire = NodeModule.createRequire(NodePath.join(root, "apps/desktop/package.json"));
const kernelDirectory = NodePath.join(root, "apps/web/src/ctox/kernel");
const provenanceBytes = await NodeFSP.readFile(NodePath.join(kernelDirectory, "PROVENANCE.json"));
const provenance = JSON.parse(provenanceBytes);
for (const file of provenance.files) {
  const bytes = await NodeFSP.readFile(NodePath.join(kernelDirectory, file.path));
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    file.sha256,
    `Vendored kernel bytes changed: ${file.path}`,
  );
}
const { build } = await import(NodeURL.pathToFileURL(webRequire.resolve("vite")).href);
const { chromium } = desktopRequire("playwright-core");
NodeAssert.ok(process.env.TMPDIR, "An admitted lane TMPDIR is required");
const output = NodePath.join(process.env.TMPDIR, "p11-b-browser-proof");
await NodeFSP.mkdir(output, { recursive: true });
await build({
  configFile: false,
  root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warn",
  build: {
    outDir: output,
    emptyOutDir: true,
    lib: {
      entry: NodePath.join(root, "apps/web/src/ctox/kernelBrowserFixture.ts"),
      formats: ["es"],
      fileName: "fixture",
    },
  },
});
const entryFile = (await NodeFSP.readdir(output)).find((name) => /^fixture\.(m?js)$/.test(name));
NodeAssert.ok(entryFile, "Fixture entry was not generated");
await NodeFSP.writeFile(
  NodePath.join(output, "index.html"),
  `<!doctype html><html><body><script type="module" src="/${entryFile}"></script></body></html>`,
);

const cache = NodePath.join(NodeOS.homedir(), ".cache/ms-playwright");
const candidates = [
  process.env.P11_BROWSER_EXECUTABLE,
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];
if (NodeFS.existsSync(cache))
  for (const name of await NodeFSP.readdir(cache)) {
    if (name.startsWith("chromium-"))
      candidates.push(
        NodePath.join(cache, name, "chrome-linux64/chrome"),
        NodePath.join(cache, name, "chrome-linux/chrome"),
      );
  }
const executablePath = candidates.find((candidate) => candidate && NodeFS.existsSync(candidate));
NodeAssert.ok(executablePath, "No existing sandboxed Chromium runtime found");
const server = NodeHttp.createServer(async (request, response) => {
  const path = NodePath.resolve(
    output,
    `.${new URL(request.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname}`,
  );
  try {
    NodeAssert.ok(path.startsWith(`${output}${NodePath.sep}`));
    NodeAssert.ok((await NodeFSP.stat(path)).isFile());
    response.setHeader(
      "Content-Type",
      NodePath.extname(path) === ".html" ? "text/html" : "text/javascript",
    );
    response.end(await NodeFSP.readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  await page
    .waitForFunction(() => typeof globalThis.runKernelReadMeasurement === "function", null, {
      timeout: 5000,
    })
    .catch((error) => {
      console.error(JSON.stringify({ errors, entryFile }));
      throw error;
    });
  await page.evaluate(() => globalThis.runKernelReadMeasurement(true));
  const measurements = [];
  for (let n = 0; n < 3; n++) {
    await page.reload();
    await page
      .waitForFunction(() => typeof globalThis.runKernelReadMeasurement === "function", null, {
        timeout: 5000,
      })
      .catch((error) => {
        console.error(JSON.stringify({ errors, entryFile }));
        throw error;
      });
    measurements.push(await page.evaluate(() => globalThis.runKernelReadMeasurement(false)));
  }
  const proof = {
    kernel: "CTOX v4/integration@c707454b0e67ec5ec8881f68dc94813a55b4a2ac",
    stub: false,
    provenanceSha256: NodeCrypto.createHash("sha256").update(provenanceBytes).digest("hex"),
    timingBoundary:
      "before opening the real IndexedDB kernel through first React commit; module loading excluded",
    multiTab: "normal browser Web Locks + BroadcastChannel",
    k20EndToEnd: "not run; no daemon or production endpoint",
    authority: "isolated browser fixture; no production endpoint",
    executablePath,
    measurements,
    errors,
    pass:
      errors.length === 0 &&
      measurements.every(
        (m) =>
          m.storage === "indexeddb" &&
          m.link === "offline" &&
          m.projectCount === 12 &&
          m.kpiValueCount === 36 &&
          m.text.includes("Open 3") &&
          m.committedMs <= 100,
      ),
  };
  await NodeFSP.writeFile(NodePath.join(output, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  NodeAssert.ok(proof.pass, "real IndexedDB reopen/read/render exceeded its contract");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
