import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  JourFixeRoom,
  jourFixeActionError,
  jourFixeStartButtonLabel,
  jourFixeThumbExportState,
} from "./JourFixeRoom";
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
  it("renders planned/preparing without live editing controls, with a writable field", () => {
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
      // Das Feld ist auch vor dem Start fokussierbar und beschreibbar.
      expect(html).toContain("Nachricht an Supervisor");
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
  it("zeigt Lade- und Endfehlerzustände knapp am Bereich, nie als Kopfleiste", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...meeting, state: "live" }}
        onMessage={async () => {}}
        presentationStatus={{ state: "loading", text: "Folien werden geladen …" }}
        narrationStatus={{ state: "failed", text: "Ton nicht verfügbar", onRetry: () => {} }}
        pendingChange={{ onRetry: () => {} }}
      />,
    );
    expect(html).toContain('data-workjet-presentation-state="loading"');
    expect(html).toContain('data-workjet-narration-state="failed"');
    expect(html).toContain("Neu laden");
    expect(html).toContain('data-workjet-pending-change="failed"');
    expect(html).toContain("Nicht gespeichert");
    expect(html).toContain("Erneut senden");
    expect(html).not.toContain("Erneut versuchen");
    expect(html).not.toContain("operation identity");
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
    expect(html).toContain("Beginnt ");
    expect(html).not.toContain("Beginnt um");
    expect(html).not.toContain("Vorbereitet");
    expect(html).not.toContain("Bereit");
    expect(html).not.toContain("Prüfen");
  });
  it("names only the start time while preparation is locked", () => {
    const html = render("preparing", inMinutes(30));
    expect(html).not.toContain("Termin starten");
    expect(html).toContain("Beginnt ");
    expect(html).not.toContain("Vorbereitung läuft");
    expect(html).not.toContain("In Vorbereitung");
  });
  it("offers the start button from five minutes before the meeting", () => {
    const html = render("ready", inMinutes(4));
    expect(html).toContain("Termin starten");
    expect(html).toContain("Beginnt ");
    expect(html).not.toContain("Bereit");
    expect(html).not.toContain("Vorbereitet");
    expect(html).not.toContain("Prüfen");
    expect(html).toContain('data-workjet-meeting-start="idle"');
  });
  it("labels a hanging start on the button only", () => {
    expect(jourFixeStartButtonLabel(true)).toBe("Startet …");
    expect(jourFixeStartButtonLabel(false)).toBe("Termin starten");
  });
  it("exports dark thumbnails by inverting the scene paper, not a pre-darkened ground", () => {
    expect(jourFixeThumbExportState("#fffef8", true)).toEqual({
      viewBackgroundColor: "#fffef8",
      exportBackground: true,
      exportWithDarkMode: true,
    });
    expect(jourFixeThumbExportState("#fffef8", false).exportWithDarkMode).toBe(false);
  });
  it("never locks a live meeting", () => {
    const html = render("live", inMinutes(30));
    expect(html).not.toContain("Beginnt ");
    expect(html).toContain("läuft seit");
    expect(html).not.toContain("Prüfen");
    expect(html).not.toContain("Aufgaben prüfen");
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

describe("Tagesordnung und freie Themen", () => {
  const slides = [
    { id: "s1", position: 0, title: "Tagesordnung", markdown: "1. Stand\n2. Freie Themen" },
    { id: "s2", position: 1, title: "Stand gegen Ziele", markdown: "PR merged." },
    { id: "s3", position: 2, title: "Freie Themen", markdown: "Offene Punkte." },
  ];
  const render = (items: typeof slides, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...meeting, state: "live", slides: items }}
        onMessage={async () => {}}
        {...extra}
      />,
    );
  it("zeigt die Position im Folienzähler der Bühne und echte Miniaturen in der Leiste", () => {
    const html = render(slides);
    expect(html).not.toContain("data-workjet-agenda-line");
    expect(html).not.toContain("Noch kein Sprecher");
    expect(html).toContain("1 / 3");
    expect(html.indexOf("1 / 3")).toBeLessThan(html.indexOf('aria-label="Folien"'));
    // Vorschaubilder nutzen die Folienfläche (Papier/Tafel), keine grauen Textkacheln.
    const nav = html.slice(html.indexOf('aria-label="Folien"'));
    expect(nav).toContain("bg-[#f5f3ee]");
    expect(nav).toContain("dark:bg-[#1b1a17]");
    expect(nav).toContain("Stand gegen Ziele");
    expect(nav).not.toContain("bg-[#e9e6df]");
  });
  it("wechselt auf der letzten Folie auf „Freie Themen“ und stellt das Eingabefeld vorne", () => {
    const html = render([slides[2]!]);
    expect(html.indexOf("Freie Themen")).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Nachricht an Supervisor"')).toBeLessThan(
      html.indexOf("Das übernehmen wir."),
    );
  });
  it("lässt das Eingabefeld bei Tagesordnungspunkten am Ende", () => {
    const html = render(slides);
    expect(html.indexOf('aria-label="Nachricht an Supervisor"')).toBeGreaterThan(
      html.indexOf("Das übernehmen wir."),
    );
  });
});

describe("Bedienung wirkt sofort", () => {
  const twoSlides = [
    { id: "s1", position: 0, title: "Tagesordnung", markdown: "1. Stand" },
    { id: "s2", position: 1, title: "Stand gegen Ziele", markdown: "PR merged." },
  ];
  const live = { ...meeting, state: "live" as const, slides: twoSlides };
  it("sperrt das Schreibfeld nie, auch nicht während Ton oder Folien laden", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={live}
        onMessage={() => new Promise<void>(() => {})}
        presentationStatus={{ state: "loading", text: "Folien werden geladen …" }}
        narrationStatus={{ state: "loading", text: "Ton wird geladen …" }}
      />,
    );
    const field = html.match(/<input[^>]*aria-label="Nachricht an Supervisor"[^>]*>/)?.[0] ?? "";
    expect(field).not.toBe("");
    expect(field).not.toContain("disabled");
    // Solange das Deck lädt, erscheint kein Fließtext-Ersatz, sondern der Ladezustand.
    expect(html.indexOf("Folie wird geladen …")).toBeGreaterThan(-1);
  });
  it("stellt Weiter und Zurück frei und kennt keinen toten Play-Knopf", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom {...props} meeting={live} onMessage={async () => {}} />,
    );
    const previous = html.match(/<button[^>]*aria-label="Vorherige Folie"[^>]*>/)?.[0] ?? "";
    const next = html.match(/<button[^>]*aria-label="Nächste Folie"[^>]*>/)?.[0] ?? "";
    const play = html.match(/<button[^>]*aria-label="Sprecher abspielen"[^>]*>/)?.[0] ?? "";
    expect(previous).toContain('disabled=""');
    expect(next).not.toContain('disabled=""');
    expect(play).not.toContain('disabled=""');
    expect(html).toContain('aria-label="Vollbild"');
    expect(html).not.toContain("Vollbild (F)");
  });
  it("zeigt im dunklen Schema die dunkle Folienfläche und ruhige Kopfzeile", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={live}
        onMessage={async () => {}}
        onEndMeeting={async () => {}}
      />,
    );
    expect(html).toContain("dark:bg-[#1b1a17]");
    expect(html).toContain("läuft seit");
    expect(html).toContain("Beenden");
    expect(html).not.toContain("text-red-400");
    expect(html).not.toContain("Termin beenden");
  });
  it("markiert Tabs ruhig und zeigt knappe deutsche Leerzustände", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{ ...live, comments: [], transcript: [] }}
        onMessage={async () => {}}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Noch keine Beiträge");
  });
  it("zeigt den Aufnahmezustand und Diktatfehler am Feld", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={live}
        onMessage={async () => {}}
        onToggleMicrophone={() => {}}
        microphoneActive={true}
        microphoneError="Keine Mikrofon-Freigabe – bitte Zugriff erlauben."
      />,
    );
    expect(html).toContain('data-workjet-microphone-state="recording"');
    expect(html).toContain("Aufnahme läuft");
    expect(html).toContain("Keine Mikrofon-Freigabe");
  });
});
