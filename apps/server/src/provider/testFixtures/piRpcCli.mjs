#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\n");
  process.exit(0);
}
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const extensionPath = process.argv.includes("--extension") ? option("--extension") : null;
const registeredTools = [];
if (extensionPath) {
  const extension = await import(NodeURL.pathToFileURL(extensionPath).href);
  await extension.default({ registerTool: (tool) => registeredTools.push(tool), on: () => {} });
}
const sessionFile = process.argv.includes("--session")
  ? option("--session")
  : NodePath.join(option("--session-dir"), "fixture-session.jsonl");
NodeFS.mkdirSync(NodePath.dirname(sessionFile), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(option("--session-dir"), "fixture-startup.json"),
  JSON.stringify({
    appendSystemPrompt: process.argv.includes("--append-system-prompt")
      ? option("--append-system-prompt")
      : null,
    replacesSystemPrompt: process.argv.includes("--system-prompt"),
    sessionFile,
    extensionPath,
    loadedTools: registeredTools.map((tool) => tool.name),
    agentDirectory: process.env.PI_CODING_AGENT_DIR,
    sourceIsolated: process.env.WORKJET_SOURCE_ISOLATED === "true",
    targetSecretPresent: process.env.WORKJET_PI_TEST_TARGET_SECRET !== undefined,
  }),
);
if (!NodeFS.existsSync(sessionFile)) NodeFS.writeFileSync(sessionFile, "");
let provider = option("--provider"),
  model = option("--model"),
  active = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (request, data) =>
  emit({ type: "response", id: request.id, command: request.type, success: true, data });
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    switch (request.type) {
      case "get_state":
        reply(request, {
          sessionId: "fixture-session",
          sessionFile,
          model: { id: model, provider },
          isStreaming: active,
        });
        break;
      case "get_messages":
        reply(request, {
          messages: NodeFS.readFileSync(sessionFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse),
        });
        break;
      case "set_model":
        provider = request.provider;
        model = request.modelId;
        reply(request, { id: model, provider });
        break;
      case "abort":
        active = false;
        reply(request);
        emit({ type: "agent_end", messages: [] });
        break;
      case "prompt":
        NodeFS.appendFileSync(
          sessionFile,
          JSON.stringify({ role: "user", content: request.message }) + "\n",
        );
        reply(request);
        active = true;
        emit({ type: "agent_start" });
        if (request.message === "WAIT_FOR_ABORT") {
          emit({
            type: "tool_execution_start",
            toolCallId: "waiting-tool",
            toolName: "bash",
            args: { command: "waiting" },
          });
          break;
        }
        for (let n = 1; n <= 20; n++) {
          const id = "call-" + n;
          const tool = request.message === "RUN_WORKJET_MCP" ? registeredTools[0] : undefined;
          const args = { command: tool ? "result-" + n : "printf " + n };
          emit({
            type: "tool_execution_start",
            toolCallId: id,
            toolName: tool?.name ?? "bash",
            args,
          });
          const result = tool
            ? await tool.execute(id, args)
            : { content: [{ type: "text", text: "result-" + n }] };
          emit({
            type: "tool_execution_end",
            toolCallId: id,
            toolName: tool?.name ?? "bash",
            result,
            isError: false,
          });
        }
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "DONE" },
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "DONE" }],
            stopReason: "stop",
          },
        });
        active = false;
        emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
        break;
      default:
        emit({
          type: "response",
          id: request.id,
          success: false,
          error: "Unknown fixture command",
        });
    }
  }
});
