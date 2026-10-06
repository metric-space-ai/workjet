import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CtoxWorkjetProjectControlResponse } from "./ctox";

const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
  onExcessProperty: "error",
});
const project = { id: "project-one", title: "greppy.xyz", workingCopies: [] };
const empty = { action: "project.list", projects: [], count: 0, truncated: false };

describe("confirmed native project lists", () => {
  it("accepts a confirmed empty list and a complete nonempty list", () => {
    expect(decode(empty)).toEqual(empty);
    const populated = { ...empty, projects: [project], count: 1 };
    expect(decode(populated)).toEqual(populated);
  });

  it.each([
    { action: "project.list", projects: [] },
    { ...empty, count: undefined },
    { ...empty, truncated: undefined },
    { ...empty, truncated: true },
    { ...empty, truncated: "false" },
    { ...empty, count: "0" },
    { ...empty, count: -1 },
    { ...empty, count: 0.5 },
    { ...empty, count: 101 },
    { ...empty, count: 1 },
    { ...empty, projects: [project] },
    { ...empty, projects: [project, project], count: 2 },
  ])("rejects unconfirmed, truncated, mismatched or duplicate lists %#", (response) => {
    expect(() => decode(response)).toThrow();
  });

  it("accepts the native bound without accepting larger lists", () => {
    const projects = Array.from({ length: 100 }, (_, index) => ({
      ...project,
      id: `project-${index}`,
    }));
    expect(decode({ ...empty, projects, count: 100 })).toMatchObject({ count: 100 });
    expect(() =>
      decode({ ...empty, projects: [...projects, { ...project, id: "extra" }], count: 100 }),
    ).toThrow();
  });
});
