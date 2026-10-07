import { useRef, useState } from "react";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, MicIcon, SendIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { WorkjetHeaderContent } from "./WorkjetHeaderSlots";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem, WorkspaceBreadcrumbSeparator } from "./WorkspaceBreadcrumb";
import { jourFixeCommentAnchor, jourFixeCommentIsCurrent, jourFixeCommentsForSlide, type JourFixeCommentDraft, type JourFixeRoomSnapshot, type JourFixeTodo } from "../lib/jourFixeRoom";

export interface JourFixeRoomProps {
  readonly projectTitle: string;
  readonly meeting: JourFixeRoomSnapshot;
  readonly onBack: () => void;
  /** Resolves only after the native receipt; must preserve uncertain operation IDs. */
  readonly onComment?: (draft: JourFixeCommentDraft, text: string) => Promise<void>;
  readonly onMessage?: (meetingId: string, expectedRevision: number, text: string) => Promise<void>;
  readonly onProposeTodos?: (meetingId: string, expectedRevision: number, proposalRevision: number, items: readonly JourFixeTodo[]) => Promise<void>;
  readonly onConfirmTodos?: (meetingId: string, expectedRevision: number, proposalRevision: number) => Promise<void>;
  readonly onToggleMicrophone?: () => void;
  readonly microphoneActive?: boolean;
  readonly partialTranscript?: string;
  /** Blob obtained through the selected instance's authorized file channel. */
  readonly audio?: { readonly slideId: string; readonly deckRevision: number; readonly blobUrl: string };
}

export function JourFixeRoom(props: JourFixeRoomProps) {
  return <JourFixeRoomContent key={`${props.meeting.projectId}:${props.meeting.id}`} {...props} />;
}

function JourFixeRoomContent({ projectTitle, meeting, onBack, onComment, onMessage, onProposeTodos, onConfirmTodos, onToggleMicrophone, microphoneActive = false, partialTranscript, audio }: JourFixeRoomProps) {
  const slides = [...meeting.slides].sort((a, b) => a.position - b.position);
  const [slideId, setSlideId] = useState(slides[0]?.id ?? "");
  const slide = slides.find((item) => item.id === slideId) ?? slides[0];
  const index = slide ? slides.indexOf(slide) : -1;
  const [tab, setTab] = useState<"conversation" | "comments" | "review">("conversation");
  const [draft, setDraft] = useState<JourFixeCommentDraft | null>(null);
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [todoDraft, setTodoDraft] = useState<{ revision: number; items: readonly JourFixeTodo[] } | null>(null);
  const todos = todoDraft?.revision === meeting.todos?.revision ? todoDraft.items : meeting.todos?.items ?? [];
  const comments = slide ? jourFixeCommentsForSlide(meeting, slide.id) : [];
  const editable = ["ready", "live", "review"].includes(meeting.state);
  const currentDraft = draft && jourFixeCommentIsCurrent(meeting, draft) ? draft : null;
  const hasTodoEdits = todoDraft !== null && todoDraft.revision === meeting.todos?.revision;
  const narration = slide && audio?.slideId === slide.id && audio.deckRevision === meeting.deckRevision && audio.blobUrl.startsWith("blob:") ? audio.blobUrl : undefined;
  async function perform(action: () => Promise<void>, done?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try { await action(); done?.(); }
    catch { setError("Could not confirm this change. Your draft is preserved; refresh the meeting before retrying."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function updateTodo(id: string, key: "title" | "acceptance", value: string) {
    if (meeting.todos === undefined) return;
    setTodoDraft({ revision: meeting.todos.revision, items: todos.map((todo) => todo.id === id ? { ...todo, [key]: value } : todo) });
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto" data-workjet-jour-fixe-room={meeting.id}>
      <WorkjetHeaderContent className="flex min-w-0 items-center">
        <WorkspaceBreadcrumb ariaLabel="Meeting breadcrumb">
          <WorkspaceBreadcrumbItem><button type="button" onClick={onBack} className="truncate hover:underline">{projectTitle}</button></WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator /><WorkspaceBreadcrumbItem current>Jour fixe</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to overview" onClick={onBack}><ArrowLeftIcon /></Button>
        <h1 className="font-medium">{projectTitle} · Jour fixe</h1>
        <time className="text-xs text-muted-foreground" dateTime={new Date(meeting.scheduledAt).toISOString()}>
          {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: meeting.timezone }).format(meeting.scheduledAt)} · {meeting.timezone}
        </time>
        <span className="ml-auto rounded-full border border-border px-2.5 py-1 text-xs capitalize" data-meeting-state={meeting.state}>{meeting.state}</span>
      </header>
      {(error || meeting.error) && <p role="alert" className="border-b border-destructive/30 px-5 py-2 text-sm text-destructive">{error ?? meeting.error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3 p-5">
          {slide ? <>
            <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-[#f5f3ee] text-[#18181b]">
              <article className="absolute inset-0 overflow-auto p-[6%]">
                <p className="mb-3 text-xs text-[#71717a]">{index + 1} / {slides.length}</p>
                <h2 className="mb-5 text-xl font-semibold tracking-tight md:text-3xl">{slide.title}</h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed md:text-base">{slide.markdown}</p>
              </article>
              {onComment && editable && <button type="button" className="absolute right-3 bottom-3 rounded-md bg-black/10 px-2 py-1 text-xs hover:bg-black/20" onClick={() => { setDraft({ meetingId: meeting.id, expectedRevision: meeting.revision, deckRevision: meeting.deckRevision, slideId: slide.id, x: .5, y: .5 }); setComment(""); }} disabled={busy}>Add comment</button>}
              {onComment && editable && <button type="button" aria-label="Place a comment on the slide" tabIndex={-1} className="absolute inset-0 bottom-12 cursor-crosshair" onClick={(event) => { const bounds = event.currentTarget.parentElement?.getBoundingClientRect(); if (!bounds) return; const anchor = jourFixeCommentAnchor(meeting, slide.id, { x: event.clientX, y: event.clientY }, bounds); if (anchor) { setDraft(anchor); setComment(""); } }} disabled={busy} />}
              {comments.map((item, number) => <button key={item.id} type="button" aria-label={`Comment ${number + 1}: ${item.text}`} className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-xs text-primary-foreground shadow-sm" style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }} onClick={() => setTab("comments")}>{number + 1}</button>)}
              {currentDraft?.slideId === slide.id && <span className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500 ring-2 ring-amber-500/30" style={{ left: `${currentDraft.x * 100}%`, top: `${currentDraft.y * 100}%` }} />}
            </div>
            <div className="flex items-center gap-2">
              <Button size="icon-sm" variant="outline" aria-label="Previous slide" disabled={index <= 0} onClick={() => setSlideId(slides[index - 1]!.id)}><ChevronLeftIcon /></Button>
              <Button size="icon-sm" variant="outline" aria-label="Next slide" disabled={index >= slides.length - 1} onClick={() => setSlideId(slides[index + 1]!.id)}><ChevronRightIcon /></Button>
              {narration ? <audio key={`${slide.id}:${meeting.deckRevision}`} controls preload="metadata" src={narration} className="h-8 min-w-0 flex-1" aria-label="Supervisor narration" /> : <span className="text-xs text-muted-foreground">Narration not available</span>}
            </div>
            <nav aria-label="Slides" className="flex gap-2 overflow-x-auto pb-1">
              {slides.map((item, number) => <button key={item.id} type="button" aria-current={item.id === slide.id ? "step" : undefined} onClick={() => setSlideId(item.id)} className={`relative w-28 shrink-0 rounded-md border p-2 text-left text-xs ${item.id === slide.id ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}><span className="block text-muted-foreground">{number + 1}</span><span className="line-clamp-2">{item.title}</span>{jourFixeCommentsForSlide(meeting, item.id).length > 0 && <span className="absolute top-1 right-1 rounded-full bg-primary px-1 text-primary-foreground">{jourFixeCommentsForSlide(meeting, item.id).length}</span>}</button>)}
            </nav>
          </> : <div role="status" className="grid aspect-video place-items-center rounded-lg border border-border text-sm text-muted-foreground">{meeting.state === "preparing" ? "Supervisor is preparing the deck…" : "No deck is available for this meeting."}</div>}
          {draft && !currentDraft && <p role="status" className="text-sm text-amber-500">The meeting changed. Place your comment again on the current deck.</p>}
          {currentDraft && <form className="flex flex-wrap gap-2 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); if (onComment && comment.trim() && !busy) void perform(() => onComment(currentDraft, comment.trim()), () => { setDraft(null); setComment(""); }); }}>
            <Input aria-label="Slide comment" maxLength={4096} value={comment} onChange={(event) => setComment(event.target.value)} className="min-w-0 flex-1" disabled={busy} />
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !comment.trim()}>Send comment</Button>
          </form>}
        </div>
        <aside className="flex min-h-80 min-w-0 flex-col border-t border-border lg:border-t-0 lg:border-l">
          <nav aria-label="Meeting panels" className="flex gap-1 border-b border-border px-3 py-2">
            {(["conversation", "comments", "review"] as const).map((name) => <Button key={name} variant={tab === name ? "secondary" : "ghost"} size="sm" aria-pressed={tab === name} onClick={() => setTab(name)} className="capitalize">{name}{name === "comments" && meeting.comments.length > 0 ? ` ${meeting.comments.length}` : ""}</Button>)}
          </nav>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {tab === "conversation" && <>
              {[...meeting.transcript].sort((a, b) => a.sequence - b.sequence).map((turn) => <div key={turn.id}><p className="text-xs text-muted-foreground">{turn.speaker === "owner" ? "You" : "Supervisor"}</p><p className="mt-1 whitespace-pre-wrap text-sm">{turn.text}</p></div>)}
              {partialTranscript && <p role="status" className="text-sm italic text-muted-foreground">{partialTranscript}</p>}
            </>}
            {tab === "comments" && meeting.comments.map((item) => <div key={item.id} className="border-l-2 border-primary pl-3 text-sm"><p className="text-xs text-muted-foreground">Slide {slides.findIndex((entry) => entry.id === item.slideId) + 1} · Deck {item.deckRevision}</p><p className="mt-1 whitespace-pre-wrap">{item.text}</p></div>)}
            {tab === "review" && <>
              <h2 className="text-sm font-medium">{meeting.todos?.status === "confirmed" ? "Confirmed goals" : "Proposed goals"}</h2>
              {todos.map((todo) => <fieldset key={todo.id} className="space-y-2 rounded-lg border border-border p-3" disabled={!onProposeTodos || busy || meeting.state !== "review" || meeting.todos?.status !== "proposed"}>
                <legend className="px-1 text-xs text-muted-foreground">{todo.priority}</legend>
                <Input aria-label={`Todo title: ${todo.title}`} maxLength={512} value={todo.title} onChange={(event) => updateTodo(todo.id, "title", event.target.value)} />
                <label className="block text-xs text-muted-foreground">Acceptance<textarea className="mt-1 block min-h-16 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm text-foreground" maxLength={4096} value={todo.acceptance} onChange={(event) => updateTodo(todo.id, "acceptance", event.target.value)} /></label>
                <p className="break-words text-xs text-muted-foreground">{todo.evidenceIds.join(" · ")}</p>
              </fieldset>)}
              {meeting.todos?.status === "proposed" && meeting.state === "review" && <div className="flex flex-wrap gap-2">
                {hasTodoEdits && onProposeTodos && <Button disabled={busy || todos.some((todo) => !todo.title.trim() || !todo.acceptance.trim())} onClick={() => void perform(() => onProposeTodos(meeting.id, meeting.revision, meeting.todos!.revision, todos), () => setTodoDraft(null))}>Save edits</Button>}
                {onConfirmTodos && <Button disabled={busy || hasTodoEdits || todos.length === 0} onClick={() => void perform(() => onConfirmTodos(meeting.id, meeting.revision, meeting.todos!.revision))}>Confirm {todos.length} goals</Button>}
              </div>}
            </>}
          </div>
          {onMessage && editable && <form className="flex items-center gap-2 border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); if (!message.trim() || busy) return; void perform(() => onMessage(meeting.id, meeting.revision, message.trim()), () => setMessage("")); }}>
            <Input aria-label="Message to supervisor" maxLength={16384} placeholder="Message…" value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} className="min-w-0 flex-1" />
            {onToggleMicrophone && <Button size="icon-sm" variant={microphoneActive ? "destructive" : "outline"} aria-label={microphoneActive ? "Stop microphone" : "Start microphone"} aria-pressed={microphoneActive} onClick={onToggleMicrophone}><MicIcon /></Button>}
            <Button type="submit" size="icon-sm" aria-label="Send message" disabled={busy || !message.trim()}><SendIcon /></Button>
          </form>}
        </aside>
      </div>
    </section>
  );
}
