// @effect-diagnostics nodeBuiltinImport:off -- Isolated OS-process regression boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vitest";

// Keep an uncaught stream error in a disposable process, never the test runner.
const fixture = `
import * as CP from 'node:child_process';
import * as Events from 'node:events';
import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import * as Stream from ${JSON.stringify(import.meta.resolve("effect/Stream"))};
import * as NodeSink from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeSink"))};
const child = CP.spawn(process.execPath, ['-e', "require('node:fs').closeSync(0); process.stdout.write('closed'); setInterval(() => {}, 1000)"], {stdio:['pipe','pipe','ignore']});
const exited = Events.once(child, 'exit');
let code;
try {
  await Events.once(child.stdout, 'data');
  const deadline = setTimeout(() => { console.error('write receipt timed out'); process.exit(2); }, 3000);
  const result = await Effect.runPromiseExit(Stream.run(Stream.make(new Uint8Array([42])), NodeSink.fromWritable({evaluate: () => child.stdin, onError: error => { code = error.code; return error; }})));
  clearTimeout(deadline);
  if (result._tag !== 'Failure' || !['EPIPE','ECONNRESET'].includes(code)) throw new Error('missing typed pipe failure: '+code);
  console.log('parent survived '+code);
} finally { child.kill('SIGTERM'); await exited; }
`;

// Force an asynchronous failure after pull completion, while end() is pending.
const finalizationFixture = `
import { Writable } from 'node:stream';
import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import * as Stream from ${JSON.stringify(import.meta.resolve("effect/Stream"))};
import * as NodeSink from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeSink"))};
let code;
const writable = new Writable({
  write(_chunk, _encoding, callback) { callback(); },
  final(callback) { setImmediate(() => callback(Object.assign(new Error('closed finalizer'), { code: 'EPIPE' }))); }
});
const deadline = setTimeout(() => { console.error('write receipt timed out'); process.exit(2); }, 3000);
const result = await Effect.runPromiseExit(Stream.run(Stream.make(new Uint8Array([42])), NodeSink.fromWritable({evaluate: () => writable, onError: error => { code = error.code; return error; }})));
clearTimeout(deadline);
if (result._tag !== 'Failure' || code !== 'EPIPE') throw new Error('missing typed finalization failure: '+code);
console.log('parent survived '+code);
`;

const exitingChildFixture = fixture
  .replace("require('node:fs').closeSync(0); process.stdout.write('closed'); setInterval(() => {}, 1000)",
    "process.stdout.write('closed'); setTimeout(() => process.exit(0), 5)")
  .replace("new Uint8Array([42])", "new Uint8Array(8 * 1024 * 1024)");

describe("closed child input pipe", () => {
  it.each([["closed input", fixture], ["exit during write", exitingChildFixture], ["error during end", finalizationFixture]])(
    "survives %s without an uncaught exception in the parent", async (_name, program) => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const parent = NodeChildProcess.spawn(NodeProcess.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      parent.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      parent.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      parent.on("error", reject);
      parent.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/parent survived (EPIPE|ECONNRESET)/);
  });
});
