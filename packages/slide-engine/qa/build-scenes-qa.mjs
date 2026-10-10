// Bundles qa/scenes-qa.tsx into qa/dist (gitignored) for qa/scenes.html.
//
// three is resolved from the package when it is linked at 0.140.0; otherwise the pinned
// learnordie tarball (three@0.140.0, sha512 from learnordie's package-lock.json) is fetched
// once into qa/dist/vendor and verified. Fonts come from the learnordie checkout as data URIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const qaDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.dirname(qaDir);
const repoDir = NodePath.resolve(packageDir, "../..");
const distDir = NodePath.join(qaDir, "dist");
const vendorDir = NodePath.join(distDir, "vendor");

const THREE_VERSION = "0.140.0";
const THREE_TARBALL = `https://registry.npmjs.org/three/-/three-${THREE_VERSION}.tgz`;
const THREE_INTEGRITY =
  "sha512-jcHjbnYspPLDdsDQChmzyAoZ5KhJbgFk6pNGlAIc9fQMvsfPGjF5H9glrngqvb2CR/qXcClMyp5PYdF996lldA==";
const FONT_DIR =
  process.env.SLIDE_ENGINE_FONT_DIR ??
  NodePath.resolve(repoDir, "../learnordie/public/vendor/excalidraw/fonts");

/** Resolves a package directory from the package, the web app, the repo root or the pnpm store. */
function packageDirectory(name, version) {
  for (const base of [packageDir, NodePath.join(repoDir, "apps/web"), repoDir]) {
    try {
      const require = NodeModule.createRequire(NodePath.join(base, "package.json"));
      const dir = NodePath.dirname(require.resolve(`${name}/package.json`));
      if (!version || readJson(NodePath.join(dir, "package.json")).version === version) return dir;
    } catch {
      // try the next location
    }
  }
  // SLIDE_ENGINE_QA_PNPM_STORE: another checkout's node_modules/.pnpm while this one installs.
  for (const store of [
    NodePath.join(repoDir, "node_modules/.pnpm"),
    process.env.SLIDE_ENGINE_QA_PNPM_STORE,
  ].filter(Boolean)) {
    if (!NodeFS.existsSync(store)) continue;
    const prefix = `${name.replace("/", "+")}@${version ?? ""}`;
    const entry = NodeFS.readdirSync(store)
      .filter((dir) => dir.startsWith(prefix))
      .sort()
      .pop();
    if (entry) return NodePath.join(store, entry, "node_modules", name);
  }
  return null;
}

function readJson(path) {
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}

function threeDirectory() {
  const linked = packageDirectory("three", THREE_VERSION);
  if (linked) return { dir: linked, source: "workspace" };
  const dir = NodePath.join(vendorDir, "three");
  if (!NodeFS.existsSync(NodePath.join(dir, "package.json"))) {
    const tarball = NodePath.join(vendorDir, `three-${THREE_VERSION}.tgz`);
    NodeFS.mkdirSync(dir, { recursive: true });
    if (!NodeFS.existsSync(tarball)) {
      NodeChildProcess.execFileSync(
        "curl",
        ["-sSfL", "--max-time", "900", "-o", tarball, THREE_TARBALL],
        { stdio: "inherit" },
      );
    }
    const digest = `sha512-${NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(tarball)).digest("base64")}`;
    if (digest !== THREE_INTEGRITY) throw new Error(`three tarball integrity mismatch: ${digest}`);
    NodeChildProcess.execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"]);
  }
  return { dir, source: "learnordie pin (qa/dist/vendor)" };
}

function fontCss() {
  const faces = [
    ["Excalifont", "Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"],
    ["Virgil", "Virgil/Virgil-Regular.woff2"],
    ["Learnordie Sketch", "Virgil/Virgil-Regular.woff2"],
  ];
  const rules = [];
  for (const [family, file] of faces) {
    const path = NodePath.join(FONT_DIR, file);
    if (!NodeFS.existsSync(path)) {
      console.warn(`font missing, falling back to system fonts: ${path}`);
      continue;
    }
    const data = NodeFS.readFileSync(path).toString("base64");
    rules.push(
      `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-display:swap}`,
    );
  }
  return rules.join("\n");
}

const esbuildDir = packageDirectory("esbuild", "0.28.1") ?? packageDirectory("esbuild");
if (!esbuildDir) throw new Error("esbuild not found; run pnpm install first");
const esbuild = NodeModule.createRequire(NodePath.join(esbuildDir, "package.json"))(esbuildDir);
const three = threeDirectory();
const alias = { three: three.dir };
for (const name of ["react", "react-dom", "zod"]) {
  const dir = packageDirectory(name);
  if (!dir) throw new Error(`${name} not found; run pnpm install first`);
  alias[name] = dir;
}

NodeFS.mkdirSync(distDir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(distDir, "fonts.css"), fontCss());
const result = await esbuild.build({
  entryPoints: [NodePath.join(qaDir, "scenes-qa.tsx")],
  outfile: NodePath.join(distDir, "scenes-qa.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: false,
  sourcemap: false,
  alias,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  metafile: true,
});
const bytes = NodeFS.statSync(NodePath.join(distDir, "scenes-qa.js")).size;
const threeInput = Object.keys(result.metafile.inputs).find((input) =>
  input.includes("three.module.js"),
);
console.log(
  `esbuild ${esbuild.version}; three ${THREE_VERSION} from ${three.source}${threeInput ? "" : " (not bundled!)"}`,
);
console.log(`wrote qa/dist/scenes-qa.js (${bytes} bytes) and qa/dist/fonts.css`);
