// @effect-diagnostics globalDate:off globalFetch:off globalTimers:off nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { CdpClient, MAX_CDP_MESSAGE_BYTES } from "./lib/cdpClient.ts";

const MAX_TARGETS = 32;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_PORT = 9300;

export interface AuditArguments {
  readonly port: number;
  readonly output: string;
}

export interface AuditViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface AuditState {
  readonly name: string;
  readonly hash: string;
  readonly interaction?:
    | "attachment"
    | "command-palette"
    | "computer"
    | "harness"
    | "model"
    | "reasoning"
    | "right-panel"
    | "system-prompt"
    | "terminal"
    | "tools"
    | "worker";
}

export const AUDIT_VIEWPORTS: readonly AuditViewport[] = [
  { name: "wide", width: 1512, height: 890 },
  { name: "compact", width: 1180, height: 820 },
  { name: "narrow", width: 860, height: 720 },
];

export const CODE_AUDIT_STATES: readonly AuditState[] = [
  { name: "draft", hash: "#/" },
  { name: "settings-general", hash: "#/settings/general" },
  { name: "settings-appearance", hash: "#/settings/appearance" },
  { name: "settings-keybindings", hash: "#/settings/keybindings" },
  { name: "settings-harnesses", hash: "#/settings/harnesses" },
  { name: "settings-models", hash: "#/settings/models" },
  { name: "settings-computers", hash: "#/settings/computers" },
  { name: "settings-worker", hash: "#/settings/workjet" },
  { name: "settings-source-control", hash: "#/settings/source-control" },
  { name: "settings-connections", hash: "#/settings/connections" },
  { name: "settings-diagnostics", hash: "#/settings/diagnostics" },
  { name: "settings-archive", hash: "#/settings/archived" },
  { name: "machines", hash: "#/machines" },
  { name: "usage", hash: "#/usage" },
  { name: "pull-requests", hash: "#/pull-requests" },
  { name: "draft-attachment-menu", hash: "#/", interaction: "attachment" },
  { name: "draft-worker-menu", hash: "#/", interaction: "worker" },
  { name: "draft-computer-menu", hash: "#/", interaction: "computer" },
  { name: "draft-harness-menu", hash: "#/", interaction: "harness" },
  { name: "draft-model-menu", hash: "#/", interaction: "model" },
  { name: "draft-reasoning-menu", hash: "#/", interaction: "reasoning" },
  { name: "draft-system-prompt", hash: "#/", interaction: "system-prompt" },
  { name: "draft-tools-menu", hash: "#/", interaction: "tools" },
  { name: "draft-command-palette", hash: "#/", interaction: "command-palette" },
  { name: "draft-terminal", hash: "#/", interaction: "terminal" },
  { name: "draft-right-panel", hash: "#/", interaction: "right-panel" },
];

interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

interface StateResult {
  readonly state: string;
  readonly viewport: string;
  readonly screenshot: string;
  readonly location: string;
  readonly title: string;
  readonly documentOverflowX: number;
  readonly clippedInteractive: readonly unknown[];
  readonly duplicateActions: readonly unknown[];
  readonly tinyControls: readonly unknown[];
  readonly truncatedText: readonly unknown[];
  readonly consoleErrors: readonly unknown[];
}

function defaultOutput(now = new Date()): string {
  return NodePath.join("/tmp", `workjet-ui-audit-${now.toISOString().replaceAll(/[:.]/gu, "-")}`);
}

export function parseAuditArguments(argv: readonly string[], now = new Date()): AuditArguments {
  let port = DEFAULT_PORT;
  let output = defaultOutput(now);
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--port") {
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
        throw new Error("port must be an integer from 1 through 65535");
    } else if (flag === "--output") {
      if (!NodePath.isAbsolute(value)) throw new Error("output must be an absolute path");
      output = NodePath.resolve(value);
    } else {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
  }
  return { port, output };
}

export function summarizeAudit(results: readonly StateResult[]): {
  readonly captures: number;
  readonly failingCaptures: number;
  readonly findings: number;
  readonly warnings: number;
} {
  let failingCaptures = 0;
  let findings = 0;
  let warnings = 0;
  for (const result of results) {
    const count =
      (result.documentOverflowX > 1 ? 1 : 0) +
      result.clippedInteractive.length +
      result.consoleErrors.length;
    if (count > 0) failingCaptures += 1;
    findings += count;
    warnings +=
      result.duplicateActions.length + result.tinyControls.length + result.truncatedText.length;
  }
  return { captures: results.length, failingCaptures, findings, warnings };
}

export function createReviewBatches<T>(
  items: readonly T[],
  maximum = 4,
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4)
    throw new Error("review batch size must be an integer from 1 through 4");
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += maximum) {
    batches.push(items.slice(index, index + maximum));
  }
  return batches;
}

async function fetchTargets(port: number): Promise<readonly CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  if (response === undefined || !response.ok) throw new Error("CDP target list is unavailable");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CDP_MESSAGE_BYTES)
    throw new Error("CDP target list is too large");
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS) throw new Error("invalid CDP target list");
  return raw.flatMap((item): CdpTarget[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.type !== "string" ||
      typeof record.url !== "string"
    )
      return [];
    return [
      {
        id: record.id,
        type: record.type,
        url: record.url,
        ...(typeof record.webSocketDebuggerUrl === "string"
          ? { webSocketDebuggerUrl: record.webSocketDebuggerUrl }
          : {}),
      },
    ];
  });
}

export function selectWorkjetTarget(targets: readonly CdpTarget[]): CdpTarget {
  const matches = targets.filter(
    (target) =>
      target.type === "page" &&
      /^t3code(?:-dev|-preview)?:\/\/app\//u.test(target.url) &&
      target.webSocketDebuggerUrl !== undefined,
  );
  if (matches.length !== 1)
    throw new Error(`Workjet target selection found ${matches.length} matches`);
  return matches[0]!;
}

const AUDIT_EXPRESSION = String.raw`(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const text = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return { left: round(value.left), top: round(value.top), right: round(value.right), bottom: round(value.bottom), width: round(value.width), height: round(value.height) };
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const value = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && value.width > 0 && value.height > 0 && value.right > 0 && value.bottom > 0 && value.left < innerWidth && value.top < innerHeight;
  };
  const selector = 'button,a[href],input,select,textarea,[role="button"],[role="menuitem"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  const interactive = [...document.querySelectorAll(selector)].filter(visible);
  const clipRect = (element) => {
    let result = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) continue;
      const value = ancestor.getBoundingClientRect();
      result = { left: Math.max(result.left, value.left), top: Math.max(result.top, value.top), right: Math.min(result.right, value.right), bottom: Math.min(result.bottom, value.bottom) };
    }
    return result;
  };
  const clippedInteractive = interactive.flatMap((element) => {
    const value = element.getBoundingClientRect();
    const clip = clipRect(element);
    const visibleWidth = Math.max(0, Math.min(value.right, clip.right) - Math.max(value.left, clip.left));
    const visibleHeight = Math.max(0, Math.min(value.bottom, clip.bottom) - Math.max(value.top, clip.top));
    if (visibleWidth >= value.width - 1) return [];
    return [{ label: text(element), rect: rect(element), visibleWidthRatio: round(visibleWidth / value.width), visibleHeightRatio: round(visibleHeight / value.height) }];
  }).slice(0, 40);
  const actionGroups = new Map();
  for (const element of interactive) {
    const label = text(element).toLocaleLowerCase();
    if (label.length === 0) continue;
    const values = actionGroups.get(label) || [];
    values.push(rect(element));
    actionGroups.set(label, values);
  }
  const duplicateActions = [...actionGroups.entries()].filter(([, values]) => values.length > 1).map(([label, values]) => ({ label, count: values.length, rects: values })).slice(0, 20);
  const tinyControls = interactive.filter((element) => {
    const value = element.getBoundingClientRect();
    return value.width < 24 || value.height < 24;
  }).map((element) => ({ label: text(element), rect: rect(element) })).slice(0, 40);
  const truncatedText = [...document.querySelectorAll('button,a,label,h1,h2,h3,p,span,td,th')].filter((element) => visible(element) && element.scrollWidth > element.clientWidth + 1 && /(hidden|clip)/.test(getComputedStyle(element).overflow + getComputedStyle(element).textOverflow)).map((element) => ({ label: text(element), rect: rect(element), hiddenPixels: element.scrollWidth - element.clientWidth })).slice(0, 60);
  return {
    location: location.hash,
    title: document.title,
    documentOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    clippedInteractive,
    duplicateActions,
    tinyControls,
    truncatedText
  };
})()`;

function consoleMessage(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return { kind: "unknown" };
  const record = params as Record<string, unknown>;
  return { kind: typeof record.type === "string" ? record.type : "error" };
}

async function settle(client: CdpClient): Promise<void> {
  await client.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200))))`,
    2_000,
  );
}

async function pressKey(client: CdpClient, key: string, modifiers = 0): Promise<void> {
  await client.command("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers });
  await client.command("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
}

async function prepareState(
  client: CdpClient,
  interaction: AuditState["interaction"],
): Promise<void> {
  if (interaction !== undefined) {
    await pressKey(client, "Escape");
    await pressKey(client, "Escape");
  }
  await client.evaluate(`(() => {
    for (const label of ["Toggle terminal drawer", "Toggle right panel"]) {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label);
      if (button?.getAttribute("aria-pressed") === "true") button.click();
    }
  })()`);
  if (interaction === undefined) return;
  if (interaction === "command-palette") {
    await pressKey(client, "k", 4);
    return;
  }
  const labels: Readonly<
    Record<Exclude<AuditState["interaction"], undefined | "command-palette" | "reasoning">, string>
  > = {
    attachment: "Add images or project files",
    computer: "Computer",
    harness: "Harness",
    model: "Model",
    "right-panel": "Toggle right panel",
    "system-prompt": "System prompt",
    terminal: "Toggle terminal drawer",
    tools: "Thread tools",
    worker: "Worker",
  };
  await client.evaluate(`(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    const more = buttons.find((candidate) => candidate.getAttribute("aria-label") === "More composer controls");
    if (more) more.click();
  })()`);
  await settle(client);
  if (interaction === "reasoning") {
    await client.evaluate(
      `([...document.querySelectorAll("button")].filter((element) => element.getBoundingClientRect().width > 0).find((element) => /^(Low|Medium|High|Extra high|Max|Ultra)(?:\\s|·)/u.test((element.textContent || "").trim())))?.click()`,
    );
    return;
  }
  const label = labels[interaction];
  await client.evaluate(
    `([...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === ${JSON.stringify(label)}))?.click()`,
  );
}

async function waitForRoute(client: CdpClient, hash: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const current = await client.evaluate("location.hash");
    if (
      (hash === "#/" && typeof current === "string" && /^#\/(?:draft\/[^/]+)?$/u.test(current)) ||
      current === hash
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`route did not settle: ${hash}`);
}

async function runAudit(args: AuditArguments): Promise<void> {
  NodeFS.mkdirSync(args.output, { recursive: true });
  const target = selectWorkjetTarget(await fetchTargets(args.port));
  const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
  const consoleErrors: unknown[] = [];
  client.on("Runtime.consoleAPICalled", (params) => {
    if (
      typeof params === "object" &&
      params !== null &&
      (params as Record<string, unknown>).type === "error"
    )
      consoleErrors.push(consoleMessage(params));
  });
  client.on("Runtime.exceptionThrown", () => consoleErrors.push({ kind: "exception" }));
  await client.command("Runtime.enable", {});
  await client.command("Page.enable", {});
  const results: StateResult[] = [];
  try {
    for (const viewport of AUDIT_VIEWPORTS) {
      await client.command("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const state of CODE_AUDIT_STATES) {
        const consoleAtStart = consoleErrors.length;
        await client.evaluate(`location.hash = ${JSON.stringify(state.hash)}`);
        await waitForRoute(client, state.hash);
        await settle(client);
        await prepareState(client, state.interaction);
        await settle(client);
        await client.evaluate(
          `document.querySelectorAll('[data-sonner-toast] button[aria-label]').forEach((button) => button.click())`,
        );
        await settle(client);
        const audit = await client.evaluate(AUDIT_EXPRESSION);
        if (typeof audit !== "object" || audit === null)
          throw new Error("audit expression returned no result");
        const screenshotResult = await client.command(
          "Page.captureScreenshot",
          { format: "png", fromSurface: true },
          10_000,
        );
        const screenshotData =
          typeof screenshotResult === "object" && screenshotResult !== null
            ? (screenshotResult as Record<string, unknown>).data
            : undefined;
        if (
          typeof screenshotResult !== "object" ||
          screenshotResult === null ||
          typeof screenshotData !== "string"
        )
          throw new Error("screenshot capture returned no data");
        const bytes = Buffer.from(screenshotData, "base64");
        if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("screenshot exceeded size limit");
        const screenshot = `${viewport.name}-${state.name}.png`;
        NodeFS.writeFileSync(NodePath.join(args.output, screenshot), bytes);
        results.push({
          state: state.name,
          viewport: viewport.name,
          screenshot,
          ...(audit as Omit<StateResult, "state" | "viewport" | "screenshot" | "consoleErrors">),
          consoleErrors: consoleErrors.slice(consoleAtStart),
        });
        process.stdout.write(`captured ${viewport.name}/${state.name}\n`);
      }
    }
  } finally {
    await client.command("Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
    client.close();
  }
  const summary = summarizeAudit(results);
  NodeFS.writeFileSync(
    NodePath.join(args.output, "audit.json"),
    JSON.stringify({ summary, results }, null, 2) + "\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(args.output, "review-batches.json"),
    JSON.stringify(
      createReviewBatches(
        results.map(({ state, viewport, screenshot }) => ({ state, viewport, screenshot })),
      ).map((captures, index) => ({ batch: index + 1, captures })),
      null,
      2,
    ) + "\n",
  );
  const markdown = [
    "# Workjet UI audit",
    "",
    `- Captures: ${summary.captures}`,
    `- Captures with blocking findings: ${summary.failingCaptures}`,
    `- Blocking findings: ${summary.findings}`,
    `- Review warnings: ${summary.warnings}`,
    "",
    "Truncation is inventoried separately because some labels intentionally ellipsize.",
    "",
    "| Viewport | State | Overflow | Clipped | Duplicate actions | Tiny controls | Console errors | Truncated text |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(
      (result) =>
        `| ${result.viewport} | ${result.state} | ${result.documentOverflowX} | ${result.clippedInteractive.length} | ${result.duplicateActions.length} | ${result.tinyControls.length} | ${result.consoleErrors.length} | ${result.truncatedText.length} |`,
    ),
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(args.output, "audit.md"), markdown);
  process.stdout.write(`report ${NodePath.join(args.output, "audit.md")}\n`);
}

const isMain = import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  runAudit(parseAuditArguments(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "UI audit failed"}\n`);
    process.exitCode = 1;
  });
}
