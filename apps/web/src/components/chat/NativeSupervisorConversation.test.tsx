import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandId, ProjectId, type WorkjetSupervisorJournal } from "@workjet/contracts";
import { NativeSupervisorConversation } from "./NativeSupervisorConversation";
import type { SupervisorPublicReply } from "../../supervisorPublicReplies";

const journal: WorkjetSupervisorJournal = {
  intent: {
    instanceId: "managed:acceptance",
    projectId: ProjectId.make("project"),
    threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
    commandId: CommandId.make("request"),
    goal: "Actual requested change",
    createdAt: "2026-10-09T00:00:00.000Z",
  },
  submission: "confirmed",
  turn: {
    commandId: "command",
    taskId: "task",
    threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
    threadKey: "business-os/threads/supervisor",
    executionPhase: "running",
    status: "running",
    queueStatus: "running",
    attempt: 1,
    terminal: false,
    result: null,
    resultTruncated: false,
    errorCode: null,
    errorMessage: null,
  },
};
const reply: SupervisorPublicReply = {
  id: "item",
  turnId: "turn",
  itemId: "item",
  phase: "final_answer",
  text: "Actual partial model reply",
  completed: true,
  truncated: false,
  incomplete: false,
};
const render = (replies: readonly SupervisorPublicReply[], current = journal) =>
  renderToStaticMarkup(
    <NativeSupervisorConversation
      journal={current}
      page={null}
      replies={replies}
      historyLimited={false}
      error={null}
      disabled={false}
      onNext={() => {}}
      onReset={() => {}}
    />,
  );

describe("native Supervisor conversation display", () => {
  it("keeps durable Owner context literal and distinguishes delivery from task completion", () => {
    const html = render([], { ...journal, inputs: [{
      intent: { ...journal.intent, body: '<script>owner context</script>',
        targetCommandId: journal.turn!.commandId, commandId: CommandId.make("input") },
      receipt: null, submission: "awaiting-receipt" }] });
    expect(html).toContain("&lt;script&gt;owner context&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Context receipt pending");
    expect(html).toContain("running · Attempt 1");
    expect(html).not.toContain("Saved for the task’s next step");
  });
  it("renders streamed emphasis and lists with the existing chat typography", () => {
    const html = render([{ ...reply, text: "**Belegt**\n\n- Erstens\n- Zweitens" }]);
    expect(html).toContain("<strong>Belegt</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Erstens</li>");
    expect(html).toContain("chat-markdown");
    expect(html).not.toContain("**Belegt**");
    expect(html).toContain("running · Attempt 1");
  });
  it("renders retained final answers as Markdown too", () => {
    const html = render([], {
      ...journal,
      turn: { ...journal.turn!, result: "**Fertig**\n\n1. Ergebnis" },
    });
    expect(html).toContain("<strong>Fertig</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>Ergebnis</li>");
  });
  it("does not interpret model-provided HTML or dangerous link schemes", () => {
    const html = render([
      {
        ...reply,
        text: '<img src=x onerror="unsafe()">\n\n[unsafe](javascript:unsafe())\n\n[safe](https://ctox.dev)',
      },
    ]);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://ctox.dev"');
  });
  it("renders public text as a reply without declaring a running task completed", () => {
    const html = render([reply]);
    expect(html).toContain('aria-label="Supervisor reply"');
    expect(html).toContain("Actual partial model reply");
    expect(html).toContain("running · Attempt 1");
    expect(html).not.toContain("Awaiting confirmation");
  });
  it("labels actual commentary separately and escapes text", () => {
    const html = render([{ ...reply, phase: "commentary", text: "<script>unsafe()</script>" }]);
    expect(html).toContain('aria-label="Supervisor commentary"');
    expect(html).toContain("Supervisor · Progress");
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("keeps an incomplete reply visible with an explicit recovery action", () => {
    const html = render([{ ...reply, incomplete: true }]);
    expect(html).toContain("Actual partial model reply");
    expect(html).toContain("Reply incomplete. Reload execution history.");
  });
  it("does not duplicate an identical authoritative terminal result", () => {
    const html = render([reply], {
      ...journal,
      turn: {
        ...journal.turn!,
        terminal: true,
        executionPhase: "terminal",
        status: "completed",
        result: reply.text,
      },
    });
    expect(html.split(reply.text).length - 1).toBe(1);
  });
  it("does not fabricate a reply from an empty item completion", () => {
    expect(render([{ ...reply, text: "" }])).not.toContain('aria-label="Supervisor reply"');
  });
});
