import type { EnvironmentId, ProjectId, PullRequestCheck } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestChecksList } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestRow, pullRequestRowStatus } from "./PullRequestRow";
import { pullRequestChecksState } from "./pullRequestPresentation";

function check(status: PullRequestCheck["status"]): PullRequestCheck {
  return { name: `check-${status}`, status, description: null, url: null };
}

describe("pullRequestChecksState", () => {
  it("lets a failure outrank a run still going, and reports nothing without checks", () => {
    expect(pullRequestChecksState([check("success"), check("pending"), check("failure")])).toBe(
      "failing",
    );
    expect(pullRequestChecksState([check("success"), check("cancelled")])).toBe("failing");
    expect(pullRequestChecksState([check("success"), check("pending")])).toBe("pending");
    expect(pullRequestChecksState([check("success")])).toBe("passing");
    // Skipped and neutral are neither a pass nor a failure, so they are no verdict at all.
    expect(pullRequestChecksState([check("skipped"), check("neutral")])).toBe(null);
    expect(pullRequestChecksState([])).toBe(null);
  });
});

function entry(overrides: Partial<EnvironmentPullRequestEntry>): EnvironmentPullRequestEntry {
  return {
    environmentId: "env-1" as EnvironmentId,
    projectId: "project-1" as ProjectId,
    provider: "github",
    repository: "pingdotgg/workjet",
    number: 1,
    title: "Add the pull requests page",
    url: "https://github.com/metric-space-ai/workjet/pull/1",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  } as EnvironmentPullRequestEntry;
}

function row(overrides: Partial<EnvironmentPullRequestEntry>): string {
  return renderToStaticMarkup(
    <PullRequestRow
      entry={entry(overrides)}
      selected={false}
      showProjectTitle={false}
      showProvider={false}
      onSelect={() => {}}
    />,
  );
}

describe("PullRequestRow als Zeile", () => {
  it("zeigt den Checks-Chip nur, wenn der Host einen Sammelstatus meldet", () => {
    expect(row({ checksState: "failing" })).toContain('data-slot="pull-request-checks-chip"');
    expect(row({})).not.toContain('data-slot="pull-request-checks-chip"');
  });

  it("trägt Statuspunkt, Nummer, Titel und Branch als Meta", () => {
    const html = row({ checksState: "passing" });
    expect(html).toContain('data-slot="row-status"');
    expect(html).toContain("#1");
    expect(html).toContain("Add the pull requests page");
    expect(html).toContain('data-slot="row-meta"');
    expect(html).toContain("feat/page");
  });

  it("klappt die Checks inline auf statt in einem Popover", () => {
    const html = row({ checksState: "passing" });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-slot="pull-request-checks-list"');
    expect(html).not.toContain("popover");
  });

  it("setzt den Statuspunkt nach Zustand", () => {
    expect(pullRequestRowStatus({ state: "open", isDraft: false })).toBe("ok");
    expect(pullRequestRowStatus({ state: "open", isDraft: true })).toBe("busy");
    expect(
      pullRequestRowStatus({ state: "open", isDraft: false, mergeability: "conflicting" }),
    ).toBe("error");
    expect(pullRequestRowStatus({ state: "merged", isDraft: false })).toBe("off");
    expect(pullRequestRowStatus({ state: "closed", isDraft: false })).toBe("off");
  });
});

describe("PullRequestChecksList", () => {
  it("listet mitgegebene Checks inline, ohne zu lesen", () => {
    const html = renderToStaticMarkup(
      <PullRequestChecksList checks={[check("success"), check("failure")]} />,
    );
    expect(html.match(/data-slot="pull-request-check"/g)?.length).toBe(2);
    expect(html).toContain("Bestanden");
    expect(html).toContain("Fehlgeschlagen");
  });
});
