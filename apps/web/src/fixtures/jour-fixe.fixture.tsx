/** Development-only, sanitized contract fixture. Never connects to a CTOX instance. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectId } from "@workjet/contracts";
import { JourFixeRoom, type JourFixeAreaStatus } from "../components/JourFixeRoom";
import { JourFixeSpeechRoom } from "../components/JourFixeSpeechRoom";
import { ProviderUpdateChipView } from "../components/ProviderUpdateLaunchNotification";
import { jourFixeDeck } from "@workjet/slide-engine/fixtures/jour-fixe-deck";
import { updateSlideCanvas } from "@workjet/slide-engine/excalidraw/scene";
import type { SlideDocument } from "@workjet/slide-engine/schema";
import { ProjectWorkspace } from "../components/ProjectWorkspace";
import { ProjectCalendar } from "../components/ProjectCalendar";
import { Button } from "../components/ui/button";
import { JourFixeReadError } from "../lib/jourFixeReadRetry";
import type { JourFixeSpeechProvider } from "../lib/jourFixeSpeech";
import { type JourFixeRoomSnapshot } from "../lib/jourFixeRoom";
import type { GalleryProject } from "../projectOverview";
import { workjetUiLanguage } from "../workjetProjectControl";
import { randomUUID } from "../lib/utils";
import fixture from "./jour-fixe.contract.json";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Jour fixe fixture is available only on a loopback development server.");
}
// Die Fixture bildet die deutsche Workjet-Oberfläche ab (index.html hat lang="de").
document.documentElement.lang = "de";
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
// `?scheduledIn=30`: the meeting is scheduled N minutes from now, to show the start lock.
// `?speech=1&narration=ready|loading|failed`: speech session with a fixture provider,
// so the dense German narration states (load, failure + „Neu laden“, playing) are visible.
// `?presentationState=loading|failed`: die knappe Folien-Statuszeile in der Folienfläche.
// `?pending=1`: die endgültig ungespeicherte Änderung als Zeile am Eingabefeld.
// `?chrome=1`: header row with the update chip and the German „Letzter Stand“ line.
const params = new URLSearchParams(location.search);
const withPresentation = params.get("presentation") === "1";
const withSpeech = params.get("speech") === "1";
const narrationMode = params.get("narration") ?? "ready";
const presentationState = params.get("presentationState");
const withPendingChange = params.get("pending") === "1";
const withChrome = params.get("chrome") === "1";
const scheduledInMinutes = Number(params.get("scheduledIn") ?? Number.NaN);
const initialState = params.get("state") as JourFixeRoomSnapshot["state"] | null;
// `?theme=dark`: der Raum folgt dem dunklen App-Schema (Klasse auf dem Wurzelelement).
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const presentationStatus: JourFixeAreaStatus | undefined =
  presentationState === "loading" || presentationState === "failed"
    ? {
        state: presentationState,
        text: presentationState === "failed" ? "Folien nicht verfügbar" : "Folien werden geladen …",
        ...(presentationState === "failed" ? { onRetry: () => {} } : {}),
      }
    : undefined;
const fixturePresentation: SlideDocument = {
  ...jourFixeDeck,
  slides: [
    { ...jourFixeDeck.slides[0]!, id: "slide-1" },
    { ...jourFixeDeck.slides[1]!, id: "slide-fixture-2" },
  ],
};

function Fixture() {
  const [view, setView] = useState<"overview" | "calendar" | "meeting">(
    withSpeech || params.get("room") === "1" ? "meeting" : "overview",
  );
  const [chipDismissed, setChipDismissed] = useState(false);
  const [presentation, setPresentation] = useState<SlideDocument>(fixturePresentation);
  const [canvasSaveCount, setCanvasSaveCount] = useState(0);
  const [meeting, setMeeting] = useState<JourFixeRoomSnapshot>({
    ...contractMeeting,
    state: initialState ?? "live",
    ...(Number.isFinite(scheduledInMinutes)
      ? { scheduledAt: Date.now() + scheduledInMinutes * 60_000 }
      : {}),
    slides: [
      {
        id: "slide-fixture-agenda",
        position: 0,
        title: "Tagesordnung",
        markdown: "1. Stand gegen Ziele\n2. Entscheidungen\n3. Nächste Ziele\n4. Freie Themen",
      },
      { ...contractMeeting.slides[0]!, position: 1 },
      {
        id: "slide-fixture-2",
        position: 2,
        title: "Entscheidungen",
        markdown:
          "## Fixture-Entscheidungen\n\n- Quellenlage prüfen.\n- Nächste Abnahmekriterien festlegen.",
      },
      {
        id: "slide-fixture-3",
        position: 3,
        title: "Nächste Ziele",
        markdown:
          "Vorgeschlagene Aufgaben vor der Bestätigung prüfen.\n\n**Diese Fixture ändert kein echtes Projektziel.**",
      },
      {
        id: "slide-fixture-4",
        position: 4,
        title: "Freie Themen",
        markdown: "Offene Punkte der Runde.",
      },
    ],
  });
  const [failNext, setFailNext] = useState(false);
  const [narration] = useState(syntheticNarration);
  const [audioSlideId, setAudioSlideId] = useState(contractMeeting.slides[0]!.id);
  useEffect(() => () => URL.revokeObjectURL(narration), [narration]);
  const [microphone, setMicrophone] = useState(false);
  const [partial, setPartial] = useState("");
  // Fixture provider: „loading“ bleibt offen (wie die bis zu 5 min laufenden
  // Wiederholungen der Bibliothek), „failed“ meldet den Fehlercode guest_failed.
  const [speechProvider] = useState<JourFixeSpeechProvider>(() => ({
    kind: "ctox-gateway",
    microphoneAvailable: false,
    async prepareNarration({ signal }) {
      if (narrationMode === "failed") throw new JourFixeReadError("guest_failed");
      if (narrationMode === "loading") {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      }
      signal.throwIfAborted();
      const response = await fetch(narration);
      return response.blob();
    },
    async startListening() {
      throw new Error("Fixture only");
    },
  }));
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
      {withChrome && (
        <div
          className="flex items-center justify-end gap-2 border-b border-border px-3 py-1.5"
          data-workjet-fixture-chrome=""
        >
          <span className="mr-auto text-xs text-muted-foreground" role="status">
            Instanz nicht erreichbar · Letzter Stand:{" "}
            {new Date("2026-10-12T18:32:38").toLocaleString(
              workjetUiLanguage() === "en" ? "en-US" : "de-DE",
              {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              },
            )}
          </span>
          {!chipDismissed && (
            <ProviderUpdateChipView
              title="Codex 0.162.1 verfügbar"
              onOpen={() => {}}
              onDismiss={() => setChipDismissed(true)}
            />
          )}
        </div>
      )}
      <nav
        className="flex flex-wrap items-center gap-2 border-b border-border p-3"
        aria-label="Fixture controls"
      >
        <span className="mr-auto text-xs text-muted-foreground">
          Isolated fixture · {fixture.source.contract}
        </span>
        {withPresentation && (
          <output aria-label="Fixture canvas save count">{canvasSaveCount}</output>
        )}
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
      {view === "meeting" && withSpeech && (
        <JourFixeSpeechRoom
          instanceId="fixture"
          speechProvider={speechProvider}
          projectTitle="Fixture project"
          meeting={meeting}
          onBack={() => setView("overview")}
          {...(presentationStatus ? { presentationStatus } : {})}
          {...(withPendingChange ? { pendingChange: { onRetry: () => {} } } : {})}
          onRefresh={async () => {
            setMeeting({ ...meeting });
          }}
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
        />
      )}
      {view === "meeting" && !withSpeech && (
        <JourFixeRoom
          projectTitle="Fixture project"
          meeting={meeting}
          onBack={() => setView("overview")}
          {...(presentationStatus ? { presentationStatus } : {})}
          {...(withPendingChange ? { pendingChange: { onRetry: () => {} } } : {})}
          {...(withPresentation
            ? {
                presentation: {
                  document: presentation,
                  editable: true,
                  onSave: async (slideId, scene) => {
                    setCanvasSaveCount((count) => count + 1);
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
