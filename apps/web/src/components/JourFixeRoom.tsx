import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  MessageSquarePlusIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { randomUUID } from "../lib/utils";
import { JourFixePlayer } from "./JourFixePlayer";
import { WorkjetHeaderContent } from "./WorkjetHeaderSlots";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";
import {
  jourFixeCommentAnchor,
  jourFixeCommentIsCurrent,
  jourFixeCommentsForSlide,
  jourFixeEvidenceLabel,
  jourFixeVisiblePartial,
  type JourFixePartialTranscript,
  type JourFixeCommentDraft,
  type JourFixeRoomSnapshot,
  type JourFixeTodo,
} from "../lib/jourFixeRoom";

import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import type { SlideDocument } from "@workjet/slide-engine/schema";
import { loadCanvasRuntime } from "@workjet/slide-engine/canvas";
import { canvasSceneForSlide } from "@workjet/slide-engine/excalidraw/scene";
import { JOUR_FIXE_CANVAS_MESSAGES } from "../lib/jourFixeCanvasMessages";
import { PresentationSlideChangedError } from "../lib/jourFixePresentation";
import { jourFixeShortcut } from "../lib/jourFixeShortcuts";

// The canvas, its 3D scenes and the Excalidraw runtime load only when a meeting has a presentation.
const JourFixeCanvasStage = lazy(() => import("./JourFixeCanvasStage"));

const MEETING_STATE_LABELS: Record<string, string> = {
  planned: "Geplant",
  preparing: "In Vorbereitung",
  ready: "Bereit",
  live: "Live",
  review: "Prüfung",
  confirmed: "Bestätigt",
  cancelled: "Abgesagt",
  failed: "Fehlgeschlagen",
};

const PANEL_LABELS = {
  conversation: "Unterhaltung",
  comments: "Kommentare",
  agenda: "Agenda",
} as const;

const MEETING_MARKDOWN_COMPONENTS: Components = {
  img: () => null,
  a: ({ children }) => <span className="underline">{children}</span>,
};

/** Der Raum öffnet frühestens fünf Minuten vor dem geplanten Beginn. */
export const JOUR_FIXE_START_LEAD_MS = 5 * 60_000;

/** Folienfläche: Papier im hellen Schema, Tafel im dunklen Schema. */
const STAGE_SURFACE_CLASSES = "bg-stage-surface text-stage-foreground";
const STAGE_MUTED_CLASSES = "text-stage-muted";

/** Feste deutsche Zeile; der Rohtext bleibt in der Konsole (UI-Vertrag §2). */
export const JOUR_FIXE_SLIDE_SAVE_FAILED = "Folie nicht gespeichert";

/** Ob die App gerade im dunklen Schema steht (Klasse `dark` auf dem Wurzelelement). */
export function useWorkjetDarkScheme(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);
  return dark;
}

const THUMB_RUNTIME_BASE = `${import.meta.env.BASE_URL}vendor/excalidraw/`;

/**
 * App-Zustand für die Vorschau per `exportToSvg`.
 * `exportWithDarkMode` legt denselben Invertier-Filter auf die ganze SVG wie
 * `theme="dark"` auf die Zeichenfläche. Der Grund bleibt das helle Papier der
 * Szene: ein vorab dunkler Grund würde mitinvertiert und wieder hell.
 */
export function jourFixeThumbExportState(backgroundColor: string, dark: boolean) {
  return {
    viewBackgroundColor: backgroundColor,
    exportBackground: true as const,
    exportWithDarkMode: dark,
  };
}

/** Während die Startbestätigung aussteht, nur die Knopfbeschriftung – keine Leiste. */
export function jourFixeStartButtonLabel(pending: boolean): string {
  return pending ? "Startet …" : "Termin starten";
}

/**
 * Verkleinerte echte Folie in der Vorschauleiste: dasselbe Engine-Deck wie die
 * Bühne, als einmalig exportiertes Bild. Zeigt das Theme der Folie, keine Kachel.
 */
function JourFixeCanvasThumb({
  document: deck,
  slideId,
  dark,
}: {
  readonly document: SlideDocument;
  readonly slideId: string;
  readonly dark: boolean;
}) {
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const slide = deck.slides.find((item) => item.id === slideId);
    if (!slide) return;
    const scene = slide.canvas ?? canvasSceneForSlide(slide, deck.assets);
    void loadCanvasRuntime({ assetBaseUrl: THUMB_RUNTIME_BASE, messages: JOUR_FIXE_CANVAS_MESSAGES })
      .then((runtime) =>
        runtime.exportToSvg({
          elements: scene.elements,
          appState: jourFixeThumbExportState(scene.backgroundColor, dark),
          files: scene.files,
        }),
      )
      .then(
        (svg) => {
          if (alive) setSvgMarkup(svg.outerHTML);
        },
        () => {},
      );
    return () => {
      alive = false;
    };
  }, [deck, slideId, dark]);
  if (!svgMarkup) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 [&_svg]:h-full [&_svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
}

/** Minutentakt für die Zeitsperre; kein Sekundenzeiger in der Kopfzeile. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function meetingTimeLabel(meeting: JourFixeRoomSnapshot): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeStyle: "short",
    timeZone: meeting.timezone,
  }).format(meeting.scheduledAt);
}

/** Server-Ablehnungen erscheinen als deutsche Zeile im Raum, nie als Toast. */
export function jourFixeActionError(reason: unknown, meeting: JourFixeRoomSnapshot): string {
  return reason instanceof Error && reason.message.includes("meeting_not_started")
    ? `Der Termin beginnt erst um ${meetingTimeLabel(meeting)}.`
    : "Änderung nicht bestätigt · Entwurf bleibt erhalten.";
}

/** Eine knappe deutsche Statuszeile direkt am betroffenen Bereich, nie als Kopfleiste. */
export interface JourFixeAreaStatus {
  readonly state: "loading" | "failed";
  readonly text: string;
  /** Erst nach endgültigem Scheitern (5 min) eine kleine Aktion an derselben Stelle. */
  readonly onRetry?: (() => void) | undefined;
}

export interface JourFixeRoomProps {
  readonly projectTitle: string;
  readonly meeting: JourFixeRoomSnapshot;
  readonly onBack: () => void;
  /** Resolve only after a native receipt. The adapter retains uncertain operation IDs. */
  readonly onComment?: (draft: JourFixeCommentDraft, text: string) => Promise<void>;
  readonly commentDelivery?: "saved" | "supervisor";
  readonly onMessage?: (meetingId: string, expectedRevision: number, text: string) => Promise<void>;
  readonly onReviseTodos?: (
    meetingId: string,
    expectedRevision: number,
    proposalRevision: number,
    items: readonly JourFixeTodo[],
  ) => Promise<void>;
  readonly onConfirmTodos?: (
    meetingId: string,
    expectedRevision: number,
    proposalRevision: number,
    expectedGoalRevision: number,
  ) => Promise<void>;
  readonly onStartMeeting?: (meetingId: string, expectedRevision: number) => Promise<void>;
  readonly onEndMeeting?: (meetingId: string, expectedRevision: number) => Promise<void>;
  readonly onRefresh?: () => Promise<void>;
  readonly onSlideChange?: (slideId: string) => void;
  readonly onToggleMicrophone?: () => void;
  readonly microphoneActive?: boolean;
  /** Eine deutsche Zeile am Feld, wenn das Diktat nicht startet (Freigabe, Transport). */
  readonly microphoneError?: string | undefined;
  readonly partialTranscript?: JourFixePartialTranscript | undefined;
  /**
   * The meeting's presentation. Slides whose id appears in it are shown as the hand-drawn
   * canvas; the others keep the markdown stage. Saves store a new presentation revision and
   * never change the deck revision that comments and narration are bound to.
   */
  readonly presentation?: {
    readonly document: SlideDocument;
    readonly editable: boolean;
    readonly onSave: (slideId: string, scene: CanvasScene) => Promise<void>;
  };
  /** Blob obtained through the selected instance's authorized file channel. */
  readonly audio?: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly slideId: string;
    readonly deckRevision: number;
    readonly blobUrl: string;
    readonly rate?: number;
  };
  /** Lade- oder Endfehlerzustand der Folien, eingeblendet in der Folienfläche. */
  readonly presentationStatus?: JourFixeAreaStatus | undefined;
  /** Lade- oder Endfehlerzustand des Tons, eingeblendet am Player. */
  readonly narrationStatus?: JourFixeAreaStatus | undefined;
  /**
   * Endgültig gescheiterte, vorher unbestätigte Änderung. Die Wiederholung selbst
   * läuft automatisch und still; nur diese Zeile steht am Eingabefeld.
   */
  readonly pendingChange?: { readonly onRetry: () => void } | undefined;
}

export function JourFixeRoom(props: JourFixeRoomProps) {
  return <JourFixeRoomContent key={`${props.meeting.projectId}:${props.meeting.id}`} {...props} />;
}

function JourFixeRoomContent({
  projectTitle,
  meeting,
  onBack,
  onComment,
  commentDelivery = "supervisor",
  onMessage,
  onReviseTodos,
  onConfirmTodos,
  onStartMeeting,
  onEndMeeting,
  onRefresh,
  onSlideChange,
  onToggleMicrophone,
  microphoneActive = false,
  microphoneError,
  partialTranscript,
  audio,
  presentation,
  presentationStatus,
  narrationStatus,
  pendingChange,
}: JourFixeRoomProps) {
  const slides = [...meeting.slides].sort((a, b) => a.position - b.position);
  const [slideId, setSlideId] = useState(slides[0]?.id ?? "");
  const slide = slides.find((item) => item.id === slideId) ?? slides[0];
  const index = slide ? slides.indexOf(slide) : -1;
  const canvasSlide =
    slide !== undefined &&
    presentation !== undefined &&
    presentation.document.slides.some((item) => item.id === slide.id);
  const [panel, setPanel] = useState<"conversation" | "comments" | "agenda">("conversation");
  const [view, setView] = useState<"slides" | "review" | null>(null);
  const review =
    view === "review" || (view === null && ["review", "confirmed"].includes(meeting.state));
  const [draft, setDraft] = useState<JourFixeCommentDraft | null>(null);
  const [placingComment, setPlacingComment] = useState(false);
  const [canvasEditing, setCanvasEditing] = useState(false);
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const captureRef = useRef<(() => CanvasScene | null) | null>(null);
  // Retain the revision/operation captured when editing starts, even if a read refreshes props.
  const saveEditRef = useRef<((slideId: string, scene: CanvasScene) => Promise<void>) | null>(null);
  const [editDocument, setEditDocument] = useState<SlideDocument | null>(null);
  const canvasEpochRef = useRef(0);
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const [pendingScene, setPendingScene] = useState<CanvasScene | null>(null);
  const [savingSlide, setSavingSlide] = useState(false);
  const [slideSaveError, setSlideSaveError] = useState<string | null>(null);
  const shownSlideId = slide?.id;
  useEffect(() => {
    if (canvasEditing && editingSlideId !== shownSlideId) {
      setCanvasEditing(false);
      setEditingSlideId(null);
      setPendingScene(null);
    }
  }, [canvasEditing, editingSlideId, shownSlideId]);
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState("");
  const [visibleTurns, setVisibleTurns] = useState(100);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);
  const now = useMinuteNow();
  const beforeStart = ["planned", "preparing", "ready"].includes(meeting.state);
  const startLocked = beforeStart && now < meeting.scheduledAt - JOUR_FIXE_START_LEAD_MS;
  const canStart = meeting.state === "ready" && !startLocked && onStartMeeting !== undefined;
  // Aufgaben nur nach dem Termin: vorher und während „läuft“ bleibt der Kopf ruhig.
  const showTaskToggle =
    meeting.todos !== undefined && (meeting.state === "review" || meeting.state === "confirmed");
  // Presenter mode: Auto plays every slide's narration in turn; keys and full screen as in
  // learnordie's live presenter.
  const [autoAdvance, setAutoAdvance] = useState(false);
  const darkScheme = useWorkjetDarkScheme();
  const playerControl = useRef<(() => void) | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const shortcutHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  const [todoDraft, setTodoDraft] = useState<{
    revision: number;
    items: readonly JourFixeTodo[];
  } | null>(null);
  const proposalHasOwners = (items: readonly JourFixeTodo[]) =>
    items.length > 0 && items.every((todo) => todo.owner?.trim());
  const hasTodoEdits = todoDraft !== null && todoDraft.revision === meeting.todos?.revision;
  const todos = hasTodoEdits && todoDraft ? todoDraft.items : (meeting.todos?.items ?? []);
  const comments = slide ? jourFixeCommentsForSlide(meeting, slide.id) : [];
  const editable = ["ready", "live", "review"].includes(meeting.state);
  const currentDraft = draft && jourFixeCommentIsCurrent(meeting, draft) ? draft : null;
  const canRevise =
    onReviseTodos !== undefined &&
    meeting.state === "review" &&
    meeting.todos?.status === "proposed";
  const partial = jourFixeVisiblePartial(meeting, partialTranscript);
  /** Eben gesendete, noch unbestätigte eigene Nachrichten, in Reihenfolge. */
  const [outbox, setOutbox] = useState<
    readonly { id: string; text: string; state: "sending" | "failed" }[]
  >([]);
  function sendMessage(text: string, retryId?: string) {
    if (!onMessage) return;
    const id = retryId ?? randomUUID();
    setOutbox((list) =>
      retryId
        ? list.map((item) => (item.id === retryId ? { ...item, state: "sending" as const } : item))
        : [...list, { id, text, state: "sending" as const }],
    );
    if (!retryId) setMessage("");
    onMessage(meeting.id, meeting.revision, text).then(
      // Die Bestätigung kommt still nach; der Verlauf zeigt den Beleg aus dem Lesemodell.
      () => setOutbox((list) => list.filter((item) => item.id !== id)),
      () =>
        setOutbox((list) =>
          list.map((item) => (item.id === id ? { ...item, state: "failed" as const } : item)),
        ),
    );
  }
  // Diktat: der Teiltext erscheint live im Feld und hängt an bereits Getipptem an.
  const dictationBase = useRef<string | null>(null);
  useEffect(() => {
    if (!microphoneActive) {
      dictationBase.current = null;
      return;
    }
    if (dictationBase.current === null)
      dictationBase.current = message.trim() ? `${message.trimEnd()} ` : "";
    if (partial) setMessage(`${dictationBase.current}${partial}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [microphoneActive, partial]);
  /** Die letzte Folie „Freie Themen“ öffnet den offenen Teil der Runde. */
  const freeTopics =
    slide !== undefined && index === slides.length - 1 && slide.title === "Freie Themen";
  const narration =
    slide &&
    audio?.meetingId === meeting.id &&
    audio.projectId === meeting.projectId &&
    audio.slideId === slide.id &&
    audio.deckRevision === meeting.deckRevision &&
    audio.blobUrl.startsWith("blob:")
      ? audio.blobUrl
      : undefined;
  async function perform(action: () => Promise<void>, done?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
    } catch (reason) {
      setError(jourFixeActionError(reason, meeting));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function startMeeting() {
    const start = onStartMeeting;
    if (!start) return;
    setStarting(true);
    void perform(() => start(meeting.id, meeting.revision)).finally(() => setStarting(false));
  }
  function discardCanvasEdit() {
    // Invalidate the old editor callback before its cleanup can flush a debounced edit.
    canvasEpochRef.current += 1;
    setCanvasEpoch(canvasEpochRef.current);
    captureRef.current = null;
    saveEditRef.current = null;
    setEditDocument(null);
    setCanvasEditing(false);
    setEditingSlideId(null);
    setPendingScene(null);
    setSlideSaveError(null);
  }
  function selectSlide(id: string) {
    setSlideId(id);
    // Unsaved canvas edits belong to the slide they were made on.
    discardCanvasEdit();
    setPlacingComment(false);
    onSlideChange?.(id);
  }
  function toggleFullscreen() {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.requestFullscreen?.().catch(() => {});
  }
  shortcutHandler.current = (event) => {
    const action = jourFixeShortcut(event, canvasEditing);
    if (!action || !slide) return;
    if (action === "next" && index < slides.length - 1) selectSlide(slides[index + 1]!.id);
    else if (action === "previous" && index > 0) selectSlide(slides[index - 1]!.id);
    else if (action === "togglePlayback") playerControl.current?.();
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  function editTodos(items: readonly JourFixeTodo[]) {
    if (!canRevise || meeting.todos === undefined) return;
    setTodoDraft({ revision: meeting.todos.revision, items });
  }
  function updateTodo(id: string, key: "title" | "acceptance" | "owner", value: string) {
    editTodos(todos.map((todo) => (todo.id === id ? { ...todo, [key]: value } : todo)));
  }
  /** Bei „Freie Themen“ steht das Eingabefeld vorne, sonst am Ende der Seitenleiste. */
  const messageForm = onMessage && (
    <div className={freeTopics ? "border-b border-border" : "border-t border-border"}>
      {microphoneActive && (
        <p
          role="status"
          data-workjet-microphone-state="recording"
          className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground"
        >
          <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-red-500" />
          Aufnahme läuft – sprich, der Text erscheint im Feld
        </p>
      )}
      {microphoneError && (
        <p role="alert" className="px-3 pt-2 text-xs text-destructive">
          {microphoneError}
        </p>
      )}
      <form
        className="flex items-center gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (message.trim()) sendMessage(message.trim());
        }}
      >
        <Input
          aria-label="Nachricht an Supervisor"
          maxLength={16384}
          placeholder="Schreiben oder sprechen …"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="min-w-0 flex-1"
        />
        {onToggleMicrophone && (
          <Button
            size="icon-sm"
            variant={microphoneActive ? "destructive" : "outline"}
            aria-label={microphoneActive ? "Mikrofon aus" : "Mikrofon an"}
            aria-pressed={microphoneActive}
            onClick={onToggleMicrophone}
          >
            <MicIcon />
          </Button>
        )}
        <Button type="submit" size="icon-sm" aria-label="Senden" disabled={!message.trim()}>
          <SendIcon />
        </Button>
      </form>
    </div>
  );
  /** Endgültig ungespeicherte Änderung: eine Zeile direkt am Eingabefeld. */
  const pendingNotice = pendingChange && (
    <p
      role="alert"
      data-workjet-pending-change="failed"
      className={`flex items-center gap-2 ${freeTopics ? "border-b" : "border-t"} border-border px-3 py-2 text-xs text-destructive`}
    >
      Nicht gespeichert
      <Button size="sm" variant="outline" onClick={pendingChange.onRetry}>
        Erneut senden
      </Button>
    </p>
  );
  return (
    <section
      className="@container flex min-h-0 flex-1 flex-col overflow-auto"
      data-workjet-jour-fixe-room={meeting.id}
    >
      <WorkjetHeaderContent className="flex min-w-0 items-center">
        <WorkspaceBreadcrumb ariaLabel="Regeltermin-Pfad">
          <WorkspaceBreadcrumbItem>
            <button
              type="button"
              onClick={onBack}
              className="truncate rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {projectTitle}
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>Regeltermin</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon-sm" aria-label="Zur Übersicht" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-sm font-medium">{projectTitle} · Regeltermin</h1>
        <time
          className="text-xs text-muted-foreground"
          dateTime={new Date(meeting.scheduledAt).toISOString()}
        >
          {new Intl.DateTimeFormat("de-DE", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: meeting.timezone,
          }).format(meeting.scheduledAt)}{" "}
          · {meeting.timezone}
        </time>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {beforeStart ? (
            <span
              className="text-xs text-muted-foreground"
              data-meeting-state={meeting.state}
              data-workjet-meeting-start-lock={startLocked ? meeting.state : undefined}
            >
              Beginnt {meetingTimeLabel(meeting)}
            </span>
          ) : meeting.state === "live" ? (
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-meeting-state="live"
            >
              <span aria-hidden="true" className="size-2 rounded-full bg-green-500" />
              läuft seit {meetingTimeLabel(meeting)}
            </span>
          ) : (
            <span
              className={`rounded-full border px-2.5 py-1 text-xs capitalize ${meeting.state === "review" ? "border-amber-400/30 bg-amber-400/10 text-amber-400" : "border-border text-muted-foreground"}`}
              data-meeting-state={meeting.state}
            >
              {meeting.state === "confirmed" && <CheckIcon className="mr-1 inline size-3" />}
              {MEETING_STATE_LABELS[meeting.state] ?? meeting.state}
            </span>
          )}
          {canStart && (
            <Button
              size="sm"
              disabled={busy}
              aria-busy={starting}
              data-workjet-meeting-start={starting ? "pending" : "idle"}
              onClick={startMeeting}
            >
              {jourFixeStartButtonLabel(starting)}
            </Button>
          )}
          {meeting.state === "live" && onEndMeeting && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => onEndMeeting(meeting.id, meeting.revision),
                  () => setView(null),
                )
              }
            >
              Beenden
            </Button>
          )}
          {showTaskToggle && (
            <Button
              size="sm"
              variant="outline"
              aria-pressed={review}
              onClick={() => setView(review ? "slides" : "review")}
            >
              {review ? "Zu den Folien" : "Aufgaben prüfen"}
            </Button>
          )}
        </div>
        {(error || meeting.error) && (
          <span role="alert" className="flex items-center gap-2 text-xs text-destructive">
            {error ?? meeting.error}
            {onRefresh && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void perform(onRefresh)}
              >
                Aktualisieren
              </Button>
            )}
          </span>
        )}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 @min-[900px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 p-4 lg:p-[18px]">
          {review ? (
            <div className="mx-auto max-w-4xl space-y-4" data-workjet-meeting-review="">
              <div>
                <h2 className="text-base font-semibold">
                  {meeting.todos?.status === "confirmed"
                    ? "Bestätigte Aufgaben"
                    : "Vorgeschlagene Aufgaben"}
                </h2>
              </div>
              {todos.map((todo, number) => (
                <fieldset
                  key={todo.id}
                  className="flex min-w-0 items-start gap-3 rounded-lg border border-border p-3"
                  disabled={!canRevise || busy}
                >
                  <span className="mt-2 text-xs tabular-nums text-muted-foreground">
                    {number + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      aria-label={`Aufgabe ${number + 1} Titel`}
                      maxLength={512}
                      value={todo.title}
                      onChange={(event) => updateTodo(todo.id, "title", event.target.value)}
                    />
                    <label className="block text-xs text-muted-foreground">
                      Verantwortlich
                      <Input
                        aria-label={`Aufgabe ${number + 1} Verantwortlich`}
                        maxLength={256}
                        value={todo.owner ?? ""}
                        onChange={(event) => updateTodo(todo.id, "owner", event.target.value)}
                        className="mt-1"
                      />
                    </label>
                    <label className="block text-xs text-muted-foreground">
                      Abnahme
                      <textarea
                        className="mt-1 block min-h-16 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm text-foreground"
                        maxLength={4096}
                        value={todo.acceptance}
                        onChange={(event) => updateTodo(todo.id, "acceptance", event.target.value)}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {todo.priority} ·{" "}
                      {todo.evidenceIds.length
                        ? todo.evidenceIds
                            .map((id) => jourFixeEvidenceLabel(meeting, id))
                            .join(" · ")
                        : "Eigene Ergänzung"}
                    </p>
                  </div>
                  {canRevise && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Aufgabe ${number + 1} entfernen`}
                      onClick={() => editTodos(todos.filter((item) => item.id !== todo.id))}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </fieldset>
              ))}
              {todoDraft && !hasTodoEdits && (
                <p role="status" className="text-sm text-amber-500">
                  Vorschlag geändert. Liste erneut prüfen.
                </p>
              )}
              {meeting.todos?.status === "proposed" && meeting.state === "review" && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {canRevise && (
                    <Button
                      variant="outline"
                      disabled={busy || todos.length >= 100}
                      onClick={() =>
                        editTodos([
                          ...todos,
                          {
                            id: randomUUID(),
                            title: "",
                            acceptance: "",
                            owner: "",
                            priority: "P1",
                            evidenceIds: [],
                          },
                        ])
                      }
                    >
                      <PlusIcon />
                      Aufgabe hinzufügen
                    </Button>
                  )}
                  {hasTodoEdits && onReviseTodos && (
                    <Button
                      disabled={
                        busy || todos.some((todo) => !todo.title.trim() || !todo.acceptance.trim())
                      }
                      onClick={() =>
                        void perform(
                          () =>
                            onReviseTodos(
                              meeting.id,
                              meeting.revision,
                              meeting.todos!.revision,
                              todos,
                            ),
                          () => setTodoDraft(null),
                        )
                      }
                    >
                      Speichern
                    </Button>
                  )}
                  {onConfirmTodos && !proposalHasOwners(todos) && (
                    <p role="status" className="mr-auto text-xs text-muted-foreground">
                      {todos.length === 0
                        ? "Mindestens eine Aufgabe nötig."
                        : "Jede Aufgabe braucht Verantwortliche."}
                    </p>
                  )}
                  {onConfirmTodos && (
                    <Button
                      disabled={
                        busy ||
                        hasTodoEdits ||
                        meeting.previousGoalRevision === undefined ||
                        !proposalHasOwners(todos)
                      }
                      onClick={() =>
                        void perform(() =>
                          onConfirmTodos(
                            meeting.id,
                            meeting.revision,
                            meeting.todos!.revision,
                            meeting.previousGoalRevision!,
                          ),
                        )
                      }
                    >
                      {todos.length} Aufgaben bestätigen
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : slide ? (
            <div className="space-y-3" data-workjet-presenter-scope="">
              {canvasSlide && presentation && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {slideSaveError && (
                    <p role="alert" className="mr-auto text-[12px] text-destructive">
                      {slideSaveError}
                    </p>
                  )}
                  {canvasEditing ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingSlide}
                        onClick={discardCanvasEdit}
                      >
                        <XIcon className="size-3" />
                        Abbrechen
                      </Button>
                      <Button
                        size="sm"
                        disabled={savingSlide}
                        onClick={() => {
                          if (savingSlide || !editingSlideId) return;
                          // Read the editor now: the debounced change may not include the last
                          // stroke or the text that is still being typed.
                          const scene = captureRef.current?.() ?? pendingScene;
                          const target = editingSlideId;
                          if (!scene) {
                            setCanvasEditing(false);
                            setEditingSlideId(null);
                            return;
                          }
                          setSavingSlide(true);
                          setSlideSaveError(null);
                          (saveEditRef.current ?? presentation.onSave)(target, scene).then(
                            () => {
                              setCanvasEditing(false);
                              setEditingSlideId(null);
                              setPendingScene(null);
                              setSavingSlide(false);
                            },
                            (reason: unknown) => {
                              if (reason instanceof PresentationSlideChangedError) {
                                // The newer slide is shown; this edit cannot be applied to it.
                                setCanvasEditing(false);
                                setEditingSlideId(null);
                                setPendingScene(null);
                              }
                              console.warn(JOUR_FIXE_SLIDE_SAVE_FAILED, reason);
                              setSlideSaveError(JOUR_FIXE_SLIDE_SAVE_FAILED);
                              setSavingSlide(false);
                            },
                          );
                        }}
                      >
                        <SaveIcon className="size-3" />
                        {savingSlide ? "Wird gespeichert …" : "Folie speichern"}
                      </Button>
                    </>
                  ) : (
                    <>
                      {onComment && editable && (
                        <Button
                          size="sm"
                          variant={placingComment ? "default" : "outline"}
                          aria-pressed={placingComment}
                          disabled={busy}
                          onClick={() => setPlacingComment((value) => !value)}
                        >
                          <MessageSquarePlusIcon className="size-3" />
                          {placingComment ? "Auf Folie klicken" : "Folie kommentieren"}
                        </Button>
                      )}
                      {presentation.editable && !placingComment && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            saveEditRef.current = presentation.onSave;
                            setEditDocument(presentation.document);
                            setCanvasEditing(true);
                            setEditingSlideId(slide.id);
                            setPendingScene(null);
                            setSlideSaveError(null);
                          }}
                        >
                          <PencilIcon className="size-3" />
                          Folie bearbeiten
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
              {/* 420 px: die 16:9-Folie wird zu klein zum Lesen; ihr Text steht lesbar daneben (Audit B #47). */}
              {canvasSlide && !canvasEditing && (slide.title || slide.markdown) ? (
                <article
                  className="@[36rem]:hidden rounded-lg border border-border px-3 py-2 text-[13.5px]"
                  data-workjet-slide-text=""
                  aria-label="Folientext"
                >
                  {slide.title ? <h2 className="font-semibold">{slide.title}</h2> : null}
                  {slide.markdown ? (
                    <div className="mt-1 leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        skipHtml
                        components={MEETING_MARKDOWN_COMPONENTS}
                      >
                        {slide.markdown}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                </article>
              ) : null}
              <div
                ref={stageRef}
                tabIndex={0}
                className={`relative aspect-video overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring [&:fullscreen]:rounded-none [&:fullscreen]:border-0 ${STAGE_SURFACE_CLASSES}`}
                data-workjet-meeting-stage=""
              >
                {presentationStatus && (
                  <p
                    role={presentationStatus.state === "failed" ? "alert" : "status"}
                    data-workjet-presentation-state={presentationStatus.state}
                    className={`absolute top-3 left-3 z-20 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs shadow-sm ${presentationStatus.state === "failed" ? "bg-background/95 text-destructive" : "bg-background/80 text-stage-muted"}`}
                  >
                    {presentationStatus.text}
                    {presentationStatus.state === "failed" && presentationStatus.onRetry && (
                      <Button size="sm" variant="outline" onClick={presentationStatus.onRetry}>
                        Neu laden
                      </Button>
                    )}
                  </p>
                )}
                {canvasSlide && presentation ? (
                  <Suspense
                    fallback={
                      <p
                        role="status"
                        className={`absolute inset-0 grid place-items-center text-sm ${STAGE_MUTED_CLASSES}`}
                      >
                        Folie wird geladen …
                      </p>
                    }
                  >
                    {savingSlide && (
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 z-30 cursor-wait bg-white/30"
                      />
                    )}
                    <JourFixeCanvasStage
                      key={`${slide.id}:${canvasEpoch}`}
                      document={
                        canvasEditing
                          ? (editDocument ?? presentation.document)
                          : presentation.document
                      }
                      slideId={slide.id}
                      mode={canvasEditing && editingSlideId === slide.id ? "edit" : "present"}
                      theme={darkScheme ? "dark" : "light"}
                      onSceneChange={(scene) => {
                        if (canvasEpochRef.current === canvasEpoch) setPendingScene(scene);
                      }}
                      captureRef={captureRef}
                    />
                  </Suspense>
                ) : presentationStatus?.state === "loading" ? (
                  <p
                    role="status"
                    className={`absolute inset-0 grid place-items-center text-sm ${STAGE_MUTED_CLASSES}`}
                  >
                    Folie wird geladen …
                  </p>
                ) : (
                  <article className="absolute inset-0 overflow-auto p-[6%]">
                    <p
                      className={`mb-2 text-[clamp(10px,1vw,13px)] tracking-wide ${STAGE_MUTED_CLASSES}`}
                    >
                      {index + 1} / {slides.length}
                    </p>
                    <h2 className="mb-5 text-[clamp(18px,2.5vw,32px)] leading-tight font-semibold tracking-tight">
                      {slide.title}
                    </h2>
                    <div className="text-[clamp(11px,1.15vw,16px)] leading-relaxed [&_h2]:mt-3 [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3 [&_table]:w-full [&_td]:p-2 [&_th]:p-2 [&_th]:text-left">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        skipHtml
                        components={MEETING_MARKDOWN_COMPONENTS}
                      >
                        {slide.markdown}
                      </ReactMarkdown>
                    </div>
                  </article>
                )}
                {onComment && editable && (!canvasSlide || (placingComment && !canvasEditing)) && (
                  <button
                    type="button"
                    aria-label="Kommentar auf Folie setzen"
                    className="absolute inset-0 z-10 cursor-crosshair focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary"
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      const point =
                        event.detail === 0
                          ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
                          : { x: event.clientX, y: event.clientY };
                      const anchor = jourFixeCommentAnchor(meeting, slide.id, point, bounds);
                      if (anchor) setDraft(anchor);
                      setPlacingComment(false);
                    }}
                    disabled={busy}
                  />
                )}
                {comments.map((item, number) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`Kommentar ${number + 1}: ${item.text}`}
                    className="absolute z-10 grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-xs text-primary-foreground ring-2 ring-primary/25"
                    style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }}
                    onClick={() => setPanel("comments")}
                  >
                    {number + 1}
                  </button>
                ))}
                {currentDraft?.slideId === slide.id && (
                  <>
                    <span
                      className="pointer-events-none absolute z-10 grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-amber-400 text-xs text-black ring-2 ring-amber-400/30"
                      style={{ left: `${currentDraft.x * 100}%`, top: `${currentDraft.y * 100}%` }}
                    >
                      {comments.length + 1}
                    </span>
                    <form
                      aria-label="Folienkommentar"
                      className="absolute z-10 grid w-64 max-w-[calc(100%-16px)] gap-2 rounded-lg border border-border bg-card p-2.5 text-foreground shadow-xl"
                      style={{
                        left: `clamp(8px, calc(${currentDraft.x * 100}% - 128px), calc(100% - 264px))`,
                        top: `clamp(8px, calc(${currentDraft.y * 100}% + 16px), calc(100% - 142px))`,
                      }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (onComment && comment.trim() && !busy)
                          void perform(
                            () => onComment(currentDraft, comment.trim()),
                            () => {
                              setDraft(null);
                              setComment("");
                            },
                          );
                      }}
                    >
                      <textarea
                        autoFocus
                        aria-label={
                          commentDelivery === "saved" ? "Kommentartext" : "Kommentar an Supervisor"
                        }
                        maxLength={4096}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        className="h-16 w-full resize-none rounded-md border border-input bg-background p-2 text-xs"
                        disabled={busy}
                      />
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDraft(null);
                            setComment("");
                          }}
                          disabled={busy}
                        >
                          <XIcon className="size-3" />
                          Abbrechen
                        </Button>
                        <Button size="sm" type="submit" disabled={busy || !comment.trim()}>
                          {commentDelivery === "saved" ? "Kommentar speichern" : "An Supervisor"}
                        </Button>
                      </div>
                    </form>
                  </>
                )}
              </div>
              {draft && !currentDraft && (
                <p role="status" className="text-sm text-amber-500">
                  Termin geändert. Kommentar neu setzen.
                </p>
              )}
              {narrationStatus && (
                <p
                  role={narrationStatus.state === "failed" ? "alert" : "status"}
                  data-workjet-narration-state={narrationStatus.state}
                  className={`flex items-center gap-2 text-xs ${narrationStatus.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {narrationStatus.text}
                  {narrationStatus.state === "failed" && narrationStatus.onRetry && (
                    <Button size="sm" variant="outline" onClick={narrationStatus.onRetry}>
                      Neu laden
                    </Button>
                  )}
                </p>
              )}
              <JourFixePlayer
                key={`${slide.id}:${meeting.deckRevision}`}
                source={narration}
                rate={narration ? audio?.rate : undefined}
                hasPrevious={index > 0}
                hasNext={index < slides.length - 1}
                onPrevious={() => selectSlide(slides[index - 1]!.id)}
                onNext={() => selectSlide(slides[index + 1]!.id)}
                autoAdvance={autoAdvance}
                onAutoAdvanceChange={setAutoAdvance}
                controlRef={playerControl}
                onFullscreen={toggleFullscreen}
              />
              <nav aria-label="Folien" className="flex gap-2 overflow-x-auto pb-1">
                {slides.map((item, number) => {
                  const itemComments = jourFixeCommentsForSlide(meeting, item.id).length;
                  const itemIsCanvas =
                    presentation !== undefined &&
                    presentation.document.slides.some((entry) => entry.id === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={`Folie ${number + 1}: ${item.title}`}
                      aria-current={item.id === slide.id ? "step" : undefined}
                      onClick={() => selectSlide(item.id)}
                      className={`relative aspect-video w-[128px] shrink-0 overflow-hidden rounded-md border-2 ${STAGE_SURFACE_CLASSES} ${item.id === slide.id ? "border-primary" : "border-transparent"}`}
                    >
                      {itemIsCanvas && presentation ? (
                        <JourFixeCanvasThumb
                          document={presentation.document}
                          slideId={item.id}
                          dark={darkScheme}
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                          className={`pointer-events-none absolute top-0 left-0 aspect-video w-[640px] origin-top-left scale-[0.2] overflow-hidden p-[6%] text-left [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3 ${STAGE_SURFACE_CLASSES}`}
                        >
                          <p className={`mb-2 text-[13px] tracking-wide ${STAGE_MUTED_CLASSES}`}>
                            {number + 1} / {slides.length}
                          </p>
                          <p className="mb-5 text-[32px] leading-tight font-semibold tracking-tight">
                            {item.title}
                          </p>
                          <div className="text-[16px] leading-relaxed opacity-80">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              skipHtml
                              components={MEETING_MARKDOWN_COMPONENTS}
                            >
                              {item.markdown}
                            </ReactMarkdown>
                          </div>
                        </div>
                      )}
                      <span className="absolute bottom-1 left-1.5 rounded bg-black/45 px-1 text-[10px] text-white">
                        {number + 1}
                      </span>
                      {itemComments > 0 && (
                        <span className="absolute top-1 right-1 rounded-full bg-primary px-1 text-[9px] text-primary-foreground">
                          {itemComments}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>
          ) : (
            <div
              role="status"
              className="grid aspect-video place-items-center rounded-lg border border-border px-6 text-center text-sm text-muted-foreground"
            >
              {meeting.state === "preparing" ? "Supervisor bereitet Folien vor …" : "Keine Folien"}
            </div>
          )}
        </div>
        <aside className="flex min-h-80 min-w-0 flex-col border-t border-border bg-muted/10 @min-[900px]:border-t-0 @min-[900px]:border-l">
          <nav
            aria-label="Terminbereiche"
            role="tablist"
            className="flex gap-1 border-b border-border px-3 py-2"
          >
            {(["conversation", "comments", "agenda"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={panel === name}
                onClick={() => setPanel(name)}
                className={`rounded-md border-b-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  panel === name
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {PANEL_LABELS[name]}
                {name === "comments" && meeting.comments.length > 0
                  ? ` ${meeting.comments.length}`
                  : ""}
              </button>
            ))}
          </nav>
          {freeTopics && (
            <>
              {pendingNotice}
              {messageForm}
            </>
          )}
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 @min-[900px]:max-h-[calc(100dvh-220px)]">
            {panel === "conversation" && (
              <>
                {meeting.transcript.length > visibleTurns && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleTurns((count) => count + 100)}
                  >
                    Frühere anzeigen
                  </Button>
                )}
                {meeting.transcript.slice(-visibleTurns).map((turn) => (
                  <div key={turn.id}>
                    <p className="text-xs text-muted-foreground">
                      {turn.speaker === "owner" ? "Du" : "Supervisor"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{turn.text}</p>
                  </div>
                ))}
                {outbox.map((item) => (
                  <div key={item.id} data-workjet-outbox-message={item.state}>
                    <p className="text-xs text-muted-foreground">Du</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{item.text}</p>
                    {item.state === "failed" && (
                      <p
                        role="alert"
                        className="mt-1 flex items-center gap-2 text-xs text-destructive"
                      >
                        Nicht gesendet
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => sendMessage(item.text, item.id)}
                        >
                          Erneut senden
                        </Button>
                      </p>
                    )}
                  </div>
                ))}
                {partial && !microphoneActive && (
                  <p role="status" className="text-sm italic text-muted-foreground">
                    {partial}
                  </p>
                )}
                {meeting.transcript.length === 0 && outbox.length === 0 && !partial && (
                  <p className="text-sm text-muted-foreground">Noch keine Beiträge</p>
                )}
              </>
            )}
            {panel === "comments" && meeting.comments.length === 0 && (
              <p className="text-sm text-muted-foreground">Noch keine Kommentare</p>
            )}
            {panel === "comments" &&
              meeting.comments.map((item) => (
                <div key={item.id} className="border-l-2 border-primary pl-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {jourFixeEvidenceLabel(meeting, item.id)}
                    {item.deckRevision !== meeting.deckRevision
                      ? ` · Früherer Folienstand ${item.deckRevision}`
                      : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
                </div>
              ))}
            {panel === "agenda" && slides.length === 0 && (
              <p className="text-sm text-muted-foreground">Noch keine Tagesordnung</p>
            )}
            {panel === "agenda" &&
              slides.map((item, number) => (
                <button
                  type="button"
                  key={item.id}
                  className="block w-full rounded-md px-2 py-1 text-left text-[13.5px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    selectSlide(item.id);
                    setView("slides");
                  }}
                >
                  {number + 1}. {item.title}
                </button>
              ))}
          </div>
          {onMessage && !freeTopics && (
            <>
              {pendingNotice}
              {messageForm}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
