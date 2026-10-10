/** Loopback-only interaction fixture; no instance, model or customer data. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  WorkjetThreadGoal,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import {
  PersistentWorkerGoal,
  type PersistentGoalChange,
} from "../components/PersistentWorkerGoal";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Persistent worker fixture requires a loopback development server.");
}
const key = "workjet.goal-interaction-fixture";
const decodeGoal = Schema.decodeSync(Schema.fromJsonString(WorkjetThreadGoal));
const boardDocument = {
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
  createdBy: {
    mode: "import",
  },
};
function readGoal() {
  const saved = localStorage.getItem(key);
  return saved ? decodeGoal(saved) : null;
}
function Fixture() {
  const [goal, setGoal] = useState(readGoal);
  const [rejectNext, setRejectNext] = useState(true);
  const config: WorkjetThreadConfig = {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    team: {
      role: "specialist",
      domain: "rendering",
      projectId: ProjectId.make("fixture-project"),
      threadId: ThreadId.make("fixture-worker"),
      parentThreadId: ThreadId.make("fixture-supervisor"),
      goal: "Die gemessene Rendering-Latenz verbessern.",
      createdAt: "2026-10-10T00:00:00Z",
    },
    ...(goal ? { goal } : {}),
  };
  const change = async (input: PersistentGoalChange) => {
    if (rejectNext) {
      setRejectNext(false);
      return false;
    }
    const revision = (goal?.revision ?? -1) + 1;
    const next = Schema.decodeUnknownSync(WorkjetThreadGoal)({
      objective: input.objective ?? goal?.objective,
      status: input.status,
      revision,
      continuationCount: goal?.continuationCount ?? 0,
      lastCompletedTurnId: null,
      pendingContinuation: null,
      reason: null,
      updatedAt: "2026-10-10T12:00:00Z",
      kanban: {
        goalRevision: revision,
        iteration: 0,
        updatedAt: "2026-10-10T12:00:00Z",
        cards: [],
        slideDocument: {
          schemaVersion: "learnordie.slide.v1",
          documentJson: JSON.stringify(boardDocument),
          sha256: "a".repeat(64),
        },
      },
    });
    localStorage.setItem(key, JSON.stringify(next));
    setGoal(next);
    return true;
  };
  return (
    <main className="mx-auto max-w-3xl py-6">
      <h1 className="px-3 pb-4 text-lg font-medium">Isolierte Persistent-Worker-Fixture</h1>
      <PersistentWorkerGoal
        config={config}
        sessionStatus={goal ? "running" : null}
        onChangeGoal={change}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
