import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  CommandId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { NativeSupervisorComposer } from "./NativeSupervisorComposer";

const threadId = ThreadId.make("e28290b0-7b0a-4d19-a242-f27041fadb84");
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const scope = { instanceId: "managed:acceptance", projectId, threadId };
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  role: "orchestrator",
  team: {
    role: "supervisor",
    projectId,
    threadId,
    parentThreadId: null,
    goal: "Coordinate",
    createdAt: "2026-10-07T00:00:00.000Z",
  },
  ctoxSupervisorTurn: {
    intent: {
      ...scope,
      commandId: CommandId.make("durable-request"),
      goal: "Real requested change",
      createdAt: "2026-10-07T00:00:00.000Z",
    },
    submission: "confirmed",
    turn: {
      commandId: "native-command",
      taskId: "native-task",
      threadId,
      threadKey: `business-os/threads/${threadId}`,
      executionPhase: "terminal",
      status: "completed",
      queueStatus: "completed",
      attempt: 2,
      terminal: true,
      result: "Actual native result",
      resultTruncated: false,
      errorCode: null,
      errorMessage: null,
    },
  },
};
const saveConfig = async () => ({ _tag: "Success" });

describe("native supervisor receipt display", () => {
  it("shows received native result and attempt without local provider controls", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={config}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain("Actual native result");
    expect(html).toContain("Versuch 2");
    expect(html).toContain("native-task");
    expect(html).not.toContain("Codex CLI");
    expect(html).not.toContain("gpt-6");
  });
  it("does not show a foreign-instance native receipt", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={{ ...scope, instanceId: "managed:foreign" }}
        config={config}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).not.toContain("Actual native result");
    expect(html).not.toContain("Real requested change");
    expect(html).toContain("Verbindung müssen bestätigt sein");
  });
  it("shows a definitive pre-submit refusal and lets the user edit a new prompt", () => {
    const rejectedConfig: WorkjetThreadConfig = { ...config, schemaVersion: 2,
      ctoxSupervisorTurn: { ...config.ctoxSupervisorTurn!, submission: "not-submitted", submissionError: "authentication_required", turn: null } };
    const html = renderToStaticMarkup(<NativeSupervisorComposer scope={scope} config={rejectedConfig} unavailable={false} saveConfig={saveConfig} />);
    expect(html).toContain("Nicht gesendet");
    expect(html).toContain("authentication_required");
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
  });
  it("keeps send unavailable without confirmed native project scope", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={null}
        config={DEFAULT_WORKJET_THREAD_CONFIG}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain('aria-label="Nachricht an Supervisor"');
    expect(html).toContain('aria-label="An Supervisor senden" disabled=""');
  });
});
