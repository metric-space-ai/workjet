import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const MOBILE_BUNDLE_TYPE = "workjet.bundled-business-os-shell.v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Derive resources only after the upstream release verifier has accepted sourceRoot. */
export async function writeMobileBusinessOsBundle({ sourceRoot, outputRoot, release, catalog }) {
  await fs.mkdir(outputRoot);
  const payload = path.join(outputRoot, "payload");
  await fs.mkdir(payload, { recursive: true });
  const files = [];
  async function write(relative, bytes) {
    const target = path.join(payload, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    files.push({ path: relative, size: bytes.length, sha256: digest(bytes) });
  }
  async function visit(relative = "") {
    const entries = await fs.readdir(path.join(sourceRoot, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        name === "vendor/ctox-office" ||
        name === "mobile-apps.json" ||
        name === "ctox-shell-manifest.json" ||
        name.startsWith(".")
      )
        continue;
      if (entry.isSymbolicLink()) throw new Error(`Shell bundle contains a symbolic link: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) await write(name, await fs.readFile(path.join(sourceRoot, name)));
      else throw new Error(`Unsupported shell bundle entry: ${name}`);
    }
  }
  await visit();
  // The native catalog belongs to the signed Workjet binary. Earlier verified
  // desktop archives contain mobile-host.js but omit this host-specific catalog.
  await write(
    "mobile-apps.json",
    Buffer.from(
      JSON.stringify({
        type: catalog.type,
        revision: catalog.revision,
        apps: catalog.apps.map(({ icon: _nativeSymbol, ...app }) => app),
      }),
    ),
  );
  for (const required of ["index.html", "mobile-host.js", "mobile-host.css", "mobile-apps.json"]) {
    if (!files.some((file) => file.path === required))
      throw new Error(`Missing mobile shell entry: ${required}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const inventory = { type: MOBILE_BUNDLE_TYPE, upstream: release, files };
  const manifest = { ...inventory, packId: digest(JSON.stringify(inventory)) };
  await fs.writeFile(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}
