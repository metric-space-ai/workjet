import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { generateWorkjetInstallManifest } from "./generate-workjet-install-manifest.mjs";

NodeTest.test("generates the complete signed-release target matrix", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-install-manifest-"));
  try {
    for (const name of [
      "Workjet-1.2.3-arm64.dmg",
      "Workjet-1.2.3-x64.dmg",
      "Workjet-1.2.3-arm64.AppImage",
      "Workjet-1.2.3-x64.AppImage",
      "Workjet-1.2.3-x64.exe",
      "Workjet-1.2.3-arm64.exe",
    ])
      await NodeFSP.writeFile(NodePath.join(root, name), name);
    const output = NodePath.join(root, "manifest.json");
    const manifest = await generateWorkjetInstallManifest({
      assetsDir: root,
      tag: "v1.2.3",
      version: "1.2.3",
      repository: "metric-space-ai/workjet",
      output,
    });
    NodeAssert.equal(manifest.productName, "Workjet");
    NodeAssert.equal(manifest.artifacts.length, 5);
    NodeAssert.deepEqual(
      manifest.artifacts.map(({ platform, arch }) => `${platform}/${arch}`),
      ["macos/arm64", "linux/arm64", "linux/x64", "windows/x64", "windows/arm64"],
    );
    NodeAssert.ok(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "explicit targets preserve the full default and reject unknown or duplicate scopes",
  async () => {
    const { selectReleaseTargets } = await import("./lib/workjet-release-targets.mjs");
    NodeAssert.equal(selectReleaseTargets().length, 5);
    NodeAssert.equal(selectReleaseTargets("macos/arm64,macos/x64,linux/x64").length, 3);
    for (const invalid of ["", "linux", "linux/x64,linux/x64", "macos/ppc"]) {
      NodeAssert.throws(() => selectReleaseTargets(invalid));
    }
  },
);

async function draftFixture(run) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-draft-assets-"));
  const targets = "macos/arm64,macos/x64,linux/x64";
  try {
    for (const name of [
      "Workjet-1.2.3-arm64.dmg",
      "Workjet-1.2.3-x64.dmg",
      "Workjet-1.2.3-arm64.zip",
      "Workjet-1.2.3-x64.zip",
      "Workjet-1.2.3-x64.AppImage",
      "Workjet-1.2.3-x64.deb",
      "latest-mac.yml",
      "latest-linux.yml",
    ])
      await NodeFSP.writeFile(NodePath.join(root, name), name);
    await generateWorkjetInstallManifest({
      assetsDir: root,
      tag: "v1.2.3",
      version: "1.2.3",
      repository: "metric-space-ai/workjet",
      output: NodePath.join(root, "workjet-desktop-install-manifest-v1.json"),
      targets,
    });
    const { spawnSync } = await import("node:child_process");
    const verify = (selection = targets) =>
      spawnSync(
        process.execPath,
        [
          new URL("./verify-workjet-release-assets.mjs", import.meta.url).pathname,
          root,
          ...(selection === null ? [] : ["--targets", selection]),
        ],
        { encoding: "utf8" },
      );
    await run({ root, verify });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

NodeTest.test("scoped draft verifies the requested installers without Windows or Linux arm64", () =>
  draftFixture(({ verify }) => {
    const result = verify();
    NodeAssert.equal(result.status, 0, result.stderr);
    // No explicit scope still enforces the historical complete release matrix.
    const complete = verify(null);
    NodeAssert.notEqual(complete.status, 0);
  }),
);

for (const filename of [
  "Workjet-1.2.3-x64.zip",
  "Workjet-1.2.3-x64.deb",
  "Workjet-1.2.3-arm64.dmg",
]) {
  NodeTest.test(`draft fails when ${filename} is missing`, () =>
    draftFixture(async ({ root, verify }) => {
      await NodeFSP.rm(NodePath.join(root, filename));
      NodeAssert.notEqual(verify().status, 0);
    }),
  );
}

NodeTest.test("draft rejects corrupted primary installer bytes", () =>
  draftFixture(async ({ root, verify }) => {
    await NodeFSP.writeFile(NodePath.join(root, "Workjet-1.2.3-x64.AppImage"), "corrupted");
    const result = verify();
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /Checksum mismatch/);
  }),
);

NodeTest.test("release workflow uses hosted runners and cannot publish or deploy", async () => {
  const { parseDocument } = await import("yaml");
  const source = await NodeFSP.readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const document = parseDocument(source, { uniqueKeys: true });
  NodeAssert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  NodeAssert.equal(workflow.on.schedule, undefined);
  NodeAssert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  NodeAssert.deepEqual(
    workflow.jobs.build.strategy.matrix.include.map(({ runner }) => runner),
    ["macos-15", "ubuntu-24.04", "ubuntu-24.04-arm", "windows-latest", "windows-11-arm"],
  );
  NodeAssert.deepEqual(Object.keys(workflow.jobs).sort(), [
    "build",
    "preflight",
    "release",
    "ssh_servers",
  ]);
  const writer = workflow.jobs.release.steps.find(({ uses }) =>
    uses?.startsWith("softprops/action-gh-release@"),
  );
  NodeAssert.equal(writer.with.draft, true);
  NodeAssert.equal(writer.with.make_latest, false);
  NodeAssert.match(writer.with.prerelease, /notarized != 'true'/);
  NodeAssert.match(source, /nicht notarisiert/);
  NodeAssert.doesNotMatch(source, /blacksmith|npm publish|vercel deploy|git push/);
  NodeAssert.match(source, /refusing to overwrite/i);
  // Check bash syntax without executing any workflow commands or credentials.
  const { spawnSync } = await import("node:child_process");
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps || []) {
      if (!step.run || step.shell === "pwsh") continue;
      const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      NodeAssert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
    }
  }
});

NodeTest.test("Apple credentials are optional; incomplete signing stays ad-hoc", async () => {
  const { parse } = await import("yaml");
  const { spawnSync } = await import("node:child_process");
  const workflow = parse(
    await NodeFSP.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.preflight.steps.find(({ id }) => id === "signing");
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-signing-flags-"));
  const complete = {
    CSC_LINK: "synthetic-certificate",
    APPLE_TEAM_ID: "synthetic-team",
    MACOS_PROVISIONING_PROFILE: "synthetic-profile",
    RP_DOMAINS: "example.test",
  };
  try {
    for (const [credentials, expected] of [
      [{}, "signed=false\nnotarized=false\n"],
      [{ CSC_LINK: "synthetic-certificate" }, "signed=true\nnotarized=false\n"],
      [complete, "signed=true\nnotarized=false\n"],
      [
        {
          ...complete,
          APPLE_API_KEY: "synthetic-key",
          APPLE_API_KEY_ID: "synthetic-id",
          APPLE_API_ISSUER: "synthetic-issuer",
        },
        "signed=true\nnotarized=true\n",
      ],
    ]) {
      const output = NodePath.join(root, "output");
      await NodeFSP.writeFile(output, "");
      const result = spawnSync("bash", ["-eu", "-c", step.run], {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          ...Object.fromEntries(Object.keys(step.env).map((key) => [key, ""])),
          ...credentials,
        },
        encoding: "utf8",
      });
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.equal(
        await NodeFSP.readFile(output, "utf8"),
        `${expected}windows_signing=unsigned\n`,
      );
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "the required five-platform release fails for any missing installer or feed",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-required-release-"));
    const targets = "macos/arm64,linux/x64,linux/arm64,windows/x64,windows/arm64";
    const assets = [
      "Workjet-1.2.3-arm64.dmg",
      "Workjet-1.2.3-arm64.zip",
      "Workjet-1.2.3-x64.AppImage",
      "Workjet-1.2.3-x64.deb",
      "Workjet-1.2.3-arm64.AppImage",
      "Workjet-1.2.3-arm64.deb",
      "Workjet-1.2.3-x64.exe",
      "Workjet-1.2.3-arm64.exe",
      "latest-mac.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
      "latest.yml",
    ];
    try {
      for (const filename of assets)
        await NodeFSP.writeFile(NodePath.join(root, filename), filename);
      await generateWorkjetInstallManifest({
        assetsDir: root,
        tag: "v1.2.3",
        version: "1.2.3",
        repository: "metric-space-ai/workjet",
        output: NodePath.join(root, "workjet-desktop-install-manifest-v1.json"),
        targets,
      });
      const { spawnSync } = await import("node:child_process");
      const verify = () =>
        spawnSync(
          process.execPath,
          [
            new URL("./verify-workjet-release-assets.mjs", import.meta.url).pathname,
            root,
            "--targets",
            targets,
          ],
          { encoding: "utf8" },
        );
      NodeAssert.equal(verify().status, 0);
      for (const filename of assets) {
        await NodeFSP.rm(NodePath.join(root, filename));
        NodeAssert.notEqual(verify().status, 0, filename);
        await NodeFSP.writeFile(NodePath.join(root, filename), filename);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("Windows chooses complete Azure, otherwise PFX, otherwise unsigned", async () => {
  const { parse } = await import("yaml");
  const { spawnSync } = await import("node:child_process");
  const workflow = parse(
    await NodeFSP.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.preflight.steps.find(({ id }) => id === "signing");
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-windows-signing-"));
  try {
    for (const [credentials, mode] of [
      [{}, "unsigned"],
      [{ WIN_CSC_LINK: "synthetic-pfx" }, "pfx"],
      [{ WIN_CSC_LINK: "synthetic-pfx", AZURE_CLIENT_ID: "synthetic-client" }, "pfx"],
      [
        {
          WIN_CSC_LINK: "synthetic-pfx",
          AZURE_TENANT_ID: "synthetic-tenant",
          AZURE_CLIENT_ID: "synthetic-client",
          AZURE_CLIENT_SECRET: "synthetic-secret",
          AZURE_PROFILE: "synthetic-profile",
          AZURE_PUBLISHER: "synthetic-publisher",
        },
        "azure",
      ],
    ]) {
      const output = NodePath.join(root, "output");
      await NodeFSP.writeFile(output, "");
      const result = spawnSync("bash", ["-eu", "-c", step.run], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          ...Object.fromEntries(Object.keys(step.env).map((key) => [key, ""])),
          ...credentials,
        },
      });
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.match(
        await NodeFSP.readFile(output, "utf8"),
        new RegExp(`windows_signing=${mode}\\n`),
      );
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
