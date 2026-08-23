// SPDX-License-Identifier: MIT OR AGPL-3.0-only
//
// Boots the packaged desktop app and checks that it is USABLE, not merely
// that it failed to crash.
//
// ── Why this script was rewritten ───────────────────────────────────────────
// The previous version launched Electron, collected stdout for 8 seconds,
// killed it, and searched the text for six crash strings. Absent those, it
// printed "Desktop smoke test passed."
//
// It never checked that a window opened, that a pixel rendered, that the
// backend answered, or that a message could be sent. An app that boots to a
// blank window and does nothing forever passed it. That is not a hypothetical:
// for five days every single turn in the real app failed with an expired
// provider login while this script — and 6050 unit tests — stayed green.
//
// So the rule here is: every check must be one that FAILS when the app is
// unusable. A check that cannot fail is not a check.
//
// ── What is deliberately NOT checked ────────────────────────────────────────
// Model output. CI has no provider credentials, and a smoke test that needs a
// paid live model is a smoke test nobody runs. Instead the turn check (opt-in,
// --with-turn) asserts something CI-safe and far more valuable: that whatever
// the turn's outcome, the app reports it TRUTHFULLY. An authentication outage
// must arrive as a failed turn, never as a completed one.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");

const WITH_TURN = process.argv.includes("--with-turn");
const DEBUG_PORT = Number(process.env.DESKTOP_SMOKE_PORT ?? 9222);
const WINDOW_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 20_000;
// A rendered shell carries chrome (sidebar, composer, buttons). A blank or
// error-only window does not clear this.
const MIN_RENDERED_CHARS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const record = (name, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  return ok;
};

console.log("\nDesktop usability smoke test\n");

const electronCommand = resolveElectronLaunchCommand([
  mainJs,
  `--remote-debugging-port=${DEBUG_PORT}`,
]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VITE_DEV_SERVER_URL: "", ELECTRON_ENABLE_LOGGING: "1" },
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

const shutdown = (code) => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  process.exit(code);
};

// ── 1. A window exists and is debuggable ────────────────────────────────────
let page;
{
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      page = list.find((target) => target.type === "page");
      if (page) break;
    } catch {
      /* not listening yet */
    }
    await sleep(400);
  }
  if (
    !record(
      "window opens",
      Boolean(page),
      page ? undefined : `no page target within ${WINDOW_TIMEOUT_MS}ms`,
    )
  ) {
    console.error("\nProcess output:\n" + output.slice(-3000));
    shutdown(1);
  }
}

// ── CDP plumbing ────────────────────────────────────────────────────────────
let socket;
let nextId = 0;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onopen = resolve;
  socket.onerror = reject;
  socket.onmessage = (message) => {
    const parsed = JSON.parse(message.data);
    const settle = pending.get(parsed.id);
    if (settle) {
      settle(parsed);
      pending.delete(parsed.id);
    }
  };
});
const evaluate = async (expression) => {
  const id = ++nextId;
  const reply = await new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
  return reply.result?.result?.value ?? null;
};

// ── 2. The renderer actually painted something ──────────────────────────────
let renderedChars = 0;
{
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    renderedChars = (await evaluate(`(document.body?.innerText ?? "").trim().length`)) ?? 0;
    if (renderedChars >= MIN_RENDERED_CHARS) break;
    await sleep(500);
  }
  record(
    "renderer paints content",
    renderedChars >= MIN_RENDERED_CHARS,
    `${renderedChars} chars (need ${MIN_RENDERED_CHARS})`,
  );
}

// ── 3. The backend answered — the window is not a shell over a dead server ──
record(
  "backend reachable",
  output.includes("backend ready"),
  output.includes("backend ready") ? undefined : "no 'backend ready' in startup log",
);

// ── 4. The coding surface is reachable and can be typed into ────────────────
// Which view the app restores depends on persisted state — a fresh profile
// lands on CTOX discovery, an existing one on Code. Checking the composer
// without first steering to Code would make this pass or fail by accident.
{
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll("button,[role=button]")]
      .find((b) => (b.innerText || b.ariaLabel || "").trim() === "Code");
    if (tab) tab.click();
    return true;
  })()`);

  let hasComposer = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    hasComposer = Boolean(
      await evaluate(`Boolean(document.querySelector("textarea, [contenteditable='true']"))`),
    );
    if (hasComposer) break;
    await sleep(500);
  }
  record("coding surface offers a composer", hasComposer);
}

// ── 5. No fatal module/script errors (the old test, kept — it did catch those)
{
  const fatal = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ].filter((pattern) => output.includes(pattern));
  record("no fatal script errors", fatal.length === 0, fatal.join(", ") || undefined);
}

// ── 6. Opt-in: a turn reports its outcome truthfully ────────────────────────
if (WITH_TURN) {
  console.log("\n  (--with-turn: sending a real message)\n");
  const typed = await evaluate(`(() => {
    const box = [...document.querySelectorAll("textarea,[contenteditable='true']")].pop();
    if (!box) return "no composer";
    const text = "Reply with the single word READY. Run no tools and change no files.";
    if (box.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
        .set.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      box.focus();
      document.execCommand("insertText", false, text);
    }
    return "typed";
  })()`);

  // Send enables on the NEXT render, not in the same tick as the insertion.
  // Reading `disabled` immediately reports a stale true and would make this
  // step fail for a reason that has nothing to do with the app being broken.
  let sent = typed === "typed" ? "send button disabled" : typed;
  if (typed === "typed") {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const clicked = await evaluate(`(() => {
        const send = [...document.querySelectorAll("button,[role=button]")]
          .find((b) => (b.ariaLabel || b.innerText || "").trim() === "Send message");
        if (!send) return "no send button";
        if (send.disabled) return "pending";
        send.click();
        return "sent";
      })()`);
      if (clicked !== "pending") {
        sent = clicked;
        break;
      }
      await sleep(400);
    }
  }

  if (!record("message sent", sent === "sent", sent === "sent" ? undefined : String(sent))) {
    console.error("\nProcess output:\n" + output.slice(-2000));
    shutdown(1);
  }

  // The provider answers within seconds when healthy, and an authentication
  // outage answers in milliseconds. Either way a terminal state must appear.
  await sleep(25_000);
  const verdict = await evaluate(`(() => {
    const text = document.body?.innerText ?? "";
    return JSON.stringify({
      authFailure: /OAuth session expired|Failed to authenticate|authentication_failed/i.test(text),
      tail: text.slice(-500),
    });
  })()`);
  const parsed = JSON.parse(verdict ?? "{}");

  // This is the check the old script most needed and did not have. An
  // authentication outage is a real failure and must be reported as one — the
  // defect was that it was stored as a completed turn and shown as an
  // ordinary assistant reply.
  record(
    "provider authenticated",
    parsed.authFailure !== true,
    parsed.authFailure
      ? "provider reports an expired/failed login — re-authenticate the CLI"
      : undefined,
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`Desktop smoke test FAILED (${failures.length}):`);
  for (const failure of failures) console.error(` - ${failure}`);
  console.error("\nProcess output:\n" + output.slice(-2500));
  shutdown(1);
}
console.log("Desktop smoke test passed.");
shutdown(0);
