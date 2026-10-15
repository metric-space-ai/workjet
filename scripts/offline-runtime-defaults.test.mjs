import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const runtimeRoots = ["apps/marketing/src", "apps/web/src", "apps/desktop/src", "apps/server/src"];
const read = (path) => NodeFSP.readFile(NodePath.join(root, path), "utf8");

async function sourceFiles(directory) {
  const entries = await NodeFSP.readdir(NodePath.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (
      /\.(?:astro|[cm]?[jt]sx?|css|html)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
    )
      files.push(path);
  }
  return files;
}

NodeTest.test(
  "runtime sources have no Google Fonts or external price-table URL; PostHog has one consent-gated sender",
  async () => {
    for (const directory of runtimeRoots) {
      for (const path of await sourceFiles(directory)) {
        const source = await read(path);
        NodeAssert.doesNotMatch(source, /fonts\.(?:googleapis|gstatic)\.com/i, path);
        NodeAssert.doesNotMatch(
          source,
          /raw\.githubusercontent\.com[^\s"'`]*model_prices_and_context_window/i,
          path,
        );
        if (path !== "apps/server/src/telemetry/AnalyticsService.ts") {
          // Settings display the destination and expose it as a search alias.
          const destinationCopy =
            path === "apps/web/src/components/settings/SettingsPanels.tsx" ||
            path === "apps/web/src/components/settings/settingsSearch.ts";
          NodeAssert.doesNotMatch(
            source,
            destinationCopy ? /https?:\/\/us\.i\.posthog\.com/i : /us\.i\.posthog\.com/i,
            path,
          );
        }
      }
    }
    const analytics = await read("apps/server/src/telemetry/AnalyticsService.ts");
    NodeAssert.match(analytics, /current\.posthogConsent/);
    NodeAssert.match(analytics, /if \(!\(yield\* hasConsent\)\) return;/);
    const usage = await read("apps/server/src/usage/UsageService.ts");
    NodeAssert.match(usage, /import bundledRates from "\.\/catalog\/model-rates\.json"/);
    NodeAssert.doesNotMatch(usage, /HttpClient|\bfetch\s*\(|usage-model-rates\.json/);
  },
);

NodeTest.test(
  "same-origin fonts and licenses are shipped with the exact pinned bytes",
  async () => {
    const layout = await read("apps/marketing/src/layouts/Layout.astro");
    for (const [name, hash] of [
      ["dm-sans", "8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d"],
      ["jetbrains-mono", "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda"],
    ]) {
      NodeAssert.ok(layout.includes(`url("/fonts/${name}.ttf")`), name);
      const bytes = await NodeFSP.readFile(
        NodePath.join(root, `apps/marketing/public/fonts/${name}.ttf`),
      );
      NodeAssert.equal(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), hash);
      NodeAssert.match(
        await read(`apps/marketing/public/fonts/${name}-OFL.txt`),
        /SIL OPEN FONT LICENSE Version 1\.1/,
      );
    }
  },
);

NodeTest.test(
  "each bundled price has live model provenance, positive rates and a version",
  async () => {
    const catalog = JSON.parse(await read("apps/server/src/usage/catalog/model-rates.json"));
    NodeAssert.equal(catalog.schemaVersion, 1);
    NodeAssert.match(catalog.version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
    const observed = new Set(
      catalog.liveCatalog.providers
        .filter((entry) => entry.status === "observed")
        .flatMap((entry) => entry.models),
    );
    NodeAssert.ok(Object.keys(catalog.document).length > 0);
    for (const [model, rates] of Object.entries(catalog.document)) {
      NodeAssert.ok(observed.has(model), model);
      for (const field of ["input_cost_per_token", "output_cost_per_token"])
        NodeAssert.ok(Number.isFinite(rates[field]) && rates[field] >= 0, `${model} ${field}`);
    }
  },
);
