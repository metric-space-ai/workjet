import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";

import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";

const pullRequest = {
  number: 42,
  title: "Completed worker",
  url: "https://github.com/owner/project/pull/42",
  baseRefName: "main",
  headRefName: "workjet/worker/42",
  state: "MERGED",
  headRepository: { name: "project" },
  headRepositoryOwner: { login: "fork" },
};

describe("authoritative GitHub pull request head", () => {
  it.each([40, 64])("preserves a full %i-character OID and fork identity", (length) => {
    const result = decodeGitHubPullRequestJson(
      JSON.stringify({ ...pullRequest, headRefOid: "A".repeat(length) }),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toMatchObject({
        state: "merged",
        headCommitOid: "a".repeat(length),
        headRepositoryNameWithOwner: "fork/project",
        headRepositoryOwnerLogin: "fork",
      });
    }
  });

  it.each([null, "", "abc1234", "g".repeat(40), " a".repeat(20)])(
    "retains unknown head evidence for %j",
    (headRefOid) => {
      const result = decodeGitHubPullRequestJson(JSON.stringify({ ...pullRequest, headRefOid }));
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect(result.success.headCommitOid).toBeNull();
    },
  );

  it("does not manufacture an OID when the provider omits it", () => {
    const result = decodeGitHubPullRequestJson(JSON.stringify(pullRequest));
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).not.toHaveProperty("headCommitOid");
  });

  it("uses the same OID normalization for listings", () => {
    const result = decodeGitHubPullRequestListJson(
      JSON.stringify([{ ...pullRequest, headRefOid: "B".repeat(40) }, pullRequest]),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success[0]?.headCommitOid).toBe("b".repeat(40));
      expect(result.success[1]?.headCommitOid).toBeUndefined();
    }
  });

  it("rejects a non-string provider OID", () => {
    const result = decodeGitHubPullRequestJson(JSON.stringify({ ...pullRequest, headRefOid: 123 }));
    expect(Result.isFailure(result)).toBe(true);
  });
});
