import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResponse,
  CtoxWorkjetProjectProjection,
} from "./ctox.js";

const request = {
  action: "project.configure",
  commandId: "config-project-test",
  projectId: "f791215c-e416-4205-8619-bbf82b999799",
  title: "ctox.dev",
  repoUrl: "https://github.com/metric-space-ai/ctox",
  publicUrl: "https://ctox.dev",
  info: {
    description: "Durable work daemon",
    goal: "All twelve projects usable\nWith real histories",
    phase: "delivery",
  },
  jourFixe: { weekday: 3, time: "09:30", timezone: "Europe/Berlin" },
};
const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
  onExcessProperty: "error",
});

describe("CTOX project configuration contract", () => {
  it("negotiates optional configuration with a boolean flag", () => {
    expect(decode({ action: "project.list", includeConfiguration: true })).toEqual({
      action: "project.list",
      includeConfiguration: true,
    });
    expect(decode({ action: "project.list" })).toEqual({ action: "project.list" });
    expect(() => decode({ action: "project.list", includeConfiguration: "true" })).toThrow();
  });
  it("supports the native configure request and explicit clearing", () => {
    expect(decode(request)).toEqual(request);
    expect(decode({ ...request, info: null, jourFixe: null, publicUrl: null }).action).toBe(
      "project.configure",
    );
  });
  it.each([
    { repoUrl: "https://user:password@example.test/repo" },
    { publicUrl: "file:///private/project" },
    { jourFixe: { weekday: 0, time: "09:30", timezone: "Europe/Berlin" } },
    { jourFixe: { weekday: 1, time: "24:00", timezone: "Europe/Berlin" } },
    { jourFixe: { weekday: 1, time: "09:30", timezone: "Missing/Zone" } },
    { ownerUserId: "foreign-owner" },
    { archived: false },
    { info: { goal: "bad\u0000control" } },
  ])("rejects unsafe or unauthorized metadata %j", (invalid) => {
    expect(() => decode({ ...request, ...invalid })).toThrow();
  });
  it("keeps old native projections valid and carries confirmed metadata", () => {
    const project = { id: request.projectId, title: request.title, workingCopies: [] };
    const read = Schema.decodeUnknownSync(CtoxWorkjetProjectProjection, {
      onExcessProperty: "error",
    });
    expect(read(project)).toEqual(project);
    expect(
      read({ ...project, repoUrl: request.repoUrl, info: request.info, jourFixe: request.jourFixe })
        .info?.goal,
    ).toBe(request.info.goal);
  });
  it("accepts the correlated metadata-only configure receipt without inventing working copies", () => {
    const response = {
      action: "project.configure",
      commandId: request.commandId,
      project: {
        id: request.projectId,
        title: request.title,
        publicUrl: request.publicUrl,
        info: request.info,
        jourFixe: request.jourFixe,
      },
    };
    expect(
      Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, { onExcessProperty: "error" })(
        response,
      ),
    ).toEqual(response);
  });
});
