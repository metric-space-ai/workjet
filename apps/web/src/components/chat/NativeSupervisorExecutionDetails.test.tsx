import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkjetSupervisorExecutionPage } from "@workjet/contracts";
import { NativeSupervisorExecutionDetails } from "./NativeSupervisorExecutionDetails";

const page: WorkjetSupervisorExecutionPage = {
  command_id: "native-command",
  task_id: "native-task",
  attempt: { attempt_id: "actual-attempt", run_id: "actual-run" },
  events: [
    {
      id: "native-event",
      sequence: 7,
      kind: "progress",
      title: "<script>unsafe()</script>",
      created_at_ms: 1791410000000,
    },
  ],
  next_cursor: { after_sequence: 7, after_event_id: "native-event" },
  has_more: true,
};
const noop = () => {};
const render = (value: WorkjetSupervisorExecutionPage | null, error: string | null = null) =>
  renderToStaticMarkup(
    <NativeSupervisorExecutionDetails
      page={value}
      error={error}
      disabled={false}
      onNext={noop}
      onReset={noop}
    />,
  );

describe("native supervisor event details", () => {
  it("shows actual native identities and escaped event titles with explicit paging", () => {
    const html = render(page);
    expect(html).toContain("Attempt ID actual-attempt");
    expect(html).toContain("Run-ID actual-run");
    expect(html).toContain("7. &lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Load more events");
    expect(html).toContain("Reload from start");
  });
  it("does not invent an attempt or run for a queued task", () => {
    const html = render({
      command_id: "native-command",
      task_id: "native-task",
      events: [],
      has_more: false,
    });
    expect(html).toContain("No retained events yet");
    expect(html).not.toContain("Attempt ID");
    expect(html).not.toContain("Run-ID");
    expect(html).not.toContain("Load more events");
  });
  it("shows unsupported observation separately without a fabricated empty history", () => {
    expect(render(null)).toBe("");
    const html = render(null, "Diese CTOX-Version stellt keinen Ausführungsverlauf bereit.");
    expect(html).toContain("keinen Ausführungsverlauf");
    expect(html).not.toContain("No retained events yet");
    expect(html).not.toContain("Run-ID");
  });
});
