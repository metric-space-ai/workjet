// @effect-diagnostics nodeBuiltinImport:off -- Validate the tracked package lock's opaque digests.
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const DIGEST_BYTES: Readonly<Record<string, number>> = {
  sha1: 20,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

describe("package lock integrity", () => {
  it("keeps registry checksums as canonical digests during product renames", async () => {
    const source = await NodeFSP.readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
    const lock = parse(source) as {
      packages: Record<string, { resolution?: { integrity?: string } }>;
    };
    const invalid: string[] = [];
    let checked = 0;
    for (const [name, entry] of Object.entries(lock.packages)) {
      const integrity = entry.resolution?.integrity;
      if (!integrity) continue;
      checked += 1;
      for (const value of integrity.split(/\s+/)) {
        const match = /^([a-z0-9]+)-([A-Za-z0-9+/]+=*)$/.exec(value);
        if (!match) {
          invalid.push(name);
          continue;
        }
        const algorithm = match[1]!;
        const encoded = match[2]!;
        const digest = NodeBuffer.Buffer.from(encoded, "base64");
        if (digest.length !== DIGEST_BYTES[algorithm] || digest.toString("base64") !== encoded) {
          invalid.push(name);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(invalid, "Registry integrity values are opaque data, not product identifiers.").toEqual(
      [],
    );
  });
});
