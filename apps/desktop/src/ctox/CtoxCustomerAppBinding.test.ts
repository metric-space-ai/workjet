// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - validates real filesystem hashing and Ed25519 signatures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  authorizedCtoxRuntimeModuleKeys,
  ctoxCustomerPackageSha256,
  ctoxRuntimeModuleKey,
} from "./CtoxCustomerAppBinding.ts";

async function fixture(): Promise<{
  readonly base: string;
  readonly instanceModuleRoot: string;
}> {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-customer-app-"));
  const runtime = NodePath.join(base, "runtime");
  const instanceModuleRoot = NodePath.join(runtime, "business-os");
  await NodeFSP.mkdir(instanceModuleRoot, { recursive: true });
  const identity = NodePath.join(runtime, "business-os-instance-id");
  await NodeFSP.writeFile(identity, "biz_allowed\n", { mode: 0o600 });
  await NodeFSP.chmod(identity, 0o600);
  return { base, instanceModuleRoot };
}

async function writeModule(input: {
  readonly instanceModuleRoot: string;
  readonly id: string;
  readonly distribution?: string;
}): Promise<string> {
  const moduleDir = NodePath.join(input.instanceModuleRoot, "installed-modules", input.id);
  await NodeFSP.mkdir(moduleDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(moduleDir, "module.json"),
    JSON.stringify({
      id: input.id,
      version: "1.2.3",
      ...(input.distribution === undefined ? {} : { distribution: input.distribution }),
    }),
  );
  await NodeFSP.writeFile(NodePath.join(moduleDir, "index.html"), "private application");
  return moduleDir;
}

async function bindModule(input: {
  readonly moduleDir: string;
  readonly moduleId: string;
  readonly allowedInstanceIds: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const signingKeyId = "test-customer-key";
  const payload = {
    type: "ctox.business-os.customer-app-binding.v1",
    customerId: "customer-opaque",
    moduleId: input.moduleId,
    allowedInstanceIds: input.allowedInstanceIds,
    packageVersion: "1.2.3",
    packageSha256: ctoxCustomerPackageSha256(input.moduleDir),
    signingKeyId,
  } as const;
  const signature = NodeCrypto.sign(
    null,
    Buffer.from(JSON.stringify(payload), "utf8"),
    privateKey,
  ).toString("hex");
  await NodeFSP.writeFile(
    NodePath.join(input.moduleDir, "customer-app-binding.json"),
    JSON.stringify({ ...payload, signature }),
  );
  return {
    [signingKeyId]: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

describe("CTOX customer app binding", () => {
  it("admits public runtime modules and blocks unbound customer modules", async () => {
    const current = await fixture();
    try {
      await writeModule({ instanceModuleRoot: current.instanceModuleRoot, id: "public-app" });
      await writeModule({
        instanceModuleRoot: current.instanceModuleRoot,
        id: "rem-private",
        distribution: "customer",
      });

      expect([...authorizedCtoxRuntimeModuleKeys(current.instanceModuleRoot)]).toEqual([
        "installed-modules/public-app",
      ]);
    } finally {
      await NodeFSP.rm(current.base, { recursive: true, force: true });
    }
  });

  it("admits only an untampered package signed for this exact instance", async () => {
    const current = await fixture();
    try {
      const moduleDir = await writeModule({
        instanceModuleRoot: current.instanceModuleRoot,
        id: "rem-private",
        distribution: "customer",
      });
      const trustKeys = await bindModule({
        moduleDir,
        moduleId: "rem-private",
        allowedInstanceIds: ["biz_allowed"],
      });
      expect([...authorizedCtoxRuntimeModuleKeys(current.instanceModuleRoot, trustKeys)]).toEqual([
        "installed-modules/rem-private",
      ]);

      await NodeFSP.writeFile(NodePath.join(moduleDir, "index.html"), "tampered");
      expect([...authorizedCtoxRuntimeModuleKeys(current.instanceModuleRoot, trustKeys)]).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(current.base, { recursive: true, force: true });
    }
  });

  it("blocks a valid signature that names another instance", async () => {
    const current = await fixture();
    try {
      const moduleDir = await writeModule({
        instanceModuleRoot: current.instanceModuleRoot,
        id: "thesen-private",
        distribution: "private",
      });
      const trustKeys = await bindModule({
        moduleDir,
        moduleId: "thesen-private",
        allowedInstanceIds: ["biz_other"],
      });
      expect([...authorizedCtoxRuntimeModuleKeys(current.instanceModuleRoot, trustKeys)]).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(current.base, { recursive: true, force: true });
    }
  });

  it("extracts only exact runtime module path keys", () => {
    expect(ctoxRuntimeModuleKey("installed-modules/app/index.js")).toBe("installed-modules/app");
    expect(ctoxRuntimeModuleKey("local-modules/app/icon.svg")).toBe("local-modules/app");
    expect(ctoxRuntimeModuleKey("modules/app/index.js")).toBeUndefined();
  });
});
