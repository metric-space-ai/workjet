#!/usr/bin/env node
// Private IPC process fixture only: no native enrollment, SDK, model or execution proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

const [command, subcommand, targetId, directory, rootFlag, root] = process.argv.slice(2);
if (command !== "sync" || subcommand !== "supervisor-source" || rootFlag !== "--root" || !root)
  process.exit(2);
await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
await NodeFSP.chmod(directory, 0o700);
const endpoint = NodePath.join(directory, "fixture-authority.sock");
const sockets = new Set();
const server = NodeNet.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let buffered = Buffer.alloc(0);
  socket.on("data", async (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 4) return;
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) return;
    const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    await NodeFSP.appendFile(NodePath.join(directory, "requests.jsonl"),
      JSON.stringify({ requestId: request.requestId, action: request.params[0].action }) + "\n");
    const action = request.params[0].action;
    if (action === "eof") { socket.destroy(); return; }
    if (action === "oversized-response") {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1_048_577, 0);
      socket.write(header); return;
    }
    const response = Buffer.from(JSON.stringify({
      version: 1,
      requestId: action === "wrong-id" ? "foreign-request" : request.requestId,
      result: action === "unavailable"
        ? { kind: "unavailable", code: "native_supervisor_source_unavailable" }
        : { kind: "reply", reply: { fixture: true, action, args: process.argv.slice(2) } },
    }));
    const frame = Buffer.alloc(response.length + 4);
    frame.writeUInt32BE(response.length, 0);
    response.copy(frame, 4);
    socket.write(frame.subarray(0, 2), () => socket.write(frame.subarray(2)));
  });
});
await new Promise((resolve) => server.listen(endpoint, resolve));
await NodeFSP.chmod(endpoint, 0o600);
process.stdout.write(JSON.stringify({
  protocolVersion: 1, endpoint, transportReady: true,
  executionReady: targetId === "invalid-ready",
}) + "\n");
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
