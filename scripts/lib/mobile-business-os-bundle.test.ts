import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { writeMobileBusinessOsBundle } from "./mobile-business-os-bundle.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-bundle-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(path.join(sourceRoot, "vendor/ctox-office"), { recursive: true });
  for (const name of [
    "index.html",
    "mobile-host.js",
    "mobile-host.css",
    "vendor/ctox-office/office.js",
  ]) {
    await fs.writeFile(
      path.join(sourceRoot, name),
      name === "index.html" ? "<html><head></head></html>" : name,
    );
  }
  const options = {
    sourceRoot,
    outputRoot: path.join(root, "bundle"),
    release: { version: "verified-test" },
    catalog: {
      type: "workjet.business-os-mobile-apps.v1",
      revision: "test",
      apps: [{ id: "threads", icon: "text.bubble", title: "Threads" }],
    },
  };
  return { root, options };
}

describe("Business OS resources inside the signed mobile binary", () => {
  it("includes the native catalog, preserves file hashes, and keeps Office separate", async () => {
    const { options } = await fixture();
    const result = await writeMobileBusinessOsBundle(options);
    const payload = path.join(options.outputRoot, "payload");
    expect(result.files.map((file: { path: string }) => file.path)).toEqual([
      "index.html",
      "mobile-apps.json",
      "mobile-host.css",
      "mobile-host.js",
    ]);
    for (const file of result.files) {
      const bytes = await fs.readFile(path.join(payload, file.path));
      expect(file.size).toBe(bytes.length);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(
      JSON.parse(await fs.readFile(path.join(payload, "mobile-apps.json"), "utf8")).apps,
    ).toEqual([{ id: "threads", title: "Threads" }]);
    await expect(fs.stat(path.join(payload, "vendor/ctox-office"))).rejects.toThrow();
    expect(result.packId).toMatch(/^[0-9a-f]{64}$/u);
    const repeated = await writeMobileBusinessOsBundle({
      ...options,
      outputRoot: `${options.outputRoot}-second`,
    });
    expect(repeated.packId).toBe(result.packId);
  });

  it("refuses missing entry points instead of packaging a launcher that cannot open apps", async () => {
    const { options } = await fixture();
    await fs.unlink(path.join(options.sourceRoot, "mobile-host.js"));
    await expect(writeMobileBusinessOsBundle(options)).rejects.toThrow(
      "Missing mobile shell entry: mobile-host.js",
    );
  });

  it("refuses links out of the verified source tree", async () => {
    const { root, options } = await fixture();
    await fs.writeFile(path.join(root, "private.txt"), "must not enter the bundle");
    await fs.symlink(path.join(root, "private.txt"), path.join(options.sourceRoot, "leak.txt"));
    await expect(writeMobileBusinessOsBundle(options)).rejects.toThrow("symbolic link");
  });
});
