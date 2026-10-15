import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const context = JSON.parse(NodeFS.readFileSync(process.argv[2], "utf8"));
const root = context.artifact.verificationRoot;
if (!NodePath.isAbsolute(root)) throw new Error("verification_root_required");
const req = NodeModule.createRequire(NodePath.join(root, "apps/desktop/package.json"));
const builder = NodeModule.createRequire(req.resolve("electron-builder"));
const library = NodeModule.createRequire(builder.resolve("app-builder-lib"));
const asar = library("@electron/asar");
// Only executable distribution metadata is inspected. No renderer/profile,
// Electron crypto, sessions, encrypted catalogs or cookies are opened.
const metadata = JSON.parse(
  asar
    .extractFile("/Applications/Workjet.app/Contents/Resources/app.asar", "package.json")
    .toString("utf8"),
);
console.log(
  JSON.stringify({
    sourceVerified:
      metadata.workjetCommitHash === context.source.slice(0, 12) &&
      metadata.version === context.artifact.buildVersion,
  }),
);
