import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  WorkjetThreadConfig,
  normalizeWorkjetThreadConfig,
  inheritWorkjetThreadSettings,
} from "./workjet.ts";
import {
  WorkjetParentTeamBinding,
  workjetParentBindingMatchesTeam,
  sameWorkjetParentTeamBinding,
} from "./workjetParentTeamBinding.ts";

const reference = {
  contract: "ctox.workjet.persistent-worker-binding.v1",
  owner_user_id: "owner",
  project_id: "project-1",
  supervisor_thread_id: "b2cd2661-181e-41fd-a54e-ea5642ccf0dc",
  thread_id: "21a77758-8723-431b-bbeb-3aa9f0507c4d",
  role: "persistent_worker",
  revision: 1,
  state: "active",
} as const satisfies WorkjetParentTeamBinding;
const team = {
  role: "specialist",
  projectId: ProjectId.make(reference.project_id),
  threadId: ThreadId.make(reference.thread_id),
  parentThreadId: ThreadId.make(reference.supervisor_thread_id),
  domain: "implementation",
  goal: "Deliver the project",
  createdAt: "2026-10-11T00:00:00Z",
} as const;
const decode = Schema.decodeUnknownSync(WorkjetParentTeamBinding);

describe("complete native Parent enrollment reference", () => {
  it("keeps all eight native fields across config decode and normalization, without inheriting enrollment", () => {
    expect(decode(reference)).toEqual(reference);
    const config = Schema.decodeUnknownSync(WorkjetThreadConfig)({
      schemaVersion: 2,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: [],
      capabilityBindings: [],
      team,
      parentTeamBinding: reference,
    });
    expect(normalizeWorkjetThreadConfig(config).parentTeamBinding).toEqual(reference);
    expect(Object.hasOwn(inheritWorkjetThreadSettings(config), "parentTeamBinding")).toBe(false);
  });

  it("rejects incomplete, extended, null, unsafe and non-canonical native references", () => {
    for (const value of [
      null,
      { ...reference, contract: "other" },
      { ...reference, role: "supervisor" },
      { ...reference, state: "revoked" },
      { ...reference, revision: 0 },
      { ...reference, revision: 1.5 },
      { ...reference, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...reference, owner_user_id: "" },
      { ...reference, project_id: "" },
      { ...reference, owner_user_id: "x".repeat(257) },
      { ...reference, supervisor_thread_id: reference.supervisor_thread_id.toUpperCase() },
      { ...reference, thread_id: "00000000-0000-0000-0000-000000000000" },
      { ...reference, host: "extra-authority" },
      ...Object.keys(reference).map((key) =>
        Object.fromEntries(Object.entries(reference).filter(([name]) => name !== key)),
      ),
    ])
      expect(() => decode(value)).toThrow();
    expect(decode({ ...reference, revision: Number.MAX_SAFE_INTEGER }).revision).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("requires the actual specialist, project and Supervisor affiliation without granting native authority", () => {
    expect(workjetParentBindingMatchesTeam(reference, team, team.projectId, team.threadId)).toBe(
      true,
    );
    expect(
      workjetParentBindingMatchesTeam(undefined, undefined, team.projectId, team.threadId),
    ).toBe(true);
    for (const member of [
      undefined,
      { ...team, role: "supervisor" as const, parentThreadId: null },
      { ...team, projectId: ProjectId.make("foreign-project") },
      { ...team, threadId: ThreadId.make(reference.supervisor_thread_id) },
      { ...team, parentThreadId: ThreadId.make(reference.thread_id) },
    ])
      expect(
        workjetParentBindingMatchesTeam(reference, member, team.projectId, team.threadId),
      ).toBe(false);
  });

  it("compares every field of the full reference and preserves absence", () => {
    expect(sameWorkjetParentTeamBinding(undefined, undefined)).toBe(true);
    expect(sameWorkjetParentTeamBinding(reference, undefined)).toBe(false);
    for (const changed of [
      { ...reference, owner_user_id: "other-owner" },
      { ...reference, project_id: "other-project" },
      { ...reference, supervisor_thread_id: reference.thread_id },
      { ...reference, thread_id: reference.supervisor_thread_id },
      { ...reference, revision: 2 },
    ])
      expect(sameWorkjetParentTeamBinding(reference, changed)).toBe(false);
  });
});
