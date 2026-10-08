/** Development-only, sanitized contract fixture. Never connects to a CTOX instance. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectId } from "@workjet/contracts";
import { JourFixeRoom } from "../components/JourFixeRoom";
import { jourFixeDeck } from "@workjet/slide-engine/fixtures/jour-fixe-deck";
import { updateSlideCanvas } from "@workjet/slide-engine/excalidraw/scene";
import type { SlideDocument } from "@workjet/slide-engine/schema";
import { ProjectWorkspace } from "../components/ProjectWorkspace";
import { ProjectCalendar } from "../components/ProjectCalendar";
import { Button } from "../components/ui/button";
import { type JourFixeRoomSnapshot } from "../lib/jourFixeRoom";
import type { GalleryProject } from "../projectOverview";
import { randomUUID } from "../lib/utils";
import fixture from "./jour-fixe.contract.json";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Jour fixe fixture is available only on a loopback development server.");
}
const contractMeeting = fixture.meeting as JourFixeRoomSnapshot;
const project: GalleryProject = {
  key: "fixture:project-1",
  id: "project-1",
  title: "Fixture project",
  native: true,
  local: null,
  configuration: {
    id: ProjectId.make("project-1"),
    title: "Fixture project",
    jourFixe: { weekday: 1, time: "13:00", timezone: "Europe/Berlin" },
  },
};
function syntheticNarration() {
  const sampleRate = 8000;
  const samples = sampleRate * 4;
  const data = new ArrayBuffer(44 + samples * 2);
  const bytes = new DataView(data);
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) =>
      bytes.setUint8(offset + index, character.charCodeAt(0)),
    );
  text(0, "RIFF");
  bytes.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, sampleRate, true);
  bytes.setUint32(28, sampleRate * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  text(36, "data");
  bytes.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++)
    bytes.setInt16(
      44 + index * 2,
      Math.round(Math.sin((index / sampleRate) * Math.PI * 440) * 500),
      true,
    );
  return URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
}
// `?presentation=1`: the first two slides carry a hand-drawn presentation; saves stay in memory.
const withPresentation = new URLSearchParams(location.search).get("presentation") === "1";
const fixturePresentation: SlideDocument = {
  ...jourFixeDeck,
  slides: [
    { ...jourFixeDeck.slides[0]!, id: "slide-1" },
    { ...jourFixeDeck.slides[1]!, id: "slide-fixture-2" },
  ],
};

function Fixture() {
  const [view, setView] = useState<"overview" | "calendar" | "meeting">("overview");
  const [presentation, setPresentation] = useState<SlideDocument>(fixturePresentation);
  const [meeting, setMeeting] = useState<JourFixeRoomSnapshot>({
    ...contractMeeting,
    state: "live",
    slides: [
      ...contractMeeting.slides,
      {
        id: "slide-fixture-2",
        position: 1,
        title: "Open decisions",
        markdown:
          "## Fixture agenda\n\n- Review the source evidence.\n- Agree on the next acceptance criteria.",
      },
      {
        id: "slide-fixture-3",
        position: 2,
        title: "Next goals",
        markdown:
          "Review the proposed to-dos before confirming.\n\n**No real project goal is changed in this fixture.**",
      },
    ],
  });
  const [failNext, setFailNext] = useState(false);
  const [narration] = useState(syntheticNarration);
  const [audioSlideId, setAudioSlideId] = useState(contractMeeting.slides[0]!.id);
  useEffect(() => () => URL.revokeObjectURL(narration), [narration]);
  const [microphone, setMicrophone] = useState(false);
  const [partial, setPartial] = useState("");
  async function apply(
    revision: number,
    change: (current: JourFixeRoomSnapshot) => JourFixeRoomSnapshot,
  ) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (failNext) {
      setFailNext(false);
      throw new Error("Fixture receipt unavailable");
    }
    if (meeting.revision !== revision) throw new Error("Fixture revision changed");
    setMeeting(change(meeting));
  }
  return (
    <main className="min-h-dvh bg-background text-foreground" data-workjet-fixture="jour-fixe">
      <nav
        className="flex flex-wrap items-center gap-2 border-b border-border p-3"
        aria-label="Fixture controls"
      >
        <span className="mr-auto text-xs text-muted-foreground">
          Isolated fixture · {fixture.source.contract}
        </span>
        <Button size="sm" variant="outline" onClick={() => setView("overview")}>
          Project overview
        </Button>
        <Button size="sm" variant="outline" onClick={() => setView("calendar")}>
          Calendar
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setFailNext(true)}
          aria-pressed={failNext}
        >
          Fail next receipt
        </Button>
        <select
          aria-label="Fixture meeting state"
          value={meeting.state}
          className="rounded border border-border bg-background p-1 text-xs"
          onChange={(event) => {
            const state = event.target.value as JourFixeRoomSnapshot["state"];
            setMeeting({ ...meeting, state, revision: meeting.revision + 1 });
          }}
        >
          {[
            "planned",
            "preparing",
            "ready",
            "live",
            "review",
            "confirmed",
            "cancelled",
            "failed",
          ].map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
      </nav>
      {view === "overview" && (
        <ProjectWorkspace
          project={project}
          threads={[]}
          onOpenChat={() => {}}
          onAddParent={async () => false}
          onOpenJourFixe={() => setView("meeting")}
        />
      )}
      {view === "calendar" && (
        <div className="p-5">
          <ProjectCalendar
            projects={[
              {
                ...project,
                onOpen: () => setView("overview"),
                onOpenJourFixe: () => setView("meeting"),
              },
            ]}
          />
        </div>
      )}
      {view === "meeting" && (
        <JourFixeRoom
          projectTitle="Fixture project"
          meeting={meeting}
          onBack={() => setView("overview")}
          {...(withPresentation
            ? {
                presentation: {
                  document: presentation,
                  editable: true,
                  onSave: async (slideId, scene) => {
                    setPresentation(updateSlideCanvas(presentation, slideId, scene));
                  },
                },
              }
            : {})}
          audio={{
            meetingId: meeting.id,
            projectId: meeting.projectId,
            slideId: audioSlideId,
            deckRevision: meeting.deckRevision,
            blobUrl: narration,
          }}
          onSlideChange={setAudioSlideId}
          partialTranscript={
            partial ? { streamId: "fixture-stream", sequence: 2, text: partial } : undefined
          }
          microphoneActive={microphone}
          onToggleMicrophone={() => {
            setMicrophone(!microphone);
            setPartial(microphone ? "" : "Fixture partial transcript…");
          }}
          onRefresh={async () => {
            setMeeting({ ...meeting });
          }}
          onStartMeeting={(_id, revision) =>
            apply(revision, (current) => ({
              ...current,
              state: "live",
              revision: current.revision + 1,
            }))
          }
          onEndMeeting={(_id, revision) =>
            apply(revision, (current) => ({
              ...current,
              state: "review",
              revision: current.revision + 1,
            }))
          }
          onComment={(draft, text) =>
            apply(draft.expectedRevision, (current) => ({
              ...current,
              revision: current.revision + 1,
              comments: [
                ...current.comments,
                {
                  id: randomUUID(),
                  slideId: draft.slideId,
                  deckRevision: draft.deckRevision,
                  x: draft.x,
                  y: draft.y,
                  text,
                },
              ],
            }))
          }
          onMessage={(_id, revision, text) =>
            apply(revision, (current) => ({
              ...current,
              revision: current.revision + 1,
              transcript: [
                ...current.transcript,
                {
                  id: randomUUID(),
                  sequence: Math.max(0, ...current.transcript.map((turn) => turn.sequence)) + 1,
                  speaker: "owner",
                  text,
                },
              ],
            }))
          }
          onReviseTodos={(_id, revision, proposal, items) =>
            apply(revision, (current) => {
              if (current.todos?.revision !== proposal) throw new Error("Stale proposal");
              return {
                ...current,
                revision: current.revision + 1,
                todos: { revision: proposal + 1, status: "proposed", items },
              };
            })
          }
          onConfirmTodos={(_id, revision, proposal, goalRevision) =>
            apply(revision, (current) => {
              if (
                current.todos?.revision !== proposal ||
                current.previousGoalRevision !== goalRevision
              )
                throw new Error("Stale goal");
              return {
                ...current,
                state: "confirmed",
                revision: current.revision + 1,
                todos: { ...current.todos, status: "confirmed" },
              };
            })
          }
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
