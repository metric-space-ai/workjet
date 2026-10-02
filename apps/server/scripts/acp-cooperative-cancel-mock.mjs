import { createInterface } from "node:readline";

const sessionId = "cooperative-session";
let heldPrompt;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [{ id: "test", name: "Test" }],
    });
  } else if (message.method === "authenticate") {
    reply(message.id, {});
  } else if (message.method === "session/new") {
    reply(message.id, { sessionId });
  } else if (message.method === "session/prompt") {
    if (message.params.prompt[0]?.text === "first") {
      heldPrompt = message.id;
      write({
        jsonrpc: "2.0",
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "held", title: "Held tool", status: "pending" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
        },
      });
    } else {
      reply(message.id, { stopReason: "end_turn" });
    }
  } else if (message.method === "session/cancel") {
    // This request is an observable receipt; no file is actually opened by the test.
    write({
      jsonrpc: "2.0",
      id: "cancel-receipt",
      method: "fs/read_text_file",
      params: { sessionId, path: "/cooperative-cancel-receipt" },
    });
  } else if (message.id === "permission" && heldPrompt !== undefined) {
    reply(heldPrompt, { stopReason: "cancelled" });
    heldPrompt = undefined;
  }
});
input.once("close", () => process.exit(0));
