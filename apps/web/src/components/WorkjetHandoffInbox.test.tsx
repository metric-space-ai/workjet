import type { ThreadId, WorkjetReceivedHandoff } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkjetHandoffInbox,
  buildWorkjetHandoffRows,
  formatWorkjetHandoffBranch,
  formatWorkjetHandoffDate,
  formatWorkjetSnapshotSize,
} from "./WorkjetHandoffInbox";

const handoff = (overrides: Partial<WorkjetReceivedHandoff> = {}): WorkjetReceivedHandoff =>
  ({
    schemaVersion: 1,
    handoffId: "wjh-0123456789abcdef",
    envelopeId: "wjm-0123456789abcdef",
    sourceThread: {
      schemaVersion: 1,
      workspaceId: "ctox:mesh-alpha",
      environmentId: "environment-remote",
      threadId: "thread-remote-source",
    },
    createdAt: "2026-08-19T10:00:00.000Z",
    expiresAt: "2026-08-20T10:00:00.000Z",
    receivedAt: "2026-08-19T10:00:02.000Z",
    snapshotAvailable: true,
    snapshotByteLength: 4_096,
    ...overrides,
  }) as unknown as WorkjetReceivedHandoff;

const render = (props: Partial<Parameters<typeof WorkjetHandoffInbox>[0]> = {}) =>
  renderToStaticMarkup(
    <WorkjetHandoffInbox
      handoffs={[handoff()]}
      onContinue={() => {}}
      onOpenThread={() => {}}
      {...props}
    />,
  );

describe("formatWorkjetHandoffBranch", () => {
  it("never claims a branch was pushed or is reachable", () => {
    const label = formatWorkjetHandoffBranch({
      schemaVersion: 1,
      branch: "agent/th-thread-handoff",
      remoteConfigured: true,
    } as unknown as WorkjetReceivedHandoff["branch"]);
    expect(label).toContain("agent/th-thread-handoff");
    expect(label).toContain("nothing was pushed");
    expect(label).not.toContain("available");
  });

  it("says the head is unknown rather than inventing one", () => {
    const label = formatWorkjetHandoffBranch({
      schemaVersion: 1,
      branch: "agent/no-commit",
      remoteConfigured: false,
    } as unknown as WorkjetReceivedHandoff["branch"]);
    expect(label).toContain("head unknown");
    expect(label).toContain("no remote");
  });

  it("returns nothing when the handoff carried no branch", () => {
    expect(formatWorkjetHandoffBranch(undefined)).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("shows a date, not a false-precision timestamp", () => {
    expect(formatWorkjetHandoffDate("2026-08-19T10:00:02.000Z")).toBe("2026-08-19");
  });

  it("shows a compact snapshot size", () => {
    expect(formatWorkjetSnapshotSize(512)).toBe("512 B");
    expect(formatWorkjetSnapshotSize(4_096)).toBe("4 KiB");
  });
});

describe("buildWorkjetHandoffRows", () => {
  it("offers continuation only when the context is readable here", () => {
    const rows = buildWorkjetHandoffRows({
      handoffs: [handoff(), handoff({ handoffId: "wjh-missing" as WorkjetReceivedHandoff["handoffId"], snapshotAvailable: false })],
      busyHandoffId: null,
    });
    expect(rows[0]?.continueState).toBe("ready");
    expect(rows[1]?.continueState).toBe("unavailable");
  });

  it("marks the handoff whose continuation is in flight", () => {
    const rows = buildWorkjetHandoffRows({
      handoffs: [handoff()],
      busyHandoffId: "wjh-0123456789abcdef",
    });
    expect(rows[0]?.continueState).toBe("busy");
  });

  it("keeps an already-continued handoff listed, pointing at its thread", () => {
    const rows = buildWorkjetHandoffRows({
      handoffs: [handoff({ acceptedThreadId: "thread-continued" as ThreadId })],
      busyHandoffId: null,
    });
    expect(rows[0]?.continueState).toBe("continued");
    expect(rows[0]?.continuedThreadId).toBe("thread-continued");
  });

  it("names the source machine and thread the work came from", () => {
    const rows = buildWorkjetHandoffRows({ handoffs: [handoff()], busyHandoffId: null });
    expect(rows[0]?.sourceLabel).toBe("environment-remote · thread-remote-source");
  });
});

describe("WorkjetHandoffInbox", () => {
  it("renders nothing when no handoff arrived", () => {
    expect(render({ handoffs: [] })).toBe("");
  });

  it("lists an arrived handoff with a continue action", () => {
    const markup = render();
    expect(markup).toContain("Handoffs (1)");
    expect(markup).toContain("thread-remote-source");
    expect(markup).toContain("Continue here");
    expect(markup).toContain('data-continue-state="ready"');
  });

  it("never renders the snapshot text, only its size", () => {
    const markup = render({
      handoffs: [handoff({ note: "Continue the transport slice." })],
    });
    expect(markup).toContain("4 KiB");
    expect(markup).toContain("Continue the transport slice.");
    // The client is never handed a copy of the context; the server seeds it.
    expect(markup).not.toContain("Workjet thread handoff");
  });

  it("disables continuation and explains why when the context never arrived", () => {
    const markup = render({ handoffs: [handoff({ snapshotAvailable: false })] });
    expect(markup).toContain("Context missing");
    expect(markup).toContain("disabled");
    expect(markup).toContain("did not arrive on this machine");
  });

  it("offers the continued thread instead of a second continuation", () => {
    const markup = render({
      handoffs: [handoff({ acceptedThreadId: "thread-continued" as ThreadId })],
    });
    expect(markup).toContain("Open thread");
    expect(markup).not.toContain("Continue here");
  });

  it("renders a refusal inline without hiding the rows", () => {
    const markup = render({ error: "The handoff context snapshot is not available." });
    expect(markup).toContain("The handoff context snapshot is not available.");
    expect(markup).toContain("thread-remote-source");
  });
});
