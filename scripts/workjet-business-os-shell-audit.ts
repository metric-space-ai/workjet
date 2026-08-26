// @effect-diagnostics globalDate:off globalFetch:off globalTimers:off nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CdpClient } from "./lib/cdpClient.ts";

const DEFAULT_PORT = 9300;
const MAX_REVIEW_BATCH = 4;
const LOCAL_SHELL_TITLE = "(CTOX Local Instance)";

interface CdpTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

interface ShellState {
  readonly name: string;
  readonly action?: string;
  readonly expected?: string;
}

function appState(title: string): ShellState {
  return {
    name: `app-${title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/(^-|-$)/g, "")}`,
    action: `app:${title}`,
    expected: ".shell-window, [data-module-host]",
  };
}

export function createDiscoveredAppStates(
  titles: readonly string[],
  existingStates: readonly ShellState[] = SHELL_STATES,
): readonly ShellState[] {
  const existingTitles = new Set(
    existingStates
      .map((state) => state.action)
      .filter((action): action is string => Boolean(action?.startsWith("app:")))
      .map((action) => action.slice("app:".length)),
  );
  return [...new Set(titles.map((title) => title.trim()).filter(Boolean))]
    .filter((title) => !existingTitles.has(title))
    .sort((left, right) => left.localeCompare(right))
    .map(appState);
}

interface ShellAuditResult {
  readonly viewport: string;
  readonly state: string;
  readonly screenshot: string;
  readonly audit: {
    readonly documentOverflowX: number;
    readonly clippedControls: readonly unknown[];
    readonly unnamedControls: readonly unknown[];
    readonly openWindows: readonly unknown[];
  };
  readonly consoleErrors: readonly unknown[];
  readonly networkFailures: readonly unknown[];
}

const VIEWPORTS = [
  { name: "wide", width: 1512, height: 890 },
  { name: "compact", width: 1180, height: 820 },
  { name: "narrow", width: 860, height: 720 },
] as const;

const SHELL_STATES: readonly ShellState[] = [
  { name: "home" },
  {
    name: "release",
    action: "[data-shell-release-status]",
    expected: "[data-shell-release-panel]:not([hidden])",
  },
  { name: "start-menu", action: "[data-shell-start]", expected: ".shell-start-menu-panel" },
  { name: "account", action: "[data-open-account]", expected: "[data-drawer-right]:not([hidden])" },
  ...["runtime", "channels", "sync", "appearance", "mcp", "users", "activity", "admin"].map(
    (tab) => ({
      name: `settings-${tab}`,
      action: `settings:${tab}`,
      expected: `[data-drawer-right]:not([hidden]) [data-settings-tab="${tab}"]`,
    }),
  ),
  ...["CTOX", "Tickets", "Files", "Knowledge", "App Store"].map(appState),
  { name: "chat", action: "[data-chat-open]", expected: ".ctox-chat-window" },
  {
    name: "history",
    action: ".ctox-date-picker-trigger",
    expected: "[data-chat-date-workload-panel]",
  },
];

export function selectLocalBusinessOsTarget(targets: readonly CdpTarget[]): CdpTarget {
  const matches = targets.filter((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
    if (!target.title.includes(LOCAL_SHELL_TITLE)) return false;
    try {
      const url = new URL(target.url);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname === "/business-os/"
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1)
    throw new Error(`expected exactly one local Business OS shell target, found ${matches.length}`);
  return matches[0]!;
}

export function createReviewBatches<T>(items: readonly T[]): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_REVIEW_BATCH) {
    batches.push(items.slice(index, index + MAX_REVIEW_BATCH));
  }
  return batches;
}

function parseArguments(argv: readonly string[]): { port: number; output: string } {
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  let port = DEFAULT_PORT;
  let output = NodePath.join("/tmp", "workjet-business-os-shell-audit");
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--port") port = Number(value);
    else if (flag === "--output") output = NodePath.resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");
  if (!NodePath.isAbsolute(output)) throw new Error("output must be absolute");
  return { port, output };
}

async function fetchTargets(port: number): Promise<readonly CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed with ${response.status}`);
  return (await response.json()) as readonly CdpTarget[];
}

async function settle(client: CdpClient, timeout = 500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeout));
  await client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function resetOverlays(client: CdpClient): Promise<void> {
  for (let count = 0; count < 3; count += 1) {
    await client.command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    await client.command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
    });
  }
  await client.evaluate(`(() => {
    document.querySelector('[data-close-account]')?.click();
    document.querySelector('[data-close-settings]')?.click();
    const start = document.querySelector('.shell-start-menu-panel');
    if (start?.classList.contains('is-active')) document.querySelector('[data-shell-start]')?.click();
    const release = document.querySelector('[data-shell-release-panel]');
    if (release && !release.hidden) document.querySelector('[data-shell-release-status]')?.click();
    document.querySelector('[data-chat-date-workload-close]')?.click();
    document.querySelectorAll('.shell-window button[data-action="close"]').forEach((button) => button.click());
  })()`);
  await settle(client, 200);
}

async function prepareState(client: CdpClient, state: ShellState): Promise<void> {
  await resetOverlays(client);
  if (!state.action) return;
  if (state.action.startsWith("settings:")) {
    const tab = state.action.slice("settings:".length);
    await client.evaluate("document.querySelector('[data-open-settings]')?.click()");
    await settle(client, 700);
    await client.evaluate(`document.querySelector('[data-settings-tab="${tab}"]')?.click()`);
  } else if (state.action.startsWith("app:")) {
    const title = state.action.slice("app:".length);
    await client.evaluate(
      `(() => {
        const title = ${JSON.stringify(title)};
        const tab = [...document.querySelectorAll('button')].find((button) => button.title === title);
        if (tab) return tab.click();
        const icon = [...document.querySelectorAll('.desktop-icon')].find((node) => node.title === title);
        if (!icon) return;
        icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      })()`,
    );
  } else {
    await client.evaluate(`document.querySelector(${JSON.stringify(state.action)})?.click()`);
  }
  await settle(client, state.action.startsWith("app:") ? 1200 : 700);
  if (state.name === "chat") {
    const hasWindow = await client.evaluate(
      "Boolean(document.querySelector('.ctox-chat-window:not(.is-minimized)'))",
    );
    if (!hasWindow) {
      await client.evaluate("document.querySelector('[data-chat-open]')?.click()");
      await settle(client, 700);
    }
  }
  if (state.name === "history") {
    const hasPanel = await client.evaluate(
      "Boolean(document.querySelector('[data-chat-date-workload-panel]'))",
    );
    if (!hasPanel) {
      await client.evaluate("document.querySelector('.ctox-date-picker-trigger')?.click()");
      await settle(client, 500);
    }
  }
  if (state.expected) {
    const visible =
      await client.evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(state.expected)})].some((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }))`);
    if (!visible) throw new Error(`${state.name} did not expose ${state.expected}`);
  }
}

const AUDIT_EXPRESSION = `(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0 || rect.width <= 1 || rect.height <= 1 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const topmost = document.elementFromPoint(x, y);
    return topmost !== null && (topmost === node || node.contains(topmost));
  };
  const controls = [...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[tabindex]')].filter(visible);
  const clipRect = (node) => {
    let result = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) continue;
      const rect = ancestor.getBoundingClientRect();
      result = { left: Math.max(result.left, rect.left), top: Math.max(result.top, rect.top), right: Math.min(result.right, rect.right), bottom: Math.min(result.bottom, rect.bottom) };
    }
    return result;
  };
  const describe = (node) => {
    const rect = node.getBoundingClientRect();
    const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.labels?.[0]?.innerText || node.getAttribute('placeholder') || (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    return {
      tag: node.tagName,
      label,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  };
  return {
    title: document.title,
    url: location.href,
    shellVersion: document.querySelector('[data-shell-version-label]')?.textContent?.trim() || '',
    moduleLoading: document.body.dataset.moduleLoading || '',
    authState: document.documentElement.dataset.authState || document.body.dataset.authState || '',
    documentOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    unnamedControls: controls.filter((node) => !(node.getAttribute('aria-label') || node.getAttribute('title') || node.labels?.[0]?.innerText || node.getAttribute('placeholder') || (node.textContent || '').trim())).map(describe),
    clippedControls: controls.filter((node) => {
      const rect = node.getBoundingClientRect();
      const clip = clipRect(node);
      const visibleWidth = Math.max(0, Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top));
      return visibleWidth < rect.width - 1 || visibleHeight < rect.height - 1;
    }).map(describe).slice(0, 60),
    tinyControls: controls.filter((node) => {
      const rect = node.getBoundingClientRect();
      return (rect.width < 24 || rect.height < 24) && !node.matches('input[type="file"],input[type="date"]');
    }).map(describe).slice(0, 60),
    openWindows: [...document.querySelectorAll('.shell-window')].filter(visible).map((windowNode) => ({
      title: windowNode.querySelector('.shell-window-title-text')?.textContent?.trim() || '',
      busy: Boolean(windowNode.querySelector('[aria-busy="true"], [data-loading="true"], .is-loading')),
      statusText: [...windowNode.querySelectorAll('[role="status"], [role="alert"], .empty-state, .module-loading-shadow-pane')]
        .filter(visible)
        .map((node) => (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240))
        .filter(Boolean)
        .slice(0, 8),
      text: (windowNode.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 1200),
    })),
    visibleText: (document.body.innerText || '').slice(0, 4000),
  };
})()`;

async function cleanEmptyAuditChat(client: CdpClient): Promise<void> {
  await client.evaluate(`(() => {
    const win = document.querySelector('.ctox-chat-window:not(.is-minimized)');
    if (!win) return;
    const hasMessages = Boolean(win.querySelector('.ctox-chat-message'));
    const draft = win.querySelector('textarea,input[name="message"]')?.value?.trim();
    if (!hasMessages && !draft) win.querySelector('[data-chat-delete]')?.click();
  })()`);
  await settle(client, 300);
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  NodeFS.mkdirSync(args.output, { recursive: true });
  const target = selectLocalBusinessOsTarget(await fetchTargets(args.port));
  const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
  const consoleErrors: unknown[] = [];
  const networkFailures: unknown[] = [];
  client.on("Runtime.consoleAPICalled", (params) => {
    if (typeof params !== "object" || !params || (params as { type?: unknown }).type !== "error")
      return;
    const args =
      (params as { args?: readonly { value?: unknown; description?: unknown }[] }).args ?? [];
    consoleErrors.push(
      args
        .map((arg) =>
          typeof arg.value === "string"
            ? arg.value
            : typeof arg.description === "string"
              ? arg.description
              : "",
        )
        .filter(Boolean)
        .join(" ")
        .slice(0, 800),
    );
  });
  client.on("Runtime.exceptionThrown", (params) => consoleErrors.push(params));
  client.on("Network.loadingFailed", (params) => {
    const failure = params as { canceled?: unknown; errorText?: unknown; type?: unknown };
    if (failure.canceled === true || failure.errorText === "net::ERR_ABORTED") return;
    networkFailures.push({ errorText: failure.errorText, type: failure.type });
  });
  await client.command("Runtime.enable", {});
  await client.command("Page.enable", {});
  await client.command("Network.enable", {});
  const discoveredAppStates = createDiscoveredAppStates(
    (await client.evaluate(
      "[...document.querySelectorAll('.desktop-icon[title]')].map((node) => node.title)",
    )) as readonly string[],
  );
  const results: ShellAuditResult[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      await client.command("Emulation.setDeviceMetricsOverride", {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const states =
        viewport.name === "wide" ? [...SHELL_STATES, ...discoveredAppStates] : SHELL_STATES;
      for (const state of states) {
        const consoleStart = consoleErrors.length;
        const networkStart = networkFailures.length;
        await prepareState(client, state);
        const audit = (await client.evaluate(AUDIT_EXPRESSION)) as ShellAuditResult["audit"];
        const shot = (await client.command(
          "Page.captureScreenshot",
          { format: "png", fromSurface: true },
          10_000,
        )) as { data?: unknown };
        if (typeof shot.data !== "string") throw new Error("screenshot returned no data");
        const screenshot = `${viewport.name}-${state.name}.png`;
        NodeFS.writeFileSync(
          NodePath.join(args.output, screenshot),
          Buffer.from(shot.data, "base64"),
        );
        results.push({
          viewport: viewport.name,
          state: state.name,
          screenshot,
          audit,
          consoleErrors: consoleErrors.slice(consoleStart),
          networkFailures: networkFailures.slice(networkStart),
        });
        process.stdout.write(`captured ${viewport.name}/${state.name}\n`);
        if (state.name === "history") await cleanEmptyAuditChat(client);
      }
    }
  } finally {
    await resetOverlays(client).catch(() => undefined);
    await client.command("Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
    client.close();
  }
  const captures = results.map(({ viewport, state, screenshot }) => ({
    viewport,
    state,
    screenshot,
  }));
  const summary = results.reduce(
    (value, result) => {
      value.blocking +=
        Number(result.audit.documentOverflowX > 1) +
        result.audit.clippedControls.length +
        result.audit.unnamedControls.length +
        result.consoleErrors.length +
        result.networkFailures.length;
      return value;
    },
    { captures: results.length, blocking: 0 },
  );
  NodeFS.writeFileSync(
    NodePath.join(args.output, "audit.json"),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(args.output, "review-batches.json"),
    `${JSON.stringify(
      createReviewBatches(captures).map((items, index) => ({ batch: index + 1, captures: items })),
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`report ${NodePath.join(args.output, "audit.json")}\n`);
  if (summary.blocking > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("workjet-business-os-shell-audit.ts")) await run();
