import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fixture from "../../../../../packages/contracts/src/fixtures/workjet-supervisor-route-computation-v2.json" with { type: "json" };
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  CommandId,
  SupervisorRouteDisplayV2,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { NativeSupervisorComposer } from "./NativeSupervisorComposer";
import { useSupervisorRouteDisplay } from "./useSupervisorRouteDisplay";
vi.mock("./useSupervisorRouteDisplay", () => ({
  useSupervisorRouteDisplay: vi.fn(() => null),
}));
afterEach(() => vi.mocked(useSupervisorRouteDisplay).mockReset());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../ProjectSupervisorLumaField", () => ({
  useProjectSupervisorLumas: () => ({
    instanceId: null,
    phase: "unavailable",
    profiles: [],
    instanceName: null,
  }),
}));

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
  it("keeps the observed answering model in the status line below the normal bar", () => {
    const route = Schema.decodeUnknownSync(SupervisorRouteDisplayV2)(
      fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value,
    );
    vi.mocked(useSupervisorRouteDisplay).mockReturnValue({ phase: "ready", route });
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={config}
        instanceId={scope.instanceId}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain(`Letzte Ausführung · Claude Code · ${route.actual?.model}`);
    expect(html.indexOf("Letzte Ausführung")).toBeGreaterThan(
      html.indexOf('data-composer-bar="true"'),
    );
    expect(html).toContain('aria-label="Luma"');
    expect(html).toContain('aria-label="Harness"');
    expect(html).toContain('aria-label="Modell"');
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html.match(/aria-label="An Supervisor senden"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Letzte Ausführung"');
    if (route.actual) {
      expect(html).not.toContain(route.actual.account_id);
      expect(html).not.toContain(route.actual.sdk_session_id);
    }
  });
  it("places the full-width editor above the same attachment, route, gear, mic and send bar", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={config}
        instanceId={scope.instanceId}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html.indexOf("<textarea")).toBeLessThan(html.indexOf("data-composer-bar="));
    expect(html).toContain('data-composer-bar="true"');
    // No gear with a single hidden choice: the mode sits inline once Chat is supported.
    expect(html).not.toContain('aria-label="Optionen"');
    expect(html).toContain('aria-label="Diktieren"');
    expect(html).not.toContain('aria-label="Modus"');
    expect(html).toContain('aria-label="Luma"');
    expect(html).toContain('aria-label="Harness"');
    expect(html).toContain('aria-label="Modell"');
    expect(html).not.toContain("Project instance");
    expect(html).not.toContain("Configure Workers");
    expect(html).not.toContain("Refresh task");
    expect(html).not.toContain(">CTOX</span>");
    expect(html).not.toContain(">Send</button>");
  });
  it("offers the existing account login for the managed project's discovery refusal", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={null}
        config={DEFAULT_WORKJET_THREAD_CONFIG}
        instanceId="managed:acceptance"
        blockReason="Sign in to ctox.dev to reconnect this project's instance."
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain("Bei ctox.dev anmelden</button>");
    expect(html).toContain('aria-label="An Supervisor senden" disabled=""');
  });

  it.each(["not_active", "timeout"] as const)(
    "keeps a restored legacy %s request pending before effects run",
    (code) => {
      const legacyConfig: WorkjetThreadConfig = {
        ...config,
        schemaVersion: 2,
        ctoxSupervisorTurn: {
          ...config.ctoxSupervisorTurn!,
          submission: "not-submitted",
          submissionError: code,
          turn: null,
        },
      };
      const html = renderToStaticMarkup(
        <NativeSupervisorComposer
          scope={scope}
          config={legacyConfig}
          instanceId={scope.instanceId}
          blockReason={null}
          unavailable={false}
          saveConfig={saveConfig}
        />,
      );
      expect(html).toContain("Real requested change");
      expect(html).toContain("Warte auf CTOX-Bestätigung");
      expect(html).not.toContain("Nicht gesendet");
      expect(html).not.toContain("You can send a new request");
      expect(html.match(/<textarea[^>]*>/)?.[0]).toContain("disabled");
      expect(html).toContain('aria-label="An Supervisor senden" disabled=""');
    },
  );
  it("shows a pending receipt without asking for Owner confirmation", () => {
    const pendingConfig: WorkjetThreadConfig = {
      ...config,
      schemaVersion: 2,
      ctoxSupervisorTurn: {
        ...config.ctoxSupervisorTurn!,
        submission: "awaiting-receipt",
        turn: null,
      },
    };
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={pendingConfig}
        instanceId={scope.instanceId}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain("Warte auf CTOX-Bestätigung");
    expect(html).not.toContain("Awaiting confirmation");
    expect(html.match(/<textarea[^>]*>/)?.[0]).toContain("disabled");
    expect(html).not.toContain("Refresh task");
  });
  it("keeps drafting available for a confirmed running task with an explicit separate-message action", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={{
          ...config,
          ctoxSupervisorTurn: {
            ...config.ctoxSupervisorTurn!,
            turn: {
              ...config.ctoxSupervisorTurn!.turn!,
              executionPhase: "running",
              status: "accepted",
              terminal: false,
            },
          },
        }}
        instanceId={scope.instanceId}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain("Trotzdem fortfahren");
    expect(html).toContain("Kontext ergänzen");
    expect(html).toContain("Kein Aufgabenkontext");
    expect(html).toContain("Vorherige Anfrage:");
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).not.toContain("Refresh task");
    expect(html).toContain("Abbrechen");
    expect(html).not.toContain("Approve");
  });
  it("shows received native result and attempt without local provider controls", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={config}
        instanceId={scope.instanceId}
        blockReason={null}
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
        instanceId="managed:foreign"
        blockReason="This project has no confirmed CTOX binding on this computer."
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).not.toContain("Actual native result");
    expect(html).not.toContain("Real requested change");
    expect(html).toContain("no confirmed CTOX binding");
    expect(html).toContain("Erneut versuchen");
  });
  it("shows a definitive pre-submit refusal and lets the user edit a new prompt", () => {
    const rejectedConfig: WorkjetThreadConfig = {
      ...config,
      schemaVersion: 2,
      ctoxSupervisorTurn: {
        ...config.ctoxSupervisorTurn!,
        submission: "not-submitted",
        submissionError: "authentication_required",
        turn: null,
      },
    };
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={scope}
        config={rejectedConfig}
        instanceId={scope.instanceId}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain("Nicht gesendet");
    expect(html).toContain("Bei ctox.dev anmelden</button>");
    expect(html.match(/data-supervisor-connection-status=/g)).toHaveLength(1);
    expect(html.match(/Bei ctox.dev anmelden<\/button>/g)).toHaveLength(1);
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
  });
  it("keeps send unavailable without confirmed native project scope", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={null}
        config={DEFAULT_WORKJET_THREAD_CONFIG}
        instanceId={null}
        blockReason={null}
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).toContain('aria-label="Nachricht an Supervisor"');
    expect(html).toContain('aria-label="An Supervisor senden" disabled=""');
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).not.toContain("Erneut versuchen");
  });
  it("offers a direct way to re-check the connection when scope is missing", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorComposer
        scope={null}
        config={DEFAULT_WORKJET_THREAD_CONFIG}
        instanceId="managed:acceptance"
        blockReason="Could not read the CTOX project list."
        unavailable={false}
        saveConfig={saveConfig}
      />,
    );
    expect(html).not.toContain("Confirm the project and CTOX connection to send.");
    expect(html).toContain("Could not read the CTOX project list.");
    expect(html).toContain("Erneut versuchen");
  });
});
