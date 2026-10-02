#!/usr/bin/env node
/**
 * In-process stand-in for `greppy` 0.4.x agent serve.
 *
 * Speaks the hosted NDJSON + newline JSON-RPC contract the adapter uses.
 * It is not the real CLI. GREPPY_ARGV_LOG, when set, receives one JSON
 * argv array per invocation so tests can see flags without reading a
 * secret-bearing environment.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const fixture = process.env.GREPPY_FIXTURE ?? "happy";
if (process.env.GREPPY_ARGV_LOG) {
  fs.appendFileSync(process.env.GREPPY_ARGV_LOG, `${JSON.stringify(args)}\n`);
}

const emit = (value) => {
  fs.writeSync(1, `${JSON.stringify(value)}\n`);
};

if (args.includes("--version")) {
  fs.writeSync(1, fixture === "old-version" ? "greppy 0.3.1\n" : "greppy 0.4.1\n");
  process.exit(0);
}

if (args[0] === "agent" && args[1] === "apply") {
  const ref = args[2] ?? "";
  if (!ref.startsWith("refs/greppy/agent/")) {
    fs.writeSync(2, "unknown proposal\n");
    process.exit(2);
  }
  fs.writeSync(1, "applied\n");
  process.exit(0);
}

if (!(args[0] === "agent" && args[1] === "serve")) {
  fs.writeSync(2, "unsupported invocation\n");
  process.exit(2);
}

const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "";
if (!model || fixture === "usage-error") {
  fs.writeSync(2, "error: --model is required (or set GREPPY_MODEL)\n");
  process.exit(2);
}

const resumeIndex = args.indexOf("--resume");
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
if (fixture === "resume-missing" && resume) {
  emit({
    type: "session",
    session_id: resume,
    uri: `greppy://sessions/${resume}`,
    run_id: "run-fixture",
    project: "fixture",
    worktree: "fixture-worktree",
    branch: "main",
    model,
    endpoint: "http://127.0.0.1:9",
    sandbox: "disabled",
    resumed: true,
    mode: "serve",
    socket: "fixture.sock",
  });
  emit({
    type: "error",
    message: `greppy agent serve: cannot resume session ${resume}: No such file or directory (os error 2)`,
  });
  emit({
    type: "result",
    status: "error",
    exit_code: 2,
    session_id: resume,
    run_id: "run-fixture",
    stop: "error",
    turns: 0,
    proposal_ref: null,
    patch: null,
    stat: null,
    applied: false,
  });
  process.exit(2);
}

const socketPath = path.join(os.tmpdir(), `gj${process.pid}.sock`);
try {
  fs.unlinkSync(socketPath);
} catch {
  // absent
}
process.on("exit", () => {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // already gone
  }
});
const sessionId = resume ?? "sess-fixture";
const runId = "run-fixture";
const reply = (socket, id, result) => {
  socket.end(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.method === "turn/start") {
        const text = request.params?.text ?? "";
        reply(socket, request.id, { accepted: true, prompt_id: "p-1", position: 0 });
        emit({ type: "phase", phase: "busy" });
        emit({
          type: "turn_start",
          prompt_id: "p-1",
          source: request.params?.source ?? "remote",
          text,
        });
        if (fixture === "cancel") return;
        if (fixture !== "no-tools") {
          emit({ type: "tool_start", id: "t1", name: "greppy", summary: "bash-smart echo" });
          emit({ type: "tool_finish", id: "t1", failed: false, elapsed_ms: 3, preview: "ok" });
        }
        emit({ type: "text", text: "pong" });
        emit({
          type: "turn_complete",
          stop: fixture === "incomplete" ? "turn limit reached" : "ready",
          usage: { input: 12, output: 2, cache_read: 0, cache_write: 0 },
        });
        emit({ type: "phase", phase: "idle" });
        return;
      }
      if (request.method === "turn/interrupt") {
        reply(socket, request.id, { accepted: true });
        emit({ type: "phase", phase: "cancelling" });
        emit({
          type: "turn_complete",
          stop: "cancelled",
          usage: { input: 1, output: 0, cache_read: 0, cache_write: 0 },
        });
        emit({ type: "phase", phase: "idle" });
        return;
      }
      if (request.method === "session/quit") {
        reply(socket, request.id, { accepted: true });
        if (fixture === "proposal") {
          emit({
            type: "result",
            status: "proposal",
            exit_code: 0,
            session_id: sessionId,
            run_id: runId,
            stop: "ready",
            turns: 1,
            proposal_ref: "refs/greppy/agent/run-fixture",
            stat: " fixture.ts | 1 +",
            patch:
              "diff --git a/fixture.ts b/fixture.ts\n--- a/fixture.ts\n+++ b/fixture.ts\n@@\n+export const answer = 2\n",
            applied: false,
            apply_error: null,
          });
        } else {
          emit({
            type: "result",
            status: "clean",
            exit_code: 0,
            session_id: sessionId,
            run_id: runId,
            stop: "ready",
            turns: 1,
            proposal_ref: null,
            stat: null,
            patch: null,
            applied: false,
          });
        }
        setTimeout(() => {
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // already gone
          }
          process.exit(0);
        }, 30);
        return;
      }
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "method not found" },
        })}\n`,
      );
    }
  });
});

server.listen(socketPath, () => {
  emit({
    type: "session",
    session_id: sessionId,
    uri: `greppy://sessions/${sessionId}`,
    run_id: runId,
    project: "fixture",
    worktree: "fixture-worktree",
    branch: "main",
    model,
    endpoint: "http://127.0.0.1:9",
    sandbox: "disabled",
    resumed: resume !== null,
    socket: socketPath,
    mode: "serve",
  });
  emit({ type: "phase", phase: "idle" });
});
