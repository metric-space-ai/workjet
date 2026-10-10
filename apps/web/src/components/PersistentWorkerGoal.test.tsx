import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  WorkjetThreadGoal,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { PersistentWorkerGoal, persistentWorkerGoalState } from "./PersistentWorkerGoal";
import WorkerKanban from "./PersistentWorkerKanban";

const goal = Schema.decodeUnknownSync(WorkjetThreadGoal)({
  objective: "Verify the real Molecularity rendering benchmark",
  status: "active",
  revision: 4,
  continuationCount: 2,
  lastCompletedTurnId: "turn-molecularity-2",
  pendingContinuation: null,
  reason: null,
  updatedAt: "2026-10-10T00:00:00Z",
});
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  team: {
    role: "specialist",
    domain: "rendering",
    projectId: ProjectId.make("Molecularity"),
    threadId: ThreadId.make("rendering-parent"),
    parentThreadId: ThreadId.make("supervisor"),
    goal: goal.objective,
    createdAt: goal.updatedAt,
  },
  goal,
};
function html(value: WorkjetThreadConfig = config, compact = false) {
  return renderToStaticMarkup(
    <PersistentWorkerGoal
      config={value}
      compact={compact}
      sessionStatus="running"
      onChangeGoal={async () => true}
    />,
  );
}
const document = {
  schemaVersion: "learnordie.slide.v1",
  id: "reported-board",
  title: "Rendering plan",
  language: "en",
  aspect: "16:9",
  theme: "learnordie-dark-room",
  deckSettings: {
    defaultTransition: "none",
    showSlideNumbers: false,
    allowFragments: false,
    mobileMode: "scaled",
  },
  slides: [
    {
      id: "iteration-2",
      title: "Rendering plan",
      layout: "table_focus",
      intent: "summary",
      blocks: [
        {
          id: "cards",
          type: "table",
          columns: ["To do", "Doing", "Done"],
          rows: [["Measure startup", "Compile", "Import"]],
          mobileStrategy: "cards",
        },
      ],
      speakerNotes: [],
      sourceRefs: [
        { id: "fixture-source", sourceType: "import", label: "Isolated interaction fixture" },
      ],
    },
  ],
  assets: [],
  createdBy: { mode: "import" },
};
describe("persistent worker goal display", () => {
  it("shows the saved objective, current loop and revision", () => {
    const text = html();
    expect(text).toContain(goal.objective);
    expect(text).toContain("Läuft · Durchlauf 2");
    expect(text).toContain("Ziel gespeichert · Revision 4");
    expect(text).toContain('dateTime="' + goal.updatedAt + '"');
    expect(text).toContain("Ziel ändern");
    expect(text).toContain("Pausieren");
  });
  it("shows the same objective and state compactly", () => {
    expect(html(config, true)).toContain("Läuft · Durchlauf 2");
    expect(html(config, true)).not.toContain("Mini-Kanban");
  });
  it("shows an imported persistent worker's assigned objective without inventing a running loop", () => {
    if (config.schemaVersion !== 2) throw new Error("Invalid fixture");
    const { goal: ignored, ...idle } = config;
    void ignored;
    const text = html(idle);
    expect(text).toContain(goal.objective);
    expect(text).toContain("Ziel noch nicht gesetzt");
    expect(text).toContain("Schleife nicht gestartet");
    expect(text).toContain("Ziel festlegen");
    expect(text).not.toContain("Pausieren");
    expect(text).not.toContain("Läuft");
  });
  it.each(["supervisor", "worker"] as const)("never adds a loop or board to %s", (role) => {
    if (config.schemaVersion !== 2 || !config.team) throw new Error("Invalid fixture");
    const identity = {
      projectId: config.team.projectId,
      threadId: config.team.threadId,
      goal: config.team.goal,
      createdAt: goal.updatedAt,
    };
    const team =
      role === "supervisor"
        ? { ...identity, role, parentThreadId: null }
        : { ...identity, role, parentThreadId: ThreadId.make("parent"), packageId: "one-pr" };
    expect(html({ ...config, team })).toBe("");
  });
  it("gives persisted stops and request waits priority over a running session", () => {
    expect(
      persistentWorkerGoalState(goal, { sessionStatus: "running", hasPendingApprovals: true }),
    ).toBe("Wartet auf Freigabe");
    expect(
      persistentWorkerGoalState(goal, { sessionStatus: "running", hasPendingUserInput: true }),
    ).toBe("Wartet auf Eingabe");
    expect(
      persistentWorkerGoalState({ ...goal, status: "paused" }, { sessionStatus: "running" }),
    ).toBe("Pausiert");
    expect(
      persistentWorkerGoalState({ ...goal, status: "blocked" }, { sessionStatus: "running" }),
    ).toBe("Blockiert");
    expect(persistentWorkerGoalState(goal, { sessionStatus: "error" })).toBe("Fehler");
  });
  it("retains queued and completed facts without claiming verification", () => {
    const queued = {
      ...goal,
      pendingContinuation: {
        commandId: "continue-3",
        messageId: "message-3",
        createdAt: goal.updatedAt,
      },
    };
    expect(persistentWorkerGoalState(Schema.decodeUnknownSync(WorkjetThreadGoal)(queued), {})).toBe(
      "Eingereiht",
    );
    expect(persistentWorkerGoalState({ ...goal, status: "complete" }, {})).toBe("Abgeschlossen");
    expect(html()).not.toContain("Verified");
  });
  it("labels a previous iteration and does not render private legacy cards as a board", () => {
    const text = html({
      ...config,
      goal: {
        ...goal,
        kanban: {
          goalRevision: 3,
          iteration: 1,
          updatedAt: goal.updatedAt,
          cards: [{ id: "private-card", title: "Legacy card content", status: "doing" }],
        },
      },
    });
    expect(text).toContain("Mini-Kanban · Durchlauf 1");
    expect(text).toContain("vorheriger Stand");
    expect(text).not.toContain("Legacy card content");
    expect(text).toContain("noch kein Slide-Engine-Board");
  });
  it("renders the retained canonical SlideDocument through the engine", () => {
    const text = renderToStaticMarkup(
      <WorkerKanban
        snapshot={{
          schemaVersion: "learnordie.slide.v1",
          documentJson: JSON.stringify(document),
          sha256: "a".repeat(64),
        }}
      />,
    );
    expect(text).toContain('data-slide-id="iteration-2"');
    expect(text).toContain("Measure startup");
    expect(text).toContain("Compile");
    expect(text).not.toContain("ungültig");
  });
  it("fails visibly for malformed stored documents", () => {
    expect(
      renderToStaticMarkup(
        <WorkerKanban
          snapshot={{
            schemaVersion: "learnordie.slide.v1",
            documentJson: "{}",
            sha256: "a".repeat(64),
          }}
        />,
      ),
    ).toContain("ungültig");
  });
});
