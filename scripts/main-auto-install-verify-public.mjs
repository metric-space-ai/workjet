import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const context = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = context.artifact.verificationRoot;
if (!path.isAbsolute(root)) throw new Error("verification_root_required");
const req = createRequire(path.join(root, "apps/desktop/package.json"));
const builder = createRequire(req.resolve("electron-builder"));
const library = createRequire(builder.resolve("app-builder-lib"));
const asar = library("@electron/asar");
// Only executable distribution metadata is inspected. No renderer/profile,
// Electron crypto, sessions, encrypted catalogs or cookies are opened.
const metadata = JSON.parse(
  asar.extractFile("/Applications/Workjet.app/Contents/Resources/app.asar", "package.json").toString("utf8"),
);
console.log(JSON.stringify({
  sourceVerified: metadata.workjetCommitHash === context.source.slice(0, 12)
    && metadata.version === context.artifact.buildVersion,
}));
