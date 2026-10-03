import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
if (process.argv.includes("--version")) { (process.env.MINIMAX_TEST_VERSION_STDERR ? process.stderr : process.stdout).write((process.env.MINIMAX_TEST_VERSION || "0.6.2") + "\n"); process.exit(0); }
const model = "MiniMax-M3.1-Flash-Preview";
const native = `m:minimax_oauth:${model}:u`;
const secondaryModel = "MiniMax-M2.7";
const secondaryNative = `m:minimax_oauth:${secondaryModel}:u`;
let sessionId = "minimax-fixture-session";
let modelValue = native;
let effort = "medium";
let mode = "default";
let nextRequestId = 100;
let pendingPrompt;
const replies = new Map();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const respond = (id, result) => send({ id, result });
const notify = (update) => send({ method: "session/update", params: { sessionId, update } });
const configOptions = () => [
  { type: "select", id: "model", category: "model", name: "Model", currentValue: modelValue, options: process.env.MINIMAX_TEST_NO_MODELS ? [] : [{ value: native, name: model }, ...(process.env.MINIMAX_TEST_SECOND_MODEL ? [{ value: secondaryNative, name: secondaryModel }] : [])] },
  { type: "select", id: "thinkingEffort", category: "thought_level", name: "Thinking effort", currentValue: effort, options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })) },
];
const setup = () => ({ configOptions: configOptions(), modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } });
const request = (method, params) => new Promise((resolve) => { const id = nextRequestId++; replies.set(id, resolve); send({ id, method, params }); });
NodeReadline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (!message.method) { const settle = replies.get(message.id); replies.delete(message.id); settle?.(message.result); return; }
  if (process.env.MINIMAX_TEST_LOG) NodeFS.appendFileSync(process.env.MINIMAX_TEST_LOG, JSON.stringify({ method: message.method, params: message.params }) + "\n");
  const { id, method, params } = message;
  switch (method) {
    case "initialize": respond(id, { protocolVersion: 1, agentInfo: { name: "minimax-code", version: process.env.MINIMAX_TEST_AGENT_VERSION || "0.6.2" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { resume: {}, close: {} } } }); break;
    case "authenticate": if (process.env.MINIMAX_TEST_AUTH_REQUIRED) { send({ id, error: { code: -32000, message: "Run mcode login and try again." } }); break; } if (params.methodId === "minimax-code-login") respond(id, {}); else send({ id, error: { code: -32602, message: "Unknown authentication method" } }); break;
    case "session/new": respond(id, { sessionId, ...setup() }); break;
    case "session/load": if (process.env.MINIMAX_TEST_LOAD_MISSING) { send({ id, error: { code: -32602, message: "Saved MiniMax Code session not found" } }); break; } sessionId = params.sessionId; notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replay" } }); respond(id, setup()); break;
    case "session/set_config_option":
      if (params.configId === "model" && (params.value === native || (process.env.MINIMAX_TEST_SECOND_MODEL && params.value === secondaryNative))) modelValue = params.value;
      else if (params.configId === "thinkingEffort" && ["low", "medium", "high", "xhigh", "max"].includes(params.value)) effort = params.value;
      else { send({ id, error: { code: -32602, message: "Value not advertised" } }); break; }
      respond(id, { configOptions: configOptions() }); break;
    case "session/set_mode": mode = params.modeId; notify({ sessionUpdate: "current_mode_update", currentModeId: mode }); respond(id, {}); break;
    case "session/close": respond(id, {}); break;
    case "session/cancel": if (pendingPrompt !== undefined) { respond(pendingPrompt, { stopReason: process.env.MINIMAX_TEST_CANCEL_END_TURN ? "end_turn" : "cancelled" }); pendingPrompt = undefined; } break;
    case "session/prompt": {
      const text = params.prompt.map((content) => content.text || "").join("");
      notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting fixture repository" } });
      if (text.includes("disconnect")) { process.exit(7); }
      if (text.includes("wait-for-cancel")) { pendingPrompt = id; notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } }); break; }
      if (text.includes("ask-question")) {
        const answer = await request("session/elicitation", { mode: "form", sessionId, message: "Scope", requestedSchema: { type: "object", properties: { scope: { type: "string", oneOf: [{ const: "small", title: "Small" }] } }, required: ["scope"] } });
        if (answer?.action !== "accept" || answer.content?.scope !== "small") { send({ id, error: { code: -32602, message: "Expected the native enum answer" } }); break; }
      }
      if (text.includes("approved-edit")) {
        const permission = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "edit-one", title: "Edit fixture", kind: "edit", status: "pending" }, options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }] });
        if (permission?.outcome?.optionId === "yes") {
          NodeFS.writeFileSync("result.txt", "approved change\n");
          notify({ sessionUpdate: "tool_call", toolCallId: "edit-one", title: "Edit fixture", kind: "edit", status: "completed", content: [{ type: "diff", path: "result.txt", oldText: "", newText: "approved change\n" }] });
        }
      }
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } });
      respond(id, { stopReason: "end_turn" }); break;
    }
    default: send({ id, error: { code: -32601, message: "Method not found" } });
  }
});
