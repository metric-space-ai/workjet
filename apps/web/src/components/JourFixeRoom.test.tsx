import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { JourFixeRoom, jourFixeActionError } from "./JourFixeRoom";
import type { JourFixeRoomSnapshot } from "../lib/jourFixeRoom";
import fixture from "../fixtures/jour-fixe.contract.json";
import { jourFixeDeck } from "@workjet/slide-engine/fixtures/jour-fixe-deck";

// The canvas stage loads Excalidraw and three.js in the browser; the room tests only need its slot.
vi.mock("./JourFixeCanvasStage", () => ({ default: () => null }));

const meeting = fixture.meeting as JourFixeRoomSnapshot;
const props = { projectTitle: "Fixture", meeting, onBack: () => {} };

describe("Jour fixe room states", () => {
  it("opens native review in the main area without claiming the goal is confirmed", () => {
    const html = renderToStaticMarkup(<JourFixeRoom {...props} onConfirmTodos={async () => {}} />);
    expect(html).toContain('data-workjet-meeting-review=""');
    expect(html).toContain("Vorgeschlagene Aufgaben");
    expect(html).toContain("Verify persistence");
    expect(html).toContain("Comment 1 · Slide 1");
    expect(html).toContain("Transcript 1");
    expect(html).not.toContain("Bestätigte Aufgaben");
  });
  it("requires explicit task owners and rejects an empty Core goal proposal", () => {
    const render = (
      items: readonly NonNullable<JourFixeRoomSnapshot["todos"]>["items"][number][],
    ) =>
      renderToStaticMarkup(
        <JourFixeRoom
          {...props}
          meeting={{ ...meeting, previousGoalRevision: 0, todos: { ...meeting.todos!, items } }}
          onReviseTodos={async () => {}}
          onConfirmTodos={async () => {}}
        />,
      );
    const unowned = render(meeting.todos!.items.map((todo) => ({ ...todo, owner: "" })));
    expect(unowned).toContain('aria-label="Aufgabe 1 Verantwortlich"');
    expect(unowned).toContain("Jede Aufgabe braucht Verantwortliche.");
    const empty = render([]);
    expect(empty).toContain("Mindestens eine Aufgabe nötig.");
    expect(empty).not.toContain("Confirm no to-dos for this meeting");
    const owned = render(
      meeting.todos!.items.map((todo) => ({ ...todo, owner: "Project supervisor" })),
    );
    expect(owned).toContain('value="Project supervisor"');
    expect(owned).not.toContain("Jede Aufgabe braucht Verantwortliche.");
  });
  it("renders planned/preparing without live editing controls or narration", () => {
    for (const state of ["planned", "preparing"] as const) {
      const html = renderToStaticMarkup(
        <JourFixeRoom
          {...props}
          meeting={{ ...meeting, state, slides: [] }}
          onComment={async () => {}}
          onMessage={async () => {}}
        />,
      );
      expect(html).not.toContain("Kommentar auf Folie setzen");
      expect(html).not.toContain("Nachricht an Supervisor");
      expect(html).toContain(state === "preparing" ? "bereitet Folien vor" : "Keine Folien");
    }
  });
  it("does not execute HTML or fetch arbitrary remote images from slide markdown", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{
          ...meeting,
          state: "live",
          slides: [
            {
              id: "slide-1",
              position: 0,
              title: "Evidence",
              markdown:
                "<script>alert(1)</script>\n\n![remote](https://foreign.invalid/image.png)\n\n[link](javascript:alert(1))",
            },
          ],
        }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("foreign.invalid");
  });
  it("keeps native transcript order across streams and initially bounds the rendered history", () => {
    const transcript = Array.from({ length: 120 }, (_, index) => ({
      id: `turn-${index}`,
      sequence: index % 2,
      speaker: "owner" as const,
      text: `Evidence turn ${index}.`,
    }));
    const html = renderToStaticMarkup(
      <JourFixeRoom {...props} meeting={{ ...meeting, state: "live", transcript }} />,
    );
    expect(html).toContain("Frühere anzeigen");
    expect(html).not.toContain("Evidence turn 19.");
    expect(html).toContain("Evidence turn 119.");
    expect(html.indexOf("Evidence turn 21.")).toBeLessThan(html.indexOf("Evidence turn 22."));
  });

  it("keeps cancelled and failed meetings read-only", () => {
    for (const state of ["cancelled", "failed"] as const) {
      const html = renderToStaticMarkup(
        <JourFixeRoom
          {...props}
          meeting={{ ...meeting, state }}
          onComment={async () => {}}
          onMessage={async () => {}}
        />,
      );
      expect(html).not.toContain("Kommentar auf Folie setzen");
      expect(html).not.toContain("Nachricht an Supervisor");
      expect(html).not.toContain("1 Aufgaben bestätigen");
    }
  });
  it("shows presentation slides on the canvas stage and keeps comments behind an explicit mode", () => {
    const first = [...meeting.slides].sort((a, b) => a.position - b.position)[0]!;
    const document = {
      ...jourFixeDeck,
      slides: [{ ...jourFixeDeck.slides[1]!, id: first.id }],
    };
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...meeting, state: "live" }}
        onComment={async () => {}}
        presentation={{ document, editable: true, onSave: async () => {} }}
      />,
    );
    expect(html).toContain("Folie wird geladen …");
    expect(html).toContain("Folie kommentieren");
    expect(html).not.toContain("Kommentar auf Folie setzen");
    expect(html).not.toContain(first.markdown.split("\n")[0]!.slice(0, 24));
  });
  it("keeps the markdown stage for slides that are not in the presentation", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...meeting, state: "live" }}
        onComment={async () => {}}
        presentation={{ document: jourFixeDeck, editable: true, onSave: async () => {} }}
      />,
    );
    expect(html).toContain("Kommentar auf Folie setzen");
    expect(html).not.toContain("Folie kommentieren");
  });
});

describe("Jour fixe start lock", () => {
  const inMinutes = (minutes: number) => Date.now() + minutes * 60_000;
  const render = (state: JourFixeRoomSnapshot["state"], scheduledAt: number) =>
    renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...meeting, state, scheduledAt }}
        onStartMeeting={async () => {}}
      />,
    );
  it("hides the start button more than five minutes before the meeting", () => {
    const html = render("ready", inMinutes(30));
    expect(html).not.toContain("Termin starten");
    expect(html).toContain("Beginnt um");
    expect(html).toContain("Vorbereitet");
  });
  it("reports ongoing preparation while locked", () => {
    const html = render("preparing", inMinutes(30));
    expect(html).not.toContain("Termin starten");
    expect(html).toContain("Beginnt um");
    expect(html).toContain("Vorbereitung läuft");
  });
  it("offers the start button from five minutes before the meeting", () => {
    const html = render("ready", inMinutes(4));
    expect(html).toContain("Termin starten");
    expect(html).not.toContain("Beginnt um");
  });
  it("never locks a live meeting", () => {
    const html = render("live", inMinutes(30));
    expect(html).not.toContain("Beginnt um");
  });
  it("answers a server meeting_not_started rejection with a German line", () => {
    const scheduled = { ...meeting, scheduledAt: inMinutes(30) };
    expect(jourFixeActionError(new Error("rejected: meeting_not_started"), scheduled)).toBe(
      `Der Termin beginnt erst um ${new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: meeting.timezone }).format(scheduled.scheduledAt)}.`,
    );
    expect(jourFixeActionError(new Error("other"), scheduled)).toBe(
      "Änderung nicht bestätigt · Entwurf bleibt erhalten.",
    );
    expect(jourFixeActionError("meeting_not_started", scheduled)).toBe(
      "Änderung nicht bestätigt · Entwurf bleibt erhalten.",
    );
  });
});
