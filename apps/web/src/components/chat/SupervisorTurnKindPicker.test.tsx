import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandId, ProjectId, ThreadId } from "@workjet/contracts";
import {
  SupervisorTurnKindPicker,
  supervisorConversationSupported,
  type ScopedSupervisorTurnCapabilities,
} from "./SupervisorTurnKindPicker";

const projectId = ProjectId.make("f791215c-e416-4205-8619-bbf82b999799");
const threadId = ThreadId.make("e28290b0-7b0a-4d19-a242-f27041fadb84");
const scope = { instanceId: "managed:acceptance", projectId, threadId };
const capability: ScopedSupervisorTurnCapabilities = {
  scope,
  error: null,
  response: {
    action: "project.supervisor.turn.capabilities",
    commandId: CommandId.make("checked-chat-support"),
    projectId,
    contract: "ctox.workjet.supervisor_turn_capabilities.v1",
    binding: {
      contract: "ctox.workjet.supervisor_binding.v1",
      projectId,
      threadId,
      threadKey: `business-os/threads/${threadId}`,
    },
    turnKinds: ["work", "conversation"],
    defaultTurnKind: "work",
  },
};
function render(value: ScopedSupervisorTurnCapabilities | null, disabled = false) {
  return renderToStaticMarkup(
    <SupervisorTurnKindPicker
      scope={scope}
      capability={value}
      value="work"
      disabled={disabled}
      onChange={() => {}}
    />,
  );
}
describe("Owner-selected Supervisor message kind", () => {
  it("renders nothing without scoped Chat support and two inline segments with it", () => {
    expect(render(null)).toBe("");
    const html = render(capability);
    expect(html).toContain('role="radiogroup" aria-label="Modus"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">Aufgabe</button>");
    expect(html).toContain(">Chat</button>");
  });
  it.each(["instanceId", "projectId", "threadId"] as const)(
    "rejects a late capability from a previous %s",
    (field) => {
      const stale = { ...capability, scope: { ...scope, [field]: "foreign" } };
      expect(supervisorConversationSupported(scope, stale)).toBe(false);
      expect(render(stale)).toBe("");
    },
  );
  it("rejects a response for a different native binding even on the same connection", () => {
    const stale = {
      ...capability,
      response: {
        ...capability.response!,
        binding: { ...capability.response!.binding, threadId: ThreadId.make("foreign-thread") },
      },
    };
    expect(supervisorConversationSupported(scope, stale)).toBe(false);
  });
  it("never makes Chat available on missing, failed or invalidated support", () => {
    expect(supervisorConversationSupported(null, capability)).toBe(false);
    expect(
      supervisorConversationSupported(scope, { scope, response: null, error: "not_active" }),
    ).toBe(false);
  });
  it("preserves the uncertain-submission lock even when Chat is supported", () => {
    expect(render(capability, true)).toContain('disabled=""');
  });
});
