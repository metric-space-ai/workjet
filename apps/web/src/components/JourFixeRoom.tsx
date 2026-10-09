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
import { PresentationSlideChangedError } from "../lib/jourFixePresentation";

// The canvas, its 3D scenes and the Excalidraw runtime load only when a meeting has a presentation.
const JourFixeCanvasStage = lazy(() => import("./JourFixeCanvasStage"));

const MEETING_MARKDOWN_COMPONENTS: Components = {
  img: () => null,
  a: ({ children }) => <span className="underline">{children}</span>,
};

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
  };
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
  partialTranscript,
  audio,
  presentation,
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
  const inFlight = useRef(false);
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
    } catch {
      setError("This change has not been confirmed. Your draft is preserved.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function selectSlide(id: string) {
    setSlideId(id);
    // Unsaved canvas edits belong to the slide they were made on.
    setCanvasEditing(false);
    setEditingSlideId(null);
    setPendingScene(null);
    setSlideSaveError(null);
    setPlacingComment(false);
    onSlideChange?.(id);
  }
  function editTodos(items: readonly JourFixeTodo[]) {
    if (!canRevise || meeting.todos === undefined) return;
    setTodoDraft({ revision: meeting.todos.revision, items });
  }
  function updateTodo(id: string, key: "title" | "acceptance" | "owner", value: string) {
    editTodos(todos.map((todo) => (todo.id === id ? { ...todo, [key]: value } : todo)));
  }
  return (
    <section
      className="@container flex min-h-0 flex-1 flex-col overflow-auto"
      data-workjet-jour-fixe-room={meeting.id}
    >
      <WorkjetHeaderContent className="flex min-w-0 items-center">
        <WorkspaceBreadcrumb ariaLabel="Meeting breadcrumb">
          <WorkspaceBreadcrumbItem>
            <button type="button" onClick={onBack} className="truncate hover:underline">
              {projectTitle}
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>Jour fixe</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to overview" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-sm font-medium">{projectTitle} · Jour fixe</h1>
        <time
          className="text-xs text-muted-foreground"
          dateTime={new Date(meeting.scheduledAt).toISOString()}
        >
          {new Intl.DateTimeFormat("en", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: meeting.timezone,
          }).format(meeting.scheduledAt)}{" "}
          · {meeting.timezone}
        </time>
        <span
          className={`ml-auto rounded-full border px-2.5 py-1 text-xs capitalize ${meeting.state === "live" ? "border-red-400/30 bg-red-400/10 text-red-400" : meeting.state === "review" ? "border-amber-400/30 bg-amber-400/10 text-amber-400" : "border-border text-muted-foreground"}`}
          data-meeting-state={meeting.state}
        >
          {meeting.state === "confirmed" && <CheckIcon className="mr-1 inline size-3" />}
          {meeting.state}
        </span>
        {meeting.state === "ready" && onStartMeeting && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void perform(() => onStartMeeting(meeting.id, meeting.revision))}
          >
            Start meeting
          </Button>
        )}
        {meeting.state === "live" && onEndMeeting && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(
                () => onEndMeeting(meeting.id, meeting.revision),
                () => setView(null),
              )
            }
          >
            End meeting
          </Button>
        )}
        {meeting.todos && (
          <Button
            size="sm"
            variant="outline"
            aria-pressed={review}
            onClick={() => setView(review ? "slides" : "review")}
          >
            {review ? "Slides" : "Review"}
          </Button>
        )}
      </header>
      {(error || meeting.error) && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/30 px-5 py-2 text-sm text-destructive"
        >
          <span>{error ?? meeting.error}</span>
          {onRefresh && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void perform(onRefresh)}
            >
              Refresh
            </Button>
          )}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 @min-[900px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 p-4 lg:p-[18px]">
          {review ? (
            <div className="mx-auto max-w-4xl space-y-4" data-workjet-meeting-review="">
              <div>
                <h2 className="text-base font-semibold">
                  {meeting.todos?.status === "confirmed" ? "Confirmed to-dos" : "Proposed to-dos"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {meeting.todos?.status === "confirmed"
                    ? "This list was confirmed by the project owner."
                    : "Review the acceptance criteria and sources. Confirming sets the supervisor’s goal."}
                </p>
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
                      aria-label={`Todo ${number + 1} title`}
                      maxLength={512}
                      value={todo.title}
                      onChange={(event) => updateTodo(todo.id, "title", event.target.value)}
                    />
                    <label className="block text-xs text-muted-foreground">
                      Owner
                      <Input
                        aria-label={`Todo ${number + 1} owner`}
                        maxLength={256}
                        value={todo.owner ?? ""}
                        onChange={(event) => updateTodo(todo.id, "owner", event.target.value)}
                        className="mt-1"
                      />
                    </label>
                    <label className="block text-xs text-muted-foreground">
                      Acceptance
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
                        : "Owner addition"}
                    </p>
                  </div>
                  {canRevise && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove todo ${number + 1}`}
                      onClick={() => editTodos(todos.filter((item) => item.id !== todo.id))}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </fieldset>
              ))}
              {todoDraft && !hasTodoEdits && (
                <p role="status" className="text-sm text-amber-500">
                  The proposal changed. Review the updated list before editing again.
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
                      Add todo
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
                      Save edits
                    </Button>
                  )}
                  {onConfirmTodos && !proposalHasOwners(todos) && (
                    <p role="status" className="mr-auto text-xs text-muted-foreground">
                      {todos.length === 0
                        ? "Add at least one to-do before confirming."
                        : "Assign an owner to each to-do before confirming."}
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
                      Confirm {todos.length} to-dos
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : slide ? (
            <div className="space-y-3">
              {canvasSlide && presentation && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {slideSaveError && (
                    <p role="alert" className="mr-auto text-xs text-red-500">
                      {slideSaveError}
                    </p>
                  )}
                  {canvasEditing ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingSlide}
                        onClick={() => {
                          setCanvasEditing(false);
                          setEditingSlideId(null);
                          setPendingScene(null);
                          setSlideSaveError(null);
                        }}
                      >
                        <XIcon className="size-3" />
                        Cancel
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
                          presentation.onSave(target, scene).then(
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
                              setSlideSaveError(
                                reason instanceof Error
                                  ? reason.message
                                  : "The slide could not be saved.",
                              );
                              setSavingSlide(false);
                            },
                          );
                        }}
                      >
                        <SaveIcon className="size-3" />
                        {savingSlide ? "Saving…" : "Save slide"}
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
                          {placingComment
                            ? "Click the slide to place the comment"
                            : "Comment on slide"}
                        </Button>
                      )}
                      {presentation.editable && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || placingComment}
                          onClick={() => {
                            setCanvasEditing(true);
                            setEditingSlideId(slide.id);
                            setPendingScene(null);
                            setSlideSaveError(null);
                          }}
                        >
                          <PencilIcon className="size-3" />
                          Edit slide
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
              <div
                className="relative aspect-video overflow-hidden rounded-lg border border-border bg-[#f5f3ee] text-[#18181b]"
                data-workjet-meeting-stage=""
              >
                {canvasSlide && presentation ? (
                  <Suspense
                    fallback={
                      <p
                        role="status"
                        className="absolute inset-0 grid place-items-center text-sm text-[#52525b]"
                      >
                        Loading the slide…
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
                      document={presentation.document}
                      slideId={slide.id}
                      mode={canvasEditing && editingSlideId === slide.id ? "edit" : "present"}
                      onSceneChange={setPendingScene}
                      captureRef={captureRef}
                    />
                  </Suspense>
                ) : (
                  <article className="absolute inset-0 overflow-auto p-[6%]">
                    <p className="mb-2 text-[clamp(10px,1vw,13px)] tracking-wide text-[#71717a]">
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
                    aria-label="Place a comment on the slide"
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
                    aria-label={`Comment ${number + 1}: ${item.text}`}
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
                      aria-label="Slide comment"
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
                          commentDelivery === "saved"
                            ? "Slide comment text"
                            : "Comment to supervisor"
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
                          Cancel
                        </Button>
                        <Button size="sm" type="submit" disabled={busy || !comment.trim()}>
                          {commentDelivery === "saved" ? "Save comment" : "To supervisor"}
                        </Button>
                      </div>
                    </form>
                  </>
                )}
              </div>
              {draft && !currentDraft && (
                <p role="status" className="text-sm text-amber-500">
                  The meeting changed. Place your comment again on the current deck.
                </p>
              )}
              <JourFixePlayer
                key={`${slide.id}:${meeting.deckRevision}`}
                source={narration}
                hasPrevious={index > 0}
                hasNext={index < slides.length - 1}
                onPrevious={() => selectSlide(slides[index - 1]!.id)}
                onNext={() => selectSlide(slides[index + 1]!.id)}
              />
              <nav aria-label="Slides" className="flex gap-2 overflow-x-auto pb-1">
                {slides.map((item, number) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`Slide ${number + 1}: ${item.title}`}
                    aria-current={item.id === slide.id ? "step" : undefined}
                    onClick={() => selectSlide(item.id)}
                    className={`relative aspect-video w-[92px] shrink-0 overflow-hidden rounded-md border-2 bg-[#e9e6df] px-2 py-1 text-left text-[#18181b] ${item.id === slide.id ? "border-primary" : "border-transparent"}`}
                  >
                    <span className="line-clamp-2 text-[8px] leading-tight">{item.title}</span>
                    <span className="absolute bottom-1 left-1.5 text-[10px]">{number + 1}</span>
                    {jourFixeCommentsForSlide(meeting, item.id).length > 0 && (
                      <span className="absolute top-1 right-1 rounded-full bg-primary px-1 text-[9px] text-primary-foreground">
                        {jourFixeCommentsForSlide(meeting, item.id).length}
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </div>
          ) : (
            <div
              role="status"
              className="grid aspect-video place-items-center rounded-lg border border-border px-6 text-center text-sm text-muted-foreground"
            >
              {meeting.state === "preparing"
                ? "Supervisor is preparing the deck…"
                : "No deck is available for this meeting."}
            </div>
          )}
        </div>
        <aside className="flex min-h-80 min-w-0 flex-col border-t border-border bg-muted/10 @min-[900px]:border-t-0 @min-[900px]:border-l">
          <nav aria-label="Meeting panels" className="flex gap-1 border-b border-border px-3 py-2">
            {(["conversation", "comments", "agenda"] as const).map((name) => (
              <Button
                key={name}
                variant={panel === name ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={panel === name}
                onClick={() => setPanel(name)}
                className="capitalize"
              >
                {name}
                {name === "comments" && meeting.comments.length > 0
                  ? ` ${meeting.comments.length}`
                  : ""}
              </Button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 @min-[900px]:max-h-[calc(100dvh-220px)]">
            {panel === "conversation" && (
              <>
                {meeting.transcript.length > visibleTurns && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleTurns((count) => count + 100)}
                  >
                    Show earlier messages
                  </Button>
                )}
                {meeting.transcript.slice(-visibleTurns).map((turn) => (
                  <div key={turn.id}>
                    <p className="text-xs text-muted-foreground">
                      {turn.speaker === "owner" ? "You" : "Supervisor"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{turn.text}</p>
                  </div>
                ))}
                {partial && (
                  <p role="status" className="text-sm italic text-muted-foreground">
                    {partial}
                  </p>
                )}
              </>
            )}
            {panel === "comments" &&
              meeting.comments.map((item) => (
                <div key={item.id} className="border-l-2 border-primary pl-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {jourFixeEvidenceLabel(meeting, item.id)}
                    {item.deckRevision !== meeting.deckRevision
                      ? ` · Earlier deck ${item.deckRevision}`
                      : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
                </div>
              ))}
            {panel === "agenda" &&
              slides.map((item, number) => (
                <button
                  type="button"
                  key={item.id}
                  className="block w-full text-left text-sm hover:underline"
                  onClick={() => {
                    selectSlide(item.id);
                    setView("slides");
                  }}
                >
                  {number + 1}. {item.title}
                </button>
              ))}
          </div>
          {onMessage && editable && (
            <form
              className="flex items-center gap-2 border-t border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!message.trim() || busy) return;
                void perform(
                  () => onMessage(meeting.id, meeting.revision, message.trim()),
                  () => setMessage(""),
                );
              }}
            >
              <Input
                aria-label="Message to supervisor"
                maxLength={16384}
                placeholder="Write or speak…"
                value={message}
                disabled={busy}
                onChange={(event) => setMessage(event.target.value)}
                className="min-w-0 flex-1"
              />
              {onToggleMicrophone && (
                <Button
                  size="icon-sm"
                  variant={microphoneActive ? "destructive" : "outline"}
                  aria-label={microphoneActive ? "Stop microphone" : "Start microphone"}
                  aria-pressed={microphoneActive}
                  onClick={onToggleMicrophone}
                >
                  <MicIcon />
                </Button>
              )}
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Send message"
                disabled={busy || !message.trim()}
              >
                <SendIcon />
              </Button>
            </form>
          )}
        </aside>
      </div>
    </section>
  );
}
